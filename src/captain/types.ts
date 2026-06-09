// Lifecycle stages a worktree moves through.
// Human-gated: PLAN_READY, READY_TO_MERGE, BLOCKED.
export type Stage =
  | "ADOPTED"
  | "PLANNING"
  | "PLAN_READY"
  | "IMPLEMENTING"
  | "SIMPLIFY"
  | "REVIEW"
  | "PR_OPEN"
  | "BABYSITTING"
  | "READY_TO_MERGE"
  | "BLOCKED";

export type GateKind = "plan" | "question" | "needs-input";

export interface Worktree {
  // cmux workspace uuid (event payload.workspace_id)
  workspaceId: string;
  // worktree path — the cross-channel join key
  cwd: string;
  name: string;
  agent: "claude" | "codex" | "unknown";
  stage: Stage;
  // epoch seconds the worktree entered `stage`
  since: number;
  // bounded REVIEW/QA loop guard
  retries: number;
  // epoch seconds of the last hook event the watcher handled for this worktree —
  // the stall clock (event-silence, not time-in-stage). Optional for back-compat
  // with state.json written before this field existed.
  lastSeen?: number;
  prUrl?: string;
  // set while a human gate is pending
  gate?: GateKind;
  note?: string;
}

export interface FleetState {
  fleetId: string;
  // never drive/notify this one
  captainWorkspaceId?: string;
  // only track worktrees whose cwd contains this (set by `fanout`)
  match?: string;
  updatedAt: number;
  // keyed by workspaceId
  worktrees: Record<string, Worktree>;
  // byte offset into intents.jsonl the watcher has already applied — its cursor
  // over the append-only intent log, so each human action is applied exactly once.
  intentsOffset?: number;
}

// A human decision (`approve`/`reject`) handed from the CLI to the watcher via the
// append-only intent log. The watcher is the sole writer of state.json, so the CLI
// never mutates it directly — it appends one of these and the watcher applies it.
export interface Intent {
  ts: number;
  kind: "approve" | "reject";
  // cmux workspace uuid the decision targets
  workspaceId: string;
  // revision feedback (reject only)
  note?: string;
}

// The subset of a cmux event frame the watcher cares about.
export interface HookEvent {
  // payload.hook_event_name: Stop, ExitPlanMode, ...
  hookEventName: string;
  // payload.workspace_id
  workspaceId: string;
  // payload.cwd
  cwd: string;
  seq: number;
}

// Result of applying one event to one worktree.
export interface Transition {
  nextStage: Stage;
  // slash command to inject when auto-advancing
  send?: string;
  // park a human gate
  gate?: GateKind;
  // human-facing alert text
  notify?: string;
}

// One line of the append-only audit log (~/.claude/captain/default/history.jsonl).
// The substrate every metric and the self-tuning policy is derived from.
export type HistoryKind =
  | "adopt"
  | "advance"
  | "approve"
  | "gate"
  | "reject"
  | "rework";

export interface HistoryRecord {
  // epoch seconds
  ts: number;
  workspaceId: string;
  name: string;
  // the cmux event sequence (0 for human actions that aren't event-driven)
  seq: number;
  // the hook_event_name that triggered this, or the human action ("approve")
  event: string;
  from: Stage;
  to: Stage;
  kind: HistoryKind;
  // slash command injected on an advance
  action?: string;
  gate?: GateKind;
}

// Per-stage rollup: how long worktrees sit here, and how reliably the watcher
// advances out of it (advances vs. reworks feed the self-tuning policy).
export interface StageMetric {
  // number of duration samples
  count: number;
  totalSec: number;
  medianSec: number;
  // clean auto-advances out of this stage
  advances: number;
  // failed advances out of this stage (busy-defer or escalation to a gate)
  reworks: number;
}

// The whole-fleet measurement view, derived purely from history + live state.
export interface FleetMetrics {
  // distinct worktrees ever seen in the log (plus any live but unlogged)
  runs: number;
  // worktrees that have reached a PR-ready stage
  prsReady: number;
  // PR-ready runs that took zero human intervention (no reject/block)
  autonomousRuns: number;
  // autonomousRuns / prsReady (0 when nothing is PR-ready)
  autonomyRate: number;
  interventions: {
    plans: number;
    rejects: number;
    blocks: number;
    total: number;
  };
  // interventions / advances — the essay's "correction/redirect rate"
  interventionRate: number;
  // PR-ready worktrees per day, over the observed window
  throughputPerDay: number;
  stages: Partial<Record<Stage, StageMetric>>;
}

// The learned driving policy: how many times the watcher will retry an
// auto-advance for a given stage before escalating to a human gate.
export interface PipelineTuning {
  maxRetries: Partial<Record<Stage, number>>;
}
