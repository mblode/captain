---
name: captain
description: Conduct a fleet of cmux worktrees — fan out Linear/donebear tickets as self-driving agents, then surface what needs you. Use when asked to "conduct my fleet", "fan out these tickets", "start this ticket", "run these on codex", "what's blocked across my agents", "approve all the plans", "show me the plans", "what's ready to merge", "start the captain", "run the dev loop", or "drain the queue".
---

# Captain

**IS:** conducting a fleet via the `captain` CLI — fan out tickets, poll `captain status`,
batch plan approvals and off-script questions into human decisions, nudge stalled agents,
distill fleet memory. **IS NOT:** typing low-level cmux verbs by hand (use
[`cmux`](../cmux/SKILL.md)) or running any pipeline step yourself — the agent self-drives
plan → implement → `/tidy` → `/pr-reviewer` → `/pr-creator` → `/pr-babysitter` → verdict.
The driver is a long-lived Claude Code session, not a human at a keyboard; Captain keeps
**no state** (`status` derives live from cmux + each worktree's `.captain/`).

`/tidy` and `/pr-reviewer` are separate configured stages; never treat one as a
replacement for the other.

## References

Load only when the condition applies:

| Reference | Read when |
|---|---|
| [references/heartbeat.md](references/heartbeat.md) | A fleet is running and you need to poll — the rung ladder and the `--since` snapshot protocol |
| [references/auto-pickup.md](references/auto-pickup.md) | The user has **explicitly armed** `/captain loop` / "run the dev loop" / "drain the queue" |

## Mental model

- **Agents self-drive** the whole pipeline; do not send routine "continue" prompts. Answer
  a real gate, deliver rejection feedback, or nudge only after `status` plus a screen read
  provides evidence of a stall.
- **Status is stateless**, derived fresh each call: membership = a cmux workspace whose
  cwd has a `.captain/` dir; busy/idle = `cmux top` run-state tags; gates = the newest
  _unresolved_ feed item per cwd; done = a hash-checked `.captain/verdict.json`. Re-run
  any time — nothing desyncs.
- **Human gates**: Claude plan approval (mandatory — implementation never starts
  un-approved), questions/blocked agents, and the merge. Everything else flows on its own.
  A codex agent has no plan mode, so its fleet has **no plan gate** — `approve`/`reject`
  have nothing to reply to; its brief tells it to plan then proceed.
- **Verdict gate**: fan-out writes the definition of done to `.captain/rubric.md`; the
  agent's fresh-context verifier writes `.captain/verdict.json` citing the rubric's hash.
  A valid pass shows READY with `✓ verified`; a fail → NEEDS YOU and its summary; no
  verdict → in flight. A criterion may also be `na` (cannot apply to this diff) — neither
  a pass nor a failure.
- **Fleet memory**: `~/.claude/captain/memory/<repo>/learnings.md` (shared per repo) —
  fan-out injects `## Rules` + the recent `## Inbox`; agents append verified learnings at
  end of run.

## Setup

1. **Prereqs:** `captain install` adds the pipeline skills (`/pr-reviewer`, `/pr-creator`,
   `/pr-babysitter` from `mblode/agent-skills`; `/tidy` lives there too but isn't fetched
   by `captain install`) and checks node, git, claude, cmux, `LINEAR_API_KEY`. If the CLI
   is missing: `npm i -g cmux-captain`, or `npm run build && npm link` from a checkout.
2. **Route each ticket semantically.** Your cwd is almost never the ticket's repo, and
   **nothing picks it for you** — a team spans repos, a project spans repos (Pulse v0
   lives in linkiq, chat _and_ frontyard), some tickets carry no project. Read the ticket
   (description, the code paths/symbols it names, its linked PRs) to decide which repo the
   work touches — grep candidates when thin — then pass `--repo-path <repo>`.
3. **Fan out:** group tickets by repo, one `captain start <ids…> --repo-path <repo>` per
   repo (one worktree + workspace + self-driving agent each). `start` is implicit, so bare
   `captain TIG-430` works — though a single non-issue word is treated as a typo'd
   subcommand and errors. A non-issue arg starts a free-form task in the current checkout.
   `--base <ref>` stacks on a prerequisite branch. **Confirm each `started[].cwd`**
   (`--json`) before approving any plan — a worktree in the wrong repo can never pass its
   rubric.
   - `--print` prepares and writes/prints the brief without launching. Not a dry-run, and
     multiple issue ids are rejected.
   - Each agent launches on a **pinned model + effort** (default `default` / `high`), so
     it never inherits your driver's tier — override per fleet with `CAPTAIN_MODEL` /
     `CAPTAIN_EFFORT` (or config `.model` / `.effort`).
   - `--agent codex` (or `CAPTAIN_AGENT` / config `.agent`) is **best-effort**: full
     autonomy, an adapted brief (plan then proceed), no plan gate.
4. **Arm the heartbeat** — see [references/heartbeat.md](references/heartbeat.md). Never
   hand polling back to the human.

## The loop

**Poll by default** once a fleet is running — never ask the human whether to poll, never
offer "ping me when you want an update". Batching gates into one AskUserQuestion keeps
them in control.

| You say | Run |
| --- | --- |
| "status" / "what's blocked" / "what's ready" | For a known run, `captain status <ticket-or-workspace…> --json`; add `--summary` for polling. Use unfiltered `captain status` only when the request is fleet-wide. `--repo`, `--needs`, and `--ready` also narrow — never fetch the full fleet merely to post-filter it. |
| "show me the plans" | Send up to the bounded batch below to **one read-only reviewer** per heartbeat; it returns one compact `{ticket, summary, scopeDrift, risk, recommendation}` decision card per plan. Deep-read only plans it flags high-risk or ambiguous — never spend your window on `--scrollback` |
| "approve all plans" | `captain approve all` (or comma-separated names, or a repo label) |
| "send 404 back: don't touch auth" | `captain reject tig-404 --note "…"` — replies to the gate _and_ types it into the workspace |
| "what's verified" | `captain status` — READY rows carry `✓ verified`; spot-read `verdict.json`'s criteria before merging |
| "this one's gone quiet" | `cmux read-screen --workspace <id>`, then `cmux send --workspace <id> "continue with your workflow\n"` to nudge |
| "distill the learnings" | Edit `~/.claude/captain/memory/<repo>/learnings.md` — promote held-up Inbox bullets to `## Rules`, cut slop; `~/.claude/captain/log.jsonl` has approve/reject notes |

**Escalating NEEDS YOU:** once per heartbeat, give pending plan gates to **one read-only
batch reviewer** with the ticket, repo, and captured plan for each gate. Bound a batch to
at most 8 plans, 6,000 input characters per plan, and 24,000 total, in status order; leave
overflow pending for the next heartbeat and mark a truncated plan ambiguous. It returns
one decision card of at most 80 words per gate. Spend a deeper review only on a card
marked high-risk or ambiguous, or when the human selects **read-more**. Then batch the
cards into **one** AskUserQuestion — one decision per gate, options **approve**
(`captain approve <ticket>`), **reject-with-note** (`captain reject <ticket> --note "…"`),
**read-more** (deeper subagent, re-ask). Off-script questions surface in that same ask and
are answered verbatim with `cmux send --workspace <id> "…\n"`. One reviewer and one ask
per wake, not per gate.

## Gotchas

- **Wrong dir is the #1 silent failure.** No `--repo-path` fans the worktree into your cwd
  — a repo with none of the ticket's code, whose rubric never passes. Reroute: close the
  workspace (never a group anchor), `git worktree remove --force`, delete the branch,
  relaunch.
- **Never approve a plan with no decision card behind it** — the read-only batch reviewer
  reads it first; high-risk or ambiguous cards get a deeper second read.
- **Never guess off-script questions** — answer verbatim in the workspace, or `reject` if
  it's a plan.
- **Stops at PR-ready** — merging and deploying stay with you.
- **Never trust a one-line verdict** — it gates the _label_, not the merge. Spot-read the
  criteria array: a thin one means the verifier was skipped, and a criterion whose `name`
  doesn't match the rubric's wording means the bar was softened.
- **`cmux send` can silently no-op** (text parked unsubmitted while `status` still reads
  "working") — follow every send with `cmux send-key --workspace <id> enter` and re-read
  the screen.
- **Verify an unknown run-state before retrying.** `run=unknown`/`—` means no live cmux
  tag was observed, regardless of agent. Read the screen first. If it's an empty shell,
  rerun the same original `captain start` command in the foreground, including its
  repo/base/agent options — Captain's idempotent retry path handles the prepared worktree.
  Never reconstruct a hard-coded launch from `prompt.txt` or blind-relaunch.
- **Workspace ids, not names** — `status` prints the right `cmux` command per row; copy it.
- **Never close an apparent duplicate workspace** — it's likely a group anchor (closing
  ungroups the fleet); a real duplicate means a stale binary, so rebuild instead.
- **Fleet-scale test runs can exhaust the machine.** N agents each spawning an uncapped
  jest/vitest worker pool (default = cores − 1, ts-jest workers reach 2–3.6GB each) pushed
  memory past 100GB on a 48GB machine and triggered kernel jetsam kills of the whole fleet
  (Jul 6 2026: three concurrent `yarn test` runs ≈ 40 workers). Three layers of defence:
  every agent launches with `VITEST_MAX_THREADS/FORKS=2` in its env (extend via config
  `.agentEnv`, e.g. `{"NODE_OPTIONS": "--max-old-space-size=3072"}`), briefs tell agents
  to pass `--maxWorkers=2`, and fan-out prints a note when the target repo's jest config
  has no `maxWorkers` cap. **Jest ignores env**, so an uncapped repo config is the
  remaining hole: cap it in the repo (`maxWorkers` + `workerIdleMemoryLimit`).

## Reference

- CLI: `captain --help`. Source: `~/Code/mblode/captain/src/captain/` (pure core:
  `view.ts` grouping, `verdict.ts`).
- Low-level cmux verbs: the [`cmux`](../cmux/SKILL.md) skill.
