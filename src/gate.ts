// 100% PURE (lint-enforced: no fs/subprocess). A pending human gate, read
// straight from the cmux feed: the feed IS the gate inventory.

import type { CmuxFeedItem } from "./captain/control";

export interface Gate {
  // feed item id
  id: string;
  // the handle `cmux rpc feed.exit_plan.reply` takes: the item's request_id,
  // which is NOT its id. Absent on question gates (and on a cmux too old to
  // report one), and approve/reject refuse rather than guess.
  replyId?: string;
  kind: "plan" | "question";
  // what the gate is asking, so status shows it without opening the workspace
  hint?: string;
  // read off the agent's screen because its feed item expired (cmux drops an
  // unanswered item after about two minutes). No replyId: approve answers the
  // menu with a keypress instead.
  onScreen?: boolean;
}

// Feed kinds that gate on a human (cmux 0.64 WorkstreamKind raw values).
const GATE_KINDS = new Set([
  "exitPlan",
  "question",
  "notification",
  "permissionRequest",
]);

// macOS often reports `/var/...` on one side and `/private/var/...` on the
// other, plus trailing slashes. A strict === here is how a live plan reads as
// no gate at all.
const normalizeCwd = (path: string): string => {
  const trimmed = path.replace(/\/+$/u, "") || "/";
  return trimmed.startsWith("/private/")
    ? trimmed.slice("/private".length)
    : trimmed;
};

export const sameCwd = (left: string, right: string): boolean =>
  left === right || normalizeCwd(left) === normalizeCwd(right);

// The newest unresolved gating feed item for a worktree, matched by cwd, or by
// agent session when one is known: workers in a shared checkout share a cwd,
// and only the session tells their gates apart. `resolved_at` is set the
// moment an item is answered or expires, so its absence marks it pending.
// feed.list is chronological: the LAST match is live.
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
// feed item about two minutes after it lands, and the agent then waits on its
// TUI menu while the run-state tag can still read "Running", so without this a
// plan gate vanishes from the board and approve finds nothing to approve.
const PLAN_MENU = /Would you like to proceed\?/u;
const QUESTION_MENU = /Enter to select .*Esc to cancel/u;
// The bordered question text above a question menu: "│ <text>" lines.
const QUESTION_LINE = /^\s*│\s?(.*)$/u;

// Only the bottom of the screen counts: a menu that scrolled up is answered.
const screenTail = (screen: string): string[] => screen.split("\n").slice(-25);

// The gate an agent's screen shows when the feed no longer does.
export const screenGate = (screen: string): Gate | undefined => {
  const tail = screenTail(screen);
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

// May a keypress approve this plan menu? Only when the highlighted option is
// the bypass-permissions approval (the same mode `feed.exit_plan.reply` uses),
// so Enter can never pick a different answer.
export const screenPlanApprovable = (screen: string): boolean =>
  screenTail(screen).some((line) => /❯\s*1\.\s*Yes\b.*bypass/iu.test(line));
