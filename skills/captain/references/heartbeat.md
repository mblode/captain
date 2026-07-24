# Heartbeat

How the driver re-invokes itself on a timer. Read this once per session, when a fleet
starts running. There is no daemon and no foreground pane — each wake re-derives status
fresh.

## The rung ladder

Take the first available rung. **Never** skip a missing rung to "ask the human to ping me".

1. **Backgrounded sleep (default, universal).** `Bash` `sleep 210` with
   `run_in_background: true` — the exit delivers a new turn, re-invoking the driver. No
   gate, no expiry, survives `--resume`; proven at fleet scale. Re-fire each wake.
2. **`CronCreate`** (if present): a `*/4 * * * *` re-prompt, but ±jitter, 7-day expiry,
   and fresh context each tick — prefer rung 1 for anything durable.
3. **`/loop`** (only when already inside one): the only place `ScheduleWakeup` is
   ungated — outside it that tool hard-fails "dynamic runtime gate is off".

`send_later` is one-shot, not a heartbeat.

## What to poll

For an ordinary fleet, retain the `started[].name` refs and poll only those.

- First session-preserving wake: `captain status <refs…> --summary --json`; retain its
  opaque `snapshot`.
- Later wakes: the same command with `--since <snapshot>`.
  - `changed:false` → no new fleet action; re-arm immediately.
  - `changed:true` → returns the current `counts` and `needsYou`. Act, replace the
    snapshot, then re-arm.

Captain persists nothing — the snapshot belongs to this driver session. A `CronCreate`
wake cannot retain it, so that rung uses the first form every time.

Retain any intentionally deferred plan-review overflow and drain the next bounded batch
even when the fleet is otherwise unchanged.

Omit `<refs…>` only for an explicitly fleet-wide request. Use full `--json` when every
row is required — including the auto-pickup loop, which forbids `--summary`/`--since`
entirely (see `auto-pickup.md`).

~200–260s lets transitions accumulate. (A human watching a terminal can use
`captain status --watch` instead; the driver cannot — a blocking foreground loop can't
yield turns.)
