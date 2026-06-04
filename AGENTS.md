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
  cli.ts            # Commander entry: fanout | watch | status | gates | approve | reject | ready
  runner.ts         # the inherited fan-out (one worktree + cmux agent per Linear issue)
  cmux.ts git.ts linear.ts repo.ts issue.ts prompt.ts images.ts launch.ts progress.ts shell.ts
  captain/
    pipeline.ts     # PURE state machine: (worktree, hook event) -> transition. Start here.
    types.ts        # Stage, Worktree, FleetState, HookEvent, Transition
    state.ts        # atomic load/save of ~/.claude/captain/<fleet>/state.json + cursor
    control.ts      # cmux wrappers: workspace.list, send, read-screen, notify, feed reply
    events.ts       # spawn `cmux events --category agent --reconnect`, parse agent.hook frames
    watch.ts        # the live daemon: adopt -> react to events -> advance / park gates
    commands.ts     # status/gates/ready/approve/reject + friendly-id resolution
    format.ts       # TTY-aware colour, stage glyphs, grouped status renderer
```

## How the watcher decides

`hook_event_name` drives everything (each frame carries `workspace_id` + `cwd` + `seq`):
`Stop` → advance (send next slash command) · `ExitPlanMode` → PLAN_READY gate ·
`AskUserQuestion`/`Notification` → BLOCKED · `UserPromptSubmit`/`PreToolUse` → busy.
The advance pipeline (`NEXT_ON_STOP` in `pipeline.ts`) is derived from real cadence usage:
`/simplify` → `/pr-reviewer` → `/pr-creator` → `/pr-babysitter`, stopping at PR-ready.

## Gotchas

- **ESM only**: use `.js` extensions in TypeScript imports.
- **The state machine is pure** (`pipeline.ts`) — keep I/O (cmux, fs) out of it so it stays unit-testable.
- **Idempotent gates**: cmux re-emits some hook frames; only alert on a _new_ gate (see `isNewGate` in `watch.ts`), never double-notify.
- **Never trust cmux's built-in status** (it desyncs); derive state from the agent event stream.
- **Colour only on a TTY** (`useColor`) — piped output and `--json` stay plain so the LLM/skill can parse them.
- **Friendly ids**: `approve`/`reject` resolve `tig-430` or substrings, never require a uuid.
- **Self-exclusion**: the watcher ignores its own workspace; launch it with `CMUX_CAPTAIN=1`.
- **Behaviour parity**: preserve the inherited `fanout` modes (single-issue, fan-out, `--print`).
