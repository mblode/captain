# linear-worktree

## 2.0.0

### Major Changes

- 08dc6ee: Drop the unused library entry point: `cmux-captain` is a CLI.

  `package.json` declared `main`, `types` and `exports` pointing at a 31-name
  `src/index.ts`. Nothing in the repo, the README, the docs site or the `/captain`
  skill ever imported it, and no usage was documented anywhere — so it was 31 public
  names under semver with no stated contract. The package now ships `bin` only, and
  `dist/` is `cli.js` alone.

  **Breaking:** `import { … } from "cmux-captain"` no longer resolves. The `captain`
  command is unaffected. If you were importing it, open an issue — the surface can
  come back documented and deliberate rather than incidental.

### Minor Changes

- 1990b04: Add `gain.roster`: the per-ticket detail behind the tallies.

  `captain gain --json` now carries a `roster` — one entry per launch, newest first, with
  `launchedAt` and the approve/reject decision from the ledger, and `title`, `group`,
  `verdict`, `summary` and `prUrl` from the live fleet. It answers "what got done and what's
  left", which neither command could before: `status` is live-only, so a merged worktree
  leaves the view entirely, and `gain` reported only aggregates.

  It is driven off launch records rather than live rows, so a worktree that has been merged
  and removed still appears — degraded to name, launch time and decision, with `live: false`.
  A caveat names that ledger-vs-snapshot split. The roster is windowed by `--since` and capped,
  with the remainder reported in `dropped`.

  `status --json` rows now also carry `title`, read from the worktree's rubric in the same file
  read that already recomputed its hash (`readRubricFacts` replaces `expectedRubricHash`). No
  new I/O, no network — `status` and `gain` stay offline.

- 2c09a6d: Fix the fanned-out pipeline order, and let a step be plain English.

  `DEFAULT_SKILLS` ran `/tidy` before `/pr-reviewer`. Both skills document the opposite: the
  reviewer is read-only and writes a report whose `Fix:` lines are committable, and `tidy`'s
  Phase 2 looks for a review that already ran and applies its confirmed findings. In the old
  order the report was produced with nothing downstream to apply it, so every fleet PR opened
  still carrying the review's own "Must fix before push" findings. The default is now
  `/pr-reviewer` → `/tidy` → two conditional UI steps → `/pr-creator` → `/pr-babysitter`, and
  the order is pinned by a test.

  **This changes behaviour on every launch.** A setup that pinned its own `.skills` or
  `CAPTAIN_SKILLS` is unaffected.

  A pipeline entry may now be a plain-English instruction instead of a `/skill` token; it
  renders verbatim as its own numbered step. That is how a step becomes conditional — the two
  new UI steps run only when the diff touches user-facing UI or a rendered page — with no
  `when` schema and no condition evaluator.

  `"$defaults"` in `.skills` (or `CAPTAIN_SKILLS`) now expands in place to the built-in
  pipeline, so you can extend it instead of silently replacing it. Without the token a
  non-empty list still replaces, as before.

### Patch Changes

- 08dc6ee: Fix three CLI defects found by a developer-experience audit.

  **`captain install` told new users to run a command that does not exist.** Its
  success line, the degraded-setup line, the empty-fleet hint in `status`, and a
  worktree-recovery note all said `captain fanout …`. There is no `fanout`
  subcommand — and typing it did not error. `withImplicitStart` only guarded a
  single bare word, so `captain fanout TIG-430` was treated as a free-form task and
  launched an agent in the user's current directory, overwriting that checkout's
  `.captain/rubric.md`. The same hole made `captain aprove tig-430` start an agent
  instead of suggesting `approve`. A bare word followed by issue tokens is now left
  for commander, which errors and names the near miss.

  **`--json` did not always emit JSON.** Commander's own parse failures (unknown
  command, unknown option, missing argument) never reach an action handler, so they
  bypassed the documented error envelope: `captain approve --json` wrote prose to
  stderr and left a driver's `JSON.parse` with empty stdout. Those failures now emit
  `{"error":{"message","type"}}` on stdout with the human hint still on stderr.

  **`--interval` accepted anything.** `captain status --watch --interval abc`
  silently fell back to 5 seconds. It now fails at the boundary and names the value.

  **Usage errors all exit 2 now.** `errors.ts` documents `EXIT.USAGE = 2` so a
  driver can branch on the number, but only some paths used it: a bad flag
  combination exited 2 while a missing argument or unknown command exited 1.
  Commander's parse failures now map to the same code as every other usage error.

  Also: the doctor checked `Node >= 22` while `engines.node` required `>=24`, so a
  Node 22 machine passed setup and then failed to install. One constant now, pinned
  to `engines` by a test. `reject --json` no longer emits `undelivered`, which was
  hardcoded `[]` and unreachable since rejection became fail-closed.

