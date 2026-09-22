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

**Changed:** `status` membership comes from the task folder, not the cmux cwd plus `.captain/`. `start` gains `--harness cursor` (runs the Cursor CLI, `agent`). Stale pipeline names get fixed: `config.ts:23,26` still has `/pr-reviewer` and `/visual-qa`, and `doctor.ts:48` still installs `pr-reviewer`. These become `/tidy` and `/ui-verification`.

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
   - **The default for workers is the cheap tier.** "Medium/low complexity tasks… mostly saturated", so Sonnet 5, GPT-6 Luna or GPT-6 Sol medium do them well.
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
| Bulk implementation (the **default** for workers) | Codex CLI, GPT-6 Sol (`gpt-6-sol`, medium), or GPT-6 Luna (`gpt-6-luna`) for mechanical ports. Claude Code on Sonnet 5 for UI | Generous limits (≤15 concurrent), resets every few days, strict on instructions |
| Review of Claude's PRs | Codex, GPT-6 Sol at high effort (Astra only for the hardest reviews) | "Codex is more thorough". OpenAI says GPT-6 Sol makes about half the mistakes of 5.6 Sol with "Astra-level reliability" at $2/$10 per M tokens, so it replaces Astra as the default reviewer without Astra's Pro cap. Verify in week 1. Never let a reviewer edit tests |
| Review of Codex's PRs | Claude Code, Opus 5.5 | A different vendor catches different mistakes |
| Narrow bugs, frontend fixes, hygiene | Cursor, Grok 4.7 fast | Fast, "good at fixing narrow issues" |
| Hardest architecture calls | Fable 5.1, sparingly | Burns the weekly cap in 2–3 days |

You route each task in 5 seconds on its decision card; the chat only suggests a default. Bake these defaults off in Phase 1, because Opus 5.5 is one day old and the chat's view of Opus 5 was poor. One login per harness, and no proxies.

## Phases and todos

### Phase 0: Captain v3, minimal (3–5 days)
- [x] Copy this plan to `captain/docs/plans/captain-v3.md`, with a `.notes.md` beside it (Deviations, How it ended).
- [x] Task folder format: add `captain init <project>` and `captain add` (from a message or a ticket id). Reuse `source.ts` and `issue.ts`.
- [x] `captain start --harness claude|codex|cursor`: worktree, bootstrap script, cmux workspace, branch `t/<id>-<slug>`. Reuse `git.ts`, `cmux.ts`, `prompt.ts`.
- [x] `captain status`: rows from the task folder plus cmux, git and `gh`. The grouping rule is now `board.ts` `rowOf`, fed through `control.ts`.
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

### Your answers (22 Sep), and what they set

- **Stack: Next.js, TypeScript, Fastify.** This plan assumes the rebuild keeps that stack. If the new stack differs, only the walking-skeleton item changes.
- **Reviewers: you plus 2 others, plus an AI bug bot and auto Stamp.** Three humans can review more than one, so WIP goes 6 in week 1, then 12 from week 2 (see "The month"). Drop it back the day review wait climbs.
  - The risk is your own research: "Now with Stamp everything ends up auto approving anyway". Stamp counts as two approvals, so a Stamped PR may never get a human look. Rules are below.
- **Cutover: gradual, area by area.** Use a strangler at the edge. Each route goes to the old or new system behind a flag, so cutover and rollback are both one flag flip.
- **Staging: yes.** Staging is the parity oracle. Goldens are recorded from staging, so no production data or PII goes into fixtures.

### The month: 100k lines, about 20 working days

The rest of the plan follows from this arithmetic.

- **Reading every line doesn't fit.** Careful review runs at roughly 200–400 lines an hour, in sessions under 90 minutes (the SmartBear/Cisco review study). At 400 lines an hour, 100k lines is about 250 reviewer-hours. Three people with about 4 focused review hours a day for 20 days gives 240 hours. Review alone would take everyone's whole month, with nothing left for the rest of the job.
- **WIP 4 doesn't fit either.** Throughput is WIP divided by cycle time. At about one day per task, 4 in flight means about 4 PRs a day, or 80 in the month. At ~300 lines a PR that's ~24k lines.
- **What does fit** is WIP 12 (three reviewers × 4) from week 2. That's about 12 PRs a day over roughly 16 working days: ~190 PRs and ~55–60k lines. It works only if most PRs are *checked by evidence and skimmed*, not read line by line.

So the month has three rules:

1. **Cut scope before building anything.**
   - Every inventory area gets one label: **delete** (unused: check PostHog and logs), **stay** (works, low churn, stays on the old system behind the edge), **port** (mechanical move, parity-proven) or **rewrite** (the reason for the rebuild).
   - Expect a fair share of **delete** and **stay**.
   - The month's goal is the platform live with the **rewrite** and **port** areas cut over, not 100k lines replaced.
   - The strangler edge means **stay** areas cost nothing to leave.
