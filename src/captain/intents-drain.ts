import { commit, persist } from "./commit";
import type { WatchOptions } from "./commit";
import { readIntentsFrom } from "./intents";
import { onPlanApproved } from "./pipeline";
import { DEFAULT_FLEET } from "./state";
import type { FleetState, Intent } from "./types";

// Apply one queued human decision from the intent log. `approve`/`reject` run in
// a separate CLI process and only ever APPEND intents — the watcher (sole writer
// of state.json) is what actually replies to the cmux plan gate and moves the
// stage, so the two never race. Guarded on PLAN_READY so a duplicate or stale
// intent is a no-op rather than yanking an already-implementing worktree
// backward.
export const applyIntent = (
  state: FleetState,
  intent: Intent,
  opts: WatchOptions
): void => {
  const wt = state.worktrees[intent.workspaceId];
  if (!wt || wt.stage !== "PLAN_READY") {
    return;
  }
  const item = opts.port.feedList().find((f) => f.cwd === wt.cwd);
  if (intent.kind === "approve") {
    if (item) {
      opts.port.replyExitPlan(item.id, true);
    }
    commit(
      state,
      wt,
      { nextStage: onPlanApproved() },
      {
        event: "approve",
        kind: "approve",
        log: `${wt.name} approved → implementing`,
        set: { gate: undefined, note: undefined },
      },
      opts
    );
    return;
  }
  if (item) {
    opts.port.replyExitPlan(item.id, false);
  }
  commit(
    state,
    wt,
    { nextStage: "PLANNING" },
    {
      event: "reject",
      kind: "reject",
      log: `${wt.name} rejected → planning: ${intent.note ?? ""}`,
      set: { gate: undefined, note: intent.note },
    },
    opts
  );
};

// Drain every intent appended since our cursor and persist the new cursor. Cheap
// to call on the hot path: with nothing new it reads a small file and returns.
// Exactly-once: the cursor (state.intentsOffset) only advances past complete
// lines, and it persists with the state, so a watcher restart never re-applies.
export const drainIntents = (state: FleetState, opts: WatchOptions): void => {
  const start = state.intentsOffset ?? 0;
  const { intents, offset } = readIntentsFrom(DEFAULT_FLEET, start);
  if (offset === start && intents.length === 0) {
    return;
  }
  for (const intent of intents) {
    applyIntent(state, intent, opts);
  }
  state.intentsOffset = offset;
  persist(state);
};
