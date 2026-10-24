---
"cmux-captain": patch
---

`captain spec` now confirms each claude agent actually started. cmux types `--command` into the new shell before its init finishes, so a startup prompt that reads stdin (fnm or nvm offering to install the repo's Node version) could swallow the agent command and leave a bare shell that captain still reported as started. Spec now waits up to 60 seconds for each workspace's agent tag, prints `not started <id>` with the likely cause for any that never appear, and exits 1. The `--json` output gains an `unstarted` list.
