# Captain vs. the AI-native SDLC playbook (August 2026)

## Context

Anthropic's AI-native SDLC playbook (`claude.com/blog/the-ai-native-sdlc-playbook`) is a
six-stage reference architecture — Plan, Design, Build, Test, Deploy, Maintain — with
roughly fifteen named plays, a leading/lagging metric pair per stage, and a three-layer
governance model (skills advisory, hooks deterministic, managed settings non-overrideable).
`CLAUDE.md` has carried a note about it since July 2026: captain already has its core loops
under other names, and five of its controls are out of scope. That note names no research
file, so its five rejections read as assertions and the article's other ten-odd plays were
never sorted at all.

This audit sorts every play, and it exists because two of them turned out to be **real
holes**, not already-have:

**The pipeline hole.** The playbook's Build stage rests on "nothing is implemented without
an accepted plan", and its artifact is a committed `plan.md`: the plan names the files that
change, the work order, and the proof tests; if the implementation diverges, `plan.md` is
updated in the same commit; the stage's lagging indicator is *merged diffs matching the
committed plan*. Captain had the gate — claude launches in plan mode, `approve`/`reject`
act on the `ExitPlanMode` feed item — and then **threw the plan away**. It survived only
inside an ephemeral cmux feed item. Nothing bound the merged diff to what was approved: the
verifier graded the diff against `.captain/rubric.md`, which is the *issue* contract, and
had never seen the plan. "The agent got approval for one approach and shipped another" was
invisible at every layer. `approve --note` records why a plan was approved, never what was
approved. `research/wayfinder-browser-harness-audit.md` noted this in passing — "the plan
is also currently thrown away at fan-out … which may be the cheaper half to fix first" —
and nothing picked it up.

**The telemetry hole.** `gain` reported approvals, rejections, an aggregate approval rate,
launch→detection latency, verdict tallies and a roster. It could not answer the Build
stage's lagging question — *how many cycles did a ticket cost* — even though the gap-free
`log.jsonl` ledger already holds every launch and every reject under the same
`${repo}-${ticket}` name. The data was there; nothing derived it.

The intended outcome: close both with the smallest change that respects captain's
invariants, and leave the remaining plays sorted with their reasoning, so deployment tiers,
control bands, hosted scans, Slack on-call, managed-settings hooks and CI evals do not get
re-proposed from the same article next quarter.

## TL;DR verdict table

| # | Play | Verdict | One-line reason |
|---|---|---|---|
| 1 | **`plan.md` as an artifact the diff is graded against** | **ADOPT — built** | Captain gated on a plan and then discarded it; nothing bound the diff to what was approved |
| 2 | **A plan names files, work order, proof tests** | **ADOPT — built** | One `prompt.ts` change; the gate is only cheap if the plan is specific |
| 3 | **Rework cycles / first-pass rate** (Stage 3 lagging) | **ADOPT — built** | Already derivable from the ledger; pure arithmetic, no new state |
| 4 | Plan mode, "nothing implemented without an accepted plan" | **ALREADY HAVE** | `--permission-mode plan` + `approve`/`reject` on the `ExitPlanMode` feed item |
| 5 | `intent.md` (Stage 1) / `spec.md` (Stage 2) as artifacts | **ALREADY HAVE, inverted** | The tracker issue *is* the intent; `rubric.ts` renders the spec mechanically and hashes it |
| 6 | `CLAUDE.md` + "same mistake twice → document it" | **ALREADY HAVE** | Repo `CLAUDE.md` plus `memory.ts`, which is the fleet-wide version of the same loop |
| 7 | Skills as institutional knowledge | **ALREADY HAVE** | `config.ts` `loadSkills`, `$defaults`, prose steps |
| 8 | Parallel sessions + subagents | **ALREADY HAVE** | Captain's entire thesis; the fresh-context verifier is the subagent |
| 9 | Test feedback loop, quantifiable target, mechanical referee | **ALREADY HAVE** | Rubric criteria 3–4 and "How to verify" step 3 (`gh pr checks` beats anything local) |
| 10 | AI in the PR review loop / `REVIEW.md` | **ALREADY HAVE / config** | `/pr-reviewer` → `/tidy` → `/pr-creator` → `/pr-babysitter`; a per-repo policy is a `.skills` entry |
| 11 | Agent cannot approve its own code | **ALREADY HAVE** | The verdict gates the *label*, never the merge |
| 12 | Control-band breach detection + trigger layer | **ADAPT — cron, zero captain code** | The playbook's own version is stateless in CI; a captain-owned trigger is the forbidden daemon |
| 13 | **Hooks + managed settings as the deterministic layer** | **REJECT — not captain's layer** | Hooks live in the target repo's settings; captain owns neither the agent's settings nor its sandbox |
| 14 | **Continuous evals in CI gating agent config** | **REJECT — deferred, argued** | The surface it would gate is already pinned by deterministic unit tests |
| 15 | CI/CD tiers, MCP deploy/rollback, env autonomy tiers | **REJECT — out of scope** | Captain stops at PR-ready, by definition |
| 16 | Hosted recurring codebase scans | **REJECT — external product** | Not a captain feature under any reading |
| 17 | Claude on call in Slack | **REJECT — already decided** | `research/builderbot-audit.md`: two-way chat control needs a persistent listener |