## 1.0.0

### Major Changes

- d759143: Release 1.0.

  Captain is driven through its commands and flags, and the 0.x line moved that
  surface more than once: `captain doctor` was folded into `captain install`, and
  `.repoMap` config routing was removed outright. Both were breaking, and 0.x gave no
  way to say so that a consumer's version range would respect.

  1.0 is the commitment that a command or flag going away now costs a major, and that
  a minor is safe to take.

## 0.9.0

### Minor Changes

- 783705a: Don't start issues whose blockers are still open. `captain start tig-1 tig-2` no longer
  starts dependent work against a prerequisite that hasn't landed: Linear blocking relations
  map to an optional `Issue.blockedBy`, and a blocked issue is held back. Fan-out **skips** it
  and launches the rest; a **single** blocked issue **errors** (`ISSUE_BLOCKED`, exit 1) naming
  the open blockers, because with no other ticket to proceed with a skip would be a silent
  successful-looking no-op. `--force` launches anyway, and `--print` still prints a brief for
  either (printing is not launching).

  Read-only (captain still writes to no tracker), launch-time only (never in `status`, which
  derives with no network), and fail-safe — absent or unfetchable relations read as unblocked,
  so donebear and a Linear hiccup both launch rather than silently refusing to.

  Also fixes a donebear task's images routing through the Linear download path: the fetch is
  now gated on the issue's source, not just on `LINEAR_API_KEY` being set.

## 0.8.8

### Patch Changes

- b1be1af: Fix `approve`/`reject` against cmux 0.64.17: `feed.exit_plan.reply` takes the feed item's
  `request_id` and a `mode` enum, not its `id` and an `approve` boolean. Every plan reply had been
  failing with `invalid_params: feed.exit_plan.reply requires request_id`, forcing approvals through
  `cmux send` and keeping their notes out of the `gain` ledger.

## 0.8.7

### Patch Changes

