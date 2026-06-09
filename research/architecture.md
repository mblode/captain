# Architecture brief — captain (June 2026)

Audit + target architecture for the whole system against KISS, DRY, Clean Code, and
June-2026 practice. **No backwards compatibility required.** Produced by the
`define-architecture` adoption workflow (map → smallest boundary-enforcing changes →
vertical slice → guardrails → rollout). Companion docs: `PLAN.md` (the phased
improvement plan this refines), `session-findings.md` (lived evidence),
`loops-fable5.md` (the verdict-gate/memory design).

## Context and constraints

- A TypeScript CLI + detached watcher daemon (Node ≥ 22, ESM, tsdown→dist, vitest,
  oxlint/ultracite). One developer, one implicit fleet, ~10 concurrent worktrees.
- Two layers: the vendored `linear-worktree` fan-out (~1,270 LOC across 14 `src/*.ts`
  files) and the captain core (~1,900 LOC in `src/captain/*` + `rubric.ts`/`memory.ts`).
- Constraint that dominates everything: **the watcher is the sole writer of
  `state.json`**; humans/CLI communicate via append-only logs. This is load-bearing and
  correct — keep it.

## Audit findings (the scorecard)

What's already gold standard — keep, don't churn:

- **One subprocess wrapper** (`shell.ts`); `captain/control.ts` correctly layers on it.
  No parallel spawn implementations anywhere.
- **No dead exports, no duplication, no circular imports** in the inherited fan-out
  layer. Boundary is strictly one-way (cli/runner → captain; captain → only `shell.ts`
  and `rubric.ts`).
- **Persistence primitives are right**: append-only JSONL (tolerant tail), byte-offset
  cursor for exactly-once intents, temp+rename atomic state. `history.ts` vs
  `intents.ts` look similar but solve different concurrency problems — extracting a
  shared JSONL abstraction would be the _wrong_ abstraction; leave them separate.
- **The pure core is genuinely pure and well-tested** (pipeline, verdict, metrics,
  format, rubric, prompt: ~900 test LOC).
- **No `spawnSync` on the per-event hot path** — the only sync call per advance is the
  deliberate busy-check `readScreen`. Fine at 10 worktrees; an issue only past ~50.

The three real debts, in priority order:

1. **`watch.ts` is a 537-LOC god-file with zero tests** — and every one of the five
   bugs from the live session was in untested I/O code (`watch.ts`, `daemon.ts`,
   `state.ts`). The transition-application sequence (`setStage` → gate/note/verdict →
   `notify` → `record` → `saveState`) is inlined **six times** (handleEvent send-path,
   handleEvent gate-path, `applyIntent` approve + reject, `enforceHalts`,
   `applyVerdictFor`). That invariant living in six places is exactly where the
   approve-didn't-stick and gate-flap bugs came from. This is the DRY violation worth
   fixing — not for the ~30 LOC, but because the invariant gets one home.
2. **~470 LOC of never-fired superstructure** (no-backcompat deletion, confirmed by
   grep): `tuning.ts` (31), `metrics.ts` (204), `renderMetrics` + the `metrics` command
   (~170 across `format.ts`/`commands.ts`/`cli.ts`), `PipelineTuning`/`FleetMetrics`/
   `StageMetric` types, `transition()`'s `tuning` param, `Worktree.retries`,
   `isHumanGated` (only re-exported, never called). Safe because `checkHalt`
   (event-silence) and the verdict gate (outcome verification) superseded what tuning
   was for. `captain audit` + `history.jsonl` remain the measurement substrate.
3. **Screen-scraping where cmux has native APIs**: the `BUSY` "esc to interrupt" regex
   and the `gateHint` PROSE regex re-derive what cmux 0.64+ exposes via Feed/run-state.
   Pragmatic when written; now it's bug surface (session bugs #2, #11).

Clean Code notes (minor): `handleEvent` is 97 lines mixing four concerns
(adopt/verdict/transition/persist); verb vocabulary drifts (`apply`/`enforce`/`drain`/
`check`) — pick `check*` = pure decision, `apply*` = execute one, `sweep*` = loop many.

## Repo shape

Single package stays — no monorepo, no `apps/`/`packages/` split (one deployable, one
team; splitting is YAGNI). The two-layer shape is already real and one-way; make it
legible rather than moving files:

```text
src/
  cli.ts  index.ts          # entrypoints: commander + library surface
  <fan-out files>           # vendored linear-worktree layer (unchanged; only runner.ts knows captain exists)
  rubric.ts memory.ts prompt.ts
  captain/
    pipeline.ts verdict.ts  # PURE domain (the only logic; no I/O imports)
    types.ts
    state.ts history.ts intents.ts   # persistence edges (one concern each)
    control.ts events.ts daemon.ts   # cmux/process edges (control.ts becomes the injectable port)
    watch.ts → split:
      watch.ts              # entry: wiring + timer + event loop only (~80 LOC)
      commit.ts             # THE transition applier: one home for setStage+gate+note+notify+record+save
      adopt.ts              # adoptFromEvent + reconcile
      sweeps.ts             # sweepHalts + sweepVerdicts (reconcile-tick passes)
      intents-drain.ts      # drainIntents + applyIntent
    commands.ts format.ts   # read surface
```

