# Loops à la Fable 5 — the verifier gate and fleet memory (June 2026)

Source: Lance Martin (Anthropic) on designing loops with Fable-class models
(<https://x.com/RLanceMartin/status/2064397389189071163>). Two findings, both
directly relevant to captain, both now implemented:

1. **A verifier sub-agent in an independent context window outperforms
   self-critique.** Put the goal/rubric in the _environment_; a grader confirms
   the criteria are met before the agent may stop (this is what CMA "Outcomes"
   and Claude Code `/goal` productize). Models grade their own outputs badly;
   a fresh context grades them well.
2. **Memory works when it completes a progression**: fail → investigate →
   verify → distill into general rules → consult the rule instead of
   re-deriving it. Weak memory is a pile of failure notes (Sonnet-class);
   strong memory is verified general rules with high verification coverage
   (Fable-class). The punchline: _"rather than directly prompting and steering,
   design loops that let the model self-correct in response to environment
   feedback and manage its own context via memory."_

## How this maps onto captain

The punchline **validates** PLAN.md's surface-and-gate thesis (Phase 4):
captain's per-`Stop` slash-command driving is exactly the "directly steering"
anti-pattern; loops the agent closes itself against the environment are the
recommended shape. It also supplies the principled **replacement** for the
tuning/metrics subsystem Phase 2 deletes: outcome verification (did the work
meet the rubric?) supersedes retry-budget arithmetic (how often did this stage
bounce?) — the latter never fired in the live 10-worktree session.

### The verifier gate (implemented)

- Fan-out writes `.captain/rubric.md` into each worktree (`src/rubric.ts`):
  acceptance criteria mechanically derived from the Linear issue + the standard
  repo gates, a fixed verification procedure, and the verdict JSON schema. The
  procedure is the post's independent-context grader, spawned **agent-side**:
  the agent must run a fresh-context verifier sub-agent over only the rubric +
  the diff, and may not write a pass verdict without one.
- The agent writes `.captain/verdict.json`; the watcher (which can only observe
  hook-event names and the fs at `wt.cwd`) reads it on `Stop` and on the 30s
  reconcile tick (`src/captain/verdict.ts`, `applyVerdictFor` in `watch.ts`).
  Pass → `READY_TO_MERGE` + the `pr-ready` gate (wiring the previously dead
  stage); fail → `BLOCKED` with the verifier's summary. Missing verdict →
  exactly the old behaviour. Purely additive, fail-safe by construction.
- Tamper check: the verdict must cite the sha256 of the rubric body as it
  exists _now_ — editing the criteria after the fact breaks the match.

### Fleet memory (implemented)

- `~/.claude/captain/memory/<repo>/learnings.md` (`src/memory.ts`): `## Rules`
  (curated, injected in full) + `## Inbox` (agent-appended, only the tail is
  injected so uncurated slop ages out — a safe failure mode).
- Consult: fan-out injects the excerpt into every agent prompt
  (`renderPromptExtras` in `src/prompt.ts`) with the write-side rule: append
  1–3 bullets, **only what you verified this run** — the post's
  verify-before-distill requirement stated as the writing rule.
- Investigate: reject feedback, gate hints, halt reasons, and verdict summaries
  now land in `history.jsonl` as `HistoryRecord.note` (they were previously
  dropped), so `captain audit` shows _why_ things failed.
- Distill: human-on-the-loop, via the captain skill's "distill the fleet's
  learnings" workflow (promote Inbox → Rules, delete slop). No daemon
  distiller.

## Considered and rejected: a daemon-run `claude -p` verifier

A watcher-spawned headless grader would give stronger independence (the agent
can't skip it). Rejected because: minutes of latency and real dollars per
verification inside a daemon; subprocess lifecycle management (timeouts,
queues, watchdogs) added to the exact layer where every bug in the live session
lived; and it contradicts the shrink-the-daemon thesis. If self-grading
contamination bites in practice, the strictly-additive upgrade is a
`/captain-verify` skill (still agent-side, uniform procedure) or the daemon
grader — the rubric/verdict file format already supports either.

## Residual risk, stated plainly

A misaligned agent can skip its verifier and hand-write `{"verdict": "pass"}`;
captain cannot distinguish. Mitigations: the procedure is fixed in the rubric
(the standard can't drift per-agent), the verdict demands per-criterion
evidence (fabricating it costs more than running the verifier), the rubric-hash
check catches after-the-fact edits deterministically, and the human merge gate
stays authoritative — the verdict gates the **label**, never the merge. This is
a labelling aid, not a security boundary.