2. **Evidence replaces line-by-line reading for most PRs.**
   - **port** PRs are merged on evidence: parity green against staging, CI green, verdict and cross-vendor review. Stamp handles them within the Stamp rules.
   - Human reading goes to **rewrite** PRs, **escalate** paths and UI click-throughs.
   - This is where your review hours go, deliberately.
3. **Cut over continuously, not in week 4.**
   - Shadow an area as soon as its parity reaches 100%, then flip it.
   - After day 20, start no new areas. The last week is for flips, fixes and stabilising.

### Timeline

| Days | What | Done means |
|---|---|---|
| 1 | Captain live on your machine. Run the three Phase 0 proofs on real work (the skeleton tasks) | proofs pass |
| 1–2 | Inventory plus usage data, then the delete / stay / port / rewrite label per area, and the area order | "The point" signed off by you |
| 2–5 | Skeleton, CI that checks the real thing, parity harness, strangler edge, guardrails. Run these *as the first fleet tasks* at WIP 6 | a test route flips old to new in staging and back |
| 6–20 | The backlog at WIP 12, area by area in order. Shadow each area as its parity hits 100% | areas cut over one by one |
| 21–22 | Last flips, then freeze new areas | no new area starts |
| 23–27 | Stabilise, roll back anything unhealthy, retire old areas that are fully cut over | error rates at or below the old system's |

The separate bake-off is gone: there isn't time. The first week's real tasks are the bake-off. The chat varies harness and model across the skeleton tasks, and day 5 sets the defaults from what merged cleanly.

### Rules for Stamp and the bug bot

