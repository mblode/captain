---
"cmux-captain": patch
---

Fix resolution/worktree/hash bugs and apply Boy Scout cleanups. `approve`/`reject` now resolve bare tickets by exact match (no `tig-1`→`tig-10` bleed), `reject` acts on every matched target, `start` no longer crashes on a linked worktree (`gitCommonDir`), a `## Verdict` heading in an issue description can no longer void the rubric hash (`lastIndexOf`), the verdict guard validates `evidence`, and `runStates` keeps the `claude_code` tag authoritative. Internal dedupe (`groupCounts`, `cmuxUnreachable`, `readConfig`, `ownsCwd`, `worktreeTmpDir`), `repoLabel` moved into `git.ts`, dead code removed, and unused `@clack/prompts` + `gray-matter` deps dropped.
