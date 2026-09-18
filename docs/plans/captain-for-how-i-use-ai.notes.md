# Notes — captain-for-how-i-use-ai

## Deviations

- Plan said: reproduce a live ExitPlanMode and `captain approve --note` against cmux.
  Code required: cmux running.
  Taken: wrote `automation.socketControlMode: automation` into
  `~/.config/cmux/settings.json` (not allowAll). After relaunch, `cmux ping` is
  `PONG`. Throwaway dispatch `captain-approve-probe-eBeu` in `/tmp` produced a
  live plan gate; `captain approve --note` appended a noted `approve` line to
  the real `log.jsonl`. The probe workspace may still be in-flight.

- Plan said: distill chat/frontyard/linkiq Inboxes (hundreds of bullets).
  Code required: those files are live under `~/.claude/captain/memory/`, not git.
  Taken: keep `INBOX_MAX_ENTRIES = 20` in `memory.ts` (briefs never saw all 286);
  drop automatic distill from the skill. Leave the files for a human pass.

- Plan said: execute phases strictly in order.
  Taken: Phase 1 live verify is blocked on cmux. Phases 2–4 were skill/docs and
  did not depend on a live gate, so they landed in the same turn.

- Plan said Phase 2: keep CLI cwd-fallback, skill-only hard stop.
  Taken: CLI now throws `DRIVER_CWD` when cwd basename is `linear-god` and
  `--repo-path` is absent. Live: `cd linear-god && dist/cli.js start TST-123
  --print --json` → exit 2. Product checkouts and `--repo-path` still work.

## How the run ended

Partial. Driver skill and captain-repo fleet memory now match the real loop
(`/captain` → CLI approve with `--note`, `--repo-path` required from the driver).
`DRIVER_CWD` refuses `linear-god` without `--repo-path` (live; PATH `captain`
is this checkout). After `open -a cmux`, ping became Access denied: default
Socket Control Mode is cmux-only, and the driver is never a cmux descendant.
CLI + skill now name Settings → Automation → Socket Control Mode → Automation
mode. Live approve→ledger still unproven until that mode is on and a plan exists
— do not probe-approve a real ticket. Do not write `~/.config/cmux/cmux.json`.
