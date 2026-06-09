# Captain — firsthand findings from a live 10-worktree session (June 2026)

This is the lived experience of driving `captain` over a real fleet: 10 frontyard
(Linktree) worktrees fanned out from Linear tickets, each running Claude Code in a
cmux workspace, driven from one "captain" session. It is the ground-truth input for a
research swarm deciding how captain should evolve. Treat every item as an observed
fact from this session, not speculation.

## What captain is (today)

A TypeScript CLI (`captain`, npm-linked from this repo, ESM, tsdown→dist) that drives a
fleet of cmux worktrees Linear-ticket→PR-ready. Core pieces:

- `captain fanout TIG-… …` — wraps `linear-worktree` to create a git worktree + cmux
  workspace + Claude agent per issue, and auto-spawns a **detached watcher daemon**.
- The **watcher** (`captain watch`) holds `cmux events --category agent --reconnect`
  open and runs a PURE state machine (`pipeline.ts`): on `Stop` it sends the next slash
  command (`/pr-reviewer → /simplify → /pr-creator → /pr-babysitter`), on `ExitPlanMode`
  it parks a PLAN_READY gate, on `AskUserQuestion`/`Notification` it parks BLOCKED.
- State in `~/.claude/captain/default/`: `state.json` (atomic temp+rename),
  `history.jsonl` (append-only audit), `intents.jsonl` (append-only approve/reject,
  added this session), `cursor` (event seq), `watch.pid`, `watch.log`.
- Read/act surface: `captain status` (NEEDS YOU / IN FLIGHT / READY), `approve`,
  `reject`, `metrics`, `audit`, `stop`. Plus a `captain` **skill** (SKILL.md) that wraps
  the CLI for an LLM driver.
- Pure, unit-tested core: `pipeline.ts`, `metrics.ts`, `tuning.ts` (self-tuning retry
  budgets from history). cmux/fs I/O kept at the edges (`control.ts`, `events.ts`,
  `state.ts`, `history.ts`, `intents.ts`).
- It deliberately re-derives all state from the agent event stream and "never trusts
  cmux's built-in status" (a stated gotcha).

## Bugs / friction observed THIS session (each cost real time)

1. **The fanout-spawned detached daemon died on its own.** It booted reporting "0
   worktrees" (adopted nothing) and exited within ~2 min even though agent events were
   flowing. Had to relaunch manually with `nohup captain watch` + hand-write the pidfile.
   `ensureDaemon`'s detached spawn is not surviving / not adopting reliably.

2. **Fleet-wipe on a flaky `cmux rpc workspace.list`.** The watcher's periodic
   `reconcile` pruned EVERY tracked worktree whenever `listWorkspaces()` returned empty
   (the RPC intermittently returned empty from the detached daemon), and busy events
   never re-adopted. One empty list = whole fleet gone from `status`. _(Fixed this
   session: adopt worktrees directly from the event-stream frames (cwd+workspace_id),
   and never prune on an empty list.)_

3. **Re-emitted `ExitPlanMode` flapped IMPLEMENTING→PLAN_READY.** cmux re-emits hook
   frames, and bypass-permissions agents re-present plans mid-implement; the watcher
   `setStage(PLAN_READY)` on every one, knocking approved worktrees back to a gate and
   stranding the pipeline (a later Stop at PLAN*READY never auto-advances). *(Fixed:
   `ExitPlanMode` only gates from pre-approval stages.)\_

4. **Two-writer `state.json` clobber.** `approve`/`reject` ran as a SEPARATE process and
   wrote `state.json`; the running watcher held stale in-memory state and clobbered the
   write on its next event-save, so **approvals didn't stick** (worktrees snapped back to
   PLAN*READY). The `ensureDaemon` comment even claimed "sole writer… no race" — untrue.
   *(Fixed this session: single-writer. approve/reject only append to `intents.jsonl`;
   the watcher drains via a byte-offset cursor and is the sole state.json writer.)\_

