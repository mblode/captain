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

// The newest unresolved gating feed item for a worktree, matched by cwd.
// `resolved_at` is set the moment an item is answered or expires, so its
// absence marks it pending. feed.list is chronological: the LAST match is live.
export const pendingGate = (
  items: CmuxFeedItem[],
  cwd: string
): Gate | undefined => {
  const item = items.findLast(
    (f) => GATE_KINDS.has(f.kind) && sameCwd(f.cwd, cwd) && !f.resolved_at
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
