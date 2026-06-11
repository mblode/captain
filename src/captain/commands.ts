import { CliError, EXIT } from "../errors";
import { run } from "../shell";
import { realCmux } from "./control";
import type { CmuxPort } from "./control";
import { msg, renderStatus, renderSummary, style, useColor } from "./format";
import type { Style } from "./format";
import { appendLog, now } from "./log";
import { fleetRows } from "./surface";
import { mergeOrderHints } from "./view";
import type { FleetRow } from "./view";

const styleFor = (out: NodeJS.WritableStream): Style => style(useColor(out));

// Resolve a user-friendly target spec to rows. Accepts "all", a repo label
// ("linkiq" → every matching row in the pool), or a comma-separated list of
// ticket names ("tig-430"), substrings, or workspace ids — never a pasted uuid.
export const resolveTargets = (
  pool: FleetRow[],
  spec: string
): { matched: FleetRow[]; unknown: string[] } => {
  if (spec === "all") {
    return { matched: pool, unknown: [] };
  }
  const matched: FleetRow[] = [];
  const unknown: string[] = [];
  const push = (hit: FleetRow): void => {
    if (!matched.includes(hit)) {
      matched.push(hit);
    }
  };
  for (const raw of spec.split(",")) {
    const token = raw.trim().toLowerCase();
    if (!token) {
      continue;
    }
    // A repo label addresses the whole repo's batch at once.
    const repoHits = pool.filter((r) => r.repo?.toLowerCase() === token);
    if (repoHits.length > 0) {
      for (const hit of repoHits) {
        push(hit);
      }
      continue;
    }
    const hit = pool.find(
      (r) =>
        r.workspaceId.toLowerCase() === token ||
        r.name.toLowerCase() === token ||
        r.name.toLowerCase().includes(token)
    );
    if (hit) {
      push(hit);
    } else {
      unknown.push(raw.trim());
    }
  }
  return { matched, unknown };
};

export interface StatusOptions {
  json?: boolean;
  // narrow to one repo's worktrees (label match, e.g. "linkiq")
  repo?: string;
  // only the NEEDS YOU group
  needs?: boolean;
  // only the READY group
  ready?: boolean;
  // compact view: group counts + the NEEDS YOU rows only — a near-zero-token
  // poll. Composes with --repo. Honoured by both --json and the TTY render.
  summary?: boolean;
}

// Group tallies over a row set — the compact summary's headline.
const groupCounts = (
  rows: FleetRow[]
): { needsYou: number; inFlight: number; ready: number } => ({
  inFlight: rows.filter((r) => r.group === "in-flight").length,
  needsYou: rows.filter((r) => r.group === "needs-you").length,
  ready: rows.filter((r) => r.group === "ready").length,
});