- 244b0a7: Record the reasoning behind plan approvals.

  `captain approve` now takes an optional `--note` (the reviewer's recommendation), recorded in
  `log.jsonl` alongside reject's. `captain gain` reports `decisions.unexplainedApprovals` and
  `recentApprovalReasons` — omitted entirely until the ledger contains at least one noted
  approval, so a pre-`--note` history is never reported as a governance failure.

## 0.8.6

### Patch Changes

- 5439f72: Fix curated fleet memory never reaching a brief, and give verdict criteria an n/a state.

  - `memory.ts` located `## Rules`/`## Inbox` with `indexOf`, and the skeleton's own preamble
    named `## Inbox` first — so the rules slice was backwards and empty, and the curated
    section was silently dropped from every brief. Headings are now matched at line start,
    and the skeleton names no heading in its prose. The skeleton also no longer states an
    append policy: it is only written when the file is absent, so a stale policy could never
    be refreshed.
  - Verdict criteria accept `na: true` (reason in `evidence`) for a criterion that cannot
    apply to the diff — neither a pass nor a failure, and never tallied by `gain`. The rubric
    pins each criterion `name` verbatim so a softened bar surfaces as a rename.
  - `parseVerdict` accepts `ts` as a quoted integer as well as a number; the rubric's schema
    example modelled it as a string, so most verdicts were scored `0` and dropped from
    `gain`'s launch→verdict latency.
  - The brief no longer mandates `AskUserQuestion` for codex agents, which have no such tool
    and were left no legal way to surface a blocker. Plans now lead with ambiguities and
    assumptions, and the fleet-memory guidance drops an ineffective dedupe mandate.

## 0.8.5

### Patch Changes

- f62c589: Keep retried workspaces visible by restoring missing Captain rubrics, and label free-form task rubrics accurately.

## 0.8.4

### Patch Changes

- 4b77cf3: Reduce fleet token usage with compact launch context and delta status polling, while making retries, launches, and control commands fail safely.

## 0.8.3

### Patch Changes

- 81ad736: Skip blank donebear checklist rows (empty title) when building acceptance criteria, so a task with an empty checklist item no longer renders an empty `<criterion>` in the agent brief. The rubric already ignored blank rows; this aligns the prompt.

## 0.8.2

### Patch Changes

- f5fe663: Add donebear.com as a second issue source: `captain start <task-url|uuid>` fetches a Done Bear task (title + checklist) and drives it through the same worktree → rubric → prompt → verdict pipeline, with each unchecked checklist item becoming an acceptance criterion. Read-only (needs `DONEBEAR_TOKEN`). Internally, issue-source handling now goes through a `source.ts` registry and a source-neutral `Issue` contract, so Linear and donebear share one path and adding a source touches one file.

## 0.8.1

### Patch Changes

- 779326f: `captain gain` now reports latency to detection: `start` ledgers each launch in `log.jsonl` (fail-soft, never `--print`) and gain joins launch→decision and launch→verdict by the qualified worktree name for median/max stats. The fleet-memory brief additionally requires distilling the root cause of any verifier failure once the run eventually passes.

## 0.8.0

### Minor Changes

- aeca2e0: Subsume `linear-worktree`: bare `captain <ticket>` now works like `captain start <ticket>` (creates the worktree, opens a cmux workspace, and launches the agent in plan mode with the Linear ticket pulled in). Add optional codex support via `--agent <claude|codex>` (or `CAPTAIN_AGENT` / the `.agent` config key); codex is best-effort with no plan gate.

## 0.7.0

### Minor Changes

- 5e2b201: Enforce fleet resource caps at launch: every agent's claude process now carries `VITEST_MAX_THREADS=2`/`VITEST_MAX_FORKS=2` (extend or override via config `.agentEnv`, e.g. a `NODE_OPTIONS` heap cap), on both the cmux workspace command and the inline fallback. Fan-out and dispatch also print a note when the target repo's jest config has no `maxWorkers` cap — jest ignores env for worker sizing, so an uncapped repo config is the one hole captain can only warn about. Follow-up to the Jul 6 incident where concurrent uncapped jest pools exhausted the machine and got the fleet jetsam-killed.

## 0.6.0

### Minor Changes

- 387413c: Pin each fleet agent's model and effort at launch so it never inherits the driver's ambient tier. Both launch paths (`cmux` fan-out and the inline plan-mode fallback) now pass `--model`/`--effort` to `claude`, defaulting to `default` / `high` (`default` resolves to the machine's configured default model). Override per fleet with `CAPTAIN_MODEL` / `CAPTAIN_EFFORT` or the config-file `.model` / `.effort` keys (fail-safe, same precedence as `.skills` / `.dataScope`).

## 0.5.2

### Patch Changes

- 5c89a52: Fix resolution/worktree/hash bugs and apply Boy Scout cleanups. `approve`/`reject` now resolve bare tickets by exact match (no `tig-1`→`tig-10` bleed), `reject` acts on every matched target, `start` no longer crashes on a linked worktree (`gitCommonDir`), a `## Verdict` heading in an issue description can no longer void the rubric hash (`lastIndexOf`), the verdict guard validates `evidence`, and `runStates` keeps the `claude_code` tag authoritative. Internal dedupe (`groupCounts`, `cmuxUnreachable`, `readConfig`, `ownsCwd`, `worktreeTmpDir`), `repoLabel` moved into `git.ts`, dead code removed, and unused `@clack/prompts` + `gray-matter` deps dropped.

## 0.5.1

### Patch Changes

- 2b7fa3a: Resolve cross-repo ticket collisions natively: when one ticket is fanned into two repos, approve/reject now disambiguate by the qualified `repo-ticket` name (refusing to guess on a bare colliding id) instead of requiring a workspace uuid, and `status` prints the resolvable handle.

## 0.5.0

### Minor Changes

- db16ea7: Remove `.repoMap` config-based repo routing (breaking).

  Routing a Linear ticket to a repo can't be a static lookup — a Linear team spans many repos and even a single project's tickets span repos. So the `.repoMap` config key, its `team-prefix → repo path` matching, and the `loadRepoMap`/`parseRepoMap`/`teamPrefixOf` helpers are gone. A run's repo is now resolved purely from `--repo-path` (else the cwd git repo). Spanning several repos in one session is the `/captain` skill driver's job: it reads each ticket and passes `--repo-path` per repo. If you relied on `.repoMap`, drop it from `~/.config/captain/config.json` and route with `--repo-path`.

### Patch Changes

- db16ea7: `captain start --print` now copies the `cd` command to the clipboard only for an interactive terminal (TTY). Previously it ran `pbcopy`/`wl-copy`/`xclip` unconditionally, so piped runs, `--json`, the `/captain` skill driver, and the test suite all clobbered the real system clipboard (e.g. with a temp worktree path). Piped/automated runs now print the command without touching the clipboard.

## 0.4.1

### Patch Changes

- c3c5421: Collapse setup to one command: `captain install` installs the skills the fleet needs (`mblode/captain` + the pipeline skills) and then checks the environment. Replaces `captain doctor` (the old check-only command, now removed).

## 0.4.0

### Minor Changes

- 11d7432: Add three features to the self-drive pipeline:

  - **Data-scope guardrail** — every agent brief now carries a `<data-scope>` section (operate on source/config only; no customer data, secrets, payments, or PII), with a matching rubric criterion. Configurable via `CAPTAIN_DATA_SCOPE` or `config.json` `.dataScope`; on by default.
  - **`captain gain`** (alias `audit`) — stateless fleet telemetry derived on demand from the decision log, the live cmux fleet, and verdict files (no daemon, no counters). Supports `--json`, `--since`, and an opt-in `--git` merged-PR approximation.
  - **Multi-repo dispatch** — one `captain start` can fan out across repos by resolving a repo per issue via `config.json` `.repoMap` (team-prefix → repo path). Purely additive: with no `.repoMap`, behaviour is byte-identical to single-repo.

## 0.3.2

### Patch Changes

- 10323da: Expose machine-readable captain driver surfaces for starting, polling, approving, and rejecting work. Status rows now carry deterministic next-command and state-hash fields, compact summary polling is available, and cmux connectivity failures report structured JSON errors for unattended drivers.

## 0.3.1

### Patch Changes

- 321efe0: Release recent captain CLI updates, including configurable skill selection, the unified start command, and quality refinements.

## 0.3.0

### Minor Changes

- d114e73: Make captain self-serve. Add `captain doctor`, a preflight that checks Node, git, claude, cmux, `LINEAR_API_KEY`, and the review/PR skills the agent brief invokes (`/pr-reviewer`, `/pr-creator`, `/pr-babysitter` from `mblode/agent-skills`; `/simplify` ships with Claude Code). Publish the CLI to npm as `cmux-captain` (`npm i -g cmux-captain`; the binary stays `captain`) with a getting-started README, and fold the worktree, Linear, and fan-out logic in directly so `captain fanout` no longer depends on a separate `linear-worktree` CLI.

## 0.2.0

### Minor Changes

- 036a360: Simplify repo detection to the current git repo or an explicit `--repo <path>`. The `~/.config/linear-worktree/repos.json` team map and the `LINEAR_WORKTREE_REPO` environment variable are no longer supported — run the command from inside the target repo, or pass `--repo` when outside it.

## 0.1.0

### Minor Changes

- c4dc639: Launch each issue in a focused cmux workspace rooted at its worktree (with an inline fallback when cmux isn't running), so quitting Claude leaves you in the new directory. Claude now opens in plan mode with bypass permissions available via shift-tab (`--permission-mode plan --allow-dangerously-skip-permissions`).

  Startup is faster and no longer silent: the Linear fetch overlaps the `git fetch`, screenshots download in parallel, and each step prints progress to stderr. Multi-issue fan-out shows a per-issue `[x/total] ISSUE-ID` indicator. Worktree creation is now idempotent — re-running reuses an existing worktree and prunes stale registrations whose directories were deleted.

### Patch Changes

- 21435d6: Make the docs and examples org-neutral. README, skill references, and test fixtures now use placeholder team prefixes and repo paths instead of organisation-specific names, and the agent instructions drop a private migration note.
