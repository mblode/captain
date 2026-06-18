# Steal-worthy ideas audit — captain vs. Block's Builderbot (June 2026)

## Context

Block published "Builderbot" (block.xyz, June 2026): an orchestration layer that
coordinates many AI agents across a 100M+ LOC monorepo, picks up Linear/Jira tickets,
opens PRs, watches CI, and lets engineers steer from a Slack thread. It is the same shape
as **captain** — a fleet of agents driving Linear-ticket → PR-ready pipelines — but built
on the opposite infrastructure bet: a persistent, multi-user, Slack-native service.

This audit asks, capability by capability: **what should captain steal, what should it
adapt, and what is a deliberate non-goal** because it collides with captain's thesis
(no daemon, no persisted state, single-operator, terminal-native; status derived live from
cmux + `.captain/` files). Findings are grounded in the actual code (file:line) and in the
`research/` history of the watcher-daemon that was deleted June 2026.

The intended outcome: a decision doc that (a) names the 1–2 quick wins worth building now,
(b) names the ideas worth building _if_ a specific need is real, and (c) records the
Builderbot bets captain should explicitly _not_ chase, with the reasoning, so the no-daemon
invariant has a written defence the next time someone proposes a listener/daemon.

## TL;DR verdict table

| #   | Builderbot capability                                               | Verdict                        | One-line reason                                                                               |
| --- | ------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| 1   | **Data-scope guardrail** (source+config only, no PII/customer data) | **ADOPT — now**                | Cheap, high-trust signal, zero architectural tension                                          |
| 2   | **Fleet telemetry / scale metrics**                                 | **ADOPT — now (stateless)**    | Derive on demand from `log.jsonl` + verdicts; mirrors `rtk gain`; no daemon                   |
| 3   | **Cross-repo / org context**                                        | **ADAPT — not a current need** | Global memory tier + org-conventions string; _not_ a code indexer. Deferred                   |
| 4   | **Multi-tracker** (Linear _and_ Jira)                               | **ADAPT — not a current need** | Extract an `Issue` provider interface; revisit only if a non-Linear tracker appears           |
| 5   | **Multi-repo dispatch** in one fleet                                | **ADAPT — build (real need)**  | Surface is already multi-repo-aware; dispatch is single-repo. The headline feature investment |
| 6   | **Conversational dispatch** (`@builderbot` in Slack)                | **REJECT — non-goal**          | Needs a persistent listener = the daemon class that was deleted                               |
| 7   | **Real-time multi-user steering**                                   | **REJECT — non-goal**          | Conflicts with single-operator + no-state thesis                                              |
| 8   | **Shared surface = the dev env** (Slack thread)                     | **ADAPT — one-way only**       | One-way `notify`→Slack push is OK; two-way control is the non-goal                            |
| 9   | **End-to-end ticket→branch→PR→CI→iterate**                          | **ALREADY HAVE**               | self-drive `<workflow>` + `/pr-babysitter` (parity, nothing to steal)                         |
| 10  | **Humans step in where they add most value**                        | **ALREADY HAVE**               | the plan/verdict gate model                                                                   |
| 11  | **Open foundations** (goose, MCP, AAIF)                             | **N/A — positioning**          | captain is cmux-native; at most, document the orchestration patterns                          |

---

## ADOPT NOW — the two quick wins

### 1. Data-scope guardrail (S–M effort, low risk)

**Builderbot:** "operates on source code and system configuration only; does not access or
process customer data, payment information, or PII." **Captain today:** the brief
(`src/prompt.ts:84-145` `renderPromptExtras`) carries `<workflow>`, `<finishing-protocol>`,
`<fleet-memory>` — but **no safety/data-scope guardrail at all**.

This is the highest signal-per-line change available. Implementation (designed against the
real seams):

