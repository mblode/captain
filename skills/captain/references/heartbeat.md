# Heartbeat

How you wake yourself while workers run. There is no daemon. Each wake re-reads the
board from scratch, so a missed wake loses nothing.

## The rung ladder

Take the first rung available. Never hand polling back to the human.

1. **Backgrounded sleep (default).** `Bash` `sleep 240` with `run_in_background: true`.
   Its exit starts a new turn. Re-arm on every wake.
2. **`CronCreate`** (if present): `*/5 * * * *`. Each tick starts with fresh context, which
   is fine: the board holds the state.
3. **`/loop`** (only when already inside one).

## Each wake

1. `captain status --json` (with several projects: `captain status --all-projects --json`;
   each row then carries `project`, and its `next` already names it).
2. Act on every `captain` row's `next` without asking.
3. Collect `needs-you` and `ready` rows. Tell the human only when that set changed since
   your last message. Silence is the right answer when nothing changed.
4. If WIP freed up and there are `queued` rows the human already said yes to, start them.
5. Re-arm.

A `working` row that hasn't changed for an hour: `captain peek` it. Stuck on a menu or a
prompt means `captain send`. An empty shell means the worker died. Its row turns
`captain` with `next: captain start <id>`, which re-launches in the same worktree.
