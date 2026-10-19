# Auto-pickup loop

Filling free agent slots from the repo's OpenSpec changes. **Off by default — read this
file only once the loop is explicitly armed.**

## Arming

Only `/captain loop`, "run the dev loop", or "drain the queue" turns this on.
`/captain loop` caps at **3** active-agent slots; `/captain loop <N>` (or the
natural-language equivalent) sets any positive integer for this session.

A plain `captain status` or `captain spec <id>` session never reads the queue and never
auto-picks. Armed state is session-local and holds until the user says stop or the
session ends. **Stop disarms immediately** — an already-backgrounded heartbeat that wakes
after a stop dispatches nothing and never re-arms.

## Every wake, in order

- **Heartbeat: session-preserving rungs only.** The backgrounded-sleep rung (or
  `ScheduleWakeup`, and only when already inside `/loop`) — see `heartbeat.md`. **Never**
  the `CronCreate` rung: fresh context each tick can't carry the explicit arm or the
  suppression set. No session-preserving rung available → stop auto-pickup, surface the
  error once, leave the fleet untouched.
- **Gates before pickup.** Derive the fleet with unfiltered `captain status --json`.
  Work the NEEDS YOU batch, _then_ consider pickup. A structured status error or a
  non-zero exit **fails closed**: dispatch nothing, surface once, re-arm.
- **Capacity.** `active` = NEEDS YOU + IN FLIGHT rows; `available = max(0, cap − active)`.
  Zero available → skip the queue and re-arm.
- **The queue** is `openspec/changes/*/` in the repo (excluding `archive/`), sorted by id.
  A change is eligible when it has a `proposal.md`, at least one unchecked `- [ ]` box in
  `tasks.md`, and no status row (`change` field) in any state. Take at most `available`.
  Skip a change whose `## Impact` paths overlap a running change's — shared checkout
  means shared files.
- **Dispatch.** One **foreground** `captain spec <ids…> --repo-path <repo> --json`. Check
  `started[]` and `skipped[]`, then re-run `captain status --json` before the next wake.
- **Fail closed.** No blind retries. On a launch error re-derive status; report only ids
  with no row and leave them for the next heartbeat.
- **Suppress repeat noise.** Key failures by `<id>:<reason>`; mention once, then suppress
  while the reason holds.
- **Re-arm after every wake** unless the user stopped or no session-preserving rung exists.

## Gotchas

- **No lock guards the loop.** Two armed drivers race the same queue. One armed loop per
  repo; stop one the moment you spot a second.
- **A finished change stays in the queue** until its boxes are all ticked or it is
  archived. A READY row with open boxes means the agent missed a box — read its verdict
  before relaunching.
- **Invariants, unchanged by arming:** plan approval stays mandatory for Claude agents;
  codex has no plan gate; `captain status --json` is the fleet source of truth;
  test-worker caps are untouched.
