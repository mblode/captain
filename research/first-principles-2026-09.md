# Captain from first principles — against the September 2026 state of the art

## Context

Five references arrived together, and the question they raise is the blunt one: if you
sat down today and designed captain from nothing, knowing what the platforms now ship,
what would you build — and does the thing in this repo still earn its place?

- **Claude Projects, redesigned** (`claude.com/blog/projects-redesigned`): "Projects have
  threads that do the work and a coordinator that directs them." Each thread is a Claude
  Code cloud session on its own branch; the coordinator scopes, delegates, reviews and
  assembles. "Every thread now adds to and draws from a shared memory."
- **Cursor Projects** (`cursor.com/blog/projects`): a coordinator that "doesn't execute
  code but directs other agents that do", so it "is never blocked". Three pillars: a cloud
  computer per Project ("closing your laptop doesn't stop it"), persistent shared context,
  and **proactive subscriptions** — Slack, a schedule, or every PR. The headline metric:
  users who mainly use Projects "merge six times as many" PRs.
- **Grok Bot** (`x.ai/bot`, Sept 2026): persistent agents with identity, memory, runtime,
  and tools; Routines for scheduled work; a return to the human "when approval or a
  decision is required."
- **GPT-6 Astra** (`openai.com/index/gpt-6-astra`, Sept 2026): an experimental context
  mechanism that keeps notes across windows instead of relying only on compaction. OpenAI's
  own caveat: Astra's "written reasoning [is] harder to monitor than its predecessor."
- **TypeSafe's Jev** (`typesafe.ai`): a "System One" model that does not generate text. You
  define the shape of the answer (yes/no, a pick, a score) and it returns calibrated
  probabilities, many questions per call. Their pitch: "smart if-statements" on tasks that
  need instinctive judgment over large text, honest that it is "not good at System 2
  tasks."

The first four are the same product drawn four times: a **persistent, hosted, stateful
coordinator** with shared memory, proactive triggers, and the human "checking in where
attention is needed." That is the watcher-daemon architecture captain deleted in June 2026
(`research/PLAN.md`, `research/builderbot-audit.md`) — now every frontier vendor's default
way to run a fleet. The fifth is a new primitive none of them use.

This document does the from-scratch design, states where captain still brings value and
where it does not, and sorts every capability the references offer. It is a decision
record, not a changelog. What shipped from it is named in the table; everything else is a
temptation with a written reason not to take it yet.

## TL;DR verdict table

