# linear-worktree

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
