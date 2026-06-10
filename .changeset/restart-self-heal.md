---
"captain": minor
---

Add `captain restart` (stop-if-running, then relaunch with the persisted match
scope) and self-heal the daemon spawn path: ensureDaemon now cleans stale
pidfiles before spawning, writes the pidfile atomically (temp+rename), and
verifies the new watcher is actually alive after a brief settle — an
instantly-dying spawn reports "could not start — check watch.log" instead of
lying (session bugs #1/#9: dead daemons previously needed a manual relaunch and
a hand-repointed pidfile). Plugin-packaging verdict from recon: Claude Code
plugin monitors and MCP servers are session-scoped and cannot host a persistent
daemon, so the watcher stays a self-managed detached process by design; the
plugin idea survives only as a possible future skill-distribution wrapper.
