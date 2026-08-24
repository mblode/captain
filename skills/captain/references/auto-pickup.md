# Auto-pickup loop

Filling free agent slots from the TIG `agent-ready` queue. **Off by default — read this
file only once the loop is explicitly armed.**

## Arming

Only `/captain loop`, "run the dev loop", or "drain the queue" turns this on.
`/captain loop` caps at **3** active-agent slots; `/captain loop <N>` (or the
natural-language equivalent) sets any positive integer for this session.

A plain `captain status` or `captain TIG-xxx` session never reads the queue and never
auto-picks. Armed state is session-local and holds until the user says stop or the
session ends. **Stop disarms immediately** — an already-backgrounded heartbeat that wakes
after a stop reads no queue, dispatches nothing, and never re-arms.

## Every wake, in order

- **Heartbeat: session-preserving rungs only.** The backgrounded-sleep rung (or
  `ScheduleWakeup`, and only when already inside `/loop`) — see `heartbeat.md`. **Never**
  the `CronCreate` rung: fresh context each tick can't carry the explicit arm or the
  per-ticket suppression set, so a loop on cron would silently re-read the queue with no
  memory. No session-preserving rung available → stop auto-pickup, surface the error
  once, leave the fleet untouched.
- **Gates before pickup.** Derive the fleet with unfiltered `captain status --json` — no
  targeted refs, no `--summary`, no `--since`; capacity and dedupe require every current
  row. Work the NEEDS YOU batch, _then_ consider pickup. A structured status error
  (`{"error":{"type":"CMUX_UNREACHABLE"}}`) or a non-zero exit **fails closed**: dispatch
  nothing, surface once, re-arm.
- **Capacity.** `active` = NEEDS YOU + IN FLIGHT rows (READY rows have finished, so they
  free a slot but still count for dedupe); `available = max(0, cap − active)`. Zero
  available → skip the Linear read entirely and re-arm.
- **Read-only queue read.** `linear__list_issues` (linear-server MCP): team TIG, label
  `agent-ready`, state type unstarted, `orderBy` createdAt, paginated to exhaustion. Sort
  locally by priority value 1 (Urgent) → 2 → 3 → 4, then 0/unset last; tiebreak
  createdAt ascending, then identifier ascending. Consider at most the first `available`
  that pass eligibility. **The driver writes no Linear.**
- **Eligibility — every check before starting anything.** Per candidate:
  - (a) lowercase the identifier, skip if any status row's `ticket` matches (NEEDS YOU,
    IN FLIGHT, _or_ READY);
  - (b) read the full description — require a `## Contract` heading and exactly one
    `**Repo & area:**` field, and take the **first** `blstrco/<repo>` token on that
    line as the target. A later token on the same line is a contrast ("blstrco/daintree
    (not blstrco/chat)"), not a second target; (d) is what proves the parse. No
    `**Repo & area:**` field at all is invalid, never guessed;
  - (c) require the `**Blast radius:**` value to begin with `low` (trimmed,
    case-normalized, reading up to the first `:` or `,`) — the rest of the line is the
    stated reason and is not part of the verdict. `elevated`
    (money/tax/PII/auth/permissions) is never auto-started; missing/unknown is invalid,
    **not** low;
  - (d) resolve `blstrco/<repo>` to `/Users/mblode/Code/linktree/<repo>` and confirm it's
    a git checkout whose `origin` names that GitHub repo, comparing **case-insensitively**
    — GitHub preserves the case it was created with but resolves without it, so a ticket
    saying `blstrco/daintree` and an origin saying `blstrco/Daintree` are the same
    repository. A missing checkout or a genuinely different repo is a routing failure,
    never a fallback to cwd.
- **Dispatch to capacity.** Group selected ids by verified checkout; one **foreground**
  `captain start <ids…> --repo-path <checkout> --json` per repo — never backgrounded.
  Validate every returned `started[].cwd` against the expected checkout. After each repo
  batch, re-run `captain status --json`, recompute `available`, and truncate the next
  batch so a partial launch or an external change can't overfill.
- **Fail closed, recover partials.** No guessed routes, no blind retries. On a launch
  error re-derive status: rows that now exist launched (deduped); report only identifiers
  with no row and leave them for the next heartbeat.
- **Suppress repeat noise (session memory).** Key failures by `<ticket>:<reason>`. A
  low-blast ticket failing the _same_ check on two consecutive wakes: mention once in the
  next gate batch, then suppress while the reason holds; reset when the ticket
  disappears, becomes eligible, or fails differently. Elevated tickets aren't malformed —
  they're human decisions: offer each once per unchanged Contract per session as an
  explicit `dispatch?` in the gate batch (approval runs the normal `captain start`;
  decline/defer suppresses until the Contract changes or a new loop session begins).
- **Re-arm after every wake** — empty, full, partial, or failed-closed — unless the user
  stopped or no session-preserving rung exists.

## Gotchas

- **No lock guards the loop.** Arming is session-local, so two armed drivers race the
  same `agent-ready` queue and can double-dispatch a ticket. One armed loop per fleet;
  stop one the moment you spot a second (don't trust worktree reuse to catch it).
- **Invariants, unchanged by arming:** plan approval stays mandatory for Claude agents;
  codex stays best-effort with no plan gate; merge stays human-only;
  `captain status --json` stays the fleet source of truth; the driver never writes
  Linear; test-worker caps are untouched.
