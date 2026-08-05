# Cloud-runner audit — captain vs. Banksia (August 2026)

## Context

A decision has been taken to pursue a **cloud runner**. Banksia is Linktree's internal
delivery platform: an EKS cluster with a Kubernetes Job spawner, a codex-only worker image,
an EFS bare-mirror repo cache, GitHub App token minting, ExternalSecrets, and durable run
provenance in Postgres. It will expose a **session-scoped agent runner** beside its existing
`workflow_runs` factory, and captain's loop will eventually reach it through a **remote launch
port** whose status is derived by **polling**.

This audit is a different shape from the two before it. Builderbot and wayfinder were rival
products to strip for parts. Banksia is not a rival — it is a **substrate captain would call**,
offered as such (*"I might be able to find a way to set up banksia so you can just use its k8s
and pod clusters"*). So the question is not "what should captain steal" but **"what does
captain hand over, what does it keep, and where exactly does the no-daemon line fall when the
worktree is no longer on this laptop"**.

It is also the follow-through on a concession already made in writing:
`builderbot-audit.md:185` — *"The CmuxPort seam (`control.ts:62-75`) means a remote adapter is
technically possible, but the listening/coordinating service is the non-goal."* That sentence
is not re-argued here. This doc settles what the adapter may and may not be.

**Nothing in this doc is built.** The Runner API is a draft contract; captain's remote port is
Phase 4 of a plan whose Phase 0 is a conversation that has not happened. Every verdict below is
a boundary that governs the port **when** it is built, not a description of behaviour that
exists. Where a fact was verified by running something, it is marked as such and cited.

**Sources.** Architecture and phases: `~/.claude/plans/maybe-use-cursor-cloud-expressive-corbato.md`.
The ask as sent-shaped prose: `tiger-agent/docs/runner-request.md`. The contract:
`tiger-agent/docs/runner/runner-api.md`. Empirical findings, both dated 2026-08-05 against
`codex-cli 0.145.0` and `claude 2.1.222`: `tiger-agent/docs/runner/resume-experiment.md` and
`tiger-agent/docs/runner/harness-events.md`. Short names below refer to these.

## TL;DR verdict table

| #   | Capability                                                          | Verdict                          | One-line reason                                                                     |
| --- | ------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | **Banksia's substrate** (cluster, Job spawner, image, EFS mirror, token minting) | **ADOPT — the whole point**      | Expensive, already security-reviewed, and none of it is loop-shaped                 |
| 2   | **Poll-only remote launch port** (`CmuxPort`-class adapter, `getTurn`) | **ADOPT — when built, poll only** | A foreground poll is the `status --watch` class, not the watcher-daemon class       |
| 3   | **Reconstruct-then-resume** (persist transcript + branch, fresh pod) | **ADOPT — verified both CLIs**   | Proved end-to-end against an unguessable token; no phase of the plan collapses       |
| 4   | **Banksia's workflow engine** (routing, bindings, blessed definitions, `workflow_runs`) | **REJECT — non-goal**            | Inheriting a loop is the one thing this exercise exists to avoid                     |
| 5   | **A callback receiver in captain** (signed POST of settled turns)   | **REJECT — non-goal**            | An inbound HTTP listener is the forbidden class verbatim; tiger-agent takes it       |
| 6   | **Slack/Linear ingestion, two-way conversational control**          | **REJECT — decided, restated**   | Already rejected as Builderbot #6/#7/#8; the cloud runner does not reopen it         |
| 7   | **Remote rows in `status`**                                         | **UNRESOLVED — see the strain**  | Every way of showing them breaks a stated invariant; launch-only until amended       |
| 8   | **Naive usage/token roll-up into `gain`**                           | **REJECT — a measured trap**     | codex totals are thread-cumulative; summing turns double-counts everything           |
| 9   | **codex `-c experimental_resume=`**                                 | **REJECT — ban in code**         | Verified silent fresh start at exit 0; a green health check over total context loss  |
| 10  | **Long-lived pod + PVC, or a third-party sandbox**                  | **N/A — not captain's call**     | A runner-side upgrade path; captain must not build against it                        |

---

## ADOPT — what Banksia contributes, and why it is substrate

### 1. The substrate, and only the substrate

The split the whole design rests on, in one line from the plan: **Banksia owns the substrate,
the caller owns the loop.**

Banksia contributes what is expensive to build and expensive to get wrong on a cluster: the
EKS cluster and `KubernetesJobSpawner`, the sandbox image, the EFS bare-mirror clone that makes
checkouts fast, GitHub App installation tokens minted per run, ExternalSecrets, and durable run
provenance. `runner-api.md:9` states the line the contract was derived from: the runner
*"never reads a rubric, never grades an outcome, never routes a ticket, never decides that a
session is finished."*

Every one of those is a thing captain already does locally with no cluster at all. The trade is
clean because none of it is loop-shaped: captain does not currently own a filesystem-provisioning
strategy, a credential-minting strategy, or a repo cache. It owns a git worktree per ticket and
a cmux workspace on top of it, and the remote equivalent is a stranger's problem by construction.

The other offer on the table — *"automatically assign tickets to banksia"* — was **declined**,
and that is the decision this whole audit hangs on. Taking it would mean tickets flowing into
Banksia's blessed workflow definitions and its `workflow_runs` state machine. That is a working
system and for the tickets it fits it is the right call; it is simply **not captain's loop**,
and the loop is the entire reason captain exists. See #4.

### 2. Why the loop stays captain's

The loop is the asset. Stated as captain builds it, not as prose:

1. The agent starts in plan mode and cannot touch the repo until a human approves — the
   `ExitPlanMode` gate, replied to with `bypassPermissions` so the agent can then self-drive
   unattended (`control.ts:43`, pinned by a wire test).
2. It implements against the Contract on the ticket (`prompt.ts` `renderPromptExtras`).
3. A verifier runs in a **fresh context** and grades against a rubric, citing the rubric's hash,
   so an edited rubric cannot pass something silently (`rubric.ts`, `surface.ts:24-44`).
4. The verdict gates the label. **Merge is always human.**
5. Durable lessons fold into a per-repo memory file the next run reads (`memory.ts:54`).

None of that needs a cluster and none of it is expressible as a workflow definition someone
else owns. Under the plan it is delivered into the sandbox **as content, per turn**,
replace-not-overwrite — because overwrite cannot express deletion, so a resumed session would
otherwise keep a dropped skill forever. That is captain's `.skills` model
(`config.ts` `loadSkills`, rendered one numbered step each at `prompt.ts:62`) crossing an HTTP
boundary without changing shape.

The BuildPass line the plan quotes is the argument in full: *"instead of relying on our own team
to have their own skills or their own intuition, we can actually design the loop of how it should
be running."* Handing the loop to a platform is handing over the only part that was ever hard.

### 3. The split: tiger-agent is the voice, captain is the fleet conductor

Three parties, one runner:

- **tiger-agent (eve)** — the conversational surface. It is the thing a human @-mentions in
  Slack or Linear. eve already gives it a durable resumable session per thread, cancel
  semantics, an unread window, and HITL buttons, so the conversation half is solved and nothing
  is built for it. It holds the Slack credentials (via Vercel Connect) and **Banksia never learns
  Slack**. Settled turns come back to tiger-agent by signed callback and it posts as itself, so
  a thread has one voice rather than a second bot.
- **captain** — the fleet conductor. A human at a terminal fans tickets out and drives the
  gates. No listener, no inbox, no thread.
- **Banksia** — the substrate. Never talks to a human.

**Captain never gains a conversational surface.** That is not a new decision; it is
Builderbot #6/#7/#8 (`builderbot-audit.md:168-187`) restated in a world where the sandbox is
remote. The cloud runner does not reopen it, and the reason it does not is that tiger-agent
already exists and already holds the ground captain would have had to become a daemon to hold.

Note the asymmetry this creates, honestly: for remote sessions the plan gate is surfaced as
**eve HITL buttons in the thread**, not as `captain approve`. See the strains.

---

## The daemon question — why poll-only is the safe class

This is the load-bearing section, so it is argued rather than asserted.

`AGENTS.md`'s "No daemon, ever" bullet already draws the line in the right place: `status --watch`
is explicitly **not** a violation, because it is *"a foreground, stateless re-render loop the
human starts and Ctrl-Cs — it holds no state, listens to nothing, and coordinates no writers.
The forbidden class is a persistent background listener, not a polling loop."*

A remote launch port sits on the safe side of that line on all four tests:

- **Foreground and human-started.** The port is exercised inside a `captain` invocation the
  human typed. Nothing runs between invocations. There is no pidfile because there is no process
  to find.
- **Listens to nothing.** Every remote read is an **outbound** `getTurn`. The contract makes this
  possible on purpose: `runner-api.md:517` — *"Only settled turns are delivered. There are no
  progress callbacks — `getTurn` covers liveness, and a second delivery channel would need its own
  ordering and dedupe rules for something a poll already answers."* Captain needs no inbound port,
  no webhook route, no public URL.
- **Coordinates no writers.** A session is owned by exactly one caller
  (`runner-api.md` conventions: *"the caller is identified by transport auth"*), and captain
  writes nothing to a tracker at any layer. The two-writer `state.json` clobber deleted in
  `372dc4b` has no remote analogue here because there is no shared mutable document.
- **Holds no state.** The port is a `CmuxPort`-class interface (`control.ts:57-70`) whose methods
  return derived facts per call, exactly as `reachable`/`listWorkspaces`/`runStates` do today.

The precise thing that was deleted in June 2026 was **a process that outlives the command, holds
connections, and owns a write lock**. A poll is none of those. The distinction that matters is
not remote-vs-local and not network-vs-filesystem — it is **who starts the process and when it
dies**. `status --watch` already makes a repeated call on a timer; whether that call crosses a
socket or a filesystem changes the latency, not the architecture.

**Where it stops being safe, stated plainly so the next proposer cannot slide past it:** the
moment captain needs to *receive* something it did not ask for, it needs a listener, and that is
the forbidden class regardless of how thin it is. Signed callbacks are therefore tiger-agent's,
permanently (#5). "Just a tiny webhook endpoint so we don't have to poll" is the exact sentence
this paragraph exists to refuse.

---

## ADOPT — reconstruct-then-resume, and the four facts that were measured

K8s Jobs structurally cannot pause and resume a filesystem, so the design does not pretend to.
It persists the harness transcript plus the pushed branch, destroys the workspace, and on the
next turn spins a fresh pod, re-clones through the EFS mirror, and resumes the CLI session.

That is a load-bearing assumption, so it was **run** rather than reasoned about
(`resume-experiment.md`, 2026-08-05). Method: turn 1 hands the agent a freshly generated random
codeword that is **never written into the workspace**; the workspace is then `rm -rf`'d and
re-cloned from a bare mirror; turn 2 asks for the codeword back. An 8-character random token
that appears nowhere on the reconstructed filesystem cannot be inferred or read from a file, so
a false pass is impossible. A negative control (fresh session, same workspace) answered `NONE`.

**Fact 1 — reconstruct-then-resume works on both CLIs.** `resume-experiment.md:11`:
*"The hypothesis holds for both CLIs."* Baseline and same-path re-clone both PASS on codex and
on Claude Code. The central substrate decision survives contact.

**Fact 2 — the two CLIs disagree about what identifies a session, and the disagreement is
asymmetric.**

- **codex resolves a session by id and ignores the workspace path.** Re-cloning at a *different*
  absolute path and resuming PASSes (`resume-experiment.md:49`); the banner confirms
  `workdir: …/wsB` while the rollout's recorded `cwd` still says `…/wsA`, and it does not matter.
  The date directory in the rollout path is not part of the lookup either — a rollout deliberately
  filed under `sessions/2020/01/01/` resumed fine (`:51`). codex scans for the id.
- **Claude Code files transcripts under a lossy slug of the workspace path.** The store is
  `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<session-id>.jsonl`, where the slug is the absolute
  path with `/`, `.`, `_` and space each replaced by `-`. Resuming from a different path fails
  **loudly** — `No conversation found with session ID`, exit 1 (`resume-experiment.md:44`). The
  scoping is *purely a filename convention*: copying the transcript into the destination path's
  slug directory makes cross-path resume work perfectly, stale internal `cwd` fields and all
  (`:45`). The mapping is **not invertible** (`:68`), so `/w/a.b`, `/w/a-b` and `/w/a_b` collide
  onto one directory and **a slug must never be treated as an identifier**.

Consequence for the port: the deterministic per-session workspace path is a **Claude-Code-only**
requirement, and even there it is one of two valid designs. A codex-only implementation must not
inherit it as though it were a hard law. Claude Code also lets the caller **pre-assign** the
session UUID with `--session-id` on turn 1; codex has no equivalent and the id must be parsed out
of turn 1's banner or `--json`. That asymmetry is a contract-level fact, not an implementation
detail.

**Fact 3 — codex usage totals are thread-cumulative. Summing them double-counts everything.**
Measured (`harness-events.md:426-433`): a resumed turn that emitted a single short sentence
reported `output_tokens: 507` against the original turn's 497, and `reasoning_output_tokens`
identical at 93 despite the resumed turn producing no reasoning at all. These are
thread-cumulative totals — take the **last** `turn.completed` as-is, and compute a per-turn delta
by subtracting the previous turn's totals yourself. Claude Code has the mirror-image trap:
`result.usage` is already summed across requests (do not sum again), and
`assistant.message.usage.output_tokens` is a stale `message_start` snapshot — three events
reporting `1`, `1`, `1` against a true total of 396. On `is_error: true` Claude Code zeroes
`result.usage` while `modelUsage` and `total_cost_usd` stay real, so a runner that records
`usage` alone books a 38k-token run as free. **codex reports no usage at all on failure** —
tokens were spent and the count is unrecoverable from the stream.

This lands directly on `gain` (#8): `computeGain` (`gain.ts:263`) is pure over inputs handed to
it, and the day someone hands it remote turn records, adding them up is wrong in a different way
per CLI. Whatever `gain` eventually reports about remote runs must carry the same honesty
contract as `--git` does today: an approximation, labelled.

**Fact 4 — codex's legacy `-c experimental_resume=<path>` silently starts a fresh conversation
at exit 0.** Verified (`resume-experiment.md:53`): it exits **0**, prints a **brand-new** session
id, and answers `NONE`. No warning, no error, no non-zero status. A runner that ever falls back
to this route loses the agent's entire history while every health check stays green. Ban it in
code, and **assert that the session id reported by a resumed run equals the id requested** —
that assertion costs nothing and is the only defence against this class.

Two smaller measured traps, recorded because they produce misleading exit codes rather than
failures: `codex exec resume` has a **strictly smaller flag set** than `codex exec` (no `-C`,
no `-s/--sandbox`, no `--add-dir`, no `-p/--profile`) and exits **2** with an empty stream —
"usage error", not "agent failed" (`harness-events.md:464`). And `codex exec` **reads stdin**;
without an explicit redirect it waits (`resume-experiment.md:95`). A single shared flag builder
across `exec` and `resume` will produce a turn that looks like an agent failure and is not.

---

## REJECT — deliberate non-goals

### 4. Banksia's workflow engine

No routing, no bindings, no blessed workflow definitions, no `workflow_runs` state machine, and
no Linear state machine. The runner sits **beside** the factory in its own tables. This is the
same refusal as wayfinder's write set (`wayfinder-browser-harness-audit.md:137-161`) in a
different costume: adopting a platform's state machine means adopting its opinion about what a
unit of work is and when it is done, and captain's opinion — plan gate, rubric, fresh-context
verdict, human merge — is the product.

### 5. A callback receiver in captain

The Runner API delivers settled turns by **signed callback** (`runner-api.md:515-528`). Captain
must never be that endpoint. An inbound HTTP listener is the forbidden class stated literally,
and it would drag in exactly the failure modes the June 2026 deletion removed: a process that
must be up when a remote system decides to talk, signature verification over raw bytes, redelivery
idempotency, and an ordering rule. tiger-agent takes the callback because tiger-agent is already
a hosted service with a session store. Captain reads the same turn with `getTurn` when a human
asks it to. **Two consumers, one push and one pull, and only the push needs a listener.**

### 6. Slack ingestion and two-way conversational control

Decided, and restated here only so the cloud runner does not read as a reopening. Conversational
dispatch, real-time multi-user steering, and the two-way half of "the thread is the dev
environment" are Builderbot #6/#7/#8, rejected in `builderbot-audit.md:168-187` on grounds that
have not changed. What *has* changed is that they now have a proper owner: tiger-agent. That
makes the rejection easier to hold, not weaker — "captain should do it because nothing else
does" was never the argument, and now it is not even available.

### 8. Naive usage roll-up, and 9. `experimental_resume`

Both covered under Fact 3 and Fact 4 above. Recorded in the table because each is a specific
line of code someone will otherwise write: `turns.reduce((a, t) => a + t.usage.output_tokens, 0)`,
and a `catch` that retries a failed resume through the legacy flag.

### 10. Long-lived pod + PVC, or a third-party sandbox

The plan names both as upgrade paths if cold start breaches its kill criterion (>4 min median).
They are **runner-side decisions**, and the relevant boundary for captain is narrower: captain
must not build anything that assumes a workspace survives between turns. Reconstruction is the
contract; if the runner later gets cheaper at it, nothing captain wrote should notice.

---

## Where this genuinely strains captain's thesis

Three tensions. None is fatal, none is fully resolved, and each is recorded here rather than
smoothed over because the boundary is only defensible if the costs are written down too.

### A. `status` cannot see a remote session without breaking something

This is the real one. `fleetRows` (`surface.ts:55`) derives the entire fleet from a cmux workspace
list filtered by `isManaged` — the presence of a local `.captain/` directory (`surface.ts:49`) —
plus two small file reads per worktree. A remote session has **no cmux workspace and no local
worktree**, so it is structurally invisible. Three ways out, and each costs something stated
elsewhere in the repo:

- **(a) Launch-only.** The port starts sessions; the human watches the thread. Cheapest, breaks
  nothing — but then captain is a *launcher* for remote work, not a conductor, and the "fleet
  conductor" half of the split is aspirational rather than true.
- **(b) `status` makes a network call.** This breaks *"status derives with no network"*, which is
  the exact reason the frontier check was cut to launch-time only
  (`wayfinder-browser-harness-audit.md:73-76`). It also makes a `--watch` tick cost one round trip
  per remote session.
- **(c) Persist remote session ids locally.** Then `status` has to trust stored data, and the
  stated test of the no-persisted-fleet-state boundary is precisely that *"`status` must never
  have to trust stored data."*

**The port is launch-only until this is settled by an explicit amendment.** A `--remote` view is
a separate decision with a separate argument, not something to be arrived at by accretion while
building the port.

### B. The loop is captain's, but captain does not operate the remote gate

Captain's first and most important verb is `approve`/`reject`, and it is implemented against
cmux's feed — `feed.exit_plan.reply` with `bypassPermissions` (`control.ts:43`), pinned by a wire
test. **A remote runner has no cmux feed**, and the Runner API deliberately has no gate verb
(it covers four asks and *"adds no fifth"*). Under the plan the remote plan gate is surfaced as
eve HITL buttons in the thread.

So the honest formulation is narrower than "the loop stays captain's": **captain authors the loop
and delivers it as content; for remote sessions it does not actuate the gate.** The loop is
split across two systems even though only one of them wrote it. That is a real weakening of the
thesis and it should be argued on its merits — not discovered later by someone wondering why
`captain approve` does nothing against a remote session id.

### C. Two local derivations have no remote input

Smaller, but concrete and easy to get wrong:

- **`repoLabel`** (`git.ts:31-42`) shells out to `git -C <cwd> rev-parse --git-common-dir`. There
  is no local cwd for a remote session, so the repo column of a remote row would have to come from
  the session record instead — a *declared* value where every other column is derived.
- **Fleet memory** (`memory.ts:54`) is keyed off the local `repoRoot`. A remote workspace lives at
  a deterministic path like `/workspace/<session-id>`, whose basename is a session id, not a repo.
  Step 5 of the loop therefore needs its key supplied explicitly by the port, or remote runs
  silently learn nothing — and "silently learns nothing" is the failure mode fleet memory is least
  able to report on itself.

Additionally, a dependency worth naming: Banksia's image is **codex-only** today
(`@openai/codex@0.139.0` pinned). Captain's own rule is *"codex is best-effort, claude is the
gated default"* — only `claude` produces the `ExitPlanMode` gate. **Until the `claude-code` runner
profile exists, the remote path has no plan gate at all.** That makes Ask 2 of the runner request
a hard prerequisite for the remote port, not a nicety, and a remote port shipped against a
codex-only image would be shipping the ungated variant as the only variant.

---

## Recommended sequence

1. **Nothing in captain until the Runner API exists.** Phases 0–3 of the plan are Banksia and
   tiger-agent work; captain's port is Phase 4. Building an adapter against a draft contract is
   building against a document.
2. **Record the boundary now** — the `AGENTS.md` "No daemon, ever" bullet, extended to name the
   poll-only remote launch port as safe and Slack/two-way control as tiger-agent's. Done in the
   same change as this file. The boundary is worth writing before the code because the code is
   where it will be argued away.
3. **When the port is built: launch-only, `getTurn`-only, no receiver.** A `CmuxPort`-shaped
   interface so the tests drive the real code with an in-memory fake, exactly as `control.ts:57-70`
   does today.
4. **Settle strain A explicitly** before any remote row appears in `status`, and strain B before
   anyone expects `captain approve` to reach a remote session.

## Critical files (when the port is built)

- `src/captain/control.ts:57-70` (`CmuxPort` — the seam a remote port is modelled on), `:43`
  (`REPLY_MODE`, the gate that has no remote analogue).
- `src/cmux.ts:36-71` (`claudeCommand`/`codexCommand`/`agentCommand` — where a remote launch
  would branch), `src/launch.ts`.
- `src/captain/surface.ts:49-55` (`isManaged`/`fleetRows` — the local-only derivation, strain A).
- `src/git.ts:31-42` (`repoLabel`), `src/memory.ts:54` (`memoryPath`) — strain C.
- `src/captain/gain.ts:263` (`computeGain`) — the usage-accounting trap, Fact 3.
- `AGENTS.md` — the no-daemon bullet and its poll-only extension.
