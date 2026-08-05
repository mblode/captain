---
"cmux-captain": minor
---

Don't start issues whose blockers are still open. `captain start tig-1 tig-2` no longer
starts dependent work against a prerequisite that hasn't landed: Linear blocking relations
map to an optional `Issue.blockedBy`, and a blocked issue is held back. Fan-out **skips** it
and launches the rest; a **single** blocked issue **errors** (`ISSUE_BLOCKED`, exit 1) naming
the open blockers, because with no other ticket to proceed with a skip would be a silent
successful-looking no-op. `--force` launches anyway, and `--print` still prints a brief for
either (printing is not launching).

Read-only (captain still writes to no tracker), launch-time only (never in `status`, which
derives with no network), and fail-safe — absent or unfetchable relations read as unblocked,
so donebear and a Linear hiccup both launch rather than silently refusing to.

Also fixes a donebear task's images routing through the Linear download path: the fetch is
now gated on the issue's source, not just on `LINEAR_API_KEY` being set.