## Module contracts (adapted to a CLI/daemon)

| Layer                                                                              | Contract                                                                           | Enforcement                                                                                    |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `cli.ts`                                                                           | transport only: parse argv, call one function, format exit                         | review                                                                                         |
| pure domain (`pipeline.ts`, `verdict.ts`, `rubric.ts` render, `memory.ts` excerpt) | no I/O imports (`node:fs`, `node:child_process` banned); data in, `Transition` out | oxlint `no-restricted-imports` per-path override — contracts decay without a lint rule         |
| edges (`state/history/intents/control/events/daemon`)                              | one resource each; no business decisions                                           | review                                                                                         |
| orchestrator (`watch.ts` + split modules)                                          | the ONLY state mutator; every mutation goes through `commit()`                     | `commit()` is the single exported mutator; oxlint bans `saveState` imports outside `commit.ts` |
| read surface (`commands.ts`, `format.ts`)                                          | never mutates; TTY-aware colour, `--json` stays plain                              | existing tests                                                                                 |

`commit(state, wt, transition, meta, opts)` is the keystone: applies stage/gate/note/
verdict/prUrl, decides new-gate idempotency (`isNewGate` moves here), notifies, records
history (with `note`), saves state. Six call sites collapse into one invariant.

## Request context and middleware policy (CLI equivalent)

- **No AsyncLocalStorage** — wrong tool for a single-tenant daemon (YAGNI). The
  explicit `env` threading (`opts.env` everywhere, `process.env` only at entrypoints)
  is the context policy; it's what makes the test suite hermetic
  (`CAPTAIN_NO_WATCH`, `CAPTAIN_MEMORY_DIR`). Keep it; never read `process.env` below
  an entrypoint.
- Knob convention stays uniform: `CAPTAIN_NO_<FEATURE>=1` to opt out,
  `CAPTAIN_<FEATURE>_<UNIT>` to tune.

## Frontend boundaries (the read surface)

`captain status` stays the whole read surface; `format.ts` owns all rendering; colour
only on TTY; `--json` plain. After the metrics deletion, `format.ts` drops to ~250 LOC
(status + audit). No TUI framework — YAGNI.

## Testing strategy

The inversion to fix: pure core ≈ fully tested; the orchestrator where all five real
bugs lived has zero tests.

1. Make `control.ts` an injectable port: `interface CmuxPort { listWorkspaces; send;
readScreen; notify; feedList; replyExitPlan }` with the spawnSync implementation as
   default. `watch()` takes the port; tests pass a fake. One seam, no mocking library.
2. Write the five regression tests the session already paid for: empty
   `workspace.list` must not prune; re-emitted `ExitPlanMode` must not regress an
   approved worktree; intent drain applies exactly once across restart; busy-defer
   defers; verdict pass/fail/missing/tampered routes correctly through `commit()`.
3. Keep the existing patterns: tmp dirs + env overrides, no mock frameworks,
   integration-style over pure logic. Unit tests stay fs-light; the runner integration
   tests already cover fan-out end-to-end.

## Rollout and rollback plan

Each slice is one PR, independently green, independently revertible (`git revert` —
no data migrations: state/history files only ever gain or lose _optional_ fields).

1. **Slice 1 — delete the superstructure** (~470 LOC out; the tracer bullet proving
   no-backcompat deletions are safe). Mechanical; tests updated in the same PR.
2. **Slice 2 — `commit()` + watch split + CmuxPort + the five regression tests.** The
   only behaviour-bearing refactor; the new tests are the rollback detector.
3. **Slice 3 — cmux-native signals** (PLAN.md Phase 3): Feed/run-state replace the
   BUSY/PROSE scrapes. Keep the scrape behind a fallback flag for one release, then
   delete.
4. **Slice 4 — plugin packaging** (PLAN.md Phase 5): verify the background-monitor
   feature first-hand before building; otherwise ship `captain restart` + self-heal
   instead. npm-link dies either way.

Phase 1 of PLAN.md (`--permission-mode plan` launch) is orthogonal and remains the
highest-leverage product fix; nothing here blocks it.

## Open risks and follow-ups

- The verdict gate is a labelling aid, not a security boundary (see
  `loops-fable5.md`); if self-grading contamination shows up, the upgrade path is a
  uniform `/captain-verify` skill — file formats already support it.
- `state.ts` (temp+rename, cursor) is still untested; cover it in slice 2.
- `research/session-findings.md` fails `npm run check` (formatting only, pre-existing)
  — one `npx ultracite fix research/session-findings.md` clears the last red.
- Re-evaluate the CmuxPort fake against real cmux quirks (the RPC's intermittent empty
  lists) — the fake must be able to simulate them, or the tests will be too kind.
