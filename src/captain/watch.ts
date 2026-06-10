import { basename } from "node:path";

import {
  feedList,
  listWorkspaces,
  notify,
  readScreen,
  replyExitPlan,
  send,
} from "./control";
import type { CmuxWorkspace } from "./control";
import { streamAgentEvents } from "./events";
import { groupOf } from "./format";
import { appendHistory } from "./history";
import { readIntentsFrom } from "./intents";
import { checkHalt, onPlanApproved, transition } from "./pipeline";
import { cursorPath, DEFAULT_FLEET, loadState, now, saveState } from "./state";
import type {
  FleetState,
  GateKind,
  HookEvent,
  HistoryKind,
  Intent,
  Stage,
  Worktree,
} from "./types";
import {
  checkVerdict,
  expectedRubricHash,
  readVerdict,
  VERDICT_STAGES,
} from "./verdict";

const RECONCILE_MS = 30_000;
const DEFAULT_STALL_SECS = 1800;
const BUSY = /esc to interrupt/iu;
// A line that reads like a real question/prompt (prose, not TUI chrome).
const PROSE = /^[A-Za-z][\w ,'"()/-]{14,118}[.?]?$/u;

const agentOf = (name: string): Worktree["agent"] => {
  if (/codex/iu.test(name)) {
    return "codex";
  }
  if (/claude|cc\b/iu.test(name)) {
    return "claude";
  }
  return "unknown";
};

interface WatchOptions {
  env: NodeJS.ProcessEnv;
  // only track worktrees whose cwd contains this substring
  match?: string;
  log?: (message: string) => void;
}

// Append one audit-log line for a worktree (ts/seq filled in; seq 0 for adopt).
const record = (
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

// Adopt current cmux workspaces into the fleet (excluding the captain itself),
// and drop tracked worktrees whose workspace has vanished.
const reconcile = (
  state: FleetState,
  workspaces: CmuxWorkspace[],
  match?: string
): void => {
  // A failed or empty `workspace.list` (the cmux RPC is unreliable from a
  // detached daemon) must NOT wipe the tracked fleet — treat it as "no data this
  // tick" and leave existing worktrees intact. The event stream re-adopts anyway.
  if (workspaces.length === 0) {
    return;
  }
  const selfId = state.captainWorkspaceId;
  const live = new Set<string>();
  for (const w of workspaces) {
    if (w.id === selfId || (match && !w.cwd.includes(match))) {
      continue;
    }
    live.add(w.id);
    const existing = state.worktrees[w.id];
    if (existing) {
      existing.cwd = w.cwd;
      existing.name = w.name;
    } else {
      state.worktrees[w.id] = {
        agent: agentOf(w.name),
        cwd: w.cwd,
        lastSeen: now(),
        name: w.name,
        since: now(),
        stage: "ADOPTED",
        workspaceId: w.id,
      };
      record(w.id, w.name, {
        event: "adopt",
        from: "ADOPTED",
        kind: "adopt",
        to: "ADOPTED",
      });
    }
  }
  state.worktrees = Object.fromEntries(
    Object.entries(state.worktrees).filter(([id]) => live.has(id))
  );
};

// A real stage change restarts the time-in-stage clock; a busy-defer (same stage) keeps it.
const setStage = (wt: Worktree, stage: Stage): void => {
  if (wt.stage !== stage) {
    wt.stage = stage;
    wt.since = now();
  }
};

// Apply one queued human decision from the intent log. `approve`/`reject` run in
// a separate CLI process and only ever APPEND intents — the watcher (sole writer of
// state.json) is what actually replies to the cmux plan gate and moves the stage,
// so the two never race. Guarded on PLAN_READY so a duplicate or stale intent is a
// no-op rather than yanking an already-implementing worktree backward.
const applyIntent = (
  state: FleetState,
  intent: Intent,
  opts: WatchOptions
): void => {
  const wt = state.worktrees[intent.workspaceId];
  if (!wt || wt.stage !== "PLAN_READY") {
    return;
  }
  const from = wt.stage;
  const item = feedList(opts.env).find((f) => f.cwd === wt.cwd);
  if (intent.kind === "approve") {
    if (item) {
      replyExitPlan(item.id, true, opts.env);
    }
    setStage(wt, onPlanApproved());
    wt.gate = undefined;
    wt.note = undefined;
    record(wt.workspaceId, wt.name, {
      event: "approve",
      from,
      kind: "approve",
      to: wt.stage,
    });
    opts.log?.(`${wt.name} approved → implementing`);
    return;
  }
  if (item) {
    replyExitPlan(item.id, false, opts.env);
  }
  setStage(wt, "PLANNING");
  wt.gate = undefined;
  wt.note = intent.note;
  record(wt.workspaceId, wt.name, {
    event: "reject",
    from,
    kind: "reject",
    note: intent.note,
    to: "PLANNING",
  });
  opts.log?.(`${wt.name} rejected → planning: ${intent.note ?? ""}`);
};

// Drain every intent appended since our cursor and persist the new cursor. Cheap
// to call on the hot path: with nothing new it reads a small file and returns.
const drainIntents = (state: FleetState, opts: WatchOptions): void => {
  const start = state.intentsOffset ?? 0;
  const { intents, offset } = readIntentsFrom(DEFAULT_FLEET, start);
  if (offset === start && intents.length === 0) {
    return;
  }
  for (const intent of intents) {
    applyIntent(state, intent, opts);
  }
  state.intentsOffset = offset;
  saveState(state);
};

// Best-effort: pull a one-line summary of what a gate is asking, so `status` can
// show it without opening the workspace. Returns undefined when nothing reads cleanly.
const gateHint = (
  workspaceId: string,
  env: NodeJS.ProcessEnv
): string | undefined => {
  const lines = readScreen(workspaceId, env, 30)
    .split("\n")
    .map((l) => l.replaceAll(/\[[0-9;]*m/gu, "").trim())
    .filter((l) => PROSE.test(l));
  return lines.at(-1);
};

const pendingCount = (state: FleetState): number =>
  Object.values(state.worktrees).filter((w) => groupOf(w.stage) === "needs-you")
    .length;

// Sweep every live worktree for a hung loop (a silently-stalled agent emits no
// events, so handleEvent never fires for it). Routes a stall into the same human
// BLOCKED gate path as any other escalation. Once a worktree is BLOCKED it's no
// longer HALTABLE, so checkHalt returns null next sweep — no double-notify.
const enforceHalts = (
  state: FleetState,
  opts: WatchOptions,
  stallSecs: number
): void => {
  for (const wt of Object.values(state.worktrees)) {
    if (wt.workspaceId === state.captainWorkspaceId) {
      continue;
    }
    const result = checkHalt(wt, now(), stallSecs);
    if (!result) {
      continue;
    }
    const from = wt.stage;
    setStage(wt, result.nextStage);
    if (result.gate) {
      wt.gate = result.gate;
    }
    // result.notify is the bare reason; the status row already shows the name, so
    // keep the note clean and only prefix the name for the (context-free) toast.
    wt.note = result.notify;
    const n = pendingCount(state);
    notify(
      `Captain · ${n} need${n === 1 ? "s" : ""} you`,
      `${wt.name}: ${result.notify}`,
      opts.env
    );
    record(wt.workspaceId, wt.name, {
      event: "halt",
      from,
      gate: result.gate,
      kind: "gate",
      note: result.notify,
      to: result.nextStage,
    });
    opts.log?.(`⚑ ${result.notify}`);
    saveState(state);
  }
};

// Surface an agent-written verdict (<cwd>/.captain/verdict.json): a verified
// pass parks the pr-ready gate (wiring READY_TO_MERGE), a fail escalates to
// BLOCKED with the verifier's summary. checkVerdict is pure and idempotent
// (null once a gate is set), so calling this from both the Stop path and the
// reconcile sweep never double-fires. Returns true when the verdict moved the
// worktree — the caller skips the normal advance for that event.
const applyVerdictFor = (
  state: FleetState,
  wt: Worktree,
  opts: WatchOptions,
  seq = 0
): boolean => {
  if (!VERDICT_STAGES.has(wt.stage) || wt.gate) {
    return false;
  }
  const verdict = readVerdict(wt.cwd);
  const result = verdict
    ? checkVerdict(wt, verdict, expectedRubricHash(wt.cwd))
    : null;
  if (!(verdict && result)) {
    return false;
  }
  const from = wt.stage;
  setStage(wt, result.nextStage);
  wt.gate = result.gate;
  wt.verdict = verdict.verdict;
  wt.note = verdict.summary;
  wt.prUrl = verdict.prUrl ?? wt.prUrl;
  if (verdict.verdict === "pass") {
    notify(
      "Captain · ready to merge",
      `${wt.name}: ${verdict.summary}`,
      opts.env
    );
  } else {
    const n = pendingCount(state);
    notify(
      `Captain · ${n} need${n === 1 ? "s" : ""} you`,
      `${wt.name}: ${result.notify}`,
      opts.env
    );
  }
  record(wt.workspaceId, wt.name, {
    event: "verdict",
    from,
    gate: result.gate,
    kind: "verdict",
    note: verdict.summary,
    seq,
    to: result.nextStage,
  });
  opts.log?.(
    `${verdict.verdict === "pass" ? "✓" : "⚑"} ${wt.name}: ${result.notify}`
  );
  saveState(state);
  return true;
};

// Reconcile-tick sweep: a verdict written after the final Stop (or under a
// manually-driven agent that emits no events) still surfaces within one tick.
const enforceVerdicts = (state: FleetState, opts: WatchOptions): void => {
  for (const wt of Object.values(state.worktrees)) {
    if (wt.workspaceId === state.captainWorkspaceId) {
      continue;
    }
    applyVerdictFor(state, wt, opts);
  }
};

// Adopt an untracked worktree straight from the live event stream. The cmux RPC
// view is unreliable, so the agent.hook frames (which carry cwd + workspace_id)
// are the real source of truth. Only adopts in-scope worktrees. New worktrees
// enter as ADOPTED, so `transition` won't auto-drive them until their plan is
// approved. Returns undefined for out-of-scope frames.
const adoptFromEvent = (
  state: FleetState,
  ev: HookEvent,
  opts: WatchOptions
): Worktree | undefined => {
  if (!ev.cwd || (opts.match && !ev.cwd.includes(opts.match))) {
    return undefined;
  }
  const adoptedName = basename(ev.cwd);
  const wt: Worktree = {
    agent: agentOf(adoptedName),
    cwd: ev.cwd,
    lastSeen: now(),
    name: adoptedName,
    since: now(),
    stage: "ADOPTED",
    workspaceId: ev.workspaceId,
  };
  state.worktrees[ev.workspaceId] = wt;
  record(ev.workspaceId, adoptedName, {
    event: "adopt",
    from: "ADOPTED",
    kind: "adopt",
    to: "ADOPTED",
  });
  opts.log?.(`adopted ${adoptedName} from event stream`);
  return wt;
};

const handleEvent = (
  state: FleetState,
  ev: HookEvent,
  opts: WatchOptions
): void => {
  // Never drive ourselves.
  if (ev.workspaceId === state.captainWorkspaceId) {
    return;
  }
  const wt = state.worktrees[ev.workspaceId] ?? adoptFromEvent(state, ev, opts);
  if (!wt) {
    return;
  }
  // Any event is a sign of life — reset the stall clock before the early-out so
  // even events that produce no transition still count as activity. Independent
  // of `since` (which setStage only resets on a stage change).
  wt.lastSeen = now();
  // A finished turn is the moment to look for the agent's verdict file: a
  // verified pass must win over blindly advancing (e.g. PR_OPEN → babysitter).
  if (ev.hookEventName === "Stop" && applyVerdictFor(state, wt, opts, ev.seq)) {
    return;
  }
  const result = transition(wt, ev);
  if (!result) {
    return;
  }
  // The stage we're leaving — captured before setStage, for the audit log.
  const from = wt.stage;

  if (result.send) {
    // Verify before you send: only advance if the surface looks idle, otherwise
    // record a rework and let the next Stop retry. A genuinely hung loop is the
    // stall halt's job (checkHalt), not a retry budget's.
    if (BUSY.test(readScreen(wt.workspaceId, opts.env, 8))) {
      record(wt.workspaceId, wt.name, {
        action: result.send,
        event: ev.hookEventName,
        from,
        kind: "rework",
        seq: ev.seq,
        to: from,
      });
      opts.log?.(`${wt.name} still busy — deferring ${result.send}`);
      saveState(state);
      return;
    }
    send(wt.workspaceId, result.send, opts.env);
    setStage(wt, result.nextStage);
    wt.gate = undefined;
    wt.note = undefined;
    record(wt.workspaceId, wt.name, {
      action: result.send,
      event: ev.hookEventName,
      from,
      kind: "advance",
      seq: ev.seq,
      to: result.nextStage,
    });
    opts.log?.(`${wt.name} → ${result.send.replace("/", "")}`);
    saveState(state);
    return;
  }

  // A gate or a plain stage change. Only alert when the gate is genuinely NEW —
  // cmux re-emits some hook frames, and we must not double-notify.
  const isNewGate = Boolean(
    result.gate && !(wt.stage === result.nextStage && wt.gate === result.gate)
  );
  setStage(wt, result.nextStage);
  if (result.gate) {
    wt.gate = result.gate;
  }
  if (isNewGate) {
    wt.note = gateHint(wt.workspaceId, opts.env);
    const n = pendingCount(state);
    notify(
      `Captain · ${n} need${n === 1 ? "s" : ""} you`,
      result.notify ?? wt.name,
      opts.env
    );
    record(wt.workspaceId, wt.name, {
      event: ev.hookEventName,
      from,
      gate: result.gate,
      kind: "gate",
      note: wt.note,
      seq: ev.seq,
      to: result.nextStage,
    });
    opts.log?.(`⚑ ${result.notify}`);
  }
  saveState(state);
};

const banner = (state: FleetState, opts: WatchOptions): void => {
  const n = Object.keys(state.worktrees).length;
  opts.log?.(
    `live on fleet "${DEFAULT_FLEET}" — ${n} worktree${n === 1 ? "" : "s"}${opts.match ? ` (match: ${opts.match})` : ""}`
  );
  opts.log?.("reacting to cmux agent events. Ctrl-C to stop (state is saved).");
};

// The live daemon. Loads state, adopts workspaces (scoped to the match `fanout`
// persisted), then reacts to each agent.hook frame as it arrives. Blocks forever
// (the event stream keeps it alive). Normally auto-started detached by `fanout`.
export const watch = (input: {
  env: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}): void => {
  const state = loadState(DEFAULT_FLEET);
  state.captainWorkspaceId =
    input.env.CMUX_WORKSPACE_ID ?? state.captainWorkspaceId;
  // `fanout` hands a fresh match via env; fall back to the persisted one on a
  // manual restart. The watcher is the sole writer of state.json from here on.
  const match = input.env.CAPTAIN_MATCH || state.match;
  state.match = match;
  const opts: WatchOptions = { env: input.env, log: input.log, match };
  const stallSecs = Number(input.env.CAPTAIN_STALL_SECS) || DEFAULT_STALL_SECS;
  const haltsEnabled = input.env.CAPTAIN_NO_HALT !== "1";
  reconcile(state, listWorkspaces(opts.env), opts.match);
  saveState(state);
  // Apply any decisions queued while no watcher was running (e.g. `approve` before
  // `fanout` finished spawning, or between a crash and this restart).
  drainIntents(state, opts);
  banner(state, opts);

  // Periodic reconcile catches worktrees spawned/closed after startup, and is a
  // backstop drain in case the event stream is briefly idle when an intent lands.
  const timer = setInterval(() => {
    reconcile(state, listWorkspaces(opts.env), opts.match);
    saveState(state);
    drainIntents(state, opts);
    if (haltsEnabled) {
      enforceHalts(state, opts, stallSecs);
    }
    enforceVerdicts(state, opts);
  }, RECONCILE_MS);
  timer.unref?.();

  // Drain queued human decisions before each event so an approval applies promptly
  // and the event is handled against the worktree's fresh stage.
  streamAgentEvents(cursorPath(DEFAULT_FLEET), opts.env, (ev) => {
    drainIntents(state, opts);
    handleEvent(state, ev, opts);
  });
};
