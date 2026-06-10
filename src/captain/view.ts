import { basename } from "node:path";

import type { CmuxFeedItem, RunState } from "./control";
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
  return {
    cwd: input.cwd,
    gate,
    group,
    prUrl: verdict?.prUrl,
    run: input.run,
    summary: verdict?.summary,
    verdict: verdict?.verdict,
    workspaceId: input.workspaceId,
    ...identityOf(input.cwd, input.fallbackName, input.repo),
  };
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