| # | Capability (source) | Verdict | One-line reason |
|---|---|---|---|
| 1 | **Coordinator + parallel worker threads** (Claude/Cursor Projects) | **COMMODITY — do not rebuild** | A session that polls `status` is not the same product as a never-blocked cloud coordinator. Use theirs for that job. Captain is not a cheaper Projects |
| 2 | **Shared, evolving project memory** (all four) | **ALREADY HAVE** | `memory.ts` fleet memory, injected per brief; human-curated Rules is a chosen trust boundary the platforms do not offer |
| 3 | **Human on the loop at decision points** (all four) | **ALREADY HAVE, stronger** | The plan gate is a hard stop (`--permission-mode plan`) an agent cannot pass itself; Projects' "check in where attention is needed" is advisory |
| 4 | **PR creation, tests, conflict handling by the agent** (Claude Projects) | **ALREADY HAVE** | The self-drive `<workflow>` + `/pr-creator` + `/pr-babysitter`; captain stops at PR-ready by design |
| 5 | **Persistent cloud runtime** ("closing your laptop doesn't stop it") | **REJECT — non-goal** | Captain is local and stateless on purpose; the hosted coordinator is the daemon class deleted June 2026 |
| 6 | **Proactive subscriptions** (Slack channel, schedule, follow PRs) | **REJECT — decided** | Needs a persistent listener; a cron shelling out to `captain "<task>"` covers the schedule case with zero code |
| 7 | **Bot-to-bot group chat / shared threads** (Grok Bot) | **REJECT — decided** | `research/cross-session-messaging-audit.md`: messaging is not a control plane |
| 8 | **Notes across context windows** (GPT-6 Astra / Codex) | **N/A — agent-internal** | Captain owns none of the agent's context; its equivalent is that `.captain/plan.md` + rubric survive any compaction because they are files |
| 9 | **Merged-PR count as the success metric** (Cursor's 6×) | **REJECT — decided** | `gain` counts decisions, verdicts, latency and rework, not throughput — `research/agent-swarm-economics.md` explains why |
| 10 | **A calibrated System One judge at the plan gate** (Jev) | **ADAPT — not now** | The driver already has a bounded read-only reviewer. A vendor, a new command, and unmeasured thresholds are not earned until a measured miss exists |
| 10a | **Objective → parallel work without a tracker** (Projects/Cursor) | **ADAPT — not now** | The real pain is a second in-checkout dispatch clobbering `.captain/`. That is "refuse the second" or one isolation flag later, not a second launch path |
| 10b | **"What changed"** (Cursor, Grok dock) | **ADAPT — summary payload** | `--summary --json` already returns `needsYou`. It also returns `ready` identities so a wake can relay both lists as returned. Not a snapshot codec, not a composed digest |
| 10c | **The decision card quotes a named plan section** (Grok inline cards) | **ADOPT** | Plans open with `## Decisions for the reviewer` (≤5 bullets); the card quotes that section verbatim |
| 10d | **Graduated trust as review confidence builds** (Cursor migrations) | **REJECT — not now** | The plan gate is per ticket. A ledger streak that batches approve-all is a trust ladder captain does not want |
| 10e | **"Same mistake twice → a rule"** (Cursor gardening) | **ADAPT — not now** | Distill is already a skill over a greppable file. A `gain.memory` metric waits until distill failure is observed |
| 11 | **Jev for repo routing** (which checkout this ticket touches) | **ADAPT — not now** | Auto-pickup already routes deterministically; a judgment only helps tickets with no contract, and the failure mode is the #1 silent one |
| 12 | **Jev for verdict-evidence checking** | **ADAPT — not now** | Wait for the first observed thin-verdict miss; the verbatim-`name` rule and `na` state were the cheaper fixes for the failure actually seen |
| 13 | **Jev for fleet-memory curation** | **ADAPT — not now** | Ranking for the human, never promoting; revisit when the Inbox tail cap starts dropping good bullets |
| 14 | **Jev inside the pure core or the `status` path** | **REJECT — invariant** | PURE means no network; `status` must derive offline. A judgment is a network call |

---

## How Projects actually runs (the launch thread)

The product posts describe architecture. [Pranathi Peri's launch thread](https://x.com/pranathiperii/status/2100640629286228223)
(18 Sep 2026) describes the loop a person actually lives in:

1. **Intake is a goal plus repos, then spam.** You name a goal and a few repositories.
   The coordinator surveys the land and *suggests* threads. After that you "spam the
   coordinator with any and all tasks" and it delegates. Work does not start as a Linear
   id.
2. **The coordinator owns decomposition, routing, and relay.** Chat starts threads, relays
   into existing ones, and speaks routines into existence (scheduled rollups, resolve
   missed threads, babysit PRs). Someone asked whether you still need skills, plugins, and
   agents. The honest answer inside their product: the *conductor* is the coordinator.
   Skills still matter *inside* a thread (how this org opens a PR). A `/captain`-shaped
   conductor skill is what they shipped as the product.
3. **Status is a story the coordinator writes.** The threads pane sorts and summarises by
   the last turn. Claude marks threads resolved, or draws your eye. You toss 10–15 tasks,
   leave, come back to screenshots or a steer. Mobile is a first-class control surface.
4. **The human role is spot-check, not a stop before code.** "Report back with only the
   things that need your attention." Attention is whatever the coordinator decided needed
   you.

That loop is the job Cursor Projects, Claude Projects, and Grok Bot are all selling. If
you sat down today to build *that*, you would not write captain. You would log into one
of those three.

## The from-scratch design

Start from what a fleet operator in September 2026 already gets without writing anything.
A coordinator that decomposes a goal; N cloud workers on their own branches; shared memory
that grows as they work; PR creation, tests, conflict-as-PR; laptop closed; phone; routines
that babysit what you forgot. Any design that re-implements that loop competes with three
vendors' core product on their turf, and will lose on continuity, mobile, and "come back
later."

So the design question is not "how do we talk to a fleet the way they do." It is: **what
does a person still need when shipping with a tracker and a definition of done that those
systems will not give them?** Working through a ticket's life, the residue is small:

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
   gate is `--permission-mode plan`: implementation cannot start un-approved.
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
   the rubric, the verdict and the memory are plain files any agent can follow.

A from-scratch design today would **not** include a conductor. The `/captain` heartbeat,
the threads-pane analogue, suggested splits, routines, mobile, and "mark it resolved"
are their product. Rebuilding them in a local CLI is how captain becomes a worse
Projects.

A from-scratch design **would** include the six residue pieces, because each is something
those products structurally will not build: read-only tracker discipline costs them
engagement ("spam me tasks"), a rubric the agent cannot edit costs them "it just works",
a harness-level plan stop costs them flow, statelessness costs them hosting, and measuring
judgment instead of PR counts costs them a marketing number.

`src/` today is residue *plus* a local launch path *plus* a session conductor. The launch
path still earns its place while the workers are processes you own (`cmux` + `claude` /
`codex`, plan mode, pinned model, no per-seat coordinator bill). The session conductor
is now the part that looks like a prototype of Projects. Do not grow it. Do not pitch it
as the same product "inverted." Shrink captain toward contract, gate, derived view, ledger.
If the workers move into their cloud, keep the contract files and drop launch.

As the platforms absorb the commodity layer, captain should **shrink toward that residue,
not grow to compete with them.**

## Where captain brings value — the answer

Stated as what a fleet operator loses by moving to any of the four platforms:

- **Gates an agent cannot argue past.** Plan mode is enforced by the harness, the rubric
  is hashed, the verdict is hash-checked (`captain/view.ts` `rowOf`: a mismatched verdict
  is simply not a verdict). Every platform's equivalent is a model deciding it is done.
- **A definition of done written by nobody's model.** `renderRubric` is deterministic
  text from the ticket.
- **Read-only trackers, with the frontier rule.** Captain never writes Linear; it reads
  `blocks` edges and refuses to launch dependent work (`issue.ts` `openBlockers`, with
  `--force`). None of the references model dependencies between the work they fan out.
- **Nothing to restart, nothing to desync.** `status` is a pure function of cmux + files.
- **A ledger you can grep.** `~/.claude/captain/log.jsonl` holds every approve, reject and
  launch with its reasoning.
- **Curated memory.** Rules are human-promoted; the Inbox tail ages out.
- **Locality and cost transparency.** Every agent is a `claude`/`codex` process on your
  machine with a pinned model and effort.

## Where it does not — stated plainly

- **Toss 10–15 tasks and come back.** That is Pran's loop. Captain's loop is: you pick
  tickets, you stay in a session, you poll, you approve before implementation. If you want
  the first loop, use Projects.
- **Suggested decomposition from a goal.** Captain does not read a goal and propose threads.
  The driver (or Linear) already sliced the work. Goal-shaped work is their turf;
  ticket-shaped work is captain's.
- **Auto-resolved threads.** Claude marking a thread resolved is a model grading its own
  fleet. Captain's `verdict.json` exists so that cannot be the merge label. Do not add a
  coordinator that "draws your eye." `status` already groups NEEDS YOU from files.
- **Routines spoken into the coordinator.** Scheduled PR babysitting and "resolve what we
  missed" are `/pr-babysitter` plus a cron, or their product. Not a listener in captain.
- **Continuity across the laptop lid, and the phone.** A cmux fleet stops when the machine
  sleeps. If that is the requirement, captain is the wrong tool.
- **Onboarding.** The platforms are a login.
- **Per-worker model quality is not captain's.**

Two products that look similar and must not be mixed:

- **Projects / Bot:** goal + repos → coordinator proposes work → cloud threads → come back
  when it pokes you. Skills inside a thread still exist; a conductor skill does not.
- **Captain:** a ticket with a contract → isolated worktree → you poll a derived view →
  you approve before code → merge stays yours.

The honest summary: captain's remaining value is **governance over tracker-shaped work**
(contract, real stop, derived view, ledger, local launch while you still own the harness).
It is not a fleet conductor, and it should stop trying to talk like one.

---

## The System One seam — where Jev would fit, and why it does not yet

TypeSafe's skill says to start from behaviour and work backward to the judgments, keep
rules and execution in code, and add a judgment only where ordinary code needs semantic
understanding. Applying that to captain's whole loop:

| Judgment | Who makes it today | Kind | Verdict |
|---|---|---|---|
| Is this token an issue / which source claims it | `source.ts`, regexes | rule | keep in code |
| Is a single bare word a typo or a task | `route.ts` | rule | keep in code (PURE) |
| Is this ticket blocked | `issue.ts` `openBlockers` | rule over tracker data | keep in code |
| Which repo does this ticket touch | the driver, or the auto-pickup `Repo & area` field | System 1 over text | **ADAPT, not now** (#11) |
| Is this plan safe to approve | the driver's read-only reviewer → decision card | System 2 spent on System 1 | **ADAPT, not now** (#10) |
| Which gate/verdict/run-state means which row | `view.ts` `rowOf` | rule | keep in code (PURE, offline) |
| Does this criterion apply (`na`) | the agent's verifier | System 1 | agent-side, stays there |
| Does this evidence support this pass | the driver, spot-reading `verdict.json` | System 1 over text | **ADAPT, not now** (#12) |
| Is this Inbox bullet worth promoting to Rules | the human, curating `learnings.md` | System 1 | **ADAPT, not now** (#13) |

Two invariants. **PURE means no network**, so a judgment can never live in
`view.ts`/`verdict.ts`/`gain.ts`/`rubric.ts`/`route.ts`/`issue.ts`. And **`status` derives
offline** — a judgment on the read path would put a network call and a third-party key
between the human and "what's blocked". Every System One use in captain would therefore be
an *opt-in edge command*, like `gain --git`.

**Why #10 waits.** The `/captain` skill's "show me the plans" step already hands every
pending plan to one read-only reviewer per heartbeat, bounded, and asks for a decision
card. Replacing that with Jev would add `TYPESAFE_API_KEY`, a `JudgePort`, a new exit
code, and thresholds that have not been measured on real plans. The cmux `exitPlan` feed
item carries no plan body, so the command would need the plan on stdin at gate time. None
of that is a current requirement. Revisit after a measured miss: unexplained approvals that
a six-question classifier would have caught, or reviewer cost that is actually the
bottleneck.

**#11–14** stay as written in the table. Wrong-dir is still the #1 silent failure, and
auto-pickup already solved routing for groomed tickets. Verdict-evidence checking is the
citation-check cookbook, and no thin-verdict miss has been observed in the ledger yet.
Inbox ranking for the human is fine in principle and unneeded while distill still has a
file to open. Inside the core is an invariant, not a backlog item.

---

## Conversation layer — what was considered, what landed

Asked directly, the layer worth stealing from the three platforms is not their daemon but
how work is started, how progress is reported, and what a decision looks like. Captain's
conversation layer is the `/captain` skill plus the `status` and `gain` renderers. Two
slices landed because they operate the residue more cheaply and add no surface:

- **Named plan lead (#10c).** The brief already asked agents to lead with what they were
  least sure of; an unnamed ordering cannot be addressed. Plans now open with
  `## Decisions for the reviewer` (≤5 bullets), and the decision card quotes that section
  verbatim.
- **READY identities on the summary (#10b).** `--summary --json` already hashed counts +
  NEEDS YOU + missing, and already returned `needsYou` on `changed: true`. READY was
  absent, so "what verified" could not be relayed without a full `--json`. The payload now
  includes a sorted `ready` list of identities, hashed into the same 16-hex snapshot. The
  heartbeat prints those two lists as returned. It does not encode a previous projection,
  does not invent a digest paragraph, and does not grow the PURE core.

What was considered and **not** taken:

- **Task worktrees / several quoted free-form tasks.** A second in-checkout dispatch
  clobbers `.captain/`. Fix that bug if it recurs; do not add `runTaskFleet` beside
  `runIssueWorktree` / `runDispatch`.
- **A v2 base64 snapshot and `fleetDigest`.** The driver already holds the previous
  summary JSON. Adding READY identities is enough.
- **`gain.rework.firstPassStreak` and skill-side approve-all.** The gate stays one ticket
  at a time.
- **`gain.memory` recurring-trap ranking.** Distill already edits `learnings.md`.

## What captain should not chase from these references

Each of these has a written decision already; this section exists so the four references
do not re-open them.

- **A hosted, persistent coordinator** (Claude Projects, Cursor Projects, Grok Bot). The
  forbidden daemon class (`research/PLAN.md`, `research/builderbot-audit.md`).
- **Proactive subscriptions.** Schedule → a cron job. Slack/PR-follow → a persistent
  listener → rejected. The one thesis-safe slice remains a one-way `notify` push.
- **Bot-to-bot coordination in shared threads.**
  `research/cross-session-messaging-audit.md`.
- **Throughput as the success metric.** `gain` counts decisions, verdicts, rework and
  latency.
- **Owning the worker's context or memory mechanics** (Astra notes, Grok `/memory`).
  Captain launches agents and owns neither their settings nor their sandbox. The artifacts
  it does own — rubric, plan, verdict, learnings — are files.

## Sources

- Claude Projects redesign — `https://claude.com/blog/projects-redesigned`
- Pranathi Peri on using Projects — `https://x.com/pranathiperii/status/2100640629286228223`
- Cursor Projects — `https://cursor.com/blog/projects`
- Grok Bot — `https://x.ai/bot`
- GPT-6 Astra — `https://openai.com/index/gpt-6-astra/`
- TypeSafe — `https://typesafe.ai`; docs `docs.typesafe.ai`
- Prior captain audits: `agent-swarm-economics.md`, `builderbot-audit.md`,
  `cross-session-messaging-audit.md`, `wayfinder-browser-harness-audit.md`, `PLAN.md`
- Take-list for this audit: `docs/plans/pr-35-high-value-take.md`