// Thin fs edge: the branch's changed files vs origin's default branch.
// Fail-soft ([]): a missing origin/HEAD or a deleted worktree must never break
// `status`.
const changedFiles = (cwd: string, env: NodeJS.ProcessEnv): string[] => {
  const head = run(
    "git",
    ["-C", cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { env }
  );
  if (head.status !== 0) {
    return [];
  }
  const diff = run(
    "git",
    ["-C", cwd, "diff", "--name-only", `${head.stdout.trim()}...HEAD`],
    { env }
  );
  if (diff.status !== 0) {
    return [];
  }
  return diff.stdout.split("\n").filter(Boolean);
};

// The one read surface: the fleet view derived live from cmux + the worktrees,
// grouped with the few that need a decision on top — each carrying its inline
// resolve command. --repo/--needs/--ready narrow the view.
export const status = (
  options: StatusOptions,
  out: NodeJS.WritableStream,
  port: CmuxPort = realCmux(process.env)
): void => {
  // Probe cmux BEFORE deriving rows: a dead daemon makes every list/feed call
  // fail soft to empty, which a driver would read as "all done". Surface it as
  // a structured error with a dedicated exit code instead of a phantom-empty
  // fleet.
  if (!port.reachable()) {
    process.exitCode = EXIT.CMUX_UNREACHABLE;
    const message =
      "cmux is not reachable — is it running? run 'captain doctor'";
    if (options.json) {
      out.write(
        `${JSON.stringify({ error: { message, type: "CMUX_UNREACHABLE" } })}\n`
      );
      return;
    }
    out.write(`${msg.err(styleFor(out), message)}\n`);
    return;
  }
  let rows = fleetRows(port);
  if (options.repo) {
    const token = options.repo.trim().toLowerCase();
    rows = rows.filter((r) => (r.repo ?? "").toLowerCase().includes(token));
  }
  // --summary: counts for every group + full detail for NEEDS YOU only. Counts
  // come off the (repo-filtered) full set, so they stay honest regardless of
  // any narrowing flags.
  if (options.summary) {
    const counts = groupCounts(rows);
    const needsYou = rows.filter((r) => r.group === "needs-you");
    if (options.json) {
      out.write(`${JSON.stringify({ counts, needsYou })}\n`);
      return;
    }
    out.write(renderSummary(rows, styleFor(out)));
    return;
  }
  if (options.needs) {
    rows = rows.filter((r) => r.group === "needs-you");
  }
  if (options.ready) {
    rows = rows.filter((r) => r.group === "ready");
  }
  if (options.json) {
    out.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  // Merge-order pass (human-display hint only): runs 2 git calls per ready
  // worktree, so it is reached ONLY on the plain TTY render — the --json and
  // --summary machine paths above all return before this point and never pay
  // the git cost. Only worth a git call when ≥2 worktrees are ready.
  const ready = rows.filter((r) => r.group === "ready");
  const overlaps =
    ready.length >= 2
      ? mergeOrderHints(
          ready.map((r) => ({
            files: changedFiles(r.cwd, process.env),
            name: r.name,
            repo: r.repo ?? "?",
            workspaceId: r.workspaceId,
          }))
        )
      : {};
  out.write(renderStatus(rows, styleFor(out), { overlaps }));
};

// Rows currently parked at the plan gate — what approve/reject act on.
const planGated = (port: CmuxPort): FleetRow[] =>
  fleetRows(port).filter((r) => r.gate?.kind === "plan");

// Approve plan(s): reply to the cmux exit-plan feed item directly — there is
// no state to update and no watcher to hand off to, so the reply IS the
// approval; the agent resumes and self-drives the rest of its brief.
export const approve = (
  spec: string,
  out: NodeJS.WritableStream,
  port: CmuxPort = realCmux(process.env),
  options: { json?: boolean } = {}
): void => {
  const { matched, unknown } = resolveTargets(planGated(port), spec);
  // A fully-unresolvable ref under --json is a usage error, not an empty
  // success — surface it as a structured {error} (exit 2) so a driver can tell
  // "I typed a bad ref" apart from "there was nothing to approve". A partial
  // match still succeeds (the good refs are approved, the bad ones reported).
  if (options.json && matched.length === 0 && unknown.length > 0) {
    throw new CliError(
      `no plan-ready worktree matches: ${unknown.join(", ")}`,
      EXIT.USAGE,
      "BAD_REF"
    );
  }
  // The reply IS the approval (no state), so do it regardless of output mode.
  for (const row of matched) {
    port.replyExitPlan(row.gate?.id ?? "", true);
    appendLog({ kind: "approve", name: row.name, ts: now() });
  }
  if (options.json) {
    out.write(
      `${JSON.stringify({ approved: matched.map((r) => r.name), unknown })}\n`
    );
    return;
  }
  const s = styleFor(out);
  for (const u of unknown) {
    out.write(`  ${msg.warn(s, `no plan-ready worktree matches "${u}"`)}\n`);
  }
  if (matched.length === 0) {
    out.write(s.dim("nothing to approve.\n"));
    return;
  }
  for (const row of matched) {
    out.write(`${msg.ok(s, `approved ${s.bold(row.name)} — implementing`)}\n`);
  }
  out.write(`${msg.hint(s, "next: captain status")}\n`);
};

// Reject a plan: reply false to the plan gate, then type the feedback into the
// workspace so the agent actually receives the why and revises against it.
export const reject = (
  ref: string,
  note: string,
  out: NodeJS.WritableStream,
  port: CmuxPort = realCmux(process.env),
  options: { json?: boolean } = {}
): void => {
  const s = styleFor(out);
  const { matched } = resolveTargets(planGated(port), ref);
  const [row] = matched;
  if (!row) {
    if (options.json) {
      out.write(`${JSON.stringify({ unknown: [ref] })}\n`);
      return;
    }
    out.write(`${msg.warn(s, `no plan-ready worktree matches "${ref}"`)}\n`);
    return;
  }
  // Deliver the feedback FIRST (best-effort): if we rejected first and the send
  // then threw, the plan would be back in planning with the agent never told
  // why. Sending first means a failed send still lets the rejection through —
  // we just flag that the reason didn't land so the human can re-send it.
  let feedbackDelivered = true;
  try {
    port.send(row.workspaceId, `Plan rejected — revise it: ${note}`);
  } catch {
    feedbackDelivered = false;
  }
  port.replyExitPlan(row.gate?.id ?? "", false);
  appendLog({ kind: "reject", name: row.name, note, ts: now() });
  if (options.json) {
    out.write(
      `${JSON.stringify({ feedbackDelivered, note, rejected: row.name })}\n`
    );
    return;
  }
  out.write(`${s.yellow("↩")} ${s.bold(row.name)} back to planning: ${note}\n`);
  if (!feedbackDelivered) {
    out.write(
      `  ${msg.warn(s, `couldn't deliver the feedback to ${row.name} — re-send it manually`)}\n`
    );
  }
  out.write(`${msg.hint(s, "next: captain status")}\n`);
};
