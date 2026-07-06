---
"cmux-captain": minor
---

Enforce fleet resource caps at launch: every agent's claude process now carries `VITEST_MAX_THREADS=2`/`VITEST_MAX_FORKS=2` (extend or override via config `.agentEnv`, e.g. a `NODE_OPTIONS` heap cap), on both the cmux workspace command and the inline fallback. Fan-out and dispatch also print a note when the target repo's jest config has no `maxWorkers` cap — jest ignores env for worker sizing, so an uncapped repo config is the one hole captain can only warn about. Follow-up to the Jul 6 incident where concurrent uncapped jest pools exhausted the machine and got the fleet jetsam-killed.
