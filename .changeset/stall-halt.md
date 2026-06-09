---
"captain": patch
---

Add a stall-halt loop-safety guard: the watcher's reconcile timer now sweeps for silently-hung agents and parks any worktree that has gone event-silent past a threshold (while in a working stage) at a human `BLOCKED` gate. The signal is event-silence, not time-in-stage, so healthy long-running turns are never falsely halted, and cold-start/normal runs are unchanged. Configurable via `CAPTAIN_STALL_SECS` (default 1800 = 30m) and opt-out via `CAPTAIN_NO_HALT=1`.
