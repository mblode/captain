import { basename } from "node:path";

import type { CmuxFeedItem, CmuxWorkspace, RunState } from "./control";
import type { Smoke } from "./smoke";
import type { Verdict } from "./verdict";
import { verdictCounts } from "./verdict";

// 100% PURE (lint-enforced: no fs/subprocess) — the fleet view derived from
// plain cmux + filesystem data. surface.ts gathers the inputs; this module
// decides what they mean. There is no persisted state: the worktrees, the cmux
// feed, and the verdict files ARE the state.

export type Group = "needs-you" | "in-flight" | "ready" | "shipping" | "done";

// A pending human gate, straight from the cmux feed (the feed IS the gate
// inventory — captain adds no state of its own on top).
export interface Gate {
  // feed item id — this workspace's gate identity (dedup/display)
  id: string;
  // the handle `cmux rpc feed.exit_plan.reply` takes: the item's request_id,
  // which is NOT its id. Absent on question gates (and on a cmux too old to
  // report one) — approve/reject refuse rather than guess.
  replyId?: string;
  kind: "plan" | "question";
  // what the gate is asking, so status shows it without opening the workspace
  hint?: string;
  // read off the agent's screen because its feed item expired (cmux drops an
  // unanswered item after ~2 minutes). No replyId: approve answers the menu
  // with a keypress instead.
  onScreen?: boolean;
}

// One workspace's live row in the fleet view.
export interface FleetRow {
  workspaceId: string;
  cwd: string;
  // the OpenSpec change this row runs, for rows in a shared checkout
  change?: string;
  // friendly display name: "${repo}-${ticket}" when both derive, else the
  // workspace's own name
  name: string;
  repo?: string;
  ticket?: string;
  run: RunState;
  gate?: Gate;
  verdict?: "pass" | "fail";
  // the production check after the merge (an OpenSpec change's smoke.json)
  smoke?: Smoke["status"];
  // the smoke test's one-line summary when there is one, else the verifier's
  summary?: string;
  prUrl?: string;
  // the ticket's subject, read from the worktree's rubric — so a row reads as
  // more than `linkiq-tig-1229`. Absent for a free-form dispatch (no issue) and
  // for any worktree whose rubric is gone.
  title?: string;
  group: Group;
  // the single executable next-action for this row (the same command the TTY
  // renderer leads with) — so a driver consuming --json acts without parsing
  // the human view. Always set by rowOf; optional only so hand-built test
  // fixtures stay terse.
  nextCommand?: string;
  // a deterministic fingerprint of this row's *actionable* state — a polling
  // driver diffs snapshots and acts only on transitions. A pure string join
  // (a plain join, not a digest: this is compared for equality, never stored or
  // transmitted, so hashing would only make it unreadable). Always set by rowOf.
  stateHash?: string;
  // the unambiguous handle to pass to approve/reject: the bare ticket when it's
  // unique in the fleet, else the full `${repo}-${ticket}` name (the cross-repo
  // collision case — same ticket fanned into two repos). Set by withHandles
  // once the whole pool is known; never a workspace uuid.
  handle?: string;
}

// The canonical ticket id inside a name/path ("tig-494"), lowercased. A donebear
// id (`db-<hex>`) is matched FIRST: a donebear worktree dir carries the repo name
// as a prefix ("donebear-db-35a2097c"), and the Linear pattern would otherwise
// greedily match the "donebear-35" boundary and return a bogus partial. The
// donebear pattern anchors on the `db-` prefix, so it can't collide that way.
//
// SOURCE SEAM: the `db-` shape is donebear-specific knowledge (see source.ts /
// donebear.ts). It lives inline here rather than in the registry on purpose —
// the pure core (lint-enforced no-fs/subprocess) may not import the fetch-side
// source modules. A third source's id shape would extend this list.
export const ticketFrom = (text: string): string | undefined => {
  const db = text.match(/db-[0-9a-f]{6,}/iu);
  if (db) {
    return db[0].toLowerCase();
  }
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

// OpenSpec changes share one checkout, so the description (the change id) is
// part of a workspace's key; worktree workspaces carry none and key by cwd.
const keyOf = (w: CmuxWorkspace): string => `${w.cwd}\0${w.description ?? ""}`;

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
  const byKey = new Map<string, CmuxWorkspace>();
  for (const w of workspaces) {
    const prev = byKey.get(keyOf(w));
    if (!prev || (!hasAgent(prev) && hasAgent(w))) {
      byKey.set(keyOf(w), w);
    }
  }
  return workspaces.filter((w) => byKey.get(keyOf(w)) === w);
};

