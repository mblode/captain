# Heartbeat

How you wake yourself while workers run. There is no daemon. Each wake re-reads the
board from scratch, so a missed wake loses nothing.

## The rung ladder

Take the first available mechanism that can observe the required state. Keep one watcher
per project; reuse it instead of starting another on every message.

1. **Completion or state-change events.** Use the harness's supported notifications.
   Worker completion alone does not cover later CI or a human merge; supplement those
   gaps with a supported monitor, not a second model-driven polling loop.
2. **`Monitor`** (if present). Run a session-owned shell process that reads
   `captain status --json` every four minutes and emits only changes to task groups,
   reasons and next actions. Keep the previous fingerprint in process memory, not a
   persistent progress file. Emit errors and an hourly liveness wake too, so an unchanged
   board cannot hide a dead worker. The process observes; the chat decides and acts.
3. **Backgrounded sleep or scheduler.** When no change-triggered mechanism exists, use
   `Bash` `sleep 240` with `run_in_background: true`, `CronCreate` at `*/5 * * * *`, or an
   existing `/loop`, only if that mechanism actually wakes this session. Never add a
   foreground sleep/status loop. If none is supported, report the pending work and the
   `captain status --json` resume command without claiming a watcher is running.

## Each wake

1. `captain status --json`.
2. Act on every `captain` row's `next` without asking.
3. Collect `needs-you` and `ready` rows. Tell the human only when that set changed since
   your last message. Silence is the right answer when nothing changed.
4. If WIP freed up and there are `queued` rows the human already said yes to, start them.
5. Re-arm only an expired mechanism. Stop it when there is no autonomous work left,
   the human asks to stop, or every remaining action requires a human decision.

A `working` row that hasn't changed for an hour: `captain peek` it. Stuck on a menu or a
prompt means `captain send`. An empty shell means the worker died. Its row turns
`captain` with `next: captain start <id>`, which re-launches in the same worktree.
