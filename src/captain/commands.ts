import { CliError, EXIT } from "../errors";
import { run } from "../shell";
import { realCmux } from "./control";
import type { CmuxPort } from "./control";
import {
  msg,
  renderGain,
  renderStatus,
  renderSummary,
  style,
  useColor,
} from "./format";
import type { Style } from "./format";
import { computeGain, parseSince } from "./gain";
import { appendLog, now, readLog } from "./log";
import { fleetRows, readVerdict } from "./surface";
import type { Verdict } from "./verdict";
import { groupCounts, mergeOrderHints, ticketFrom } from "./view";
import type { FleetRow } from "./view";

const styleFor = (out: NodeJS.WritableStream): Style => style(useColor(out));

// A token that loosely matched more than one worktree (the same ticket fanned
// into two repos). We refuse to guess; `candidates` are the fully-qualified
// `${repo}-${ticket}` names to retype.
export interface Ambiguity {
  token: string;
  candidates: string[];
}

export interface ResolvedTargets {
  matched: FleetRow[];
  unknown: string[];
  ambiguous: Ambiguity[];
}

// Resolve a user-friendly target spec to rows. Accepts "all", a repo label
// ("linkiq" → every matching row in the pool), or a comma-separated list of
// fully-qualified names ("frontyard-tig-424"), bare tickets ("tig-430"),
// substrings, or workspace ids — never a pasted uuid.
//
// Cross-repo collisions resolve natively: a fully-qualified name or a workspace
// id always picks exactly one row, so it disambiguates a ticket that runs in
// two repos. A bare/substring token that hits more than one worktree is
// reported as `ambiguous` (with the qualified names to retype) instead of being
// silently first-matched to the wrong one.
export const resolveTargets = (
  pool: FleetRow[],
  spec: string
): ResolvedTargets => {
  if (spec === "all") {
    return { ambiguous: [], matched: pool, unknown: [] };
  }
  const matched: FleetRow[] = [];
  const unknown: string[] = [];
  const ambiguous: Ambiguity[] = [];
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
    // A fully-qualified handle — the `${repo}-${ticket}` name or a workspace id
    // — resolves to exactly one row. This is how you target one of several
    // worktrees that share a ticket across repos, no uuid needed.
    const exact = pool.find(
      (r) =>
        r.workspaceId.toLowerCase() === token || r.name.toLowerCase() === token
    );
    if (exact) {
      push(exact);
      continue;
    }
    // A bare ticket ("tig-1") resolves by EXACT ticket, never a substring —
    // otherwise `tig-1` would silently approve `tig-10` (and with both present,
    // exact `tig-1` was wrongly refused as ambiguous). Unique → take it; the
    // same ticket fanned into two repos → ambiguous, qualify with the repo.
    if (ticketFrom(token) === token) {
      const ticketHits = pool.filter((r) => r.ticket?.toLowerCase() === token);
      if (ticketHits.length === 1) {
        push(ticketHits[0]);
      } else if (ticketHits.length > 1) {
        ambiguous.push({
          candidates: ticketHits.map((r) => r.name),
          token: raw.trim(),
        });
      } else {
        unknown.push(raw.trim());
      }
      continue;
    }
    // Otherwise a loose substring — a name fragment or a partial workspace id
    // (not a ticket, so no `tig-1`/`tig-10` bleed): unique → take it, colliding
    // → refuse to guess and report the qualified names.
    const loose = pool.filter(
      (r) =>
        r.name.toLowerCase().includes(token) ||
        r.workspaceId.toLowerCase().includes(token)
    );
    if (loose.length === 1) {
      push(loose[0]);
    } else if (loose.length > 1) {
      ambiguous.push({
        candidates: loose.map((r) => r.name),
        token: raw.trim(),
      });
    } else {
      unknown.push(raw.trim());
    }
  }
  return { ambiguous, matched, unknown };
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
  // --watch: a stateless foreground live view that re-renders on a timer. NOT a
  // daemon — it holds no state, every tick re-derives the fleet from scratch
  // (same as re-running `status`), and Ctrl-C ends it. The agent driver does
  // NOT use this; its heartbeat is a backgrounded sleep that re-invokes its turn
  // (see the captain skill). This is purely the human's terminal view.
  watch?: boolean;
  // --watch poll interval in seconds (default 5). Ignored without --watch.
  interval?: number;
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

// Probe cmux BEFORE deriving anything: a dead daemon makes every list/feed call
// fail soft to empty, which a driver would read as "all done". On an
// unreachable daemon this writes a structured error with a dedicated exit code
// and returns true so the caller bails, instead of rendering a phantom-empty
// fleet. Shared by `status` and `gain`.
const cmuxUnreachable = (
  port: CmuxPort,
  options: { json?: boolean },
  out: NodeJS.WritableStream
): boolean => {
  if (port.reachable()) {
    return false;
  }
  process.exitCode = EXIT.CMUX_UNREACHABLE;
  const message =
    "cmux is not reachable — is it running? run 'captain install'";
  if (options.json) {
    out.write(
      `${JSON.stringify({ error: { message, type: "CMUX_UNREACHABLE" } })}\n`
    );
  } else {
    out.write(`${msg.err(styleFor(out), message)}\n`);
  }
  return true;
};