// Feed kinds that gate on a human. Wire names are WorkstreamKind raw values
// (cmux 0.64): exitPlan, question, permissionRequest. `notification` is kept
// because older feed.list payloads used it; current cmux maps that hook to
// telemetry, so it is harmless if absent.
const GATE_KINDS = new Set([
  "exitPlan",
  "question",
  "notification",
  "permissionRequest",
]);

// Worktree cwd vs feed.cwd: macOS often reports `/var/...` on one side and
// `/private/var/...` on the other. Trailing slashes too. A strict === here is
// how a live plan reads as gate=None.
const normalizeCwd = (path: string): string => {
  const trimmed = path.replace(/\/+$/u, "") || "/";
  return trimmed.startsWith("/private/")
    ? trimmed.slice("/private".length)
    : trimmed;
};

const sameCwd = (left: string, right: string): boolean =>
  left === right || normalizeCwd(left) === normalizeCwd(right);

// The newest unresolved gating feed item for a worktree, matched by cwd (the
// cross-channel join key) — or by agent session when one is known, because
// OpenSpec changes share a cwd and only the session tells their gates apart. `resolved_at` is set the moment an item is
// answered/expired, so its absence is the pending marker; feed.list is
// chronological, so the LAST match is the live gate.
export const pendingGate = (
  items: CmuxFeedItem[],
  cwd: string,
  session?: string
): Gate | undefined => {
  const item = items.findLast(
    (f) =>
      GATE_KINDS.has(f.kind) &&
      (session ? f.session === session : sameCwd(f.cwd, cwd)) &&
      !f.resolved_at
  );
  if (!item) {
    return undefined;
  }
  return {
    hint: item.question_prompt || item.text || undefined,
    id: item.id,
    kind: item.kind === "exitPlan" ? "plan" : "question",
    replyId: item.request_id,
  };
};

// Claude Code's own menus, as `cmux read-screen` renders them. cmux expires a
// feed item ~2 minutes after it lands, and the agent then waits on its TUI
// menu while the run-state tag can still read "Running" — so without this the
// plan gate vanishes from status and approve reports "no plan-ready worktree".
const PLAN_MENU = /Would you like to proceed\?/u;
const QUESTION_MENU = /Enter to select .*Esc to cancel/u;
// The bordered question text above a question menu: "│ <text>" lines.
const QUESTION_LINE = /^\s*│\s?(.*)$/u;

// PURE: the gate an agent's screen shows when the feed no longer does. Only the
// bottom of the screen counts: a menu that scrolled up is already answered.
export const screenGate = (screen: string): Gate | undefined => {
  const tail = screen.split("\n").slice(-25);
  const text = tail.join("\n");
  if (PLAN_MENU.test(text)) {
    return {
      hint: "plan approval",
      id: "screen",
      kind: "plan",
      onScreen: true,
    };
  }
  if (QUESTION_MENU.test(text)) {
    const hint = tail
      .map((line) => QUESTION_LINE.exec(line)?.[1].trim() ?? "")
      .filter(Boolean)
      .join(" ");
    return {
      hint: hint || undefined,
      id: "screen",
      kind: "question",
      onScreen: true,
    };
  }
  return undefined;
};

// PURE: may a keypress approve this plan menu? Only when the highlighted
// option is the bypass-permissions approval — the same mode
// `feed.exit_plan.reply` uses — so Enter can never pick a different answer.
export const screenPlanApprovable = (screen: string): boolean =>
  screen
    .split("\n")
    .slice(-25)
    .some((line) => /❯\s*1\.\s*Yes\b.*bypass/iu.test(line));

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
  smoke?: Smoke | null;
  // the rubric's hash as it exists NOW — editing criteria after the verdict
  // voids it (undefined = no rubric on disk, accept the verdict as-is)
  expectedHash?: string;
  // the ticket's subject, from the same rubric read as expectedHash
  title?: string;
  // an OpenSpec change: its id (the ticket) and its agent's session id (the
  // gate join key). Worktree rows derive the ticket from the cwd instead.
  ticket?: string;
  session?: string;
  // the agent's screen, read only when the feed shows no gate for it
  screen?: string;
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
//   in-flight /
//   shipping /
//   done         → cmux read-screen … to peek at the agent
export const nextCommand = (row: FleetRow): string => {
  if (row.gate?.kind === "plan") {
    return `captain approve ${row.handle ?? row.ticket ?? row.name}`;
  }
  if (row.group === "ready") {
    return row.prUrl
      ? `gh pr merge ${row.prUrl} --squash`
      : "captain status --ready";
  }
  return `cmux read-screen --workspace ${row.workspaceId}`;
};

