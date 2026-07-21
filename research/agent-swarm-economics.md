# Steal-worthy ideas audit — captain vs. Cursor's agent-swarm economics (July 2026)

## Context

Cursor published "Agent swarms and the new model economics"
(<https://cursor.com/blog/agent-swarm-model-economics>, July 2026): a comparison of their
old and new agent-swarm harnesses rebuilding SQLite in Rust from nothing but the 835-page
manual — same models, same four-hour budget, graded against a held-out sqllogictest suite
the swarm was never told about. The new harness won every model configuration, and the
headline finding is economic: every model mix produced similar quality while costs varied
~8× ($1,339 for Opus 4.8-planner + Composer 2.5-worker vs $10,565 for GPT-5.5 solo).

Cursor's swarm is a different animal from captain — hundreds of concurrent agents sharing
one codebase through a custom VCS at ~1,000 commits/second, versus captain's one agent per
ticket in an isolated worktree with a human merge gate. This audit asks what transfers.

**Verdict up front: mostly validation, not gaps.** The post independently confirms three
of captain's core design bets. One idea (model tiering) is worth keeping in the back
pocket; the contention machinery that fills most of the post is explicitly not captain's
problem, by design.

## TL;DR verdict table

| #   | Cursor swarm idea                                                    | Verdict                       | One-line reason                                                                        |
| --- | -------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| 1   | **Context efficiency > parallelism** (planners never implement)      | **ALREADY HAVE**              | The `/captain` driver never implements; each worktree agent gets one narrow brief       |
| 2   | **Specs as prompts** ("what's scarce is the description of intent")  | **ALREADY HAVE**              | `rubric.ts` → `.captain/rubric.md` as the per-worktree definition of done               |
| 3   | **Field Guide** (agent-authored shared context, line-budgeted)       | **ALREADY HAVE**              | `memory.ts` fleet memory: Rules + tail-capped Inbox, verified learnings only            |
| 4   | **Model-mix economics** (frontier planner + cheap worker, ~1/8 cost) | **ADAPT — back pocket**       | Per-run `CAPTAIN_MODEL` tiering already exists; document as driver guidance if needed   |
| 5   | **Decorrelated review lenses** (stacked reviewers, high-return)      | **PARTIAL — note only**       | Two lenses exist (/pr-reviewer + fresh-context verifier); a third is not a current need |
| 6   | **Agent-curated memory promotion** (agents own Rules curation)       | **REJECT — deliberate**       | Human curation of Rules via the captain skill is a chosen trust boundary                |
| 7   | **Custom VCS, merge mediators, megafile flags, split-brain fixes**   | **N/A — different problem**   | Machinery for shared-state contention; captain avoids the class (worktree per ticket)   |

---

## What the post validates (nothing to build)

**1. Context efficiency over parallelism.** Cursor's explanation for why swarms beat
long-running single agents: a planner never implements, so its context never fills with
low-level detail; a worker never plans, so all its context goes to one narrow piece. They
suspect scaling comes "from this context efficiency, more than from parallelism itself."
That is captain's driver/fleet split verbatim — the `/captain` skill reads tickets and
routes; each worktree agent's brief (`prompt.ts`) carries exactly one issue's pipeline.

**2. Specs as prompts.** Their closing thesis — the swarm resembles a compiler for
intent, and "what was scarce in this experiment … is the right description of intent" —
is the rubric bet: `rubric.ts` renders a definition of done into each worktree with no
LLM call, and the verdict must cite its hash so the spec stays authoritative.

**3. The Field Guide is fleet memory.** Their agent-owned shared-context folder, injected
into every agent at start, curated by the agents under "only … a line budget," exists
because "model weights are frozen, so it's precisely surprise encounters that are worth
capturing." Captain's `memory.ts` matches piece for piece: `learnings.md` injected via
`<fleet-memory>`, tail-capped Inbox, and the rule that a failed-then-passed verifier run
must record its root cause as a preventive rule — surprise capture, verified. Good
external evidence the design pulls its weight; they report it as "an early experiment
with promising results" while captain already runs it in production shape.

## The one transferable finding — model-mix economics (#4)

The economics section is the real payload. Across four configurations, quality converged
(all new-harness runs eventually passed 100% of the suite) while cost spread ~8×.
Structure of the spend: workers carried ≥69% of tokens (>90% in most runs), but the
planner took roughly two-thirds of the *dollars* in the Opus + Composer mix. Their
reading: "few moments in a large task genuinely require frontier intelligence … once a
frontier planner has collapsed the ambiguity into a detailed, explicit instruction, less
expensive models simply have to follow it." Worker fleet cost for the same task: $9,373
on GPT-5.5 vs $411 on Composer 2.5.

Mapping to captain: the **plan gate is the ambiguity-collapse moment**. The approved plan
is the "detailed, explicit instruction"; everything after it is worker-shaped. Three
possible responses, in increasing order of cost:

1. **Do nothing** (current choice). Captain fleets are small (a handful of tickets, not
   hundreds of agents), so absolute spend rarely justifies tiering overhead.
2. **Per-run tiering with existing knobs** — `CAPTAIN_MODEL`/`CAPTAIN_EFFORT` already
   support launching a whole run on a cheaper tier. If spend becomes a concern, the cheap
   slice is driver guidance in the `/captain` skill: frontier for ambiguous tickets,
   cheap model for well-specified ones. Zero code.
3. **Mid-run model switching** (frontier through plan approval, cheap after) — real
   complexity (relaunch or in-flight model change, plan-gate plumbing) for savings that
   only matter at swarm scale. YAGNI.

**The caveat worth remembering:** in Cursor's data, the Fable 5 planner used *fewer*
planning tokens than Opus 4.8 (smaller planner bill despite ~2× per-token price) but its
workers burned several times more tokens, making the run substantially *more* expensive
overall. Smarter planner ≠ cheaper run; the planner's instruction style drives worker
spend. Any future tiering decision should measure end-to-end cost, not planner cost —
`captain gain` is the natural place such telemetry would land if it's ever needed.

## Noted, not adopted

**Decorrelated review lenses (#5).** "No single lens catches everything, but decorrelated
lenses stack … the compute spent on review is high return, since review is much cheaper
than the work it audits." Captain already stacks two decorrelated lenses — `/pr-reviewer`
mid-pipeline and the fresh-context verifier sub-agent at the end (decorrelated by
construction: it sees the rubric and the code, not the implementer's transcript). The
cheapest third decorrelation, if verifier misses ever show up in practice, is pinning the
verifier to a *different model* than the implementer. Not a current need; recorded here so
the idea has a home.

**Agent-curated Rules promotion (#6).** Cursor lets agents own the whole guide. Captain
deliberately splits this: agents append verified learnings to the Inbox, humans promote to
Rules via the captain skill. That asymmetry is a trust boundary (a bad rule poisons every
future launch), not an oversight. Keep it.

## Not applicable — the contention machinery (#7)

Most of the post's engineering — a from-scratch VCS doing 1,000 commits/second, a neutral
merge-mediator agent, megafile flagging with commit blocks, split-brain reconciliation via
compile-checked design-doc references, licensed intentional breakage — solves shared-state
contention among hundreds of agents in one codebase (their old harness accumulated 70,000+
merge conflicts in under two hours; one file was touched by 1,173 agents). Captain sits on
the other side of Coase's firm-boundary argument the post itself cites: one worktree per
ticket means agents never share mutable state, and the human merge gate is the
coordination point. The failure catalogue is still useful reading as a preview of what
breaks if that isolation is ever weakened — but none of it is work to do.

Two numbers that make the isolation bet vivid: the old harness needed 64,305 lines of
engine code where the new needed 9,908 for the same passing suite, and Cursor's own
diagnosis of the 70×-higher commit rate was "busywork (thrash, contention, churn)" — high
activity metrics reading as productivity is exactly why `captain gain` counts decisions
and verdicts, not operations.
