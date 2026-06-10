import { adoptFromEvent, reconcile } from "./adopt";
import { commit, persist } from "./commit";
import type { WatchOptions } from "./commit";
import { realCmux } from "./control";
import type { CmuxPort } from "./control";
import { streamAgentEvents } from "./events";
import { drainIntents } from "./intents-drain";
import { transition } from "./pipeline";
import { cursorPath, DEFAULT_FLEET, loadState, now } from "./state";
import { applyVerdict, sweepHalts, sweepVerdicts } from "./sweeps";
import type { FleetState, HookEvent, Worktree } from "./types";

const RECONCILE_MS = 30_000;
const DEFAULT_STALL_SECS = 1800;

// ── Legacy screen-scrape fallbacks ──────────────────────────────────────────
// These regexes + readers are the CAPTAIN_SCRAPE=1 / unknown-run-state /
// empty-feed fallback for the cmux-native signals (top run-state + feed items
// below). Slated for deletion one release after the native path proves out.
const BUSY = /esc to interrupt/iu;
// A line that reads like a real question/prompt (prose, not TUI chrome).
const PROSE = /^[A-Za-z][\w ,'"()/-]{14,118}[.?]?$/u;

const screenBusy = (workspaceId: string, port: CmuxPort): boolean =>
  BUSY.test(port.readScreen(workspaceId, 8));

const screenHint = (
  workspaceId: string,
  port: CmuxPort
): string | undefined => {
  const lines = port
    .readScreen(workspaceId, 30)
    .split("\n")
    .map((l) => l.replaceAll(/\[[0-9;]*m/gu, "").trim())
    .filter((l) => PROSE.test(l));
  return lines.at(-1);
};

// ── cmux-native signals ──────────────────────────────────────────────────────

// Busy = the agent process is mid-turn. Primary signal is `cmux top`'s run-state
// TAG — per-process accounting, so the "never trust cmux's built-in status" rule
// (about the workspace status glyphs, which desync) does not apply to it. A
// flaky `top` ("unknown") falls back to the screen scrape so it can never break
// driving; CAPTAIN_SCRAPE=1 forces the scrape outright.
const isBusy = (wt: Worktree, opts: WatchOptions): boolean => {
  if (opts.scrape) {
    return screenBusy(wt.workspaceId, opts.port);
  }
  const live = opts.port.runState(wt.workspaceId);
  return live === "unknown"
    ? screenBusy(wt.workspaceId, opts.port)
    : live === "running";
};

// Feed kinds whose text describes what a gate is asking of the human.
const HINT_KINDS = new Set(["question", "notification"]);

// Primary gate hint: the workspace's newest unresolved question/notification
// feed item, matched by cwd (the cross-channel join key — same matching as
// applyIntent). `resolved_at` is set the moment an item is answered/expired,
// so its absence is the pending marker (verified live on cmux 0.64.14).
// feed.list is chronological, so the LAST match is the gating item.
const feedHint = (cwd: string, port: CmuxPort): string | undefined => {
  const item = port
    .feedList()
    .findLast((f) => HINT_KINDS.has(f.kind) && f.cwd === cwd && !f.resolved_at);
  return item?.question_prompt || item?.text || undefined;
};

// Best-effort: a one-line summary of what a gate is asking, so `status` can
// show it without opening the workspace. Feed first; an empty/unusable feed
// falls back to the screen scrape automatically.
const gateHint = (wt: Worktree, opts: WatchOptions): string | undefined => {
  if (!opts.scrape) {
    const hint = feedHint(wt.cwd, opts.port);
    if (hint) {
      return hint;
    }
  }
  return screenHint(wt.workspaceId, opts.port);
};

// React to one agent.hook frame: adopt if untracked, mark liveness, surface a
// verdict on Stop, then run the pure transition and commit its result.
export const handleEvent = (
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
  // of `since` (which commit only resets on a stage change).
  wt.lastSeen = now();
  // A finished turn is the moment to look for the agent's verdict file: a
  // verified pass must win over blindly advancing (e.g. PR_OPEN → babysitter).
  if (ev.hookEventName === "Stop" && applyVerdict(state, wt, opts, ev.seq)) {
    return;
  }
  const result = transition(wt, ev);
  if (!result) {
    return;
  }
  if (result.send) {
    // Verify before you send: only advance if the agent is idle, otherwise
    // record a rework and let the next Stop retry. A genuinely hung loop is the
    // stall halt's job (checkHalt), not a retry budget's.
    if (isBusy(wt, opts)) {
      commit(
        state,
        wt,
        { nextStage: wt.stage },
        {
          action: result.send,
          event: ev.hookEventName,
          kind: "rework",
          log: `${wt.name} still busy — deferring ${result.send}`,
          seq: ev.seq,
        },
        opts
      );
      return;
    }
    opts.port.send(wt.workspaceId, result.send);
    commit(
      state,
      wt,
      result,
      {
        action: result.send,
        event: ev.hookEventName,
        kind: "advance",
        log: `${wt.name} → ${result.send.replace("/", "")}`,
        seq: ev.seq,
        set: { gate: undefined, note: undefined },
      },
      opts
    );
    return;
  }
  // A gate or a plain stage change. commit owns the new-gate idempotency: a
  // re-emitted frame refreshes stage/gate silently, never double-notifies.
  commit(
    state,
    wt,
    result,
    {
      event: ev.hookEventName,
      hint: () => gateHint(wt, opts),
      kind: "gate",
      log: `⚑ ${result.notify}`,
      notice: { body: result.notify ?? wt.name, kind: "needs-you" },
      seq: ev.seq,
    },
    opts
  );
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
// `port` is the test seam; production uses the real cmux CLI.
export const watch = (input: {
  env: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  port?: CmuxPort;
}): void => {
  const state = loadState(DEFAULT_FLEET);
  state.captainWorkspaceId =
    input.env.CMUX_WORKSPACE_ID ?? state.captainWorkspaceId;
  // `fanout` hands a fresh match via env; fall back to the persisted one on a
  // manual restart. The watcher is the sole writer of state.json from here on.
  const match = input.env.CAPTAIN_MATCH || state.match;
  state.match = match;
  const port = input.port ?? realCmux(input.env);
  const opts: WatchOptions = {
    log: input.log,
    match,
    port,
    scrape: input.env.CAPTAIN_SCRAPE === "1",
  };
  const stallSecs = Number(input.env.CAPTAIN_STALL_SECS) || DEFAULT_STALL_SECS;
  const haltsEnabled = input.env.CAPTAIN_NO_HALT !== "1";
  // Apply any decisions queued while no watcher was running (e.g. `approve`
  // before `fanout` finished spawning, or a scope extension from a fanout that
  // landed between a crash and this restart) — before the first reconcile so an
  // extended scope adopts its worktrees immediately.
  drainIntents(state, opts);
  reconcile(state, port.listWorkspaces());
  persist(state);
  banner(state, opts);

  // Periodic reconcile catches worktrees spawned/closed after startup, and is a
  // backstop drain in case the event stream is briefly idle when an intent lands.
  const timer = setInterval(() => {
    reconcile(state, port.listWorkspaces());
    persist(state);
    drainIntents(state, opts);
    if (haltsEnabled) {
      sweepHalts(state, opts, stallSecs);
    }
    sweepVerdicts(state, opts);
  }, RECONCILE_MS);
  timer.unref?.();

  // Drain queued human decisions before each event so an approval applies promptly
  // and the event is handled against the worktree's fresh stage.
  streamAgentEvents(cursorPath(DEFAULT_FLEET), input.env, (ev) => {
    drainIntents(state, opts);
    handleEvent(state, ev, opts);
  });
};