- **`src/prompt.ts`** — add optional `dataScope?: string` to `PromptExtras` (`:63-76`); emit
  a `<data-scope>` block in `renderPromptExtras` _between_ `<workflow>` and
  `<finishing-protocol>`. Gated on a truthy field, so `renderPromptExtras({})` stays
  byte-identical (`prompt.test.ts` asserts `=== ""`). Keeps prompt.ts pure (no fs).
- **`src/config.ts`** — add `DEFAULT_DATA_SCOPE` (a sensible non-empty default — guardrail is
  on by default), `parseDataScope` (string sibling of `parseSkills`), and
  `loadDataScope(env)` copying `loadSkills`'s exact fail-safe shape
  (`CAPTAIN_DATA_SCOPE` env > `config.json` `.dataScope` > default; `try/catch → default`,
  never throws).
- **`src/rubric.ts`** — add an optional `dataScope` param to `criteriaFor` (`:29`) /
  `renderRubric` (`:56`) and push one acceptance criterion so the **verifier** checks scope
  compliance too. The rubric-hash change is self-consistent (each `start` rewrites
  `.captain/rubric.md` fresh; `rubric.test.ts:45` already treats criteria-driven hash changes
  as expected — no hardcoded hash anywhere).
- **`src/runner.ts`** — thread `dataScope` through `withLoopExtras` (`:247`), the single
  chokepoint both `prepareIssue` (Linear fan-out + single issue) and `runDispatch` (free-form)
  funnel through → behaviour parity across **all** start modes and `--print` for free.

### 2. Fleet telemetry — `captain gain` (S–M effort, low risk)

**Builderbot:** "200,000 operations/day, ~1,500 PRs/week, ~15% of all production code."
**Captain today:** records only approve/reject to `~/.claude/captain/log.jsonl`
(`src/captain/log.ts`). No analytics command. The user already uses & likes `rtk gain`, so a
`captain gain` (alias `audit`) mirrors a familiar pattern.

**Adversarially confirmed: this needs no daemon, no persisted counters, no event stream** —
every metric is an on-demand read, exactly like `status`:

- **From `log.jsonl`** (the one true history): approve/reject counts, approval rate, reject
  reasons, decision cadence by day, `--since` window. _Gap-free for human decisions._
- **From live `fleetRows`** (`src/captain/surface.ts:55`): current NEEDS YOU / IN FLIGHT /
  READY composition, per-repo split, open PR URLs. _Honest label: a snapshot, not a trend._
- **From each worktree's `.captain/verdict.json`**: pass/fail tally + criteria-level failure
  breakdown, hash-validated via `verdictCounts`. _Snapshot of the live fleet only —
  verdict.json is overwritten and dies with the worktree; not a historical ledger._
- **`--git` (opt-in)**: merged-PR counts via `gh pr list --state merged`, fail-soft like
  `changedFiles`. The closest thing to "1,500 PRs/week", explicitly flagged "approx".

Structure mirrors the codebase split: a **pure** `src/captain/gain.ts` (`computeGain(input)`
→ metrics, lint-enforced no-fs like `view.ts`) + a thin fs/cmux edge in `commands.ts` + a
`renderGain` in `format.ts` (TTY colour, plain `--json`) + a `captain gain` subcommand in
`cli.ts`. New I/O: one `readLog(env)` reader in `log.ts` (skip-bad-line, missing→`[]`).

**Honesty contract (printed in the footer, tested for presence):** decisions are gap-free
per-machine history; fleet/verdicts are a live snapshot; `--git` is an approximation;
operation-level throughput à la "200k ops/day" is _not_ recorded by design. This is the
accepted tradeoff, stated rather than hidden.

---

## ADAPT — the one to build: multi-repo dispatch

### 5. Multi-repo dispatch (M–L effort) — **the real need**

This is the capability worth investing in. The good news: the **surface is already
multi-repo aware** — `view.ts` `identityOf` composes `${repo}-${ticket}`, `mergeOrderHints`
skips cross-repo file overlap, and `repoLabel` (`control.ts:11`) derives the repo name per
worktree at render time. `status`/`approve`/`reject` would already display and resolve a
fleet that spans repos. Only **dispatch** is single-repo-bound.

