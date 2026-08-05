---
"cmux-captain": minor
---

Skip issues whose blockers are still open during fan-out. `captain start tig-1 tig-2` no
longer starts dependent work against a prerequisite that hasn't landed: Linear blocking
relations map to an optional `Issue.blockedBy`, and a blocked issue is skipped while the
rest of the fan-out proceeds. `--force` launches anyway.

Read-only (captain still writes to no tracker), launch-time only (never in `status`, which
derives with no network), and fail-safe — absent or unfetchable relations read as unblocked,
so donebear and a Linear hiccup both launch rather than silently refusing to.

Also fixes a donebear task's images routing through the Linear download path: the fetch is
now gated on the issue's source, not just on `LINEAR_API_KEY` being set.
