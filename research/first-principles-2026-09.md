# Captain from first principles — against the September 2026 state of the art

## Context

Five references arrived together, and the question they raise is the blunt one: if you
sat down today and designed captain from nothing, knowing what the platforms now ship,
what would you build — and does the thing in this repo still earn its place?

- **Claude Projects, redesigned** (`claude.com/blog/projects-redesigned`): "Projects have
  threads that do the work and a coordinator that directs them." Each thread is a Claude
  Code cloud session on its own branch; the coordinator scopes, delegates, reviews and
  assembles. "Every thread now adds to and draws from a shared memory." Claude "creates
  pull requests, runs tests, and manages merge conflicts."
- **Cursor Projects** (`cursor.com/blog/projects`): the same shape, stated as a thesis —
  a coordinator that "doesn't execute code but directs other agents that do", so it "is
  never blocked". Three pillars: a cloud computer per Project ("closing your laptop doesn't
  stop it"), persistent shared context ("agents add research and artifacts, along with what
  they learn about the codebase and how you prefer work to be done"), and **proactive
  subscriptions** — a coordinator can "watch a Slack channel, run on a schedule, or follow
  all your PRs". The headline metric: users who mainly use Projects "merge six times as
  many" PRs.
- **Grok Bot** (`x.ai/bot`, Sept 3 2026; page is behind a challenge, read via InfoQ and the
  xAI release notes): "Bots are persistent agents with their own identity, memory, runtime,
  and tools", with Routines for scheduled work, group chats between bots, computer access,
  and a return to the human "when approval or a decision is required". Grok Build (Sept 16)
  added cross-session memory with `/memory` and `/dream`.
- **GPT-6 Astra** (`openai.com/index/gpt-6-astra`, Sept 3 2026; same access note): the
  Codex-relevant change is "an experimental context mechanism … that allows the agent to
  maintain notes across context windows instead of relying only on compaction", with
  earlier windows searchable. Hallucination rate reported at 4.2% against 12.2% for its
  predecessor — and OpenAI's own caveat that Astra's "written reasoning [is] harder to
  monitor than its predecessor".
- **TypeSafe's Jev** (`typesafe.ai`, the skill at `typesafe-ai/skills`): a "System One"
  model that does not generate text. You define the shape of the answer — a yes/no (Noul),
  a pick from a set (Choice), a position on ordered levels (Score) — and it returns
  calibrated probabilities over it, many questions per call in parallel. Their pitch:
  "smart if-statements", 20–200× faster and 40–1,000× cheaper than a reasoning model on
  tasks that need instinctive judgment over large text, honest that it is "not good at
  System 2 tasks". List price: $0.042 per million input tokens, output free
  (docs.typesafe.ai/models, `jev-1.13.0`).

The first four are the same product drawn four times: a **persistent, hosted, stateful
coordinator** with shared memory, proactive triggers, and the human "checking in where
attention is needed". That is, almost word for word, the watcher-daemon architecture
captain deleted in June 2026 (`research/PLAN.md`, `research/builderbot-audit.md`) — now
offered by every frontier vendor as the default way to run a fleet. The fifth is a new
kind of primitive that none of them use.

This document does the from-scratch design, states where captain still brings value and
where it no longer does, sorts every capability the references offer, and records what
was built from it: one opt-in command that puts Jev at the single point in captain's loop
where a System One judgment fits.

## TL;DR verdict table

