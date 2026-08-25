---
"cmux-captain": minor
---

Add `gain.roster`: the per-ticket detail behind the tallies.

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