5. **`captain status` prints an unusable read command.** It shows
   `cmux read-screen --workspace frontyard-tig-368 …`, but `read-screen` needs a
   `workspace:N` ref or UUID — the worktree _name_ is rejected ("Invalid workspace
   handle"). Every "read the plan" copy-paste failed; had to map names→refs by hand.

6. **Agents run in BYPASS-PERMISSIONS mode and self-drive.** They do NOT reliably wait
   at the ExitPlanMode gate — several blew past it and were already editing/implementing
   while captain still showed PLAN*READY. So captain's central human-gate (plan approval)
   is partly moot, and captain's per-Stop driving can \_collide* with an agent that is
   already self-running the next step. This is arguably the biggest conceptual tension:
   **captain assumes it is the sole driver, but cmux agents in bypass mode drive
   themselves.**

7. **Finished/idle worktrees look BLOCKED and can't be advanced.** An agent that
   finished implementing and printed "want me to commit and open a PR?" emits a
   `Notification` at idle → captain marks it BLOCKED (a false "needs you"). And captain
   can only advance on a _Stop event_; an idle/done worktree emits no new Stop, so
   captain can't nudge it forward without a manual `cmux send`.

8. **Fresh worktrees have no `node_modules`.** Every agent hit "Couldn't find the
   node_modules state file" and burned minutes on `yarn install` before it could run
   tests/lint. Not captain's bug, but it dominates wall-clock and captain has no notion
   of per-worktree setup/bootstrap.

9. **Manual daemon lifecycle.** Across the session the watcher had to be killed and
   relaunched ~4 times (to pick up rebuilds, after the death in #1). Each time the
   pidfile had to be hand-repointed so `captain status` read the right pid. There is no
   `captain restart`, no health self-heal, no "reload code" path.

10. **Heavy overlap with the `cmux` skill / CLI.** captain wraps `cmux workspace.list`,
    `cmux events`, `cmux read-screen`, `cmux send`, `cmux notify`, `cmux rpc
feed.list/exit_plan.reply`. cmux itself is a fleet-of-agents orchestrator with its
    own skill ("god mode over your cmux sessions"). Unclear how much captain
    re-implements what cmux now does natively (esp. feed/gates and status).

11. **State drift after any manual intervention.** Once I sent commands directly to
    workspaces, captain's `status` labels went stale (showed PLAN_READY for worktrees
    that were actually mid-/pr-reviewer) with no way to resync from ground truth
    (screens/feed). The model is write-once-from-events with no reconciliation against
    the agents' actual current activity.

12. **Pipeline order is hardcoded.** The advance sequence lives in `NEXT_ON_STOP`. The
    user wanted `/pr-reviewer → /simplify → /pr-creator` (I had to edit + rebuild to
    reorder). No per-fleet/per-run config for the cadence, the slash commands, or the
    "stop at PR-ready vs auto-merge" policy.

13. **Plan review is manual and serial.** `captain status` lists PLAN_READY worktrees
    but not the plans. Reviewing N plans = N `read-screen --scrollback` calls + manual
    summarize. The skill talks about "batch-summarize all plans" but the CLI gives no
    affordance for it.

14. **Editing captain mid-flight is painful.** Every fix required: edit → `npm run
build` → kill watcher → relaunch → re-point pidfile. A long-lived compiled daemon is
    awkward to iterate on while a live fleet depends on it.

## Things that worked well (keep these)

- The PURE core (`pipeline.ts`/`metrics.ts`/`tuning.ts`) is genuinely clean and
  unit-testable; the state-machine framing is good.
- Append-only logs (`history.jsonl`, now `intents.jsonl`) are the right concurrency
  primitive — the single-writer fix fell out naturally from that pattern.
- `captain status` as the single read surface (grouped NEEDS YOU / IN FLIGHT / READY) is
  a nice DX idea.
- Deriving state from the event stream (not cmux's built-in status) was the right call;
  the failure was only in adoption/pruning, not the principle.
- The skill wrapper made it drivable in natural language ("approve all plans", "what's
  blocked").

## The open questions to answer

- **Should captain be more lightweight?** Is a long-lived compiled daemon the right
  shape, or should it be a thinner layer over cmux-native primitives (or a skill +
  hooks)? What can be deleted if cmux/Claude Code now provide it?
- **Should captain be an installed skill / plugin** rather than an npm-linked CLI? What
  is the gold-standard distribution for a Claude Code orchestration tool in June 2026
  (skill, plugin + marketplace, MCP server, Agent SDK app, hooks)?
- **What is the gold-standard pattern** for driving a fleet of cmux + Claude Code
  worktrees through the SDLC in June 2026, and how far is captain from it?

## Repo facts

- Source: `/Users/mblode/Code/mblode/captain` (`src/captain/*`, `src/cli.ts`).
- Commands table & architecture in `AGENTS.md` (CLAUDE.md is a symlink to it).
- Skill: the `captain` skill (SKILL.md) under the user's skills dir; pairs with the
  `cmux` and `linear-worktree` skills.
- Stack: Node ≥22, tsdown, vitest, oxlint, ultracite (oxfmt). `npm run build/test/
typecheck/check/fix`.