---

## ADOPT — 1 & 2: the approved plan becomes an artifact (S effort, low risk)

`.captain/plan.md` joins the rubric and the verdict as the third per-worktree file.

**Written by the agent, never by captain.** Captain writes the rubric at fan-out and reads
the verdict; it cannot write the plan, because claude presents it from plan mode — where it
cannot write files — and captain only ever replies to the feed item. It never sees the plan
text. So the brief instructs, and `PLAN_RELPATH` (`src/rubric.ts`) is the one place the path
is spelled.

**Git-ignored, unlike the playbook's committed `plan.md`.** This is the one place the audit
deliberately departs from the article. The playbook's unit of work is an engineer's
long-lived repo, where committing the plan is free; captain's is a throwaway worktree, and
committing it would put agent scratch into every PR diff and break the
`.captain/`-never-reaches-a-diff invariant. The plan's job here is to bind implement→verify
*inside* the run, which is where the drift actually happens. The durable record stays what
it already was: the ledger's `approve --note` and the PR description the rubric already
requires to match the diff. A merged worktree loses the plan exactly as it loses the
verdict — consistent with `gain`'s roster caveat, and stated there.

**Graded, with a mechanical `na`.** One acceptance criterion (`criteriaFor`, `src/rubric.ts`):

> The diff does what `.captain/plan.md` says, or every departure from it is named under
> that file's "## Deviations" heading. Evidence must be the plan's own steps set against
> the diff's files (e.g. `git diff --stat <base>...HEAD`), not a summary. Mark `na` only
> when `.captain/plan.md` does not exist.

Departures are **appended**, never merged into the plan. This is where captain's
git-ignored artifact forces a real divergence from the playbook's second sentence
("if the implementation diverges, update `plan.md` in the same commit"): `.captain/` is in
the repo's exclude file, so this plan is in no commit and has no history at all. Rewriting
it would erase the approved version and leave the criterion nothing to compare the diff
against; a `## Deviations` section keeps both halves in the one artifact the verifier is
already handed.

Two properties keep this from becoming the `/security-review` mistake, which is the
precedent it has to clear:

- **Its `na` is a file-existence test, not an exemption argument.** The failure mode
  `CLAUDE.md` records for the test criterion is agents each inventing a different
  exemption, some rewording the criterion itself. Here there is nothing to argue: either
  the file is on disk or it is not.
- **It carries no recurring per-ticket cost.** `/security-review` was reverted because it
  added a whole extra review pass to every diff forever, most of which have no security
  surface. Every ticket has a plan, and the verifier is already reading the worktree; the
  marginal cost is one file read.

`renderRubric`'s "How to verify" step 1 hands the verifier the plan alongside the rubric and
the branch diff — still nothing of the implementing agent's own reasoning.

