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
