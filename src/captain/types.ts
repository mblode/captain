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

export type GateKind = "plan" | "question" | "needs-input" | "pr-ready";

export interface Worktree {
  // cmux workspace uuid (event payload.workspace_id)
  workspaceId: string;
  // worktree path — the cross-channel join key
  cwd: string;
  name: string;
  // short repo label ("linkiq") and canonical ticket ("tig-494"), set at
  // adoption. Optional for back-compat with state.json written before they
  // existed — readers derive from cwd/name when absent.
  repo?: string;
  ticket?: string;
  agent: "claude" | "codex" | "unknown";
  stage: Stage;
  // epoch seconds the worktree entered `stage`
  since: number;
  // epoch seconds of the last hook event the watcher handled for this worktree —
  // the stall clock (event-silence, not time-in-stage). Optional for back-compat
  // with state.json written before this field existed.
  lastSeen?: number;
  prUrl?: string;
  // set while a human gate is pending
  gate?: GateKind;
  note?: string;
  // outcome of the agent-side verifier run (.captain/verdict.json), once seen
  verdict?: "pass" | "fail";
}

export interface FleetState {
  fleetId: string;
  // never drive/notify this one
  captainWorkspaceId?: string;
  // only track worktrees whose cwd contains this (set by `fanout`)
  match?: string;
  // additional scope dirs appended at runtime (a later fanout outside the boot
  // match extends the scope via a `scope` intent instead of being dropped)
  matches?: string[];
  updatedAt: number;
  // keyed by workspaceId
  worktrees: Record<string, Worktree>;
  // byte offset into intents.jsonl the watcher has already applied — its cursor
  // over the append-only intent log, so each human action is applied exactly once.
  intentsOffset?: number;
}

// A human decision (`approve`/`reject`) or a scope extension handed from the
// CLI to the watcher via the append-only intent log. The watcher is the sole
// writer of state.json, so the CLI never mutates it directly — it appends one
// of these and the watcher applies it.
export interface Intent {
  ts: number;
  kind: "approve" | "reject" | "scope";
  // cmux workspace uuid the decision targets ("" for fleet-level intents)
  workspaceId: string;
  // revision feedback (reject only)
  note?: string;
  // scope dir to start tracking (scope only) — a later fanout outside the
  // running watcher's boot match extends the scope instead of being dropped
  dir?: string;
}

// The agent-side verifier's report, written to <worktree>/.captain/verdict.json
// per the finishing protocol. The watcher only reads pass/fail + hash; the
// criteria array is evidence for the human reviewing the gate.
export interface Verdict {
  issue: string;
  rubricHash: string;
  verdict: "pass" | "fail";
  criteria: { name: string; pass: boolean; evidence: string }[];
  summary: string;
  // the opened PR, when the agent includes it — wires Worktree.prUrl so the
  // status merge hint is real
  prUrl?: string;
  ts: number;
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
// The substrate `captain audit` renders and the memory distill reads.
export type HistoryKind =
  | "adopt"
  | "advance"
  | "approve"
  | "gate"
  | "reject"
  | "rework"
  | "verdict";

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
  // the why behind a human/escalation record: reject feedback, gate hint, halt
  // reason, or verdict summary — the substrate the memory distill reads
  note?: string;
}
