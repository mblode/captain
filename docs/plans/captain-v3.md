# Captain from first principles (Sep 2026), built to run the Series A rebuild

## The ask, restated from your messages
1. If you built Captain today from nothing, what would it be, given what the new models can do?
2. It has to carry a from-scratch rebuild of a Series A codebase with a huge backlog, on Cursor Ultra, ChatGPT Pro and Claude Max 20x.
3. **One lightweight, local chat, like Grok Bot.**
   - You send it tickets and messages.
   - It keeps the task list itself and kicks work off.
   - It fans out to full code harnesses, and you can check in on it.
4. Keep cmux. No GitHub Actions. Weigh Pi, Eve and Claude Code + cmux, and say whether Slack + Devin or Cursor would be better.
5. Deliver a plan with phases and todos, grounded in the chat (Jul–Sep) and in the beyond-the-hype research.

## Where the last draft lost the plot (holistic audit)
- **It built an enterprise workflow engine for one person.** It had typed evidence edges, intent-then-effect events, lock files, launchd, pure-core modules, route tables and stall detectors. That's 25+ Captain slices before any rebuild work. Captain is the means; the rebuild is the goal. Captain v3 should take days.
- **It ignored the first principle in the question: the models changed.**
  - Opus 5.5 stays on task for 18h, "delegates to subagents far more effectively and checks its own work", and uses half the tokens.
  - Grok Bot is loved because it "just does stuff for me in the background" (you, 31 Aug).
  - Orchestration judgment now belongs to the model. Code should only do what a model can't be trusted to do.
- **It contradicted you.** You said "the agent should maintain and handle" the task list, and the draft added a hook stopping the chat from writing it.
- **It piled up layers from each round of feedback** (a control repo, leftover Actions, cloud adapters, audit tables for drafts that no longer exist) and buried the answer.
- **The rebuild itself was generic.** The rebuild's real risks are knowing when it's done (parity with the old system) and review throughput, not orchestration.

The simple rule that replaces all of that: **"Start simple. Adopt complexity as needed. Agents LOOOOVE Bash tool calls."** (Josh, 1 Sep). Plus Raethke's warning (11 Sep): the system, not the coordinator's memory, has to know where each task is up to. Files and live signals give that for free.

## The answer: Captain v3 is your local Grok Bot for code

Three parts, all local, all files and CLIs:

**1. The chat (brain).**
- One long-lived Claude Code session named `captain`, on Opus 5.5, in its own cmux workspace. A `/captain` skill gives it its persona and rules: brief, decisions only, like Grok Bot.
- You talk to it in the terminal, or from your phone with Remote Control (on by default since 22 Aug). You paste a ticket id or just say "rebuild billing settings, same behaviour as the old app".
- It shapes the task and writes it to the list. Anything risky becomes a one-screen decision card for you. Then it starts workers, watches them, re-prompts ones that stall, and reports back only what needs you.
- It wakes on `/loop` or CronCreate, as in v2's `references/heartbeat.md`. It holds nothing in its head: every wake starts from `captain status`.

**2. The task list (memory).**
- A folder of plain markdown files in a small local git repo: `~/captain/<project>/tasks/<id>.md`.
  - Frontmatter: status, blockers, risk, harness/model.
  - Body: contract, then plan, then deviations.
- Plus `learnings.md` (v2 `memory.ts`).
- **The agent maintains it**, you can read and edit it, and git gives history and undo. Tickets from Linear or Done Bear get copied in with a link back (v2 `source.ts`).
- If the team later needs to see the list, sync it to Linear. Tom's "Linear is right there" still stands. For a solo rebuild, files are faster.

**3. The hands (the `captain` CLI, shrunk).** The chat calls a few deterministic commands:
- `captain start <task> --harness claude|codex|cursor --model --effort`:
  - makes a worktree plus bootstrap (deps, env, port offset);
  - opens a cmux workspace;
  - launches the full harness with the brief;
  - uses the branch `t/<id>-<slug>`.
- `captain status [--json]`: each task's live state, built fresh from cmux (busy/idle, plan waiting), git and `gh` (PR, CI, review). This is v2's derived view, so it can't drift from reality.
- `captain approve|reject <task> --note`: the plan gate for risky tasks, through the cmux feed. Every decision is logged.
- `captain send <task> "<msg>"`: steer a worker.

