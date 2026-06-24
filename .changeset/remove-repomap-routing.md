---
"cmux-captain": minor
---

Remove `.repoMap` config-based repo routing (breaking).

Routing a Linear ticket to a repo can't be a static lookup — a Linear team spans many repos and even a single project's tickets span repos. So the `.repoMap` config key, its `team-prefix → repo path` matching, and the `loadRepoMap`/`parseRepoMap`/`teamPrefixOf` helpers are gone. A run's repo is now resolved purely from `--repo-path` (else the cwd git repo). Spanning several repos in one session is the `/captain` skill driver's job: it reads each ticket and passes `--repo-path` per repo. If you relied on `.repoMap`, drop it from `~/.config/captain/config.json` and route with `--repo-path`.
