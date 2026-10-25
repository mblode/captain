---
"cmux-captain": patch
---

Recognize cmux workspace titles when descriptions are absent so the board can distinguish workers sharing a checkout.

Preserve discovery of existing task-ID and title-named workers, give new shared workers a project/task identifier, and scope lookup to their checkout. Namespace new worktree branches and folders by project while preserving existing task checkouts.
