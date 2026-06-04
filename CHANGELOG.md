# linear-worktree

## 0.2.0

### Minor Changes

- 036a360: Simplify repo detection to the current git repo or an explicit `--repo <path>`. The `~/.config/linear-worktree/repos.json` team map and the `LINEAR_WORKTREE_REPO` environment variable are no longer supported — run the command from inside the target repo, or pass `--repo` when outside it.

## 0.1.0

### Minor Changes

- c4dc639: Launch each issue in a focused cmux workspace rooted at its worktree (with an inline fallback when cmux isn't running), so quitting Claude leaves you in the new directory. Claude now opens in plan mode with bypass permissions available via shift-tab (`--permission-mode plan --allow-dangerously-skip-permissions`).

  Startup is faster and no longer silent: the Linear fetch overlaps the `git fetch`, screenshots download in parallel, and each step prints progress to stderr. Multi-issue fan-out shows a per-issue `[x/total] ISSUE-ID` indicator. Worktree creation is now idempotent — re-running reuses an existing worktree and prunes stale registrations whose directories were deleted.

### Patch Changes

- 21435d6: Make the docs and examples org-neutral. README, skill references, and test fixtures now use placeholder team prefixes and repo paths instead of organisation-specific names, and the agent instructions drop a private migration note.