**No hash migration.** `readRubricFacts` (`src/captain/surface.ts`) recomputes `rubricHash`
from each worktree's rubric file *as it exists on disk*, so an in-flight worktree keeps its
own rubric and its own hash. Shipping a new criterion voids no in-flight verdict. (The
wayfinder audit's #10 assumed otherwise; it was over-cautious.)

Play 2 is one sentence appended to `planLead` (`src/prompt.ts`), on both agent branches:
name the files you will change, the order you will do the work in, and the tests that will
prove it. The gate is only cheap to the human if the plan is specific enough to disagree
with.

## ADOPT — 3: rework at the plan gate (XS effort)

`ReworkStats` / `reworkStats` in `src/captain/gain.ts`, which stays 100% PURE. Per ticket
**name**, not per launch — the reject→relaunch cycle is exactly what is being counted, and
it spans launches by construction. A ticket is first-pass when every decision under its name
is an approval; each rejection is one cycle it cost.

Three things make it honest rather than a vanity number:

- **Omitted wholesale when no ticket carries a decision**, the same "no sample ⇒ omit" rule
  that already governs `latency` and the approval-notes block. An empty ledger reporting
  "0 of 0 first pass" would read as a measurement.
- **A `--since` window picks the ticket set, not which cycles count.** Names decided inside
  the window are the tickets; their rejections are then counted over the whole ledger — the
  same asymmetry `latency` uses for launches. Windowing both would report a ticket whose
  earlier rejections fell outside as a clean first pass, and a governance number that is
  wrong upward is the worst kind.
- **Its caveat says what it is not**: cycles at the *plan gate*, from the ledger — not
  post-merge rework, and a relaunch that was never rejected is invisible to it.
- **`topReworked` is uncapped**, worst first, ties broken by name — matching
  `failingCriteria`, the nearest name-keyed tally. A silent truncation is what `roster`'s
  `dropped` field exists to avoid.

`renderGain` puts it directly under DECISIONS, above the live-snapshot sections, because it
is ledger history like DECISIONS is. Dim prose and a `↩`, never red: it is a cadence signal,
not a failure count.

## ADAPT — 12: control bands are a cron job, not a captain feature

The Maintain stage's shape is a deterministic detector over one metric with response tiers
(1σ log, 2σ diagnose read-only, 3σ may act), a trigger layer, and findings re-entering the
pipeline. Captain's honest version already exists and needs no code: the playbook itself
says Claude "runs **stateless** in CI or Agent SDK service", so the trigger is a scheduled
workflow that shells out to `captain "<the diagnosis task>"` — the free-form dispatch path,
in the checkout, with the full brief. The tiers are the job's own config.

What captain must **not** grow is the trigger layer itself. A captain-owned watcher for
metric breaches is the persistent-listener class deleted in June 2026, verbatim. Same
reasoning as the browser step in `research/wayfinder-browser-harness-audit.md`: the need is
real, the implementation belongs outside captain.

The half that stays a non-goal is the return leg — "findings re-enter the pipeline as
`intent.md`" means writing to a tracker. Captain reads trackers and never writes them; when
that write is wanted, the **agent** does it, exactly as it already opens PRs.

## REJECT — deliberate non-goals

### 13. Hooks and managed settings as the deterministic layer

The playbook's middle governance layer — hooks that block edits to protected paths, run
formatters, keep credentials out of diffs, and pause for named human approvals; plus
admin-owned managed settings engineers cannot override — lives in the **target repo's**
`.claude/settings.json` and the machine's managed settings. Captain launches agents into
worktrees; it owns neither their settings nor their sandbox. That is the same line already
drawn for egress allowlisting and remote-VM containment in `CLAUDE.md`, and moving it here
would make captain a settings manager for every repo it fans out into.

Captain's own deterministic layer is different in mechanism and equivalent in effect: the
plan gate is a hard stop no agent can pass itself, the rubric hash makes a tampered
definition of done unusable, and `.git/info/exclude` keeps `.captain/` out of every diff.

### 14. Continuous evals in CI

The play is a 20–50 task regression suite gating changes to `CLAUDE.md`, skills and hooks.
For captain the gated surface would be `prompt.ts`, `rubric.ts` and `DEFAULT_SKILLS` — and
that surface is **already pinned by deterministic unit tests**: `prompt.test.ts` pins the
workflow steps and both agent branches, `rubric.test.ts` pins the criteria and the hash
round-trip, and `config.test.ts` pins the load-bearing `/pr-reviewer`-before-`/tidy` order.
An LLM eval suite over the same files adds API keys in CI, nondeterminism, and a per-PR
cost, for a strictly weaker signal on what it can actually check.

Not "never": the honest trigger to revisit is a regression that the unit tests *structurally
cannot* catch — a brief that renders exactly as pinned and still drives agents badly. That
has not happened. Until it does, this is ceremony.

### 15. Deployment: CI/CD tiers, MCP deploy tools, environment autonomy

Stage 5's second half — scoped deploy/status/rollback as MCP tools, per-environment
autonomy tiers, release-manager gates, rehearsed rollback — sits entirely past captain's
boundary. Captain's output is a PR-ready worktree; the human merge gate is the last thing
it participates in. Everything downstream is the repo's own delivery pipeline.

### 16. Hosted recurring codebase scans

A hosted scheduled scanning product, not an architectural pattern captain could adopt. It
composes with captain from the outside (a finding becomes a ticket, captain fans it out)
and needs nothing from `src/`.

### 17. Claude on call in Slack

Decided in June 2026 and written up in `research/builderbot-audit.md`: a chat participant
that receives incidents and responds is a persistent listener, the exact daemon class whose
deletion this architecture is built on. A **one-way** `notify`→external push remains the
only thesis-safe slice; two-way conversational control stays a non-goal.

## What the article confirms rather than changes

Five of captain's loops are the playbook's plays under different names, and it is worth
recording the mapping so they are not "added" later: the fresh-context verifier sub-agent is
its independent-reviewer pattern; per-criterion evidence is "prove the finding"; fleet
memory (`memory.ts`) is the discovery→instructions loop, and the *fleet-wide* version of the
`CLAUDE.md` rule rather than a competitor to it; `gain` is the vitals dashboard; and the
plan gate plus the human merge gate are humans placed at the leverage points.

Its metrics table is also mostly already served — decisions, latency-to-detection, verdict
pass/fail and the roster — with one deliberate refusal that stands: operation-level
throughput is not recorded, because an event stream needs a listener. `gain`'s caveats say
so in the output, not just here.

## Recommended sequence

1. **The plan artifact** (#1, #2) — built; the change that closes the pipeline hole.
2. **Rework metric** (#3) — built; the change that closes the telemetry hole.
3. Record #13/#14/#15/#16/#17 as **explicit non-goals** in `CLAUDE.md`, pointing here, so
   the boundary is defensible without re-reading the article.

Control bands (#12) are documented above but deferred — no captain change, and a cron job
when the need is real.

## Verification

- The plan criterion renders verbatim with its file-existence `na` rule, and the verify
  procedure hands the verifier the plan: `src/rubric.test.ts`.
- Both agent variants write `.captain/plan.md` and carry the deviation rule; both name
  files/order/proof tests; codex still never waits for an approval that cannot arrive:
  `src/prompt.test.ts`.
- Rework omitted with no decisions, counted per name across the reject→relaunch cycle,
  ordered and capped, windowed by `--since`, and caveated: `src/captain/gain.test.ts`.
- The REWORK block renders only when present, and above FLEET: `src/captain/format.test.ts`.
- Rendered end to end with no network and no cmux: `captain start "…" --print` on both
  agents, and `computeGain`/`renderGain` over a seeded `CAPTAIN_HOME` ledger
  (first-pass 1 of 2, the reworked ticket listed, the caveat present; both absent on an
  empty ledger).
- Whole suite green: `npm run typecheck && npm run check && npm run test && npm run build`.

## Critical files

- `src/rubric.ts` (`PLAN_RELPATH`, the plan criterion, "How to verify" step 1),
  `src/prompt.ts` (`planLead`, `planFile`, the agent-aware `planSteps`) — #1, #2.
- `src/captain/gain.ts` (`ReworkStats`, `reworkStats`, `caveatsFor`, `computeGain`),
  `src/captain/format.ts` (`renderGain`) — #3.
- `src/captain/surface.ts` (`readRubricFacts`) — why no hash migration is needed.
- `CLAUDE.md` — the plan artifact, the `na` gotcha, and the non-goals.
