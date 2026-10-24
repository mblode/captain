---
"cmux-captain": minor
---

Bring the OpenSpec workflow to v3. Projects now default to a shared checkout: every worker runs in the repo's own checkout on its current branch, commits only its own files tagged `[<id>]`, and pushes to that branch, with no PR per task. After you merge, each worker waits for the deploy, runs the task's `## Smoke test` checks in production and writes `smoke.json`, so the board shows it as shipping and then verified. `captain init --worktrees` keeps the worktree-and-PR flow. New `captain spec <id…>` / `--all` turns changes from the repo's OpenSpec home (the same `~/.claude/captain/openspec` folders v2 used) into tasks and starts them, creating a shared project for the repo on first use. Claude workers get a fixed session id so plan and question gates are matched per worker even though they share a folder. Unattended briefs now ask the plan to record the choice made for each unknown instead of waiting for an approval.