// PURE: a deterministic fingerprint of the row's *actionable* state — the fields
// that decide whether a driver must act. A plain string join rather than a
// digest: nothing stores or transmits this, it is only compared to the previous
// tick, and a readable join is debuggable where a hash is not. (Purity does not
// forbid node:crypto — rubric.ts hashes; see oxlint.config.ts for the one
// definition.) Equal joins ⇒ same actionable state, so a poller can diff two
// snapshots and skip rows that haven't transitioned.
export const stateHash = (
  row: Pick<FleetRow, "group" | "gate" | "verdict" | "smoke" | "run">
): string =>
  [
    row.group,
    row.gate?.kind ?? "",
    row.gate?.id ?? "",
    row.verdict ?? "",
    row.smoke ?? "",
    row.run,
  ].join("|");

// The grouping rule — the whole "state machine" that's left:
//   a pending gate, a failed verdict or smoke test, or an agent stuck on
//   input → needs-you
//   a passing smoke test → done (merged, deployed and verified in production)
//   a smoke test running → shipping (merged; the worker is checking production)
//   a valid passing verdict → ready (the human merge gate stays authoritative)
//   otherwise → in-flight (working or idling)
// A smoke result counts only on top of a passing verdict that counts.
const groupOf = (
  gate: Gate | undefined,
  verdict: Verdict | undefined,
  smoke: Smoke | undefined,
  run: RunState
): Group => {
  if (gate || verdict?.verdict === "fail" || smoke?.status === "fail") {
    return "needs-you";
  }
  if (smoke?.status === "pass") {
    return "done";
  }
  if (smoke?.status === "running") {
    return run === "needs-input" ? "needs-you" : "shipping";
  }
  if (verdict?.verdict === "pass") {
    return "ready";
  }
  // the agent is blocked on input that never reached the feed (e.g. a raw
  // permission prompt) — still a "needs you", just without a hint
  return run === "needs-input" ? "needs-you" : "in-flight";
};

export const rowOf = (input: RowInput): FleetRow => {
  const gate =
    pendingGate(input.feed, input.cwd, input.session) ??
    (input.screen ? screenGate(input.screen) : undefined);
  const verdict =
    input.verdict && verdictCounts(input.verdict, input.expectedHash)
      ? input.verdict
      : undefined;
  const smoke =
    verdict?.verdict === "pass" ? (input.smoke ?? undefined) : undefined;
  const group = groupOf(gate, verdict, smoke, input.run);
  const row: FleetRow = {
    change: input.ticket,
    cwd: input.cwd,
    gate,
    group,
    // placeholders; filled below once the row's shape is known
    nextCommand: "",
    prUrl: verdict?.prUrl,
    run: input.run,
    smoke: smoke?.status,
    stateHash: "",
    summary: smoke?.summary || verdict?.summary,
    title: input.title,
    verdict: verdict?.verdict,
    workspaceId: input.workspaceId,
    ...(input.ticket
      ? {
          name: input.repo ? `${input.repo}-${input.ticket}` : input.ticket,
          repo: input.repo,
          ticket: input.ticket,
        }
      : identityOf(input.cwd, input.fallbackName, input.repo)),
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

// PURE: the per-group tally over a row set — the single definition the summary
// headline, the status/summary renderers, and the gain fleet block all share
// (the keys match status --summary's `counts`). A `total` is just rows.length,
// left to whichever caller needs it.
export const groupCounts = (
  rows: FleetRow[]
): {
  needsYou: number;
  inFlight: number;
  ready: number;
  shipping: number;
  done: number;
} => ({
  done: rows.filter((r) => r.group === "done").length,
  inFlight: rows.filter((r) => r.group === "in-flight").length,
  needsYou: rows.filter((r) => r.group === "needs-you").length,
  ready: rows.filter((r) => r.group === "ready").length,
  shipping: rows.filter((r) => r.group === "shipping").length,
});

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