**What code guarantees, because a model shouldn't be trusted with it:**
1. **One worktree per task.** Isolation plus bootstrap, which fixes v2's gaps with missing `node_modules`, OOM from parallel test pools and wrong-repo launches.
2. **Status from evidence, not claims.** A worker saying "done" means nothing. Done means a PR exists, CI is green and the cross-vendor review has passed. `captain status` reads these directly.
3. **A plan stop for risky work.** Auth, billing, data migrations, deletes, public contracts and build or release config start in Claude Code plan mode, and you approve before any code gets written.
4. **WIP limit = your review capacity.** `captain start` refuses once the number of PRs waiting on you reaches the limit (starting at 4: "4 Claudes at a time is my max ability"). This matters most, because review is the ceiling: AI PRs wait about 5x longer (LinearB), and past capacity the wait grows as 1/(1−ρ).
5. **You merge.** Every time at first. Only a tier the ledger shows is safe gets auto-merged later.

**Kept from v2 as-is:** `source.ts`, `linear.ts`, `donebear.ts`, `issue.ts` (blockers), `git.ts` (worktree and lock), `cmux.ts` + `captain/control.ts` (cmux port, approve/reject), `prompt.ts` (brief), `memory.ts`, `captain/log.ts`, `captain/gain.ts`, `errors.ts`, `config.ts`. Also kept: the rubric and verdict (`rubric.ts`, `captain/verdict.ts`), as the reviewer's checklist.

**Changed:** `status` membership comes from the task folder, not the cmux cwd plus `.captain/`. `start` gains `--harness cursor` (runs `cursor-agent`). Stale pipeline names get fixed: `config.ts:23,26` still has `/pr-reviewer` and `/visual-qa`, and `doctor.ts:48` still installs `pr-reviewer`. These become `/tidy` and `/ui-verification`.

**Not built unless it's needed.** Each of these has a trigger that justifies adding it:

| Thing | Add it when |
|---|---|
| launchd tick so the fleet runs while the chat is dead | The chat has died or compacted mid-run and a task sat idle for hours |
| Stall detector in code | The chat misses a Codex "next step is… and stops" more than once a week |
| Main-red brake in code | Main breaks with agents still dispatching (the 21 Aug failure) |
| Jev for triage only (never model routing) | Intake volume outgrows your 5-second read of each decision card |
| Slack or WhatsApp inbox (Slack Code channels, or your eve template) | Remote Control isn't enough on your phone |
| Pi as the chat harness | You need two vendors inside one task loop, with non-Claude-subscription auth |

## What Dave Slutzkin's posts (OpenAI's "agentic software factory", 16–17 Sep) change

OpenAI's loop is:
1. A human defines the outcome.
2. Codex writes the code.
3. CI (build, test, perf harness) runs.
4. Specialist reviewers check it in parallel and classify the risk.
5. Low-risk changes deploy with an agent watching the rollout. Everything else goes to a human reviewer.
6. In production, Sevbot and a Perf Factory watch for problems.

Captain v3 already has that shape, run locally and on flat plans. Four lessons change the plan:

1. **You choose the model, not an automatic router.** Dave: automatic model routing "fails to pick right almost half the time". An experienced human takes 5 seconds because they already have the context. So there's no route table, and Jev is dropped from the "later" list for routing.
   - The chat puts a default harness and model on each decision card, and you override it with one word ("hard", "codex", "cursor").
   - **The default for workers is the cheap tier.** "Medium/low complexity tasks… mostly saturated", so Sonnet 5, Luna or Sol medium do them well.
   - Frontier models (Opus 5.5 high, Astra, Fable) are reserved for the chat itself, for slicing epics, for reviewing escalate-tier work, and for tasks you tag "hard".
2. **No separate budget per model.** Those end with people either never using the powerful model or burning through it early. The single rule above replaces budgets. `captain status` shows how much of each plan is used, so you see a limit coming before you hit it.
3. **No context magic.** OpenAI gives agents many data sources and lets them choose what to pull, with no RAG in between. Captain does the same:
   - every worktree gets the old codebase checked out read-only at `../legacy`;
   - workers get the CLIs they need (`gh`, `linear`, `psql` against a read replica, a log CLI);
   - AGENTS.md says what each source is for.
   - No vector store and no context layer.
