import { basename } from "node:path";

import type { CmuxFeedItem, CmuxWorkspace, RunState } from "./control";
import type { Verdict } from "./verdict";
import { verdictCounts } from "./verdict";

// 100% PURE (lint-enforced: no fs/subprocess) — the fleet view derived from
// plain cmux + filesystem data. surface.ts gathers the inputs; this module
// decides what they mean. There is no persisted state: the worktrees, the cmux
// feed, and the verdict files ARE the state.

export type Group = "needs-you" | "in-flight" | "ready";

// A pending human gate, straight from the cmux feed (the feed IS the gate
// inventory — captain adds no state of its own on top).
export interface Gate {
  // feed item id — the handle `cmux rpc feed.exit_plan.reply` takes
  id: string;
  kind: "plan" | "question";
  // what the gate is asking, so status shows it without opening the workspace
  hint?: string;
}

// One workspace's live row in the fleet view.
export interface FleetRow {
  workspaceId: string;
  cwd: string;
  // friendly display name: "${repo}-${ticket}" when both derive, else the
  // workspace's own name
  name: string;
  repo?: string;
  ticket?: string;
  run: RunState;
  gate?: Gate;
  verdict?: "pass" | "fail";
  // the verifier's one-line summary, when a verdict exists
  summary?: string;
  prUrl?: string;
  group: Group;
  // the single executable next-action for this row (the same command the TTY
  // renderer leads with) — so a driver consuming --json acts without parsing
  // the human view. Always set by rowOf; optional only so hand-built test
  // fixtures stay terse.
  nextCommand?: string;
  // a deterministic fingerprint of this row's *actionable* state — a polling
  // driver diffs snapshots and acts only on transitions. A pure string join
  // (no crypto: the pure core may not import node:crypto). Always set by rowOf.
  stateHash?: string;
  // the unambiguous handle to pass to approve/reject: the bare ticket when it's
  // unique in the fleet, else the full `${repo}-${ticket}` name (the cross-repo
  // collision case — same ticket fanned into two repos). Set by withHandles
  // once the whole pool is known; never a workspace uuid.
  handle?: string;
}

// The canonical ticket id inside a name/path ("tig-494"), lowercased.
export const ticketFrom = (text: string): string | undefined => {
  const m = text.match(/([a-z]+-\d+)/iu);
  return m ? m[1].toLowerCase() : undefined;
};

// Stable identity for a worktree: ticket from the dir (or the workspace name)
// and a `${repo}-${ticket}` display name when both exist — so two worktrees of
// one repo never share a bare label and every row is addressable by ticket.
export const identityOf = (
  cwd: string,
  fallback: string,
  repo: string | undefined
): { name: string; repo?: string; ticket?: string } => {
  const ticket = ticketFrom(basename(cwd)) ?? ticketFrom(fallback);
  const name = repo && ticket ? `${repo}-${ticket}` : fallback;
  return { name, repo, ticket };
};

// PURE: collapse workspaces that share a cwd into the one that actually hosts
// the agent. cmux sidebar groups are anchored to a real workspace, and a
// group's anchor can be an idle shell spawned in a worktree's dir — without
// this it reads as a second row for that worktree and the overlap hints report
// the worktree conflicting with itself (closing the "duplicate" then dissolves
// the group). The agent workspace is the one `cmux top` tags with a run state;
// an anchor or stray shell has none. Ties keep the first listed.
export const pickAgentWorkspaces = (
  workspaces: CmuxWorkspace[],
  runs: Record<string, RunState>
): CmuxWorkspace[] => {
  const hasAgent = (w: CmuxWorkspace): boolean => w.id.toLowerCase() in runs;
  const byCwd = new Map<string, CmuxWorkspace>();
  for (const w of workspaces) {
    const prev = byCwd.get(w.cwd);
    if (!prev || (!hasAgent(prev) && hasAgent(w))) {
      byCwd.set(w.cwd, w);
    }
  }
  return workspaces.filter((w) => byCwd.get(w.cwd) === w);
};

// Feed kinds that gate on a human: a plan awaiting approval, or a question /
// notification the agent is blocked on.
const GATE_KINDS = new Set(["exitPlan", "question", "notification"]);

// The newest unresolved gating feed item for a worktree, matched by cwd (the
// cross-channel join key). `resolved_at` is set the moment an item is
// answered/expired, so its absence is the pending marker; feed.list is
// chronological, so the LAST match is the live gate.
export const pendingGate = (
  items: CmuxFeedItem[],
  cwd: string
): Gate | undefined => {
  const item = items.findLast(
    (f) => GATE_KINDS.has(f.kind) && f.cwd === cwd && !f.resolved_at
  );
  if (!item) {
    return undefined;
  }
  return {
    hint: item.question_prompt || item.text || undefined,
    id: item.id,
    kind: item.kind === "exitPlan" ? "plan" : "question",
  };
};

// Everything surface.ts gathers about one workspace.
export interface RowInput {
  workspaceId: string;
  cwd: string;
  // the workspace's own name (cmux description / dir basename)
  fallbackName: string;
  repo?: string;
  run: RunState;
  feed: CmuxFeedItem[];
  verdict?: Verdict | null;
  // the rubric's hash as it exists NOW — editing criteria after the verdict
  // voids it (undefined = no rubric on disk, accept the verdict as-is)
  expectedHash?: string;
}

