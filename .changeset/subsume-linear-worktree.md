---
"cmux-captain": minor
---

Subsume `linear-worktree`: bare `captain <ticket>` now works like `captain start <ticket>` (creates the worktree, opens a cmux workspace, and launches the agent in plan mode with the Linear ticket pulled in). Add optional codex support via `--agent <claude|codex>` (or `CAPTAIN_AGENT` / the `.agent` config key); codex is best-effort with no plan gate.