1. **Stamp approves only what Captain already calls READY TO MERGE:** CI green, a passing verifier verdict, and a passing review from the other vendor. Stamp is the last check, not the only one.
2. **Stamp never approves escalate paths:** auth, billing, payments, migrations, deletes, permissions, public API contracts, build and release config. Enforce it with CODEOWNERS on those paths requiring a named human, and with Stamp's own path excludes. Don't rely on the size rule.
3. **Stamp never approves UI changes.** A page or component change needs a human to click through the preview (Dave's UAT point). Exclude `apps/web/**/components` and route files from Stamp, or require a label a human adds after clicking through.
4. **The bug bot is a third reviewer. Check that it earns its place.**
   - At roughly $5 per PR in the chat's numbers, run it on ready-for-review PRs only, not on drafts or every push.
   - After two weeks, compare what it found that the cross-vendor review missed, and keep only the one that catches more.
5. **Stamp's size limit (≤100 lines, ≤2 files) suits small slices.** Keep that limit in the slicing rules, not as a reason to skip review.

### Phase 1: Rebuild ground truth (days 1–5; you think, agents gather)
- [ ] **The point:** one page covering each area's label (delete / stay / port / rewrite), what "parity" means per area, the area order, and the deadline. Done by day 2.
- [ ] **Inventory:** the chat fans out one discovery task per area of the old system into `docs/inventory/<area>.md`:
  - Fastify routes and their schemas;
  - Next.js routes and pages;
  - data model;
  - jobs and queues;
  - integrations;
  - revenue flows.

  Check: every route that `fastify.printRoutes()` lists, and every Next.js route, appears in some inventory file. Each area also gets its 90-day traffic and error counts from PostHog and logs, so the delete and stay labels come from data.
- [ ] **Harness defaults from real work:** no separate bake-off. The chat spreads the week-1 skeleton tasks across GPT-6 Sol, Opus 5.5 and Grok 4.7 (plus GPT-6 Luna on the mechanical ones), and on day 5 sets the defaults from what merged cleanly on the first pass.
- [ ] **Walking skeleton** (codebase-architecture Design mode):
  - A monorepo with `apps/web` (Next.js App Router), `apps/api` (Fastify) and `packages/contracts` (the request and response schemas both apps import).
  - Fastify with a schema type provider, so each route's schema is its contract and its types.
  - One Fastify plugin per module (`handler` / `service` / `dao`).
  - One vertical feature in production behind a flag.
  - AGENTS.md with the `check` / `verify` / `verify:full` tiers and the list of "commands that lie".
- [ ] **CI that checks the real thing:** `verify:full` covers:
  - `next build`;
  - a boot check that builds the Fastify app and awaits `app.ready()` without listening, which catches plugin and route registration errors;
  - the deploy artifact build;
  - e2e smoke.

  Prove it by breaking the Dockerfile and a plugin on purpose and watching CI go red. This is the 21 Aug fix.
- [ ] **Parity harness (from staging):**
  - **API:** record request and response pairs from staging per area. Replay them against the new Fastify app with `app.inject()`: in process, fast, no network. Volatile fields (ids, timestamps) get normalised.
  - **UI:** Playwright flows recorded against staging, replayed against the new app's preview.
  - Parity % per area is what "done" means for that area.
- [ ] **Context without magic:** every worktree gets `../legacy` (the old codebase, read-only), the CLIs `gh`, `linear`, `psql` on a staging read replica, and logs. AGENTS.md says which source answers which question.
- [ ] **Guardrails:**
  - import boundaries between modules;
  - an auth policy on every Fastify route, enforced by an `onRoute` hook that fails startup when a route has none;
  - the blast-radius list (CODEOWNERS plus Stamp excludes, per the rules above);
  - session-start dependency install;
  - worktree port offsets from `CAPTAIN_SLOT` for both apps.

  Prove each one fails on a deliberate violation.
- [ ] **Strangler edge:** a routing layer (Next.js `rewrites` or proxy, or the load balancer) that sends each path to old or new by a per-area flag. Prove it by flipping one test route in staging and back.

### Phase 2: Run the backlog (days 6–20)
- [ ] Give the chat one inventory area at a time, in the Phase 1 order. It slices vertical tasks with real blockers (`planning/references/splitting.md`), sized to fit Stamp's limit where it can. It shows you the epic as one decision card, then files and dispatches the frontier.
- [ ] `captain` WIP 12 (`project.json`), **port** areas first because they're parity-proven and Stamp-eligible, **rewrite** areas alongside at a lower share. Codex runs overnight on reset windows. The morning summary is the merge queue for all three reviewers, split by who reads what (rewrite, escalate and UI to humans).
- [ ] Every PR must have:
  - CI green;
  - the cross-vendor review passed;
  - parity for its area not regressed.

  UI PRs also need a preview URL plus a Playwright video that a human clicks through. Stamp only within the rules above; everything else gets a human merge.
- [ ] **Daily, 10 minutes** (a month is too short for weekly): review wait, reverts, main-red time, parity % by area, and Stamp's share of merges. Change one thing: WIP, a harness default, or a learning promoted into `## Rules`. If an area's parity stalls for two days, relabel it **stay** and move on.

### Phase 3: Cutover, per area (continuous from about day 10; flips end day 22)
- [ ] **Shadow first:** for an area at 100% parity on staging, run shadow reads in production. The new Fastify handlers get a copy of each read request, and responses are compared and logged, never returned. Fix diffs until a week is clean.
- [ ] **Flip the area's flag** for a small share of traffic, then all of it. Rollback is the same flag, proven in staging first. An agent watches the rollout for this cutover only (graphs, error rates, and a rollback recommendation you act on).
- [ ] **Human UAT pass** on the area's key flows before the full flip.
- [ ] **Data:** expand, then migrate, then contract, with a restore drill on a production snapshot before the first real move. Migrations are always escalate tasks.
- [ ] Retire the old area, then repeat.

## Verification
- **Captain:** `npm run lint && npm test && npm run build` in `captain/`, plus the three Phase 0 proofs above, run live.
- **Rebuild:** the deliberately broken Dockerfile goes red, parity replay fails on a changed response shape, and each guardrail fails on a deliberate violation.
- **Fleet health, weekly:** queue wait stays flat as WIP rises. If it doesn't, WIP goes back down.

## STOP conditions
- A harness can't run headless in cmux under its plan → use it by hand for now. Don't use proxies.
- Staging responses can't be recorded without PII, or staging has drifted too far from production to be the oracle → redesign parity before Phase 2.
- The review queue is over capacity for 2 days → freeze new starts, and don't add agents.
- Day 15 and projected cutover covers under half of the rewrite and port areas → cut scope with the team that day (relabel areas as **stay**). Don't raise WIP past review capacity to catch up.

## Assumptions and open questions
- **Verified this session:**
  - the v2 files named above exist;
  - the stale names are at `config.ts:23,26` and `doctor.ts:48`;
  - the release facts come from the vendor pages fetched 22 Sep (the OpenAI and x.ai/bot pages returned 403 and were covered from search).
- **Unverified:**
  - whether the Cursor CLI (`agent`) and `codex` run headless in cmux under your plans at the concurrency you need (their flags were checked against `--help` and docs on 22 Sep, but not run live);
  - whether Remote Control works on a long-lived cmux-hosted session;
  - how good Opus 5.5 is on your code.
- **Answered 22 Sep:** Next.js + TypeScript + Fastify; you plus 2 reviewers, an AI bug bot and auto Stamp; gradual cutover; staging exists (see "Your answers").
- **Answered 22 Sep:** 100k lines, one month.
- **Still open:** the area order and each area's delete / stay / port / rewrite label. Both go in "The point" in Phase 1, by day 2.