| # | Capability (source) | Verdict | One-line reason |
|---|---|---|---|
| 1 | **Coordinator + parallel worker threads** (Claude/Cursor Projects) | **ALREADY HAVE, inverted** | The `/captain` skill is the coordinator; worktrees are the threads. Captain's coordinator is a *session*, not a *service* — the whole difference |
| 2 | **Shared, evolving project memory** (all four) | **ALREADY HAVE** | `memory.ts` fleet memory, injected per brief; human-curated Rules is a chosen trust boundary the platforms do not offer |
| 3 | **Human on the loop at decision points** (all four) | **ALREADY HAVE, stronger** | The plan gate is a hard stop (`--permission-mode plan`) an agent cannot pass itself; Projects' "check in where attention is needed" is advisory |
| 4 | **PR creation, tests, conflict handling by the agent** (Claude Projects) | **ALREADY HAVE** | The self-drive `<workflow>` + `/pr-creator` + `/pr-babysitter`; captain stops at PR-ready by design |
| 5 | **Persistent cloud runtime** ("closing your laptop doesn't stop it") | **REJECT — non-goal** | Captain is local and stateless on purpose; the hosted coordinator is the daemon class deleted June 2026 |
| 6 | **Proactive subscriptions** (Slack channel, schedule, follow PRs) | **REJECT — decided** | Needs a persistent listener; a cron shelling out to `captain "<task>"` covers the schedule case with zero code (`research/ai-native-sdlc-playbook-audit.md` #12) |
| 7 | **Bot-to-bot group chat / shared threads** (Grok Bot) | **REJECT — decided** | `research/cross-session-messaging-audit.md`: messaging is not a control plane |
| 8 | **Notes across context windows** (GPT-6 Astra / Codex) | **N/A — agent-internal** | Captain owns none of the agent's context; its equivalent is that `.captain/plan.md` + rubric survive any compaction because they are files |
| 9 | **Merged-PR count as the success metric** (Cursor's 6×) | **REJECT — decided** | `gain` counts decisions, verdicts, latency and rework, not throughput — `research/agent-swarm-economics.md` explains why |
| 10 | **A calibrated System One judge at the plan gate** (Jev) | **ADOPT — built** | `captain triage`: the driver's bounded, frontier-model plan review was System 2 spent on System 1 work |
| 10a | **Objective → parallel work without a tracker** (Projects/Cursor) | **ADOPT — built** | Free-form tasks get worktrees, several fan out; the driver decomposes and shows the split first |
| 10b | **"What changed" + "next run due"** (Cursor, Grok Build dock) | **ADOPT — built** | `status --since` returns a deterministic `digest`; every wake ends with it and the next check time |
| 10c | **The decision card quotes a named plan section** (Grok inline cards) | **ADOPT — built** | `## Decisions for the reviewer` at the top of every plan |
| 10d | **Graduated trust as review confidence builds** (Cursor migrations) | **ADOPT — built** | `gain.rework.firstPassStreak` per repo; the batching rule lives in the skill, the human still approves |
| 10e | **"Same mistake twice → a rule"** (Cursor gardening) | **ADAPT — built as a nudge** | `gain.memory.recurring` ranks Inbox traps for the human; promotion stays human |
| 11 | **Jev for repo routing** (which checkout does this ticket touch) | **ADAPT — not now** | The auto-pickup contract already routes deterministically; a judgment only helps tickets with no contract, and the failure mode is the #1 silent one |
| 12 | **Jev for verdict-evidence checking** (does the evidence support the pass) | **ADAPT — not now** | The citation-check cookbook shape fits exactly; wait for the first observed thin-verdict miss |
| 13 | **Jev for fleet-memory curation** (rank Inbox bullets for promotion) | **ADAPT — not now** | Ranking for the human, never promoting; revisit when the Inbox tail cap starts dropping good bullets |
| 14 | **Jev inside the pure core or the `status` path** | **REJECT — invariant** | PURE means no network; `status` must derive offline. A judgment is a network call |

---

## The from-scratch design

Start from what a fleet operator in September 2026 already gets without writing anything.
Claude Projects, Cursor Projects and Grok Bot each hand you: a coordinator that plans and
delegates; N parallel workers on their own branches; a shared memory that grows across
runs; PR creation with tests and conflict handling; a cloud box that outlives the laptop;
and, in Cursor's and xAI's case, triggers that start work without you. GPT-6 Astra and
Grok Build make each worker better at long tasks on its own. Any design that re-implements
one of those is a design that competes with three vendors' core product on their turf.

So the design question is the residue: **what do those systems not give you, that a
person shipping software with a fleet still needs?** Working through each stage of a
ticket's life, the residue is small and specific:

1. **Ingest from your tracker, read-only, source-neutrally.** Every platform ingests from
   chat. A team's work lives in Linear or a task tool, with dependency edges. Nothing above
   reads a `blocks` relation and refuses to start the dependent ticket. Nothing maps a
   tracker's sub-issues into acceptance criteria. → `source.ts` + `Issue` + `openBlockers`.
2. **A definition of done that the agent cannot rewrite.** The platforms' "review" is the
   coordinator reading the worker's output with the same model family and, often, the
   same context. A hash-pinned rubric rendered from the ticket with no LLM call, graded by
   a fresh-context verifier that never saw the implementer's transcript, and a verdict that
   is void the moment the criteria change → `rubric.ts`, the `<finishing-protocol>`,
   `verdict.ts`. Astra's own release notes make the case: a model whose "written reasoning
   [is] harder to monitor" is exactly one whose self-report you should not grade by.
3. **A plan gate that is a real stop, and a plan that is an artifact.** All four references
   return to the human "when a decision is required" — the agent decides when. Captain's
   gate is `--permission-mode plan`: implementation cannot start un-approved, and the
   approved plan lands in `.captain/plan.md` with one criterion grading the diff against it
   (the playbook hole closed in `research/ai-native-sdlc-playbook-audit.md`).
4. **A view you can trust after a crash, a laptop lid, or a cmux upgrade.** Hosted
   coordinators are stateful; when their state desyncs from the workers you have no way to
   know. `status` derives every row from live signals and files (`captain/surface.ts`
   `fleetRows`, `captain/view.ts` `rowOf`), so there is nothing to desync and nothing to
   restart. This is the property the June 2026 rewrite bought, and none of the platforms
   have it because none of them can afford to — a hosted product has to hold state.
5. **A ledger of *why*, and metrics that measure judgment rather than motion.**
   `approve --note`, `reject --note`, launch records → `gain`'s unexplained approvals,
   launch→decision latency, first-pass rate, roster. Cursor reports "six times as many"
   merged PRs; `research/agent-swarm-economics.md` records why captain deliberately does
   not count that.
6. **Agent- and vendor-neutrality at the launch edge.** `--agent claude|codex` today; the
   platforms are each one vendor's coordinator driving that vendor's workers. The brief,
   the rubric, the verdict and the memory are plain files any agent can follow — a Grok
   Build worker is a third `agentCommand` branch, not a new architecture.

That residue *is* `src/`. The from-scratch design converges on the current shape not
because the current shape is sacred but because each of the six pieces is something the
platforms structurally will not build: read-only tracker discipline costs them engagement,
a rubric the agent cannot edit costs them "it just works", statelessness costs them
hosting, and measuring judgment instead of PR counts costs them a marketing number.

Two components a from-scratch design would **not** include, and captain does not:

- **A coordinator process.** The `/captain` skill runs inside a Claude Code session the
  human opened. It polls with a backgrounded sleep (`skills/captain/references/heartbeat.md`),
  holds no state the CLI needs, and dies with the session. That is the whole distinction
  from Projects/Bot: a coordinator that is a *session* can be killed, resumed, or replaced
  by a human at a keyboard with no loss, because everything it knew is re-derivable.
- **Its own memory store.** `learnings.md` is a text file per repo. The platforms' memory
  is a feature you cannot read, diff, or curate; captain's is one you edit with `$EDITOR`,
  with an agent-appended Inbox that ages out and a human-promoted Rules section that does
  not. The Sept 16 Grok Build memory release ("Instructions in the current conversation
  take precedence") is a reminder that opaque memory needs an override rule; a text file
  needs none.

## Where captain brings value — the answer

Stated as what a fleet operator loses by moving to any of the four platforms:

- **Gates an agent cannot argue past.** Plan mode is enforced by the harness, the rubric
  is hashed, the verdict is hash-checked (`captain/view.ts` `rowOf`: a mismatched verdict
  is simply not a verdict). Every platform's equivalent is a model deciding it is done.
- **A definition of done written by nobody's model.** `renderRubric` is deterministic
  text from the ticket. The criteria a plan is graded against, and that the verifier
  grades the diff against, cannot drift per agent, per model, or per day.
- **Read-only trackers, with the frontier rule.** Captain never writes Linear; it reads
  `blocks` edges and refuses to launch dependent work (`issue.ts` `openBlockers`, with
  `--force`). None of the references model dependencies between the work they fan out.
- **Nothing to restart, nothing to desync.** `status` is a pure function of cmux + files.
  The platforms' coordinator state is the single point of failure captain removed.
- **A ledger you can grep.** `~/.claude/captain/log.jsonl` holds every approve, reject and
  launch with its reasoning; `gain` turns it into unexplained-approval counts, first-pass
  rate and latency-to-detection with no new state. The platforms give you a chat history.
- **Curated memory.** Rules are human-promoted; the Inbox tail ages out. The platforms'
  memory grows monotonically under the model's own control.
- **Locality and cost transparency.** Every agent is a `claude`/`codex` process on your
  machine with a pinned model and effort (`config.ts` `loadModel`/`loadEffort`), a capped
  test-worker pool, and a worktree you can `cd` into. There is no per-seat coordinator
  bill and no cloud box.

## Where it does not — stated plainly

- **Continuity across the laptop lid.** A cmux fleet stops when the machine sleeps. If
  "closing your laptop doesn't stop it" is the requirement, captain is the wrong tool and
  Claude Projects is the right one; captain's answer is a machine that stays on.
- **Proactive ingestion.** A Slack mention or a schedule cannot start a captain run
  without a cron job or a human. This is the decided boundary, not an oversight
  (`research/builderbot-audit.md` #6–8).
- **Onboarding.** The platforms are a login; captain is `npm i -g`, cmux, a Linear key,
  skills, and a driver session. `captain install` narrows this but does not close it.
- **Per-worker model quality is not captain's.** Astra's cross-window notes and Grok
  Build's memory make each worker better at long tasks. Captain benefits from that for free
  (a better `claude`/`codex` binary) and contributes nothing to it, by design.

The honest summary: captain's value is **governance, measurement, and locality** over a
fleet whose coordinator, workers, memory and PR automation are increasingly commodity.
As the platforms absorb more of the commodity layer, captain should shrink toward that
residue, not grow to compete with them.

---

## The System One seam — where Jev fits, and where it does not

TypeSafe's skill says to start from behaviour and work backward to the judgments, keep
rules and execution in code, and add a judgment only where ordinary code needs semantic
understanding. Applying that to captain's whole loop gives a short inventory. Each row is
a place where *something* today reads text and forms a judgment:

| Judgment | Who makes it today | Kind | Verdict |
|---|---|---|---|
| Is this token an issue / which source claims it | `source.ts`, regexes | rule | keep in code |
| Is a single bare word a typo or a task | `route.ts` | rule | keep in code (PURE) |
| Is this ticket blocked | `issue.ts` `openBlockers` | rule over tracker data | keep in code |
| Which repo does this ticket touch | the driver, reading the ticket and grepping; or the auto-pickup `Repo & area` field | System 1 over text | **ADAPT, not now** (#11) |
| Is this plan safe to approve | the driver's read-only reviewer sub-agent → decision card | **System 2 spent on System 1** | **BUILT** (#10) |
| Which gate/verdict/run-state means which row | `view.ts` `rowOf` | rule | keep in code (PURE, offline) |
| Does this criterion apply (`na`) | the agent's verifier | System 1 | agent-side, stays there |
| Does this evidence support this pass | the driver, spot-reading `verdict.json` | System 1 over text | **ADAPT, not now** (#12) |
| Is this Inbox bullet worth promoting to Rules | the human, curating `learnings.md` | System 1 | **ADAPT, not now** (#13) |

Two invariants decide the shape of anything built from this table. **PURE means no
network**, so a judgment can never live in `view.ts`/`verdict.ts`/`gain.ts`/`rubric.ts`/
`route.ts`/`issue.ts`. And **`status` derives offline** — a judgment on the read path would
put a network call and a third-party key between the human and "what's blocked". Every
System One use in captain is therefore an *opt-in edge command*, like `gain --git`.

### Built: `captain triage` — the plan gate, sorted before it is read

**The behaviour.** The `/captain` skill's "show me the plans" step (`skills/captain/
SKILL.md`) hands every pending plan to one read-only reviewer sub-agent per heartbeat,
bounded to 8 plans, 6,000 characters each, 24,000 total, and asks for a decision card:
summary, scope drift, risk, recommendation. Overflow waits for the next heartbeat. Then
the human decides, one AskUserQuestion per wake. Look at what the card actually contains:
*does the plan stay in scope, how big is the blast radius, does it name files, order and
proof tests, does it silently resolve an ambiguity*. Those are the five things
`prompt.ts`'s `planLead` asks the agent to lead with, and four of them are yes/no
judgments over two texts. A frontier reasoning model reading 24,000 characters per wake
to answer them is the pattern the TypeSafe skill names: "an LLM prompt-and-parse step
[that] could become a structured decision".

**The judgments** (`src/captain/triage.ts`, `TRIAGE_QUESTIONS`), all asked in one call
over the state `{contract, plan}` — the contract being the rubric's issue context and
acceptance criteria exactly as the verifier will see them (`rubric.ts` `rubricContract`),
the plan being the text the agent presented:

- `inScope` (Noul): nothing added the contract does not ask for, nothing required left out.
- `risk` (Score, three levels): the auto-pickup contract's own blast-radius vocabulary —
  `low` / `moderate` / `elevated`, with `elevated` naming money, tax, PII, auth,
  permissions, deletion, migrations, the tier auto-pickup never dispatches.
- `namesFiles`, `namesOrder`, `namesTests` (Nouls): the plan-shape the brief demands.
- `silentAssumption` (Noul): the plan resolved a contract ambiguity without saying so —
  the `planLead` rule "never resolve an ambiguity silently", checked.

**The card** (`triageCard`, PURE, lint-enforced in `oxlint.config.ts`): `clean` only when
every question is answered and decisive in the safe direction — a Noul at or above 0.8, or
at or below 0.2, with the band between read as the model saying it does not know (their
docs: a Noul near 0.5 means "similar probability for yes and no"); P(elevated) at or below
0.2 whatever the argmax tier; Score confidence at or above 0.5. Anything else is `review`
with the reasons listed in question order. A missing or malformed answer is `review`,
never `clean` — the same fail-safe rule `parseVerdict` follows. The raw probabilities ride
along on the card so a threshold change never needs a re-ask, and the `note` is a
mechanical one-liner shaped for `captain approve --note`, so a triaged approval enters the
ledger with its reasoning and `gain` never scores it unexplained.

**What it is not.** It is a *triage*, not a decision, and the command touches no gate and
writes no ledger record (`captain/commands.ts` `triage`). The human still approves every
plan; the driver's deep reviewer now reads only what lands in `review`. TypeSafe's own
confidence page says to use probabilities "to guide behavior rather than as permission to
act", and the auto-approve threshold in their citation-check cookbook (0.8) is presented as
an example to evaluate, not a rule — the thresholds here are exported constants with the
same status. It sits after the cmux reachability check and after `resolvePlanTargets`, so
a dead cmux or an unknown ticket fails exactly as `approve` does, before any network call.

**Cost.** A 6,000-character plan plus a typical contract is on the order of 3,000 input
tokens; at list price that is about a hundredth of a cent per plan, so every pending plan
can be triaged every heartbeat with no batch bound, and the frontier reviewer's window is
spent only where the judge flagged something or was unsure.

**Wiring.** `src/judge.ts` is the one network edge — a `JudgePort` seam like `CmuxPort`,
with `realJudge(env)` doing a single `fetch` to `POST /v1/systemone` and a fake in the
tests. It needs `TYPESAFE_API_KEY`; `TYPESAFE_MODEL` (default `jev-latest`) and
`TYPESAFE_ENDPOINT` override. Without a key the command fails with `JUDGE_UNAVAILABLE`
(exit 12) and every other command is untouched. The plan text comes from the driver on
stdin or `--plan-file`: the cmux `exitPlan` feed item carries a `request_id` and no plan
body (`captain/control.ts` `CmuxFeedItem`), and `.captain/plan.md` is written by the agent
only *after* the gate clears, so at gate time captain has no other source.

**Limitation, stated.** The wire shape is pinned from TypeSafe's published docs
(`src/judge.test.ts`) and was not exercised against the live API from this environment;
the first live run should confirm the answer shapes, and `parseAnswers` is written so that
any mismatch reads as `review`, never as a false `clean`. The thresholds have not been
measured on real plans. TypeSafe's own "Jev 1.13 jaggedness" page (listed in their index,
unreachable at time of writing) should be read before trusting the risk Score on unusual
domains; the skill is explicit that calibration is trained for, not guaranteed per domain.

### Not built — and why

**Repo routing (#11).** "Wrong dir is the #1 silent failure" (`skills/captain/SKILL.md`),
and a Choice over candidate checkouts with a `none` option and a confidence gate is the
textbook TypeSafe pattern for it. Two reasons to wait. The auto-pickup loop already solved
routing for groomed tickets deterministically (`references/auto-pickup.md`, the
`Repo & area` field), and a judgment only adds value for tickets with no contract, where
the driver's grep is the safer fallback. And the consequence of a confident wrong answer
is a worktree in the wrong repo whose rubric can never pass — the one failure the docs'
own risk-adjusted-threshold guidance says to gate hardest. Design when needed: a
`captain route <ticket> --candidates <dir>` that prints `{repo, confidence}` and never
launches; the driver passes `--repo-path` as today.

**Verdict-evidence check (#12).** The skill's "never trust a one-line verdict" spot-read
is the citation-check cookbook exactly: per criterion, `{claim: criterion, evidence}` →
supports / contradicts / says nothing. It would run at the driver's "what's verified"
step, opt-in, never in `status`. Not built because no thin-verdict miss has been observed
in the ledger yet; the rubric's verbatim-`name` rule and the `na` state were the cheaper
fixes for the failure mode actually seen.

**Memory curation (#13).** A Score per Inbox bullet on "would this change what the next
agent does" would rank the human's curation queue — the same 45%-topography finding
`prompt.ts` records. Ranking for the human, never promoting; the Rules/Inbox asymmetry is
a trust boundary (`research/agent-swarm-economics.md` #6). Revisit when the Inbox tail cap
is observed dropping good bullets.

**Inside the core or the read path (#14).** Rejected on the invariant. The `route.ts`
typo-vs-task guard is the tempting one — a Noul would decide it well — but it runs before
commander parses, on every invocation, and a network call there would make `captain
status` depend on a third party. The heuristic stays.

---

## Built: the conversation layer — how captain talks to you and manages the fleet

Asked directly, the layer worth stealing from the three platforms is not their daemon but
their *conversation*: how work is started, how progress is reported, what a decision looks
like, how trust grows, and what happens when the same mistake recurs. Captain's
conversation layer is the `/captain` skill plus the `status` and `gain` renderers, none of
which touches the no-state boundary, so all five changes below landed there.

**Starting work: an objective, not a ticket.** Projects and Cursor take "profile each
endpoint and open PRs" and fan out. Captain took tickets, or one free-form task in the
checkout that clobbered `.captain/` if you ran two. Now a free-form task can take
`--worktree` (a sibling `<repo>-<slug>` on branch `<slug>`, the same shape an issue gets, so
every read path treats it identically), and **several quoted tasks fan out one worktree
each** with no tracker in between (`runTaskFleet`). The routing predicate is deliberate:
a token is a task only when it carries whitespace, so `captain tidy the readme` stays one
task and the typo guard in `route.ts` is untouched. Decomposition stays the driver's: the
skill now says to read the code, propose the split as one decision card, and only then
fan out the approved parts. Captain does no decomposition — that is the agent-side line
the wayfinder audit drew for tracker writes, applied to objectives.

**Talking back: the digest, and when the next check is.** Cursor's coordinator is "never
blocked, always responsive"; Grok Build's dock shows when the next run is due. Captain's
driver went quiet between heartbeats and could only say *whether* the fleet changed,
because the `--since` token was a hash. The token is now the encoded actionable
projection (`projectFleet`/`encodeSnapshot`), and a decodable previous token yields
`fleetDigest`: one deterministic line per worktree whose actionable state moved, then a
counts line. Still caller-held, still stateless, still blind to run-state churn. The skill
requires every wake to end with that digest verbatim and the time of the next check, and
the TTY gets the same block under SINCE LAST CHECK. The rule "diffed, never composed"
matters: the same transition must read the same way every time, which prose from two
payloads cannot promise.

**The decision card quotes a named section.** The brief already asked agents to lead
with what they were least sure of, but an unnamed ordering cannot be addressed. Plans now
open with `## Decisions for the reviewer` (≤5 bullets), and the card quotes it verbatim,
so the human reads the sentences that matter rather than the plan.

**Graduated trust, derived from the ledger.** Cursor describes heavy scrutiny early and
less as confidence builds. Captain had the data: `gain.rework` now carries
`firstPassStreak` per repo — the newest decided tickets in a row never rejected, over the
whole ledger, never windowed, because a streak is state not a rate. The batching rule is
the driver's and lives in the skill: a repo at streak ≥ 5 whose pending plans are all
triage-`clean` and risk `low` may be offered as one approve-all option; each approval still
carries its own `--note`, one rejection or one `review` card resets it, never across repos.
Captain computes the number and decides nothing, which is the same split `triage` made.

**"The same mistake twice" as a nudge, not a rule.** Cursor's gardener "adds a lint rule
whenever it sees the same mistake twice". Captain's Inbox→Rules promotion is human on
purpose (`research/agent-swarm-economics.md` #6), and the distill step almost never
happened because nothing prompted it. `gain.memory` now reads every repo's `learnings.md`
(`memoryStatsOf`, pure over the file) and reports rules vs inbox, `beyondTail` (bullets no
brief reads any more), `oldestInboxDays`, and `recurring` — backticked tokens named by two
or more inbox bullets. The skill surfaces it once per session as a one-line nudge. It ranks
for the human; it promotes nothing.

What was *not* taken, and why: the platforms' progress narrative comes from a coordinator
that holds the story; captain's comes from a diff of two derivations, which is the only
version that survives a restart. Their trust ladders are opaque; captain's is a number in
a greppable ledger with its rule written in a skill file a human edits. Their memory grows
under the model's control; captain's still needs a person to promote a rule.

## What captain should not chase from these references

Each of these has a written decision already; this section exists so the four references
do not re-open them.

- **A hosted, persistent coordinator** (Claude Projects, Cursor Projects, Grok Bot). The
  forbidden daemon class, with the failure catalogue in `research/PLAN.md` and
  `research/builderbot-audit.md`. The platforms can afford it because they run it for you;
  captain's stateless derivation is the property you buy by not having one.
- **Proactive subscriptions.** Schedule → a cron job shelling out to `captain "<task>"`
  (playbook audit #12). Slack/PR-follow → a persistent listener → rejected (Builderbot #6).
  The one thesis-safe slice remains a one-way `notify` push.
- **Bot-to-bot coordination in shared threads.** `research/cross-session-messaging-audit.md`:
  fleet memory is the durable cross-session channel; `cmux send` and `approve`/`reject`
  are the control plane.
- **Throughput as the success metric.** `gain` counts decisions, verdicts, rework and
  latency. Cursor's "six times as many PRs" is the activity metric
  `research/agent-swarm-economics.md` explains captain does not record.
- **Owning the worker's context or memory mechanics** (Astra notes, Grok Build `/memory`).
  Captain launches agents and owns neither their settings nor their sandbox (playbook audit
  #13); the artifacts it does own — rubric, plan, verdict, learnings — are files that
  survive any compaction scheme the agent uses.

## Sources

- Claude Projects redesign — `https://claude.com/blog/projects-redesigned`
- Cursor Projects — `https://cursor.com/blog/projects`
- Grok Bot — `https://x.ai/bot` (via InfoQ `infoq.com/news/2026/08/grok-bot-agent/` and
  the xAI release notes at `releasebot.io/updates/xai`, Sept 3 and Sept 16 2026 entries)
- GPT-6 Astra — `https://openai.com/index/gpt-6-astra/` (via InfoQ
  `infoq.com/news/2026/09/openai-gpt6-astra/` and 9to5Mac, Sept 4 2026)
- TypeSafe — `https://typesafe.ai`; the skill `github.com/typesafe-ai/skills`
  (`skills/typesafe-ai/SKILL.md`, installed as plugin `typesafe@typesafe-ai` 0.5.7);
  docs `docs.typesafe.ai`: `/api`, `/primitives/{noul,choice,score}`, `/confidence`,
  `/models`, `/cookbooks/citation_check`
- Prior captain audits this document leans on: `agent-swarm-economics.md`,
  `ai-native-sdlc-playbook-audit.md`, `builderbot-audit.md`,
  `cross-session-messaging-audit.md`, `wayfinder-browser-harness-audit.md`, `PLAN.md`
