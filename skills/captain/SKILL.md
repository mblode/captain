---
name: captain
description: Dispatch a fleet of cmux worktrees (Linear ticket → PR-ready) and surface what needs you. `captain start` gives each agent a brief carrying the whole pipeline (plan → implement → /simplify → /pr-reviewer → /pr-creator → /pr-babysitter → verifier verdict) and the agent drives it itself; `captain status` derives NEEDS YOU / IN FLIGHT / READY live from cmux signals and verdict files — no daemon, no state. Use when asked to "conduct my fleet", "fan out these tickets", "what's blocked across my agents", "approve all the plans", "show me the plans", "what's ready to merge", or "start the captain".
---

# Captain

Dispatch a fleet of cmux worktrees from Linear ticket to PR-ready, then surface the few
decisions that are yours. Each agent's start brief carries the **whole pipeline** and the
agent self-drives it; Captain keeps **no state** — `status` is derived live from cmux-native
signals and the per-worktree `.captain/` files. This skill is the steering wheel — the
`captain` CLI is the engine (it owns the worktree + Linear + fan-out itself). The real driver
of this skill is a long-lived Claude Code session, not a human at a keyboard. Pairs with the
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
- **The verdict gate.** Fan-out writes a definition of done into each worktree — the rubric, a
  markdown file at `<worktree>/.captain/rubric.md`; the agent must run a fresh-context verifier
  sub-agent against it and write `.captain/verdict.json` citing the rubric's hash. `status` shows
  READY TO MERGE +
  `✓ verified` only on a valid pass; a failed verdict surfaces as NEEDS YOU with the verifier's
  summary. No verdict = the worktree just reads as in flight.
- **Fleet memory.** `~/.claude/captain/memory/<repo>/learnings.md` is shared across every run
  on a repo: fan-out injects its `## Rules` (curated) and recent `## Inbox` (raw) into each
  agent's brief, and agents append verified learnings to the Inbox at end of run.

## Setup

1. **Check prerequisites:** `captain doctor` verifies node, git, claude, cmux, `LINEAR_API_KEY`,
   and the review/PR skills the brief invokes (`/pr-reviewer`, `/pr-creator`, `/pr-babysitter`
   from `mblode/agent-skills`; `/simplify` ships with Claude Code). Required gaps exit non-zero;
   fix them first.
2. **Ensure the CLI is installed:** `captain --version`. If missing: `npm i -g cmux-captain`
   (or build + link from a checkout: `cd ~/Code/mblode/captain && npm run build && npm link`).
3. **Fan out work:** `captain start TIG-401 TIG-402 …` (worktree + workspace + self-driving
   agent per issue). A non-Linear argument starts a free-form task in the current checkout
   instead. `--base <ref>` stacks on a prerequisite branch; `--print` previews the brief
   without launching.
4. **Arm the loop:** the agent driver self-arms with **native Claude Code scheduling**
   (ScheduleWakeup / cron / the `/loop` skill) — not a foreground watcher pane, in keeping with
   captain's no-daemon ethos. On each wakeup it polls `captain status --summary --json`, diffs
   each row's `stateHash` (the deterministic per-row fingerprint of a row's actionable state —
   gate + verdict + run-state — that a polling driver diffs to detect transitions) against the
   snapshot it holds in context, and acts only on transitions.

## The loop (what you do)

Self-arm a wakeup (ScheduleWakeup / cron / `/loop`) → `captain status --summary --json` → diff
each row's `stateHash` against the snapshot you hold in context → act only on **transitions**
(a new gate, a verdict flipped) → escalate the changed rows (see NEEDS YOU below) or re-arm.
Nothing polls in the foreground; the schedule is the heartbeat.

