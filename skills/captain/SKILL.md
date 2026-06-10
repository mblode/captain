---
name: captain
description: Dispatch a fleet of cmux worktrees (Linear ticket → PR-ready) and surface what needs you. `captain fanout` gives each agent a brief carrying the whole pipeline (plan → implement → /simplify → /pr-reviewer → /pr-creator → /pr-babysitter → verifier verdict) and the agent drives it itself; `captain status` derives NEEDS YOU / IN FLIGHT / READY live from cmux signals and verdict files — no daemon, no state. Use when asked to "conduct my fleet", "fan out these tickets", "what's blocked across my agents", "approve all the plans", "show me the plans", "what's ready to merge", or "start the captain".
---

# Captain

Dispatch a fleet of cmux worktrees from Linear ticket to PR-ready, then surface the few
decisions that are yours. Each agent's fan-out brief carries the **whole pipeline** and the
agent self-drives it; Captain keeps **no state** — `status` is derived live from cmux-native
signals and the per-worktree `.captain/` files. This skill is the steering wheel — the
`captain` CLI is the engine (it owns the worktree + Linear + fan-out itself). Pairs with the
low-level [`cmux`](../cmux/SKILL.md) skill (the four verbs).

## Mental model

- **Agents self-drive.** The brief's `<workflow>` section orders the pipeline: plan →
  implement → `/simplify` → `/pr-reviewer` → `/pr-creator` → `/pr-babysitter` → finishing
  protocol. Nothing external types commands into a workspace; if an agent stalls, you nudge it.
- **Status is stateless.** A captain worktree is any cmux workspace whose cwd has a
  `.captain/` dir. Busy/idle comes from `cmux top` run-state tags; gates are the newest
  _unresolved_ feed items (plan approvals, questions); done is a hash-checked
  `.captain/verdict.json`. Re-run `captain status` any time — there is nothing to desync.
- **Human gates**: plan approval (mandatory — implementation never starts un-approved),
  questions/blocked agents, and the merge itself. Everything else flows on its own.
- **The verdict gate.** Fan-out writes a definition of done into each worktree
  (`.captain/rubric.md`); the agent must run a fresh-context verifier sub-agent against it and
  write `.captain/verdict.json` citing the rubric's hash. `status` shows READY TO MERGE +
  `✓ verified` only on a valid pass; a failed verdict surfaces as NEEDS YOU with the verifier's
  summary. No verdict = the worktree just reads as in flight.
- **Fleet memory.** `~/.claude/captain/memory/<repo>/learnings.md` is shared across every run
  on a repo: fan-out injects its `## Rules` (curated) and recent `## Inbox` (raw) into each
  agent's brief, and agents append verified learnings to the Inbox at end of run.

## Setup

1. **Check prerequisites:** `captain doctor` verifies node, git, claude, cmux, `LINEAR_API_KEY`,
   and that the pipeline skills the brief invokes (`/simplify`, `/pr-reviewer`, `/pr-creator`,
   `/pr-babysitter`) are installed. Required gaps exit non-zero; fix them first.
2. **Ensure the CLI is installed:** `captain --version`. If missing: `npm i -g cmux-captain`
   (or build + link from a checkout: `cd ~/Code/mblode/captain && npm run build && npm link`).
3. **Fan out work:** `captain fanout TIG-401 TIG-402 …` (worktree + workspace + self-driving
   agent per issue). `--base <ref>` stacks on a prerequisite branch; `--print` previews the
   brief without launching.
4. **Optional toasts:** run `captain notify` in a spare pane (foreground; Ctrl-C stops) for
   notifications on new gates, fresh verdicts, and quiet worktrees. `--once` does a single pass.

## The loop (what you do)

| You say                                      | Run                                                                                                                                                                                                                                           |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "status" / "what's blocked" / "what's ready" | `captain status` (`--json` for parsing; `--repo`, `--needs`, `--ready` to narrow) — one view: NEEDS YOU / IN FLIGHT / READY, each gate carrying its inline resolve command and each PR its merge hint (plus merge-order overlap warnings)     |
| "show me the plans"                          | for each plan gate, `cmux read-screen --workspace <id> --scrollback` once; summarize **all together** so scope drift is spottable in one pass                                                                                                 |
| "approve all plans"                          | `captain approve --plans all` (or comma-separated ticket names, or a repo label)                                                                                                                                                              |
| "send 404 back: don't touch auth"            | `captain reject --ref tig-404 --note "…"` — replies to the plan gate _and_ types the feedback into the workspace                                                                                                                              |
| "what's verified"                            | `captain status` — READY rows carry `✓ verified` plus the verdict summary; spot-read `<worktree>/.captain/verdict.json`'s criteria array before merging                                                                                       |
| "this one's gone quiet"                      | `cmux read-screen --workspace <id>` to see where it is, then `cmux send --workspace <id> "continue with your workflow\n"` to nudge                                                                                                            |
| "distill the fleet's learnings"              | open `~/.claude/captain/memory/<repo>/learnings.md`; promote Inbox bullets that held up into `## Rules`, delete slop. `~/.claude/captain/log.jsonl` holds approve/reject notes and toasts — grep it for recurring failure causes worth a rule |

## Gotchas

- **Never approve a plan you haven't read.** The plan gate is the one place under-planning
  hurts most. Read the batched plans, then approve.
- **Never guess off-script questions.** NEEDS YOU rows are surfaced verbatim — answer in that
  workspace with `cmux send --workspace <id> "…\n"`, or `reject` if it's a plan.
- **Stops at PR-ready.** Merging and deploying stay with you (no auto-merge).
- **Never trust a one-line verdict summary.** The verdict gates the _label_, not the merge — a
  lazy agent can skip its verifier. Spot-read the verdict's per-criterion evidence before
  merging; a suspiciously thin criteria array means the verifier run probably didn't happen.
- **There is no daemon.** Nothing to start, restart, or stop; `status` can never be stale. If
  you want push notifications, run `captain notify` yourself (it's safe to kill any time).
- **Workspace ids, not names.** `cmux read-screen` / `cmux send` take the workspace UUID —
  `captain status` prints the right command per row; copy it.

## Reference

- CLI: run `captain --help`. Source: `~/Code/mblode/captain` (`src/captain/`). The pure
  decision core is `src/captain/view.ts` (grouping) and `src/captain/verdict.ts` (verdict).
- Low-level cmux CLI (read-screen, send, send-key, feed): the [`cmux`](../cmux/SKILL.md) skill.
