---
name: captain
description: Drive a whole fleet of cmux worktrees through the SDLC from one session you talk to, live. A watcher daemon (`captain watch`) holds the cmux event stream open and auto-advances each worktree (plan → implement → /simplify → /pr-reviewer → /pr-creator → /pr-babysitter), parking every human gate for you and stopping at PR-ready. You make decisions; it does the plumbing. Use when asked to "conduct my fleet", "drive my worktrees end to end", "run the whole SDLC", "what's blocked across my agents", "approve all the plans", "show me the plans", "what's ready to merge", or "start the captain".
---

# cmux Captain

One session you talk to that drives a fleet of cmux worktrees from Linear ticket to PR-ready.
A live watcher daemon reacts to cmux `agent.hook.*` events the instant they arrive and
auto-advances each worktree; it parks every decision for you and **stops at PR-ready**. This
skill is the steering wheel — the `captain` CLI is the engine. Pairs with the low-level
[`cmux`](../cmux/SKILL.md) skill (the four verbs) and `linear-worktree` (fan-out).

## Mental model

- The watcher (`captain watch`) holds `cmux events --category agent --reconnect` open and
  switches on `hook_event_name`: **Stop** → advance (send the next slash command) ·
  **ExitPlanMode** → PLAN_READY gate · **AskUserQuestion/Notification** → BLOCKED · others → busy.
- Auto-advance pipeline (from real usage): IMPLEMENTING → `/simplify` → SIMPLIFY → `/pr-reviewer`
  → REVIEW → `/pr-creator` → PR_OPEN → `/pr-babysitter` → BABYSITTING → READY_TO_MERGE.
- State lives in `~/.claude/captain/default/state.json` (one implicit fleet — no `--fleet`). You
  answer "what's blocked" from it — **never re-read 20 screens**.
- Human-gated stages: **PLAN_READY** (mandatory — implementation never starts un-approved),
  **BLOCKED**, **READY_TO_MERGE**. Everything else flows on its own.

## Setup

1. **Ensure the CLI is installed:** `captain --version`. If missing, build + link from the
   repo: `cd "/Users/mblode/Code/mblode/captain" && npm run build && npm link`.
2. **Fan out work** — this also starts the watcher (a single detached background process; no env
   vars, no separate workspace): `captain fanout TIG-401 TIG-402 …` (worktree + agent per issue).
   Use `CAPTAIN_NO_WATCH=1 captain fanout …` to create worktrees without auto-driving them.

## The loop (what you do)

| You say | Run |
|---|---|
| "status" / "what's blocked" / "what's ready" | `captain status` (`--json` for parsing) — one view: NEEDS YOU / IN FLIGHT / READY, each gate carrying its inline resolve command and each PR its merge hint |
| "show me the plans" | for each `PLAN_READY`, `cmux read-screen --workspace <id> --scrollback` once; summarize **all together** with each issue's `requirements-erosion` anchors so scope drift is spottable in one pass |
| "approve all plans" | `captain approve --plans all` (or comma-separated ticket names) |
| "send 404 back: don't touch auth" | `captain reject --ref tig-404 --note "…"` |
| "stop the captain" | `captain stop` (tears down the watcher) |

## Gotchas

- **Safe to adopt live sessions.** The watcher only auto-sends slash commands to worktrees you've
  approved (IMPLEMENTING and beyond). `ADOPTED`/`PLANNING` worktrees are never touched.
- **Never approve a plan you haven't read.** The plan gate is the one place under-planning hurts
  most. Read the batched plans, then approve.
- **Never guess off-script questions.** `BLOCKED` worktrees are surfaced verbatim — answer in that
  workspace with `cmux send --workspace <id> "…\n"`, or `reject` if it's a plan.
- **Stops at PR-ready.** Merging and deploying stay with you (no auto-merge).
- **One watcher, auto-started by `fanout`.** It's a detached background process (not a cmux
  workspace), pidfile-guarded so re-running `fanout` never double-spawns, and self-excluding for
  free. Restart-safe — it resumes from the event cursor with no missed events. `captain stop` ends it.

## Reference

- CLI: run `captain --help`. Source: `/Users/mblode/Code/mblode/captain`
  (`src/captain/`). The pure state machine is `src/captain/pipeline.ts`.
- Low-level cmux CLI (read-screen, send, send-key, feed): the [`cmux`](../cmux/SKILL.md) skill.
