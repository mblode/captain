---
'cmux-captain': patch
---

Fix the auto-pickup eligibility gate, which could not match any ticket.

Four checks disagreed with the tickets they read. The gate required an HTML
comment marker that the grooming agent is forbidden to write, rejected a second
`blstrco/<repo>` token on the `Repo & area` line when that token is a contrast
rather than a second target, required `Blast radius` to be exactly `low` when
every real value carries its reason after a colon, and compared the repository
slug case-sensitively against a `git remote` that preserves GitHub's casing.

Validated against live `agent-ready` tickets: the new rules dispatch the ones a
human would, and still refuse elevated blast radius, a missing blast radius, a
missing Contract, and a repository with no verified checkout.
