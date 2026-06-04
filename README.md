# captain

Drive a fleet of [cmux](https://cmux.com/) worktrees through the SDLC — **live** — from Linear
ticket to PR-ready. One watcher daemon holds the cmux event stream open, auto-advances every
worktree (plan → `/simplify` → `/pr-reviewer` → `/pr-creator` → `/pr-babysitter`), and parks each
decision for you. You approve plans, answer questions, and merge. It does the rest.

- **Live, not polling** — reacts to cmux `agent.hook.*` events the instant they arrive.
- **Batched gates** — every plan approval and question is surfaced to you, never auto-decided.
- **Stops at PR-ready** — no auto-merge; merging and deploying stay with you.
- **Glanceable** — `status` leads with what needs you; restart-safe via an event cursor.

Built on [`linear-worktree`](https://github.com/mblode/linear-worktree) — its fan-out is the
`captain fanout` command; captain is the live driver layered on top.

## Install

Not yet published. From a checkout of this repo:

```bash
npm install && npm run build && npm link   # puts `captain` on your PATH
```

Requires Node ≥ 22 and `git`, `claude`, [`cmux`](https://cmux.com/) on your PATH. Set
`LINEAR_API_KEY` to pull ticket details into each agent's prompt.

## Quick start

```bash
# 1. Fan out: a git worktree + plan-mode agent per Linear issue
captain fanout TIG-430 TIG-431 TIG-449

# 2. Start the live watcher in its OWN cmux workspace (CMUX_CAPTAIN=1 self-excludes it)
CMUX_CAPTAIN=1 captain watch --fleet qa --match frontyard

# 3. From anywhere, drive it
captain status  --fleet qa     # glanceable: NEEDS YOU first, then in-flight, then ready
captain gates   --fleet qa     # the pending decisions, each with the command to resolve it
captain approve --fleet qa --plans tig-430,tig-431   # or --plans all
captain ready   --fleet qa     # PR-ready worktrees + a merge hint
```

The watcher reacts to cmux `agent.hook.*` events the instant they arrive:

| Event                              | Captain does                              |
| ---------------------------------- | ----------------------------------------- |
| `Stop` (turn finished)             | auto-advance: send the next slash command |
| `ExitPlanMode`                     | park a **plan-approval** gate, notify you |
| `AskUserQuestion` / `Notification` | park a **blocked** gate, notify you       |

State lives in `~/.claude/captain/<fleet>/state.json`; a restart resumes from the event cursor
with no missed events.

## Commands

| Command                                                 | What it does                                     |
| ------------------------------------------------------- | ------------------------------------------------ |
| `captain fanout <ISSUE-ID…>`                            | worktree + plan-mode agent per Linear issue      |
| `captain watch --fleet <id> [--match <substr>]`         | the live daemon — run in its own workspace       |
| `captain status --fleet <id> [--json]`                  | grouped fleet view (NEEDS YOU first)             |
| `captain gates --fleet <id>`                            | pending decisions, each with its resolve command |
| `captain approve --fleet <id> --plans <tickets\|all>`   | approve plan(s) → implementing                   |
| `captain reject --fleet <id> --ref <ticket> --note "…"` | send a plan back to planning                     |
| `captain ready --fleet <id>`                            | PR-ready worktrees + a merge hint                |

Targets accept friendly ticket names (`tig-430`), not UUIDs. Run `captain --help` for the full
workflow.

## Why a CLI, not a chat loop

A chat turn can't hold a live event stream open. The deterministic plumbing — holding the stream,
the state machine, sending slash commands — lives here in code; the judgment (which plan to
approve, how to answer a question) stays with you, or with the paired `captain` agent skill that
shells out to these commands.

## Development

```bash
npm run build      # tsdown → dist/
npm run test       # vitest
npm run typecheck  # tsc --noEmit
npm run check      # ultracite (lint + format, CI-equivalent)
npm run fix        # ultracite fix
```

## License

[MIT](LICENSE.md)
