import { runningPid, watcherHealth } from "./daemon";
import {
  DEFAULT_STALE_SECS,
  groupOf,
  msg,
  renderAudit,
  renderStatus,
  repoOf,
  style,
  useColor,
} from "./format";
import type { Style } from "./format";
import { readHistory } from "./history";
import { appendIntent } from "./intents";
import { DEFAULT_FLEET, loadState, now } from "./state";
import type { FleetState, HistoryRecord, Worktree } from "./types";

const styleFor = (out: NodeJS.WritableStream): Style => style(useColor(out));

// Resolve a user-friendly target spec to worktrees. Accepts "all", a repo label
// ("linkiq" → every gated worktree of that repo), or a comma-separated list of
// ticket names ("tig-430"), substrings, or workspace ids — never a pasted uuid.
export const resolveTargets = (
  state: FleetState,
  spec: string,
  stage: Worktree["stage"]
): { matched: Worktree[]; unknown: string[] } => {
  const pool = Object.values(state.worktrees).filter((w) => w.stage === stage);
  if (spec === "all") {
    return { matched: pool, unknown: [] };
  }
  const matched: Worktree[] = [];
  const unknown: string[] = [];
  const push = (hit: Worktree): void => {
    if (!matched.includes(hit)) {
      matched.push(hit);
    }
  };
  for (const raw of spec.split(",")) {
    const token = raw.trim().toLowerCase();
    if (!token) {
      continue;
    }
    // A repo label addresses the whole repo's gated batch at once.
    const repoHits = pool.filter((w) => repoOf(w).toLowerCase() === token);
    if (repoHits.length > 0) {
      for (const hit of repoHits) {
        push(hit);
      }
      continue;
    }
    const hit = pool.find(
      (w) =>
        w.workspaceId.toLowerCase() === token ||
        w.name.toLowerCase() === token ||
        w.name.toLowerCase().includes(token)
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
  // include long-parked stale gates instead of folding them into a count
  all?: boolean;
}

// How long a human gate sits unanswered before status folds it away as stale.
const staleSecsFrom = (env: NodeJS.ProcessEnv): number =>
  Number(env.CAPTAIN_STALE_SECS) || DEFAULT_STALE_SECS;

// The one read surface: a watcher-health header, then worktrees grouped with the
// few that need a decision on top — each carrying its inline resolve command.
// --repo/--needs/--ready narrow the view; --all unfolds stale gates.
export const status = (
  options: StatusOptions,
  out: NodeJS.WritableStream
): void => {
  let rows = Object.values(loadState(DEFAULT_FLEET).worktrees);
  if (options.repo) {
    const token = options.repo.trim().toLowerCase();
    rows = rows.filter((w) => repoOf(w).toLowerCase().includes(token));
  }
  if (options.needs) {
    rows = rows.filter((w) => groupOf(w.stage) === "needs-you");
  }
  if (options.ready) {
    rows = rows.filter((w) => groupOf(w.stage) === "ready");
  }
  if (options.json) {
    out.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  out.write(
    renderStatus(rows, styleFor(out), watcherHealth(DEFAULT_FLEET), {
      all: options.all,
      staleSecs: staleSecsFrom(process.env),
    })
  );
};

// Parse a coarse duration like "90m", "2h", "1d", "1h30m" → seconds
// (undefined if nothing parses, so a typo'd --since is a no-op, not a crash).
const parseSince = (spec: string): number | undefined => {
  const units: Record<string, number> = { d: 86_400, h: 3600, m: 60, s: 1 };
  let total = 0;
  let matched = false;
  for (const m of spec.matchAll(/(\d+)\s*([dhms])/giu)) {
    total += Number(m[1]) * units[m[2].toLowerCase()];
    matched = true;
  }
  return matched ? total : undefined;
};

export interface AuditFilter {
  since?: string;
  ref?: string;
}

// Pure filter for the audit trail: recency window (--since) and/or a worktree
// (--ref, by friendly ticket substring or workspace id). Kept pure of fs/clock so
// the slicing is unit-testable; `audit` feeds it the real log + clock.
export const filterHistory = (
  records: HistoryRecord[],
  filter: AuditFilter,
  nowSec: number
): HistoryRecord[] => {
  let out = records;
  if (filter.since) {
    const secs = parseSince(filter.since);
    if (secs !== undefined) {
      const cutoff = nowSec - secs;
      out = out.filter((r) => r.ts >= cutoff);
    }
  }
  if (filter.ref) {
    const token = filter.ref.trim().toLowerCase();
    out = out.filter(
      (r) =>
        r.workspaceId.toLowerCase() === token ||
        r.name.toLowerCase().includes(token)
    );
  }
  return out;
};

// The governance trail: the append-only history rendered chronologically,
// optionally narrowed to a recency window or a single worktree.
export const audit = (
  filter: AuditFilter & { json?: boolean },
  out: NodeJS.WritableStream
): void => {
  const records = filterHistory(readHistory(DEFAULT_FLEET), filter, now());
  if (filter.json) {
    out.write(`${JSON.stringify(records, null, 2)}\n`);
    return;
  }
  out.write(renderAudit(records, styleFor(out)));
};

// Approve plan(s): reply to the cmux exit-plan feed item, then mark IMPLEMENTING
// A queued intent only takes effect when a watcher drains it; warn if none is up.
const warnIfNoWatcher = (out: NodeJS.WritableStream, s: Style): void => {
  if (!runningPid(DEFAULT_FLEET)) {
    out.write(
      s.dim("  (no watcher running — queued; it applies when one starts)\n")
    );
  }
};

// so the next Stop auto-advances. `spec` = "all" or ticket names / ids.
//
// The CLI never writes state.json — that's the watcher's job alone (no two-writer
// race). It appends an `approve` intent per target; the watcher drains the log,
// replies to the cmux plan gate, and advances the worktree to IMPLEMENTING. If no
// watcher is running, the intent is queued and applied the moment one starts.
export const approve = (spec: string, out: NodeJS.WritableStream): void => {
  const s = styleFor(out);
  const state = loadState(DEFAULT_FLEET);
  const { matched, unknown } = resolveTargets(state, spec, "PLAN_READY");
  for (const u of unknown) {
    out.write(`  ${msg.warn(s, `no plan-ready worktree matches "${u}"`)}\n`);
  }
  if (matched.length === 0) {
    out.write(s.dim("nothing to approve.\n"));
    return;
  }
  for (const wt of matched) {
    appendIntent(DEFAULT_FLEET, {
      kind: "approve",
      ts: now(),
      workspaceId: wt.workspaceId,
    });
    out.write(`${msg.ok(s, `approved ${s.bold(wt.name)} → implementing`)}\n`);
  }
  warnIfNoWatcher(out, s);
  out.write(`${msg.hint(s, "next: captain status")}\n`);
};

// Reject a plan: queue a `reject` intent with the revision feedback. The watcher
// replies to the plan gate with the note and sends the worktree back to PLANNING.
export const reject = (
  ref: string,
  note: string,
  out: NodeJS.WritableStream
): void => {
  const s = styleFor(out);
  const state = loadState(DEFAULT_FLEET);
  const { matched } = resolveTargets(state, ref, "PLAN_READY");
  const [wt] = matched;
  if (!wt) {
    out.write(`${msg.warn(s, `no plan-ready worktree matches "${ref}"`)}\n`);
    return;
  }
  appendIntent(DEFAULT_FLEET, {
    kind: "reject",
    note,
    ts: now(),
    workspaceId: wt.workspaceId,
  });
  out.write(`${s.yellow("↩")} ${s.bold(wt.name)} back to planning: ${note}\n`);
  warnIfNoWatcher(out, s);
  out.write(`${msg.hint(s, "next: captain status")}\n`);
};
