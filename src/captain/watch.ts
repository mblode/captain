import { listWorkspaces, notify, readScreen, send } from "./control";
import type { CmuxWorkspace } from "./control";
import { streamAgentEvents } from "./events";
import { groupOf } from "./format";
import { appendHistory, readHistory } from "./history";
import { computeMetrics } from "./metrics";
import { transition } from "./pipeline";
import { cursorPath, DEFAULT_FLEET, loadState, now, saveState } from "./state";
import { deriveTuning } from "./tuning";
import type {
  FleetState,
  GateKind,
  HookEvent,
  HistoryKind,
  PipelineTuning,
  Stage,
  Worktree,
} from "./types";

const RECONCILE_MS = 30_000;
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
  }
): void => {
  appendHistory(DEFAULT_FLEET, {
    action: rec.action,
    event: rec.event,
    from: rec.from,
    gate: rec.gate,
    kind: rec.kind,
    name,
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
        name: w.name,
        retries: 0,
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

// A real stage change resets the retry counter; a busy-defer (same stage) keeps it.
const setStage = (wt: Worktree, stage: Stage): void => {
  if (wt.stage !== stage) {
    wt.stage = stage;
    wt.since = now();
    wt.retries = 0;
  }
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

const handleEvent = (
  state: FleetState,
  ev: HookEvent,
  opts: WatchOptions,
  tuning: PipelineTuning
): void => {
  // Never drive ourselves.
  if (ev.workspaceId === state.captainWorkspaceId) {
    return;
  }
  // Not a tracked fleet worktree.
  const wt = state.worktrees[ev.workspaceId];
  if (!wt) {
    return;
  }
  const result = transition(wt, ev, tuning);
  if (!result) {
    return;
  }
  // The stage we're leaving — captured before setStage, for the audit log.
  const from = wt.stage;

  if (result.send) {
    // Verify before you send: only advance if the surface looks idle, otherwise
    // count a rework, bump the retry counter, and let the next Stop retry — the
    // tuning policy escalates to a human once retries exhaust the learned budget.
    if (BUSY.test(readScreen(wt.workspaceId, opts.env, 8))) {
      wt.retries += 1;
      record(wt.workspaceId, wt.name, {
        action: result.send,
        event: ev.hookEventName,
        from,
        kind: "rework",
        seq: ev.seq,
        to: from,
      });
      opts.log?.(
        `${wt.name} still busy — deferring ${result.send} (retry ${wt.retries})`
      );
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
  reconcile(state, listWorkspaces(opts.env), opts.match);
  saveState(state);
  banner(state, opts);

  // The learned driving policy, recomputed from the audit log. Refreshed on each
  // reconcile so it adapts as runs accumulate; the event handler reads it live.
  const refreshTuning = (): PipelineTuning =>
    deriveTuning(
      computeMetrics(
        readHistory(DEFAULT_FLEET),
        Object.values(state.worktrees),
        now()
      )
    );
  let tuning = refreshTuning();

  // Periodic reconcile catches worktrees spawned/closed after startup.
  const timer = setInterval(() => {
    reconcile(state, listWorkspaces(opts.env), opts.match);
    saveState(state);
    tuning = refreshTuning();
  }, RECONCILE_MS);
  timer.unref?.();

  streamAgentEvents(cursorPath(DEFAULT_FLEET), opts.env, (ev) =>
    handleEvent(state, ev, opts, tuning)
  );
};
