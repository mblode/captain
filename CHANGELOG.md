# linear-worktree

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
