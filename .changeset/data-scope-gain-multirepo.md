---
"cmux-captain": minor
---

Add three features to the self-drive pipeline:

- **Data-scope guardrail** — every agent brief now carries a `<data-scope>` section (operate on source/config only; no customer data, secrets, payments, or PII), with a matching rubric criterion. Configurable via `CAPTAIN_DATA_SCOPE` or `config.json` `.dataScope`; on by default.
- **`captain gain`** (alias `audit`) — stateless fleet telemetry derived on demand from the decision log, the live cmux fleet, and verdict files (no daemon, no counters). Supports `--json`, `--since`, and an opt-in `--git` merged-PR approximation.
- **Multi-repo dispatch** — one `captain start` can fan out across repos by resolving a repo per issue via `config.json` `.repoMap` (team-prefix → repo path). Purely additive: with no `.repoMap`, behaviour is byte-identical to single-repo.
