---
"cmux-captain": patch
---

Resolve cross-repo ticket collisions natively: when one ticket is fanned into two repos, approve/reject now disambiguate by the qualified `repo-ticket` name (refusing to guess on a bare colliding id) instead of requiring a workspace uuid, and `status` prints the resolvable handle.