| You say                                      | Run                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "status" / "what's blocked" / "what's ready" | `captain status` (`--json` for parsing; `--repo`, `--needs`, `--ready` to narrow) — one view: NEEDS YOU / IN FLIGHT / READY, each gate carrying its inline resolve command and each PR its merge hint (plus merge-order overlap warnings)                                                                                                                                                                             |
| "show me the plans"                          | for each plan gate, fan out a **read-only subagent** (Agent/Explore tool) that reads the plan and returns a structured decision card `{summary, scopeDrift, risk, recommendation}`; present the batch — never spend your own window on raw `--scrollback`. This is the captain-native **decision-ready** gate: don't bring a rough plan, prep it first so scope drift is spottable across the whole batch in one pass |
| "approve all plans"                          | `captain approve all` (or comma-separated ticket names, or a repo label)                                                                                                                                                                                                                                                                                                                                              |
| "send 404 back: don't touch auth"            | `captain reject tig-404 --note "…"` — replies to the plan gate _and_ types the feedback into the workspace                                                                                                                                                                                                                                                                                                            |
| "what's verified"                            | `captain status` — READY rows carry `✓ verified` plus the verdict summary; spot-read `<worktree>/.captain/verdict.json`'s criteria array before merging                                                                                                                                                                                                                                                               |
| "this one's gone quiet"                      | `cmux read-screen --workspace <id>` to see where it is, then `cmux send --workspace <id> "continue with your workflow\n"` to nudge                                                                                                                                                                                                                                                                                    |
| "distill the fleet's learnings"              | open `~/.claude/captain/memory/<repo>/learnings.md`; promote Inbox bullets that held up into `## Rules`, delete slop. `~/.claude/captain/log.jsonl` holds approve/reject notes — grep it for recurring failure causes worth a rule                                                                                                                                                                                    |

### Escalating NEEDS YOU

The table verbs are how the decision is **executed**; the human-facing surfacing is the
**AskUserQuestion** primitive, not prose the agent can't act on. When a wakeup turns up gated
plans, batch them into **one** structured AskUserQuestion — one question per gate, each carrying
its subagent decision card (`{summary, scopeDrift, risk, recommendation}` from "show me the
plans") and options:

- **approve** → `captain approve <ticket>` (or `captain approve all` for the batch)
- **reject-with-note** → `captain reject <ticket> --note "…"` (the note is the human's text)
- **read-more** → fan out a deeper read-only subagent on that one plan, then re-ask

Off-script questions (NEEDS YOU rows that aren't plan gates) surface the same way — one
AskUserQuestion carrying the verbatim question; the answer is typed back with
`cmux send --workspace <id> "…\n"`. Batch a wakeup's escalations into a single ask; don't
interrupt the human once per gate.

## Gotchas

- **Never approve a plan you haven't read.** The plan gate is the one place under-planning
  hurts most. The read-only subagent reads it for you and returns a decision card; surface the
  card, get the call, then approve — but never approve a gate with no card behind it.
- **Never guess off-script questions.** NEEDS YOU rows are surfaced verbatim — answer in that
  workspace with `cmux send --workspace <id> "…\n"`, or `reject` if it's a plan.
- **Stops at PR-ready.** Merging and deploying stay with you (no auto-merge).
- **Never trust a one-line verdict summary.** The verdict gates the _label_, not the merge — a
  lazy agent can skip its verifier. Spot-read the verdict's per-criterion evidence before
  merging; a suspiciously thin criteria array means the verifier run probably didn't happen.
- **There is no daemon.** Nothing to start, restart, or stop; `status` can never be stale. The
  agent driver's heartbeat is native scheduling (ScheduleWakeup / cron / `/loop`), re-derived
  fresh each wakeup — never a long-running watcher process.
- **Workspace ids, not names.** `cmux read-screen` / `cmux send` take the workspace UUID —
  `captain status` prints the right command per row; copy it.
- **Never close an apparent duplicate workspace.** A cmux sidebar group's anchor is a real
  workspace whose cwd can be a fleet worktree; closing it dissolves the group and ungroups the
  whole fleet. `status` collapses same-cwd rows to the agent's row (fix shipped 2026-06-11), so
  seeing a duplicate means a stale binary — rebuild (`cd ~/Code/mblode/captain && npm run build`)
  instead of closing anything. Identify anchors with `cmux rpc workspace.group.list '{}'`.

## Reference

- CLI: run `captain --help`. Source: `~/Code/mblode/captain` (`src/captain/`). The pure
  decision core is `src/captain/view.ts` (grouping) and `src/captain/verdict.ts` (verdict).
- Low-level cmux CLI (read-screen, send, send-key, feed): the [`cmux`](../cmux/SKILL.md) skill.
