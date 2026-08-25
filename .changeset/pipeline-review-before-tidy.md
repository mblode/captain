---
"cmux-captain": minor
---

Fix the fanned-out pipeline order, and let a step be plain English.

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
