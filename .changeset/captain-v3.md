---
"cmux-captain": major
---

Captain v3: one local chat that runs your coding agents.

- **Projects and tasks:** `captain init <name> --repo <path>` creates `~/captain/<name>/`. Each task is a markdown file the `/captain` chat maintains.
- **New commands:** `add` (from a message, or a Linear or Done Bear ticket), `start --harness claude|codex|cursor`, `status`, `approve`, `reject`, `send`, `peek`, `review` (the other vendor reviews the PR), `done`, `drop` and `gain`.
- **Status from evidence:** status is derived from cmux, git, GitHub CI and hash-checked verdict and review files. READY TO MERGE needs CI green, a passing verifier and a passing review from the other vendor.
- **WIP limit:** `start` refuses past it, since every started task is a PR you review.
- **Plan gate for risky tasks:** `--risk escalate` tasks always run in Claude Code plan mode and wait for `captain approve`.
- **Pipeline skills:** the default pipeline uses `/tidy` (replacing the retired `/pr-reviewer`) and `/ui-verification` (replacing `/visual-qa`).
- **Breaking:** the v2 `start <ticket>` fan-out, free-form dispatch, `--agent`, `--repo-path`, bare-token routing, `status --summary/--since/--watch`, and the `~/.claude/captain` log and memory locations are gone.