4. **User-facing changes still need a human to click through.** Dave doesn't believe UI changes ship well without it. For any PR that changes a page or component, part of "done" is a preview URL plus a Playwright video, and you click through it before merging. Cutover of each area includes a UAT pass.

**What not to copy yet: agentic deploy, Perf Factory, Sevbot.** Dave's point is that ops loops use a lot of tokens ("Sessions get deep quick") and could only be afforded with free tokens. Run the cheap versions on Cursor Ultra's separate allowance, as automations you already have:
- CI failure doctor;
- PostHog errors;
- flake stabiliser;
- perf and accessibility guard.

Add an agent that watches the deploy only for the cutover of each area, where days of monitoring actually pay for themselves. Keep your Claude and ChatGPT plans for building.

## Which harness for the chat
**Claude Code + cmux, as you run it now.** The logic lives in the CLI and the skill, so changing the chat's harness later is cheap.
- **Pi:** a great "manual car", and it's the best at mixing models inside one session (Raethke runs 6 features on Claude 20x + Pro).
  - You'd rebuild plan mode, Remote Control and hooks yourself.
  - Running your Claude Max plan through a third-party harness is the account risk people raised (11 Sep).
  - Captain gets model mixing anyway, by sending each task to a separate full harness.
- **Eve:** runs on Vercel Functions, Workflows and Sandbox, so it isn't local and can't drive cmux. It's still a good *front door* later (your WhatsApp template).
- **Slack + Devin:** cloud-only, billed outside your three plans, and your own data shows 17% of Devin PRs ghosted plus a wrong root cause called at 90% confidence. Skip it.
- **Cursor Projects:** the closest ready-made "one chat that fans out", but it's cloud-only, uses only Cursor Ultra, and was the harness behind 21 Aug (100 PRs, main broke twice). Use Cursor as a **worker** (`--harness cursor`, Grok 4.7 fast for narrow fixes) and for your 17 hygiene automations.

## Who does what (the three plans)
| Job | Harness / model | Why (chat evidence) |
|---|---|---|
| The `captain` chat, specs, slicing, UI | Claude Code, Opus 5.5 (high) | Leads on long-horizon and delegation. "Keep UI in Claude" |
| Bulk implementation (the **default** for workers) | Codex CLI, GPT-5.6 Sol (medium) or Luna. Claude Code on Sonnet 5 for UI | Generous limits (≤15 concurrent), resets every few days, strict on instructions |
| Review of Claude's PRs | Codex, Astra (low/medium) | "Codex is more thorough". Never let Astra edit tests ("throws away the guardrails") |
| Review of Codex's PRs | Claude Code, Opus 5.5 | A different vendor catches different mistakes |
| Narrow bugs, frontend fixes, hygiene | Cursor, Grok 4.7 fast | Fast, "good at fixing narrow issues" |
| Hardest architecture calls | Fable 5.1, sparingly | Burns the weekly cap in 2–3 days |

You route each task in 5 seconds on its decision card; the chat only suggests a default. Bake these defaults off in Phase 1, because Opus 5.5 is one day old and the chat's view of Opus 5 was poor. One login per harness, and no proxies.

## Phases and todos

### Phase 0: Captain v3, minimal (3–5 days)
- [x] Copy this plan to `captain/docs/plans/captain-v3.md`, with a `.notes.md` beside it (Deviations, How it ended).
- [x] Task folder format: add `captain init <project>` and `captain add` (from a message or a ticket id). Reuse `source.ts` and `issue.ts`.
- [x] `captain start --harness claude|codex|cursor`: worktree, bootstrap script, cmux workspace, branch `t/<id>-<slug>`. Reuse `git.ts`, `cmux.ts`, `prompt.ts`.
- [x] `captain status`: rows from the task folder plus cmux, git and `gh`. Reuse `view.ts` `rowOf` and `control.ts`.
- [x] WIP limit check in `start`, one config number.
- [x] Fix the stale skill names (`config.ts:23,26`, `doctor.ts:48`).
- [x] Rewrite `skills/captain/SKILL.md` as the Grok-Bot-style chat:
  - persona;
  - the message-to-task flow;
  - the decision-card format;
  - the heartbeat;
  - cross-vendor review as part of what "done" means for a task;
  - a morning and evening summary.
- [ ] **Proof:**
  - message the chat one real task and it goes to a merged PR;
  - kill the chat mid-run, start a new one, and it picks up from `captain status` with nothing lost;
  - with 4 PRs waiting on you, `start` refuses.

