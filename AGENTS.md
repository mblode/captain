# captain

A live driver for a fleet of cmux worktrees (Linear ticket → PR-ready), built on the
`linear-worktree` fan-out. The watcher holds the cmux agent event stream open and advances each
worktree through a state machine, parking human gates.

## Commands

```bash
npm install                 # setup (requires Node >= 22)
npm run build               # tsdown -> dist/
npm run dev                 # tsdown --watch
npm run test                # vitest run
npm run typecheck           # tsc --noEmit
npm run lint                # oxlint .
npm run check               # ultracite check (lint + format, CI-equivalent)
npm run fix                 # ultracite fix (format + lint autofix)
npm link                    # install `captain` globally from this checkout
```

## Architecture

```text
src/
  cli.ts            # Commander entry: fanout | status | approve | reject | stop | watch
  runner.ts         # the inherited fan-out + armWatcher (writes match, ensures the daemon)
  cmux.ts git.ts linear.ts repo.ts issue.ts prompt.ts images.ts launch.ts progress.ts shell.ts
  captain/
    pipeline.ts     # PURE state machine: (worktree, hook event) -> transition. Start here.
    types.ts        # Stage, Worktree, FleetState, HookEvent, Transition
    state.ts        # DEFAULT_FLEET + atomic load/save of ~/.claude/captain/default/state.json + cursor
    daemon.ts       # singleton watcher: pidfile guard, ensureDaemon (detached spawn), stopDaemon
    control.ts      # cmux wrappers: workspace.list, send, read-screen, notify, feed reply
    events.ts       # spawn `cmux events --category agent --reconnect`, parse agent.hook frames
    watch.ts        # the live daemon: adopt -> react to events -> advance / park gates
    commands.ts     # status (the one read view) + approve/reject + friendly-id resolution
    format.ts       # TTY-aware colour, stage glyphs, grouped status with inline resolve commands
```

## DX surface

One implicit fleet (`DEFAULT_FLEET`), so no `--fleet` anywhere. `fanout` auto-starts a single
detached watcher (pidfile-guarded in `daemon.ts`), passing the worktrees' shared parent dir as a
`CAPTAIN_MATCH` scope. The watcher is the **sole writer** of `state.json` (it persists that match),
so `fanout` never races its saves; an already-running watcher keeps its boot-time scope and warns
if a later `fanout` falls outside it. `status` is the whole read surface — it folds in the old
`gates`/`ready` by printing each gate's inline resolve command and each PR's merge hint, plus a
watcher-health header. `stop` tears the daemon down. `CAPTAIN_NO_WATCH=1` opts out of auto-driving.

## How the watcher decides

`hook_event_name` drives everything (each frame carries `workspace_id` + `cwd` + `seq`):
`Stop` → advance (send next slash command) · `ExitPlanMode` → PLAN_READY gate ·
`AskUserQuestion`/`Notification` → BLOCKED · `UserPromptSubmit`/`PreToolUse` → busy.
The advance pipeline (`NEXT_ON_STOP` in `pipeline.ts`) is derived from real cadence usage:
`/simplify` → `/pr-reviewer` → `/pr-creator` → `/pr-babysitter`, stopping at PR-ready.

## Gotchas

- **ESM, bundler resolution**: extensionless relative imports (`./state`, not `./state.js`); `tsconfig` uses `moduleResolution: "Bundler"` and tsdown bundles to `dist/`.
- **The state machine is pure** (`pipeline.ts`) — keep I/O (cmux, fs) out of it so it stays unit-testable.
- **Idempotent gates**: cmux re-emits some hook frames; only alert on a _new_ gate (see `isNewGate` in `watch.ts`), never double-notify.
- **Never trust cmux's built-in status** (it desyncs); derive state from the agent event stream.
- **Colour only on a TTY** (`useColor`) — piped output and `--json` stay plain so the LLM/skill can parse them.
- **Friendly ids**: `approve`/`reject` resolve `tig-430` or substrings, never require a uuid.
- **Self-exclusion is free**: the auto-started watcher is a detached process, not a cmux workspace, so it never appears in `cmux workspace list` and can't drive itself (no `CMUX_CAPTAIN` needed). The `CMUX_WORKSPACE_ID` fallback in `watch.ts` only matters for a manual in-workspace `captain watch`.
- **Singleton watcher**: `ensureDaemon` is pidfile-guarded — re-running `fanout` never double-spawns. Tests must set `CAPTAIN_NO_WATCH=1` to avoid spawning a real daemon / writing real `~/.claude` state.
- **Behaviour parity**: preserve the inherited `fanout` modes (single-issue, fan-out, `--print`).
