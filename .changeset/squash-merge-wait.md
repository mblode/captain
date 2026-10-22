---
"cmux-captain": patch
---

Fix the worker brief's wait-for-merge loop so it ends on squash and rebase merges. It now checks the PR's head commit (fetched by `refs/pull/<n>/head`, so a deleted branch is fine) for the worker's last commit, not the merge commit. A squash merge rewrites that commit, so the old loop polled forever. The loop also stops when the PR is closed without merging.