### Phase 1: Rebuild ground truth (week 1–2; you think, agents gather)
- [ ] **The point:** one page covering scope, what "parity" means, what's out, the cutover style and the deadline. "At some point you have to think" (your talk title).
- [ ] **Inventory:** the chat fans out discovery tasks, one per area of the old system (routes, data, jobs, integrations, revenue flows), into `docs/inventory/`. Check: every old route appears in some inventory file.
- [ ] **Bake-off:** 10 real tasks × {Sol, Opus 5.5, Grok 4.7}, each reviewed by the other vendor. Score quality, speed and plan usage, and set the table above from the results.
- [ ] **Walking skeleton** (codebase-architecture Design mode, `stack-defaults.md` unless the old system forces something else):
  - modular monorepo;
  - one vertical feature in production behind a flag;
  - AGENTS.md with the `check` / `verify` / `verify:full` tiers and the list of "commands that lie".
- [ ] **CI that checks the real thing:** `verify:full` builds the deploy artifact and runs a boot check and e2e smoke. Prove it by breaking the Dockerfile on purpose and watching CI go red. This is the 21 Aug fix.
- [ ] **Parity harness:** record golden request/response pairs and Playwright flows from the old system and replay them against the new one per area. Parity % is what "done" means for each area.
- [ ] **Context without magic:** every worktree gets `../legacy` (the old codebase, read-only) and the CLIs `gh`, `linear`, a read-replica `psql` and logs. AGENTS.md says which source answers which question.
- [ ] **Guardrails:** import boundaries, auth policy per route, a blast-radius list (what escalates to a plan stop), session-start dependency install, worktree port offsets. Prove each one fails on a deliberate violation.

### Phase 2: Run the backlog (weeks 2–N)
- [ ] Give the chat one inventory area at a time. It slices vertical tasks with real blockers (`planning/references/splitting.md`), shows you the epic as one decision card, then files and dispatches the frontier.
- [ ] Start at WIP 4, low-risk tasks only. Codex runs overnight on reset windows. The morning summary is your merge queue.
- [ ] Every PR: CI green, cross-vendor review passed, parity for its area not regressed. UI PRs also need a preview URL plus a Playwright video that you click through. Then you merge.
- [ ] Weekly, 15 minutes: `captain gain` (queue wait, first-pass rate, reverts, main-red time, parity % by area). Change one thing: WIP, a route, or promote a learning into `## Rules`. Add something from "not built unless needed" only when its trigger has fired.

### Phase 3: Cutover, per area
- [ ] An area at 100% parity, plus a shadow or dual run where it's safe, and a human UAT pass, gets its flag flipped. Rollback is proven in staging first. An agent watches the rollout for that cutover only (graphs, error rates, rollback if needed).
- [ ] Data moves expand, then migrate, then contract, with a restore drill on a production snapshot before the first real move.
- [ ] Retire the old area, then repeat.

## Verification
- **Captain:** `npm run lint && npm test && npm run build` in `captain/`, plus the three Phase 0 proofs above, run live.
- **Rebuild:** the deliberately broken Dockerfile goes red, parity replay fails on a changed response shape, and each guardrail fails on a deliberate violation.
- **Fleet health, weekly:** queue wait stays flat as WIP rises. If it doesn't, WIP goes back down.

## STOP conditions
- A harness can't run headless in cmux under its plan → use it by hand for now. Don't use proxies.
- The old system can't be recorded for goldens (no staging, or PII you can't scrub) → redesign parity before Phase 2.
- The review queue is over capacity for 3 days → freeze new starts, and don't add agents.

## Assumptions and open questions
- **Verified this session:**
  - the v2 files named above exist;
  - the stale names are at `config.ts:23,26` and `doctor.ts:48`;
  - the release facts come from the vendor pages fetched 22 Sep (the OpenAI and x.ai/bot pages returned 403 and were covered from search).
- **Unverified:**
  - whether `cursor-agent` and `codex` run headless in cmux under your plans at the concurrency you need;
  - whether Remote Control works on a long-lived cmux-hosted session;
  - how good Opus 5.5 is on your code.
- **Open, and these change Phase 1:**
  - the stack and size of the Series A codebase;
  - who else reviews (which sets WIP);
  - strangler vs big-bang, and the deadline;
  - whether staging exists.