// PURE: the single executable next-action for a row, matching what the TTY
// renderer leads with per group (format.ts's actionLines builds its primary
// line from this — ONE definition of the command string). cmux commands take
// the workspace UUID; the display name is not a valid handle.
//   plan gate    → captain approve <name>   (reject is the alternative)
//   question /
//   needs-input  → cmux read-screen … (inspect, then cmux send the answer)
//   ready        → the merge hint (gh pr merge <prUrl>) when a PR exists, else
//                  captain status --ready
//   in-flight    → cmux read-screen … to peek at the running agent
export const nextCommand = (row: FleetRow): string => {
  if (row.gate?.kind === "plan") {
    return `captain approve ${row.handle ?? row.ticket ?? row.name}`;
  }
  if (row.group === "needs-you") {
    return `cmux read-screen --workspace ${row.workspaceId}`;
  }
  if (row.group === "ready") {
    return row.prUrl
      ? `gh pr merge ${row.prUrl} --squash`
      : "captain status --ready";
  }
  return `cmux read-screen --workspace ${row.workspaceId}`;
};

// PURE: a deterministic fingerprint of the row's *actionable* state — the
// fields that decide whether a driver must act. A plain string join (the pure
// core may not import node:crypto); equal joins ⇒ same actionable state, so a
// poller can diff two snapshots and skip rows that haven't transitioned.
export const stateHash = (
  row: Pick<FleetRow, "group" | "gate" | "verdict" | "run">
): string =>
  [
    row.group,
    row.gate?.kind ?? "",
    row.gate?.id ?? "",
    row.verdict ?? "",
    row.run,
  ].join("|");

// The grouping rule — the whole "state machine" that's left:
//   a pending gate, a failed verdict, or an agent stuck on input → needs-you
//   a valid passing verdict → ready (the human merge gate stays authoritative)
//   otherwise → in-flight (working or idling)
export const rowOf = (input: RowInput): FleetRow => {
  const gate = pendingGate(input.feed, input.cwd);
  const verdict =
    input.verdict && verdictCounts(input.verdict, input.expectedHash)
      ? input.verdict
      : undefined;
  let group: Group = "in-flight";
  if (gate || verdict?.verdict === "fail") {
    group = "needs-you";
  } else if (verdict?.verdict === "pass") {
    group = "ready";
  } else if (input.run === "needs-input") {
    // the agent is blocked on input that never reached the feed (e.g. a raw
    // permission prompt) — still a "needs you", just without a hint
    group = "needs-you";
  }
  const row: FleetRow = {
    cwd: input.cwd,
    gate,
    group,
    // placeholders; filled below once the row's shape is known
    nextCommand: "",
    prUrl: verdict?.prUrl,
    run: input.run,
    stateHash: "",
    summary: verdict?.summary,
    verdict: verdict?.verdict,
    workspaceId: input.workspaceId,
    ...identityOf(input.cwd, input.fallbackName, input.repo),
  };
  row.nextCommand = nextCommand(row);
  row.stateHash = stateHash(row);
  return row;
};

// PURE: assign every row its unambiguous command handle. A bare ticket is a
// fine handle until the SAME ticket is fanned into two repos (TIG-424 →
// frontyard + ltfollowers): then `tig-424` addresses two worktrees and a
// silent first-match would resolve to the wrong one. Those colliding rows get
// the full `${repo}-${ticket}` name as their handle; tickets unique in the
// fleet keep the short form. This is the cross-repo answer instead of forcing a
// workspace uuid. nextCommand is recomputed so the displayed runbook command
// matches the handle resolveTargets will accept.
export const withHandles = (rows: FleetRow[]): FleetRow[] => {
  const ticketCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.ticket) {
      ticketCounts.set(r.ticket, (ticketCounts.get(r.ticket) ?? 0) + 1);
    }
  }
  return rows.map((r) => {
    const collides =
      Boolean(r.ticket) && (ticketCounts.get(r.ticket ?? "") ?? 0) > 1;
    const handle = collides ? r.name : (r.ticket ?? r.name);
    const withHandle: FleetRow = { ...r, handle };
    withHandle.nextCommand = nextCommand(withHandle);
    return withHandle;
  });
};

// PURE: pairwise changed-file overlap between ready worktrees OF THE SAME REPO
// (paths are repo-relative, so cross-repo "overlap" is meaningless). Two
// branches touching the same file will conflict at merge — surface the
// merge-order call instead of leaving it to be discovered by hand.
export const mergeOrderHints = (
  entries: {
    workspaceId: string;
    name: string;
    repo: string;
    files: string[];
  }[]
): Record<string, string> => {
  const hints: Record<string, string> = {};
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i];
      const b = entries[j];
      if (a.repo !== b.repo) {
        continue;
      }
      const shared = a.files.filter((f) => b.files.includes(f));
      if (shared.length === 0) {
        continue;
      }
      const files =
        shared.length > 2
          ? `${shared.slice(0, 2).join(", ")} (+${shared.length - 2} more)`
          : shared.join(", ");
      hints[a.workspaceId] ??=
        `overlaps ${b.name} on ${files} — merge one, rebase the other`;
      hints[b.workspaceId] ??=
        `overlaps ${a.name} on ${files} — merge one, rebase the other`;
    }
  }
  return hints;
};
