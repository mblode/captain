import { run } from "../shell";
import { realCmux } from "./control";
import type { CmuxPort } from "./control";
import { msg, renderStatus, style, useColor } from "./format";
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
}

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
  let rows = fleetRows(port);
  if (options.repo) {
    const token = options.repo.trim().toLowerCase();
    rows = rows.filter((r) => (r.repo ?? "").toLowerCase().includes(token));
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
  // Merge-order pass: only worth a git call when ≥2 worktrees are ready.
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
  port: CmuxPort = realCmux(process.env)
): void => {
  const s = styleFor(out);
  const { matched, unknown } = resolveTargets(planGated(port), spec);
  for (const u of unknown) {
    out.write(`  ${msg.warn(s, `no plan-ready worktree matches "${u}"`)}\n`);
  }
  if (matched.length === 0) {
    out.write(s.dim("nothing to approve.\n"));
    return;
  }
  for (const row of matched) {
    port.replyExitPlan(row.gate?.id ?? "", true);
    appendLog({ kind: "approve", name: row.name, ts: now() });
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
  port: CmuxPort = realCmux(process.env)
): void => {
  const s = styleFor(out);
  const { matched } = resolveTargets(planGated(port), ref);
  const [row] = matched;
  if (!row) {
    out.write(`${msg.warn(s, `no plan-ready worktree matches "${ref}"`)}\n`);
    return;
  }
  port.replyExitPlan(row.gate?.id ?? "", false);
  port.send(row.workspaceId, `Plan rejected — revise it: ${note}`);
  appendLog({ kind: "reject", name: row.name, note, ts: now() });
  out.write(`${s.yellow("↩")} ${s.bold(row.name)} back to planning: ${note}\n`);
  out.write(`${msg.hint(s, "next: captain status")}\n`);
};