The three single-repo assumptions to break (all in the start path):

1. **One `resolveRepo` per invocation** (`runner.ts:282`). `captain start` resolves exactly
   one repo root from cwd/`--repo-path`. Multi-repo needs a repo resolved _per issue_.
2. **Worktree sibling rule** (`git.ts:215-218`): `worktreePath = join(dirname(repoRoot),
basename(repoRoot)-{issueId})`. `ensureWorktree` takes one `repoRoot`; multi-repo needs it
   called per-repo with the correct root.
3. **Memory keyed by `basename(repoRoot)`** (`memory.ts:40`) — a latent collision bug
   (two repos named `web` in different parents share memory). This becomes a **prerequisite
   fix** under multi-repo: key by a stable hash/path-suffix of the full `repoRoot`.

**The crux / open design decision (flag, don't pre-decide):** _how does an issue map to a
repo?_ Linear issues don't carry a target repo. Options, cheapest first — (a) a config map in
`config.json` (Linear team/project → repo path), loaded fail-safe like `loadSkills`; (b) a
per-issue `--repo-path` on the CLI; (c) infer from Linear's git-branch metadata if present.
A config map (a) fits captain's existing patterns best and keeps dispatch declarative. This is
the one decision to settle before building #5.

Effort M–L; touches `runner.ts` (per-issue repo resolution in `dispatch`/`prepareIssue`),
`git.ts` (`ensureWorktree` already parameterised by `repoRoot` — wire per-repo), `memory.ts`
(collision fix), `config.ts` (the repo map loader). No daemon, no new state — it's still
fan-out + filesystem.

## ADAPT — documented but deferred (not a current need)

### 3. Cross-repo / org context — deferred

Notably _not_ needed even with multi-repo fleets: each agent stays scoped to its own repo, so
no cross-repo context injection is required (a simpler world). If it ever is, the lightweight
path is a **global memory tier** (`~/.claude/captain/memory/__global__/learnings.md` +
`readGlobalMemoryExcerpt` reusing `memoryExcerptOf`, injected above the per-repo excerpt with a
"consult, do **not** append here" label) and/or an `<org-context>` config string — never a
code index/embeddings (that heavyweight version stays a non-goal).

### 4. Multi-tracker / Jira — deferred

Linear is hard-coded throughout (`LinearIssue` `types.ts:29-45`, `fetchLinearIssue`
`linear.ts:6`, the ID regex `issue.ts:4`, `isLinearToken` `runner.ts:549`,
`renderPrompt`/`renderRubric` field access). No `Issue` abstraction exists. If a non-Linear
tracker ever appears, extract an `IssueProvider` interface (`isId`/`parse`/`fetch`) + a
generic `Issue` type and make Linear one provider. Worth the refactor for cleanliness then;
not worth it speculatively now.

### 8. Shared surface — one-way push only (not pursued)

The steal-worthy kernel of "the conversation is the dev environment" is **reduced context
switching**. A thesis-compatible slice: a **one-way** `captain notify`→Slack bridge that
pushes "NEEDS YOU" rows to a channel (the `notify` poller already diffs the view every ~30s;
no new state). **Two-way control/ingestion from Slack is the non-goal** (see below).

---

## REJECT — deliberate non-goals (what NOT to steal)

These are Builderbot's biggest bets and exactly where captain says "no" on purpose.

**6. Conversational dispatch (`@builderbot` in Slack) + 7. real-time multi-user steering +
the two-way half of 8.** All three require a **persistent process** holding webhook/event
connections and coordinating multiple writers — i.e. the watcher-daemon class of thing.

Captain **deleted exactly this** in June 2026 (commit `372dc4b`, ~2,270 LOC across 10 files:
`daemon.ts`, `watch.ts`, `events.ts`, `state.ts`, `intents.ts`, `sweeps.ts`, `commit.ts`, …).
The `research/` history records _why_, and it is the core argument for the rejection:

- Agents run in **bypass-permissions mode and self-drive** the whole pipeline; they don't
  reliably wait at gates. A per-step puppeteer _collides_ with an agent already running the
  next step (`session-findings.md` bug #6).
- **Every one of the 5 live-session bugs was in untested I/O/orchestrator code** — daemon
  death, fleet-wipe on a flaky `workspace.list`, gate-flap on re-emitted hook frames,
  two-writer `state.json` clobber (approvals didn't stick), manual lifecycle (~4 restarts).
  The pure core was fine; the daemon was where bugs lived.

A Slack-native, multi-user, real-time captain would reintroduce that whole failure domain.
The CmuxPort seam (`control.ts:62-75`) means a _remote adapter_ is technically possible, but
the **listening/coordinating service is the non-goal**. The stateless model also eliminates
the multi-writer coordination problem entirely — there's nothing to coordinate.

**9 & 10 (end-to-end automation, human-in-the-loop):** captain already has these — the
self-drive `<workflow>` (plan → implement → skills → `/pr-creator` → `/pr-babysitter` →
verifier verdict) and the plan/verdict gates. Parity, not theft.

**11 (open foundations):** positioning, not a feature. If anything, the steal is _narrative_:
captain could document its no-daemon orchestration pattern the way Block open-sourced goose.

---

## Recommended sequence

1. **Data-scope guardrail** (#1) — smallest change, biggest trust signal, no tension. Cheap
   warm-up.
2. **`captain gain`** (#2) — gives captain its own "PRs shipped" story, stays stateless, reuses
   the `rtk gain` mental model.
3. **Multi-repo dispatch** (#5) — _the real feature investment._ Settle the issue→repo mapping
   decision first (a config map is recommended), do the `memory.ts` basename-collision fix as a
   prerequisite, then thread per-issue repo resolution through `dispatch`/`ensureWorktree`. The
   surface already supports it.
4. Record #6/#7/#8-two-way as **explicit non-goals** in `CLAUDE.md` (the "No daemon, ever"
   gotcha already exists — extend it to name Slack/real-time so the next proposer reads the
   history first).

Cross-repo context (#3) and Jira (#4) are documented above but deferred — not current needs.

## Verification (if the quick wins are built)

- **Data-scope:** `npm run test` (new `config.test.ts` cases mirror the 5 `loadSkills` cases;
  `prompt.test.ts` asserts `<data-scope>` present when set, absent + byte-identical when unset;
  `rubric.test.ts` asserts the criterion). Manual: `CAPTAIN_DATA_SCOPE="..." captain start <id>
--print` shows the `<data-scope>` block; with no config the default appears; all three start
  modes carry it.
- **`captain gain`:** pure `gain.test.ts` with fixture `LogRecord[]` + `FleetRow[]` (no I/O);
  `commands.test.ts` extended with the existing fake-`CmuxPort` + `CAPTAIN_HOME` temp pattern —
  seed `log.jsonl`, build a fleet with a passing-verdict worktree, assert JSON metrics; assert
  `--json` is pure JSON, `--since` filters, unreachable cmux → structured error + exit 11.
  Manual: `captain gain` (TTY colour) and `captain gain --json` (plain) against a live fleet.
- Whole suite green: `npm run typecheck && npm run check && npm run test`.

## Critical files (if building)

- `src/prompt.ts`, `src/config.ts`, `src/rubric.ts`, `src/runner.ts` — data-scope (#1) +
  org context (#3).
- `src/captain/gain.ts` (new, pure), `src/captain/log.ts` (`readLog`), `src/captain/commands.ts`,
  `src/captain/format.ts`, `src/cli.ts` — `captain gain` (#2).
- `src/memory.ts` — global memory tier (#3).
- `CLAUDE.md` — env knobs + extend the "No daemon, ever" non-goals note (#6/#7/#8).
