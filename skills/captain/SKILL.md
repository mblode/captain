---
name: captain
description: Dispatch a fleet of cmux worktrees (Linear ticket → PR-ready) and surface what needs you. `captain start` — or bare `captain TIG-430`, start is implicit — gives each agent a brief carrying the whole pipeline (plan → implement → /tidy → /pr-reviewer → /pr-creator → /pr-babysitter → verifier verdict) and the agent drives it itself; `--agent codex` launches codex agents instead (best-effort, no plan gate). `captain status` derives NEEDS YOU / IN FLIGHT / READY live from cmux signals and verdict files — no daemon, no state. Use when asked to "conduct my fleet", "fan out these tickets", "start this ticket", "run these on codex", "what's blocked across my agents", "approve all the plans", "show me the plans", "what's ready to merge", or "start the captain". "run the dev loop" and "drain the queue" arm `/captain loop`, an explicitly armed mode that fills free agent slots from the TIG `agent-ready` queue.
---

# Captain

**IS:** conducting a fleet via the `captain` CLI — fan out Linear tickets, run the explicitly
armed auto-pickup loop, poll `captain status`, batch plan approvals and off-script questions into
human decisions, nudge stalled agents, distill fleet memory. **IS NOT:** typing low-level cmux verbs by hand (use [`cmux`](../cmux/SKILL.md)) or
running any pipeline step yourself — the agent self-drives plan → implement → `/tidy` →
`/pr-reviewer` → `/pr-creator` → `/pr-babysitter` → verdict. The driver is a long-lived Claude Code
session, not a human at a keyboard; Captain keeps **no state** (`status` derives live from cmux +
each worktree's `.captain/`).

## Mental model

- **Agents self-drive** the whole pipeline; nothing types into a workspace — if one stalls, nudge
  it.
- **Status is stateless**, derived fresh each call: membership = a cmux workspace whose cwd has a
  `.captain/` dir; busy/idle = `cmux top` run-state tags; gates = the newest _unresolved_ feed item
  per cwd; done = a hash-checked `.captain/verdict.json`. Re-run any time — nothing desyncs.
- **Human gates**: plan approval (mandatory — implementation never starts un-approved),
  questions/blocked agents, and the merge. Everything else flows on its own. (Claude agents only:
  a codex agent has no plan mode, so its fleet has **no plan gate** — `approve`/`reject` have
  nothing to reply to; its brief tells it to plan then proceed.)
- **Verdict gate**: fan-out writes the definition of done to `.captain/rubric.md`; the agent's
  fresh-context verifier writes `.captain/verdict.json` citing the rubric's hash. A valid pass shows
  READY with the `✓ verified` label; a fail → NEEDS YOU and its summary; no verdict → in flight.
- **Fleet memory**: `~/.claude/captain/memory/<repo>/learnings.md` (shared per repo) — fan-out
  injects `## Rules` + recent `## Inbox`; agents append verified learnings at end of run.

## Setup

1. **Prereqs:** `captain install` adds the pipeline skills (`/pr-reviewer`, `/pr-creator`,
   `/pr-babysitter` from `mblode/agent-skills`; `/tidy` lives there too but isn't fetched by
   `captain install`) and checks node,
   git, claude, cmux, `LINEAR_API_KEY`. If the CLI is missing: `npm i -g cmux-captain`, or
   `npm run build && npm link` from a checkout.
2. **Route each ticket semantically.** Your cwd is almost never the ticket's repo, and **nothing
   picks it for you** — a team spans repos, a project spans repos (Pulse v0 lives in linkiq, chat
   _and_ frontyard), some tickets carry no project. Read the ticket — description, the code
   paths/symbols it names, its linked PRs — to decide which repo the work touches (grep candidates
   when thin), then pass `--repo-path <repo>`.
3. **Fan out:** group tickets by repo, run one `captain start <ids…> --repo-path <repo>` per repo
   (one worktree + workspace + self-driving agent each; `start` is implicit — bare `captain TIG-430`
   works, though a single non-Linear word is treated as a typo'd subcommand and errors). A non-Linear
   arg starts a free-form task in the current checkout. `--base <ref>` stacks on a prerequisite
   branch; `--print` previews. Confirm each `started[].cwd` (`--json`) before approving any plan — a
   worktree in the wrong repo can never pass its rubric. Each agent launches on a **pinned model +
   effort** (default `default` / `high`, where `default` = the machine's configured default model),
   so it never inherits your driver's tier — override per fleet with `CAPTAIN_MODEL` /
   `CAPTAIN_EFFORT` (or config `.model` / `.effort`). The agent binary is claude unless you pass
   `--agent codex` (or set `CAPTAIN_AGENT` / config `.agent`) — codex is **best-effort**: full
   autonomy, an adapted brief (plan then proceed), no plan gate, and no busy/idle run-state in
   `status` (codex emits no `cmux top` tag, so its rows read `—`).
4. **Arm the heartbeat** — the driver re-invokes itself on a timer (no daemon, no foreground pane;
   each wake re-derives status fresh). Take the first available rung; never skip a missing rung to
   "ask the human to ping me":
   1. **Backgrounded sleep (default, universal).** `Bash` `sleep 210` with `run_in_background: true`
      — the exit delivers a new turn, re-invoking the driver. No gate, no expiry, survives
      `--resume`; proven at fleet scale. Re-fire each wake.
   2. **`CronCreate`** (if present): a `*/4 * * * *` re-prompt, but ±jitter, 7-day expiry, fresh
      context each tick — prefer rung 1 for anything durable.
   3. **`/loop`** (only when already inside one): the only place `ScheduleWakeup` is ungated —
      outside it that tool hard-fails "dynamic runtime gate is off".

   `send_later` is one-shot, not a heartbeat. Each wake: poll `captain status --summary --json`
   (group `counts` + NEEDS YOU rows, each with a `stateHash` fingerprint of gate + verdict +
   run-state); a changed count or NEEDS YOU hash is a transition — act, then re-arm. Use plain
   `--json` for every row's hash. ~200–260s lets gates accumulate and verdicts land between sweeps.
   (A human can watch a terminal with `captain status --watch`.)

## Auto-pickup loop

**Off by default; arm it explicitly.** Only `/captain loop`, "run the dev loop", or "drain the queue"
turns this on — `/captain loop` caps at **3** active-agent slots, `/captain loop <N>` (or the
natural-language equivalent) sets any positive integer for this session. A plain `captain status` or
`captain TIG-xxx` session never reads the queue and never auto-picks. Armed state is session-local
and holds until the user says stop or the session ends; **stop disarms immediately** — an
already-backgrounded heartbeat that wakes after a stop reads no queue, dispatches nothing, and never
re-arms.

- **Heartbeat: session-preserving rungs only.** Setup's backgrounded-sleep rung (or `ScheduleWakeup`,
  and only when already inside `/loop`). **Never** the `CronCreate` rung — fresh context each tick
  can't carry the explicit arm or per-ticket suppression. No session-preserving rung available → stop
  auto-pickup, surface the error once, leave the fleet untouched.
- **Gates before pickup, every wake.** Derive the fleet with `captain status --json` (full, not
  `--summary` — summary lacks the rows dedupe needs), work the NEEDS YOU batch, _then_ consider
  pickup. A structured status error (`{"error":{"type":"CMUX_UNREACHABLE"}}`) or non-zero exit **fails
  closed** — dispatch nothing, surface once, re-arm.
- **Capacity.** `active` = NEEDS YOU + IN FLIGHT rows (READY rows have finished, so they free a slot
  but still count for dedupe); `available = max(0, cap − active)`. Zero available → skip the Linear
  read entirely, re-arm.
- **Read-only queue read.** `linear__list_issues` (linear-server MCP): team TIG, label `agent-ready`,
  state type unstarted, `orderBy` createdAt, paginated to exhaustion. Sort locally by priority value
  1 (Urgent) → 2 → 3 → 4, then 0/unset last; tiebreak createdAt ascending, then identifier ascending.
  Consider at most the first `available` that pass eligibility. **The driver writes no Linear.**
- **Eligibility — every check before starting anything.** Per candidate: (a) lowercase the
  identifier, skip if any status row's `ticket` matches (NEEDS YOU, IN FLIGHT, _or_ READY); (b) read
  the full description — require `<!-- tiger-agent:contract -->` plus exactly one `**Repo & area:**`
  field carrying exactly one `blstrco/<repo>` token (missing, duplicate, or multi-repo is ambiguous,
  never guessed); (c) require `**Blast radius:** low` exactly (trimmed, case-normalized) — `elevated`
  (money/tax/PII/auth/permissions) is never auto-started, missing/unknown is invalid, **not** low;
  (d) resolve `blstrco/<repo>` to `/Users/mblode/Code/linktree/<repo>` and confirm it's a git checkout
  whose `origin` names that exact GitHub repo — a missing checkout or origin mismatch is a routing
  failure, never a fallback to cwd.
- **Dispatch to capacity.** Group selected ids by verified checkout; one **foreground**
  `captain start <ids…> --repo-path <checkout> --json` per repo — never backgrounded. Validate every
  returned `started[].cwd` against the expected checkout. After each repo batch, re-run
  `captain status --json`, recompute `available`, and truncate the next batch so a partial launch or
  external change can't overfill.
- **Fail closed, recover partials.** No guessed routes, no blind retries. On a launch error re-derive
  status: rows that now exist launched (deduped); report only identifiers with no row, leave them for
  the next heartbeat.
- **Suppress repeat noise (session memory).** Key failures by `<ticket>:<reason>`. A low-blast ticket
  failing the _same_ check on two consecutive wakes: mention once in the next gate batch, then
  suppress while the reason holds; reset when the ticket disappears, becomes eligible, or fails
  differently. Elevated tickets aren't malformed — they're human decisions: offer each once per
  unchanged Contract per session as an explicit `dispatch?` in the gate batch (approval runs the
  normal `captain start`; decline/defer suppresses until the Contract changes or a new loop session
  begins).
- **Re-arm after every wake** — empty, full, partial, or failed-closed — unless the user stopped or
  no session-preserving rung exists.

**Invariants (unchanged):** plan approval stays mandatory for Claude agents; codex stays best-effort
with no plan gate; merge stays human-only; `captain status --json` stays the fleet source of truth;
the driver never writes Linear; test-worker caps are untouched.

## The loop

**Poll by default** once a fleet is running — never ask the human whether to poll, never offer
"ping me when you want an update". Batching gates into one AskUserQuestion keeps them in control.

| You say                                      | Run                                                                                                                                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "status" / "what's blocked" / "what's ready" | `captain status` (`--json`, `--repo`, `--needs`, `--ready` to narrow) — NEEDS YOU / IN FLIGHT / READY, each gate with its resolve command, each PR its merge hint + overlap warnings         |
| "show me the plans"                          | per plan gate, fan out a **read-only subagent** that reads the plan and returns `{summary, scopeDrift, risk, recommendation}`; present the batch — never spend your window on `--scrollback` |
| "approve all plans"                          | `captain approve all` (or comma-separated names, or a repo label)                                                                                                                            |
| "send 404 back: don't touch auth"            | `captain reject tig-404 --note "…"` — replies to the gate _and_ types it into the workspace                                                                                                  |
| "what's verified"                            | `captain status` — READY rows carry `✓ verified`; spot-read `verdict.json`'s criteria before merging                                                                                         |
| "this one's gone quiet"                      | `cmux read-screen --workspace <id>`, then `cmux send --workspace <id> "continue with your workflow\n"` to nudge                                                                              |
| "distill the learnings"                      | edit `~/.claude/captain/memory/<repo>/learnings.md` — promote held-up Inbox bullets to `## Rules`, cut slop; `~/.claude/captain/log.jsonl` has approve/reject notes                          |

**Escalating NEEDS YOU:** batch gated plans into **one** AskUserQuestion — one per gate with its
decision card, options **approve** (`captain approve <ticket>`), **reject-with-note**
(`captain reject <ticket> --note "…"`), **read-more** (deeper subagent, re-ask). Off-script
questions surface the same way, answered verbatim with `cmux send --workspace <id> "…\n"`. One ask
per wake, not per gate.

## Gotchas

- **Wrong dir is the #1 silent failure.** No `--repo-path` fans the worktree into your cwd — a repo
  with none of the ticket's code, whose rubric never passes. Reroute: close the workspace (never a
  group anchor), `git worktree remove --force`, delete the branch, relaunch.
- **Never approve a plan with no decision card behind it** — the read-only subagent reads it first.
- **Never guess off-script questions** — answer verbatim in the workspace, or `reject` if it's a
  plan.
- **Stops at PR-ready** — merging and deploying stay with you.
- **Never trust a one-line verdict** — it gates the _label_, not the merge; spot-read the criteria
  array (a thin one = the verifier was skipped).
- **No daemon** — the heartbeat is step 4's self-re-invoking timer (rung 1 = backgrounded `sleep`);
  a missing scheduling tool is never a reason to stop polling or hand the loop back to the human.
- **Auto-pickup forbids the `CronCreate` rung** — its fresh context each tick drops the explicit arm
  and the per-ticket suppression set, so a loop on cron would silently re-read the queue with no
  memory. Use the backgrounded-sleep rung (or `ScheduleWakeup` inside `/loop`), or don't loop.
- **No lock guards the loop** — arming is session-local, so two armed drivers race the same
  `agent-ready` queue and can double-dispatch a ticket. One armed loop per fleet; stop one the moment
  you spot a second (don't trust worktree reuse to catch it).
- **`cmux send` can silently no-op** (text parked unsubmitted while `status` still reads "working")
  — follow every send with `cmux send-key --workspace <id> enter` and re-read the screen.
- **Verify run-state right after launch** — a launch race leaves a workspace at an empty shell
  (`run=unknown`); relaunch from `/tmp/linear-worktree/<TICKET>/prompt.txt` (match captain's pinned
  tier: `claude --model default --effort high --permission-mode plan --allow-dangerously-skip-permissions
"$(cat …/prompt.txt)"`), and run `captain start` in the **foreground** (backgrounding has returned
  no workspace + a half-made worktree). **Codex workspaces are the exception**: they emit no
  run-state tag, so `run=unknown`/`—` is their normal — read the screen before concluding a race,
  never blind-relaunch a codex row.
- **Workspace ids, not names** — `status` prints the right `cmux` command per row; copy it.
- **Never close an apparent duplicate workspace** — it's likely a group anchor (closing ungroups the
  fleet); a real duplicate means a stale binary, so rebuild instead.
- **Fleet-scale test runs can exhaust the machine.** N agents each spawning an uncapped jest/vitest
  worker pool (default = cores − 1, ts-jest workers grow to 2–3.6GB each) has pushed memory past
  100GB on a 48GB machine and triggered kernel jetsam kills of the whole fleet (Jul 6 incident:
  three concurrent `yarn test` runs ≈ 40 workers). Three layers of defence: every agent launches
  with `VITEST_MAX_THREADS/FORKS=2` in its env (extend via config `.agentEnv`, e.g.
  `{"NODE_OPTIONS": "--max-old-space-size=3072"}`), briefs tell agents to pass `--maxWorkers=2`,
  and fan-out prints a note when the target repo's jest config has no `maxWorkers` cap — jest
  ignores env, so an uncapped repo config is the remaining hole: cap it in the repo
  (`maxWorkers` + `workerIdleMemoryLimit`).

## Reference

- CLI: `captain --help`. Source: `~/Code/mblode/captain/src/captain/` (pure core: `view.ts`
  grouping, `verdict.ts`).
- Low-level cmux verbs: the [`cmux`](../cmux/SKILL.md) skill.
