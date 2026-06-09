import type {
  HookEvent,
  PipelineTuning,
  Stage,
  Transition,
  Worktree,
} from "./types";

// The auto-advance pipeline: when a worktree in `stage` finishes a turn (Stop),
// send the slash command and move to the next stage. The flow is:
//   IMPLEMENTING → /simplify → SIMPLIFY → /pr-reviewer → REVIEW
//                → /pr-creator → PR_OPEN → /pr-babysitter → BABYSITTING
// derived from the developer's real cadence history (simplify 96 > pr-reviewer 36
// > pr-creator 12 > pr-babysitter 29) — not an invented sequence. Keys are sorted
// for the linter; the `next` field documents the actual order.
const NEXT_ON_STOP: Partial<Record<Stage, { next: Stage; send: string }>> = {
  IMPLEMENTING: { next: "SIMPLIFY", send: "/simplify" },
  PR_OPEN: { next: "BABYSITTING", send: "/pr-babysitter" },
  // v1 advances REVIEW linearly; verdict-based retry (blockers → IMPLEMENTING) is v2.
  REVIEW: { next: "PR_OPEN", send: "/pr-creator" },
  SIMPLIFY: { next: "REVIEW", send: "/pr-reviewer" },
};

// ExitPlanMode only legitimately gates BEFORE a plan is approved. cmux re-emits
// ExitPlanMode frames, and bypass-permissions agents re-present their plan while
// already implementing — neither must regress a worktree past approval back to a
// plan gate (which would strand it: a later Stop at PLAN_READY never auto-advances).
const PLANNABLE_FROM = new Set<Stage>(["ADOPTED", "PLANNING", "PLAN_READY"]);

// Working stages the watcher actively drives — a long event-silence here means a
// hung agent. Excludes ADOPTED (transient), BABYSITTING (legitimately polls a PR
// for a long time), and the human gates (PLAN_READY/READY_TO_MERGE/BLOCKED), which
// idle by design and must not be auto-halted.
const HALTABLE = new Set<Stage>([
  "IMPLEMENTING",
  "PLANNING",
  "PR_OPEN",
  "REVIEW",
  "SIMPLIFY",
]);

// Stages where a generic Notification means the agent is genuinely blocked on us,
// rather than an incidental cue mid-work.
const GATED_FROM = new Set<Stage>([
  "ADOPTED",
  "PLANNING",
  "IMPLEMENTING",
  "SIMPLIFY",
  "REVIEW",
  "PR_OPEN",
  "BABYSITTING",
]);

// Pure: given a worktree and an incoming hook event, what should change?
// Returns null when the event is informational (no state change). `tuning` is the
// learned policy (input data, not I/O — purity preserved); when omitted, or when a
// stage has no learned budget, the watcher retries an advance indefinitely, exactly
// as it did before self-tuning existed.
export const transition = (
  wt: Worktree,
  ev: HookEvent,
  tuning?: PipelineTuning
): Transition | null => {
  switch (ev.hookEventName) {
    case "ExitPlanMode": {
      // A re-emitted frame (or a bypass-mode re-plan) on an already-approved
      // worktree is noise — ignore it so it can't knock the worktree back to a gate.
      if (!PLANNABLE_FROM.has(wt.stage)) {
        return null;
      }
      return {
        gate: "plan",
        nextStage: "PLAN_READY",
        notify: `${wt.name}: plan ready for approval`,
      };
    }
    case "AskUserQuestion": {
      return {
        gate: "question",
        nextStage: "BLOCKED",
        notify: `${wt.name}: waiting on a question`,
      };
    }
    case "Notification": {
      if (!GATED_FROM.has(wt.stage)) {
        return null;
      }
      return {
        gate: "needs-input",
        nextStage: "BLOCKED",
        notify: `${wt.name}: needs input`,
      };
    }
    case "Stop": {
      const step = NEXT_ON_STOP[wt.stage];
      if (!step) {
        return null;
      }
      // Self-tuning: if this stage keeps failing to advance, the learned budget
      // routes it to a human instead of retrying forever.
      const budget = tuning?.maxRetries[wt.stage];
      if (budget !== undefined && wt.retries >= budget) {
        return {
          gate: "needs-input",
          nextStage: "BLOCKED",
          notify: `${wt.name}: auto-advance stuck at ${wt.stage.toLowerCase()} — needs you`,
        };
      }
      return { nextStage: step.next, send: step.send };
    }
    case "UserPromptSubmit":
    case "PreToolUse": {
      // First sign of life in plan mode moves a freshly adopted worktree to PLANNING.
      return wt.stage === "ADOPTED" ? { nextStage: "PLANNING" } : null;
    }
    default: {
      // SessionStart / SubagentStop / anything else: no transition.
      return null;
    }
  }
};

// Pure: the watcher's reconcile-timer guard for a hung loop. A silently-hung agent
// emits no events, so transition() never fires for it — this catches it off
// wall-clock. The signal is event-silence (lastSeen), not time-in-stage (since), so
// a long but healthy turn that keeps emitting events is never falsely halted.
export const checkHalt = (
  wt: Worktree,
  nowSec: number,
  stallSecs: number
): Transition | null => {
  if (!HALTABLE.has(wt.stage) || wt.gate) {
    return null;
  }
  const idleSecs = nowSec - (wt.lastSeen ?? wt.since);
  if (idleSecs < stallSecs) {
    return null;
  }
  // `notify` is the bare reason (single source of truth): the watcher uses it
  // verbatim as the status-row note and prefixes the worktree name for the toast.
  return {
    gate: "needs-input",
    nextStage: "BLOCKED",
    notify: `no activity for ${Math.round(idleSecs / 60)}m`,
  };
};

// Approving a plan is a human action (not an event): the agent now implements.
export const onPlanApproved = (): Stage => "IMPLEMENTING";

export const isHumanGated = (stage: Stage): boolean =>
  stage === "PLAN_READY" || stage === "READY_TO_MERGE" || stage === "BLOCKED";
