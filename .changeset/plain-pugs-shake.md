---
"cmux-captain": patch
---

Fix `approve`/`reject` against cmux 0.64.17: `feed.exit_plan.reply` takes the feed item's
`request_id` and a `mode` enum, not its `id` and an `approve` boolean. Every plan reply had been
failing with `invalid_params: feed.exit_plan.reply requires request_id`, forcing approvals through
`cmux send` and keeping their notes out of the `gain` ledger.
