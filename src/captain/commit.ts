import type { CmuxPort } from "./control";
import { groupOf } from "./format";
import { appendHistory } from "./history";
import { DEFAULT_FLEET, now, saveState } from "./state";
import type {
  FleetState,
  GateKind,
  HistoryKind,
  Stage,
  Transition,
  Worktree,
} from "./types";

// Shared options threaded through the watcher modules. `port` is the injectable
// cmux seam (tests pass a fake; see control.ts); `match` scopes which worktrees
// we track to the parent dir `fanout` persisted.
export interface WatchOptions {
  port: CmuxPort;
  // only track worktrees whose cwd contains this substring
  match?: string;
  log?: (message: string) => void;
  // CAPTAIN_SCRAPE=1: force the legacy screen-scrape paths (busy check + gate
  // hint) instead of the cmux-native run-state/feed signals — the one-release
  // escape hatch while the native path proves out.
  scrape?: boolean;
}

// Persist a non-transition mutation (workspace adoption, the intents cursor).
// Anything stage-shaped must go through commit() instead. saveState imports are
// lint-banned outside commit.ts (oxlint no-restricted-imports in
// oxlint.config.ts), so the watcher's single-mutator invariant can't silently
// erode. Residual the lint rule can't catch: *.test.ts files are exempt —
// state.test.ts exercises saveState directly and the established
// `vi.spyOn(state, "fleetDir")` pattern needs `import * as state`, which the
// named-import ban would otherwise flag.
export const persist = (state: FleetState): void => {
  saveState(state);
};

// Append one audit-log line for a worktree (ts filled in; seq 0 for human/sweep
// actions that aren't event-driven).
export const record = (
  workspaceId: string,
  name: string,
  rec: {
    event: string;
    from: Stage;
    to: Stage;
    kind: HistoryKind;
    seq?: number;
    action?: string;
    gate?: GateKind;
    note?: string;
  }
): void => {
  appendHistory(DEFAULT_FLEET, {
    action: rec.action,
    event: rec.event,
    from: rec.from,
    gate: rec.gate,
    kind: rec.kind,
    name,
    note: rec.note,
    seq: rec.seq ?? 0,
    to: rec.to,
    ts: now(),
    workspaceId,
  });
};

// A real stage change restarts the time-in-stage clock; a same-stage commit
// (busy-defer rework) keeps it.
const setStage = (wt: Worktree, stage: Stage): void => {
  if (wt.stage !== stage) {
    wt.stage = stage;
    wt.since = now();
  }
};

const pendingCount = (state: FleetState): number =>
  Object.values(state.worktrees).filter((w) => groupOf(w.stage) === "needs-you")
    .length;

// Everything about one transition that isn't in the Transition itself.
export interface CommitMeta {
  kind: HistoryKind;
  // the hook_event_name that triggered this, or the human/sweep action
  // ("approve", "halt", "verdict")
  event: string;
  // the cmux event sequence; omit for non-event-driven commits (recorded as 0)
  seq?: number;
  // slash command involved (recorded on an advance or a busy-defer rework)
  action?: string;
  // Explicit worktree field patches. A key PRESENT with value undefined CLEARS
  // the field (an advance/approve clears gate+note); absent keys are untouched.
  set?: Partial<Pick<Worktree, "gate" | "note" | "verdict" | "prUrl">>;
  // Lazy gate hint (feed lookup, read-screen scrape as fallback) — only
  // evaluated when the gate is genuinely new, so re-emitted frames never cost
  // a subprocess call.
  hint?: () => string | undefined;
  // Toast to raise: "needs-you" gets the pendingCount "N need you" title,
  // "pr-ready" the "ready to merge" title. Omit for silent commits (advances).
  notice?: { kind: "needs-you" | "pr-ready"; body: string };
  log?: string;
}

// THE single mutator: every stage/gate/note/verdict/prUrl change the watcher
// makes — event advance, event gate, approve/reject intent, halt sweep, verdict
// apply — lands here, so the invariant (mutate → notify → record history → save
// state) has exactly one home. Call sites do their port side-effects first
// (send the slash command, reply to the plan gate) and then commit the result.
export const commit = (
  state: FleetState,
  wt: Worktree,
  t: Transition,
  meta: CommitMeta,
  opts: WatchOptions
): void => {
  // Idempotent gates: cmux re-emits some hook frames, and we must never
  // double-notify. A gate-kind commit only announces (note/notify/record/log)
  // when the gate is genuinely NEW — a re-emitted frame still refreshes
  // stage/gate and saves, silently. Every other kind always announces: halts
  // and verdicts are pre-guarded by their pure checks (null once a gate is
  // set), and advances/approves/rejects/reworks are never re-emitted.
  const announce =
    meta.kind !== "gate" ||
    Boolean(t.gate && !(wt.stage === t.nextStage && wt.gate === t.gate));
  const from = wt.stage;
  setStage(wt, t.nextStage);
  if (t.gate) {
    wt.gate = t.gate;
  }
  if (announce) {
    if (meta.set) {
      Object.assign(wt, meta.set);
    }
    if (meta.hint) {
      wt.note = meta.hint();
    }
    if (meta.notice) {
      const n = pendingCount(state);
      const title =
        meta.notice.kind === "pr-ready"
          ? "Captain · ready to merge"
          : `Captain · ${n} need${n === 1 ? "s" : ""} you`;
      opts.port.notify(title, meta.notice.body);
    }
    record(wt.workspaceId, wt.name, {
      action: meta.action,
      event: meta.event,
      from,
      gate: t.gate,
      kind: meta.kind,
      // The note belongs on the record only when this commit set it (reject
      // feedback, gate hint, halt reason, verdict summary) — a rework must not
      // drag a stale note into the audit log.
      note: (meta.set && "note" in meta.set) || meta.hint ? wt.note : undefined,
      seq: meta.seq,
      to: t.nextStage,
    });
    if (meta.log) {
      opts.log?.(meta.log);
    }
  }
  saveState(state);
};
