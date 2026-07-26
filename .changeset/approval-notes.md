---
"cmux-captain": patch
---

Record the reasoning behind plan approvals.

`captain approve` now takes an optional `--note` (the reviewer's recommendation), recorded in
`log.jsonl` alongside reject's. `captain gain` reports `decisions.unexplainedApprovals` and
`recentApprovalReasons` — omitted entirely until the ledger contains at least one noted
approval, so a pre-`--note` history is never reported as a governance failure.