// The one read surface: the fleet view derived live from cmux + the worktrees,
// grouped with the few that need a decision on top — each carrying its inline
// resolve command. --repo/--needs/--ready narrow the view. One independent,
// stateless derivation per call.
const statusOnce = (
  options: StatusOptions,
  out: NodeJS.WritableStream,
  port: CmuxPort = realCmux(process.env)
): void => {
  if (cmuxUnreachable(port, options, out)) {
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

// The status entry point. Without --watch it derives the view once and returns
// (the machine/one-shot path every script and the agent driver use). With
// --watch it re-renders on a timer for a human watching a terminal — a
// stateless foreground loop, NOT a daemon: it persists nothing, every tick is
// an independent `statusOnce`, and Ctrl-C (SIGINT) ends it. Returns a stop()
// handle in watch mode so callers/tests can tear the loop down deterministically.
export const status = (
  options: StatusOptions,
  out: NodeJS.WritableStream,
  port: CmuxPort = realCmux(process.env)
): (() => void) | undefined => {
  if (!options.watch) {
    statusOnce(options, out, port);
    return undefined;
  }
  const seconds =
    typeof options.interval === "number" &&
    Number.isFinite(options.interval) &&
    options.interval > 0
      ? options.interval
      : 5;
  const isTty = (out as Partial<NodeJS.WriteStream>).isTTY === true;
  const render = (): void => {
    // Clear+home on a TTY so each tick repaints in place; on a pipe just append.
    if (isTty) {
      out.write("\u001B[2J\u001B[H");
    }
    out.write(
      `${styleFor(out).dim(`captain status — watching every ${seconds}s · Ctrl-C to exit`)}\n`
    );
    statusOnce(options, out, port);
  };
  // Paint immediately, then again on each tick.
  render();
  const handle = setInterval(render, seconds * 1000);
  const onSigint = (): void => {
    clearInterval(handle);
    out.write("\n");
    process.exit(0);
  };
  process.on("SIGINT", onSigint);
  return (): void => {
    clearInterval(handle);
    process.removeListener("SIGINT", onSigint);
  };
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
  const { matched, unknown, ambiguous } = resolveTargets(planGated(port), spec);
  // A fully-unresolvable ref under --json is a usage error, not an empty
  // success — surface it as a structured {error} (exit 2) so a driver can tell
  // "I typed a bad ref" apart from "there was nothing to approve". An ambiguous
  // ref is the same class of usage error: it never picks one silently. A
  // partial match still succeeds (the good refs are approved, the rest
  // reported).
  if (
    options.json &&
    matched.length === 0 &&
    (unknown.length > 0 || ambiguous.length > 0)
  ) {
    const parts = [
      unknown.length > 0
        ? `no plan-ready worktree matches: ${unknown.join(", ")}`
        : "",
      ...ambiguous.map(
        (a) =>
          `"${a.token}" is ambiguous — qualify it: ${a.candidates.join(", ")}`
      ),
    ].filter(Boolean);
    throw new CliError(parts.join("; "), EXIT.USAGE, "BAD_REF");
  }
  // The reply IS the approval (no state), so do it regardless of output mode.
  for (const row of matched) {
    port.replyExitPlan(row.gate?.id ?? "", true);
    appendLog({ kind: "approve", name: row.name, ts: now() });
  }
  if (options.json) {
    out.write(
      `${JSON.stringify({ ambiguous, approved: matched.map((r) => r.name), unknown })}\n`
    );
    return;
  }
  const s = styleFor(out);
  for (const a of ambiguous) {
    out.write(
      `  ${msg.warn(s, `"${a.token}" matches ${a.candidates.length} worktrees — qualify it: ${a.candidates.join(", ")}`)}\n`
    );
  }
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
  const { matched, ambiguous, unknown } = resolveTargets(planGated(port), ref);
  // Reject every matched worktree (a repo label / comma list resolves to many),
  // mirroring approve. Deliver the feedback FIRST (best-effort) per row: if we
  // rejected first and the send then threw, the plan would be back in planning
  // with the agent never told why. Sending first means a failed send still lets
  // the rejection through — we flag the ones whose reason didn't land so the
  // human can re-send them.
  const rejected: string[] = [];
  const undelivered: string[] = [];
  for (const row of matched) {
    let feedbackDelivered = true;
    try {
      port.send(row.workspaceId, `Plan rejected — revise it: ${note}`);
    } catch {
      feedbackDelivered = false;
    }
    port.replyExitPlan(row.gate?.id ?? "", false);
    appendLog({ kind: "reject", name: row.name, note, ts: now() });
    rejected.push(row.name);
    if (!feedbackDelivered) {
      undelivered.push(row.name);
    }
  }
  if (options.json) {
    out.write(
      `${JSON.stringify({ ambiguous, note, rejected, undelivered, unknown })}\n`
    );
    return;
  }
  // An ambiguous ref (a ticket shared across repos) gets the qualified names to
  // retype; an unknown ref is reported too — every unresolved token, not just
  // the first.
  for (const a of ambiguous) {
    out.write(
      `  ${msg.warn(s, `"${a.token}" matches ${a.candidates.length} worktrees — qualify it: ${a.candidates.join(", ")}`)}\n`
    );
  }
  for (const u of unknown) {
    out.write(`  ${msg.warn(s, `no plan-ready worktree matches "${u}"`)}\n`);
  }
  if (rejected.length === 0) {
    out.write(s.dim("nothing to reject.\n"));
    return;
  }
  for (const name of rejected) {
    out.write(`${s.yellow("↩")} ${s.bold(name)} back to planning: ${note}\n`);
  }
  for (const name of undelivered) {
    out.write(
      `  ${msg.warn(s, `couldn't deliver the feedback to ${name} — re-send it manually`)}\n`
    );
  }
  out.write(`${msg.hint(s, "next: captain status")}\n`);
};

export interface GainOptions {
  json?: boolean;
  // a "since" window for the decision-based metrics: "7d" / "24h" / ISO date
  since?: string;
  // opt in to the gh/git merged-PR approximation (one call per unique repo)
  git?: boolean;
}

// Per-row valid verdicts for the criteria-level detail. `row.verdict` is only
// set by rowOf when the on-disk verdict already passed the hash-check against
// the rubric as it exists NOW, so the row itself is the validity gate — no need
// to re-read the rubric and re-run verdictCounts here. We still read the raw
// verdict for its criteria (the row carries only the pass/fail label).
const validVerdicts = (
  rows: FleetRow[]
): { repo?: string; verdict: Verdict }[] => {
  const out: { repo?: string; verdict: Verdict }[] = [];
  for (const row of rows) {
    if (!row.verdict) {
      continue;
    }
    const verdict = readVerdict(row.cwd);
    if (verdict) {
      out.push({ repo: row.repo, verdict });
    }
  }
  return out;
};

// The opt-in --git approximation: per unique repo, count merged PRs via `gh`.
// Fail-soft per repo (gh missing / not authed / non-repo → skipped), so a
// partial answer beats an error, and CI without gh just omits the block. Lives
// in this edge, never in the pure gain.ts.
const mergedCounts = (
  rows: FleetRow[],
  env: NodeJS.ProcessEnv
): { repo: string; count: number }[] => {
  const byRepo = new Map<string, string>();
  for (const row of rows) {
    if (row.repo && !byRepo.has(row.repo)) {
      byRepo.set(row.repo, row.cwd);
    }
  }
  const counts: { repo: string; count: number }[] = [];
  for (const [repo, cwd] of byRepo) {
    const res = run(
      "gh",
      ["pr", "list", "--state", "merged", "--limit", "100", "--json", "number"],
      { cwd, env }
    );
    if (res.status !== 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(res.stdout) as unknown[];
      if (Array.isArray(parsed)) {
        counts.push({ count: parsed.length, repo });
      }
    } catch {
      // gh returned non-JSON (e.g. an auth nudge on stdout) — skip this repo
    }
  }
  return counts;
};

// Stateless fleet telemetry: every metric derived ON DEMAND from the decision
// log (the one gap-free ledger), the live cmux fleet, and the verdict files —
// no daemon, no persisted counter, no event stream. The honesty caveats name
// exactly what each number is so a snapshot is never read as a trend.
export const gain = (
  options: GainOptions,
  out: NodeJS.WritableStream,
  port: CmuxPort = realCmux(process.env)
): void => {
  // Probe cmux first — same reason as `status`: a dead daemon fails every
  // list/feed call soft to empty, which would read as an honest "empty fleet".
  if (cmuxUnreachable(port, options, out)) {
    return;
  }
  const { env } = process;
  const rows = fleetRows(port);
  const at = now();
  const metrics = computeGain({
    decisions: readLog(env),
    merged: options.git ? mergedCounts(rows, env) : undefined,
    now: at,
    rows,
    since: parseSince(options.since, at),
    verdicts: validVerdicts(rows),
  });
  if (options.json) {
    out.write(`${JSON.stringify(metrics, null, 2)}\n`);
    return;
  }
  out.write(renderGain(metrics, styleFor(out)));
};
