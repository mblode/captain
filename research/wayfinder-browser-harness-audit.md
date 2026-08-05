# Steal-worthy ideas audit — captain vs. wayfinder & browser-harness (August 2026)

## Context

Two unrelated references arrived together. Matt Pocock's `wayfinder`
(github.com/mattpocock/skills, Aug 2026) is a multi-session planning discipline that
lives **on an issue tracker**: a map issue labelled `wayfinder:map`, decision tickets as
child issues, native blocking edges so the frontier renders in the tracker's own UI, four
ticket types split HITL/AFK, claim-by-assignment, and one ticket resolved per session.
`browser-use/browser-harness` (v0.1.8) is a Python CLI plus a bundled skill that drives a
browser over CDP — attaching to the user's already-running Chrome by default, or to a
billed cloud browser.

Both are the same shape as parts of **captain** built on the opposite bet. Wayfinder makes
the tracker the durable shared state and runs work strictly serially; captain keeps no
state and fans out one worktree per ticket in parallel. browser-harness holds a persistent
daemon attached to a long-lived browser; captain deleted its daemon in June 2026.

This audit asks, capability by capability: **what should captain steal, what should it
adapt, and what is a deliberate non-goal** because it collides with captain's thesis (no
daemon, no persisted state, read-only trackers, status derived live from cmux +
`.captain/` files). Findings are grounded in the actual code (file:line) on both sides.

The intended outcome: a decision doc that (a) names the one thing worth building now,
(b) records why the browser step is a config entry rather than a feature, and (c) records
the wayfinder and browser-harness bets captain should explicitly _not_ chase, with the
reasoning, so the read-only-tracker invariant has a written defence the next time someone
proposes a planner that writes to Linear or a daemon that holds a browser.

## TL;DR verdict table

| # | Capability | Verdict | One-line reason |
|---|---|---|---|
| 1 | **Blocking edges → frontier filter** (don't launch a ticket whose blockers are open) | **ADOPT — built** | Read-only, launch-time only, no state; the real gap in parallel fan-out |
| 2 | **Browser validation in the pipeline** (agent looks at the running app) | **ADAPT — config only** | Already expressible as a `.skills` entry; needs no captain code |
| 3 | **Acceptance criteria as checkboxes** (`to-tickets`, `AGENT-BRIEF.md`) | **ALREADY HAVE** | `rubric.ts` renders exactly this object from `Issue.criteria` |
| 4 | **Refer to work by name, never a bare id** (`wayfinder:15-17`) | **ALREADY HAVE** | `withHandles` (`src/captain/view.ts:239-254`) |
| 5 | **Ticket typing HITL/AFK** (`wayfinder:73-80`) | **ADAPT — not a current need** | No source emits the types; revisit only if captain ingests wayfinder maps |
| 6 | **`to-tickets`-style decomposition** (plan → dependency-ordered tickets) | **ADAPT — agent-side, deferred** | The tracker write belongs to an agent, as PR creation already does |
| 7 | **The map as durable planning state** (map issue, fog, Decisions-so-far) | **REJECT — non-goal** | Read-modify-write of one shared body = the two-writer clobber, remotely |
| 8 | **Claim-by-assignment** (`wayfinder:67`) | **REJECT — non-goal** | Advisory lock with no CAS; the worktree already claims, locally and stronger |
| 9 | **browser-harness as a dependency** | **REJECT — non-goal** | Default-on telemetry, human gate, one shared Chrome, unreaped daemon |
| 10 | **A graded "UI verified" rubric criterion** | **REJECT — decided** | The `/security-review` precedent, verbatim |

---

## ADOPT — the one to build: blocking edges (S effort, low risk)

**Wayfinder:** "A ticket is **unblocked** when every ticket blocking it is closed; the
**frontier** is the open, unblocked, unclaimed children" (`wayfinder/SKILL.md:69`), wired
through the tracker's native dependency relationship. **Captain before this change:** no
dependency concept at any layer. `rowOf` (`src/captain/view.ts:196-229`) computes each row
independently and cannot see another row; a grep for `depends|blocked_by|prerequisite|
topolog` over `src/` returned nothing outside an unrelated error code. The only adjacent
primitive was `start --base <ref>` (`src/git.ts:49-52`), which is human-supplied and lives
on the shared `PrepareContext` (`src/runner.ts:891`) — so a single fan-out cannot even give
two tickets different bases.

That gap is a correctness problem unique to captain's shape. Wayfinder never hits it
because it resolves one ticket per session; captain launches N at once, so
`captain start tig-1 tig-2` would start dependent work against a prerequisite that has not
landed. Pocock has the graph and no fan-out; captain has the fan-out and no graph.

Built as: `Issue.blockedBy?: IssueBlocker[]` (`src/types.ts`), populated from Linear's
`inverseRelations` in `mapLinearIssue` (`src/linear.ts`); a pure `openBlockers`
(`src/issue.ts`); and a launch-time filter in the fan-out path (`src/runner.ts`) with
`--force` as the escape hatch.

Three properties make this fit rather than fight the thesis:

- **Read-only.** Captain still writes nothing to any tracker. The `IssueSource` interface
  (`src/source.ts:14-29`) gains no verb.
- **Launch-time only, never in `status`.** `status` derives with no network. Surfacing a
  "blocked" row would mean either a network call in the offline read path or persisting the
  graph into `.captain/` — which is the no-persisted-fleet-state boundary, whose test is
  that `status` must never have to trust stored data.
- **Fail-safe, like the rest.** Absent, null, or unfetchable relations read as *unblocked*.
  donebear has no dependency concept and simply leaves the field unset. Refusing to launch
  on missing data would be the dangerous default.

**Scope deliberately cut:** the check runs on the multi-issue fan-out only, not on a single
`captain start tig-2`. A single blocked issue would need "error" semantics rather than
"skip", which is different code for a case the driver does not hit — it fans out. YAGNI
until it bites.

## ADAPT — browser validation: a config entry, not a feature (zero effort)

Nothing in the fleet ever looks at the running app: the `ui-audit` skill defers runtime
execution to Playwright/Cypress and reasons from source, and captain's only browser-adjacent
surface is inbound Linear screenshots (`src/runner.ts:500-510`). The gap is real.

It is also already solved by a decision made elsewhere in this file: only plan, implement,
and the verdict finish are fixed; everything between is `.skills`-configurable
(`src/config.ts` `loadSkills`, rendered one numbered step each at `src/prompt.ts:62`). A
browser step is one string in `.skills` or `CAPTAIN_SKILLS`. It needs no captain code, and
per B7's line — "Captain launches agents; it does not own their network or sandbox" — a
browser is agent-side by construction.

What that skill should drive is a **per-worktree throwaway headless Chromium**, not
browser-harness (#9). Each worktree already has its own checkout and its own port, so a
per-invocation browser inherits that isolation for free: no human gate, no shared browser,
no billing, nothing left running.

Keep it **opt-in per repo, never in `DEFAULT_SKILLS`** — most fleet tickets are
copy/label/refactor diffs with no browser surface, and a default-on pass is a recurring
per-ticket cost forever.

## ADAPT — documented but deferred (not current needs)

### 5. Ticket typing HITL/AFK — deferred

Wayfinder's `research`/`prototype`/`grilling`/`task` types (`wayfinder:73-80`) are a real
launch decision, not prose: a `grilling` ticket resolves only through live human exchange,
so fanning it out unattended is a category error. Deferred because no source captain reads
emits these types. If captain ever ingests wayfinder-style maps, the check belongs at
claim time in `prepareIssue`, not as a `TicketType` enum in `src/` — the same reasoning
that keeps risk-tiering out of the codebase.

### 6. `to-tickets`-style decomposition — deferred, and agent-side when it lands

The seam is real and currently unowned. `/planning` tells the user the scope is too big and
to "propose a split", then supplies no procedure, format, or artifact for it. `to-tickets`
fills exactly that hole: vertical tracer-bullet slices, each sized to one fresh context,
each declaring its blocking edges, human-confirmed for granularity, published in dependency
order with acceptance criteria as checkboxes. Captain's `Issue` contract is already the
receiving shape, and #1 makes the edges meaningful.

Two constraints if it is ever built. It belongs in **agent-skills, not captain** — and the
tracker write is done by the agent running the skill, exactly as it already opens PRs, so
captain stays read-only. And it is gated on the pain being real: the plan is also currently
thrown away at fan-out (the brief carries issue context, workflow, data scope, finishing
protocol, and fleet memory — never the plan's key decisions or STOP conditions), which may
be the cheaper half to fix first.

## REJECT — deliberate non-goals (what NOT to steal)

### 7 & 8. Wayfinder's write set

Everything that makes wayfinder wayfinder is a mutation of shared, remote, persistent
state: create the map, create children, **wire blocking edges in a second pass**, claim by
assignment, post a resolution comment, close, **append to Decisions-so-far**, graduate fog
by clearing a Not-yet-specified patch, and "update or delete those tickets" on invalidation
(`wayfinder:113-126`).

Two are outright hazardous for captain. **Claim-by-assignment has no CAS** in a system that
explicitly expects concurrent writers ("expect other sessions to be editing the tracker
concurrently", `wayfinder:128`) — and captain does not need it: a worktree's existence plus
its `.captain/` marker is a stronger, filesystem-local, derived claim. And **the map body is
a read-modify-write of one shared document**: Decisions-so-far, fog graduation, and
out-of-scope lines all rewrite the same issue body concurrently. That is the wayfinder-shaped
version of the two-writer `state.json` clobber deleted in commit `372dc4b` — moved onto a
remote tracker, where it also gains partial-write and rate-limit failure modes.

Captain writes to no tracker at any layer today: no write verb on `IssueSource`
(`src/source.ts:14-29`), only GraphQL queries in `linear.ts`/`donebear.ts`, and the driver
skill states "the driver writes no Linear" twice as an invariant. **Adopting the read side
is precedent-following; adopting the write side is a new failure domain.**

Note the clean junction: wayfinder stops where captain starts. Its output is decisions, not
diffs — "it hands off, it doesn't build" (`ask-matt:46`). The piece whose output is
literally captain's input is `to-tickets` (#6), not wayfinder.

### 9. browser-harness as a dependency

**Five independent blockers, any one disqualifying for an unattended fleet:**

- **Telemetry is on by default and unredacted on the CLI path.** `capture_cli_event`
  (`telemetry.py:247-294`) builds its properties dict directly and never calls
  `_safe_properties`, so the `FORBIDDEN_KEYS` redaction at `telemetry.py:22-41` does not
  apply. It posts the full Python the agent wrote (20,000 chars), the stdout tail (20,000
  chars), and every helper call's `repr`'d arguments — including text passed to
  `type_text`. That breaches the `<data-scope>` guardrail (`src/prompt.ts:116-120`) on the
  first call.
- **The local path terminates in a human.** "ask the user to … Retry after the user
  confirms; do not retry before" (`admin.py:382-427`), after a 45s handshake
  (`daemon.py:92`). A worktree agent has no user.
- **One shared Chrome across N worktrees.** Its own skill says so: "Local Chrome is one
  shared browser; parallel tasks fight over tabs and focus" (`SKILL.md:55`). N daemons all
  call `attach_first_page` and take `pages[0]` (`daemon.py:369-395`). Fan-out is captain's
  entire thesis.
- **Full logged-in profile, no origin gate anywhere.** It attaches to an already-open tab in
  the real profile, and the repo documents cookie extraction as a normal move
  (`cloud.md:151-155`). One prompt injection from a page under test reaches Gmail.
- **A daemon nothing reaps, plus a shared mutable workspace.** Cleanup lives in a `finally:`
  (`daemon.py:641`) that SIGTERM skips, and `agent_helpers.py` is one global file `exec`'d
  into every run with unconditional name override (`helpers.py:512-515`) — a two-writer
  clobber with cross-repo blast radius.

The cloud path removes the first three at the cost of per-minute billing, a 3-concurrent
free-tier ceiling below typical fleet width (`README.md:44`), and a leak on any force-kill.
_Not worth it when a headless Chromium and a script do the job._ See #2.

### 10. A graded "UI verified in a browser" criterion

Re-litigating a decided boundary. A browser criterion in `criteriaFor` (`src/rubric.ts:33-71`)
would repeat the `/security-review` mistake exactly: a recurring per-ticket cost, turning a
cheap nudge into hard enforcement, against a fleet whose tickets are mostly copy/label/
refactor diffs with no browser surface. It would also void every in-flight verdict's
`rubricHash` on landing. If it ever comes back it needs an `na` path for surface-free diffs
and should stay effort (a skill step), not enforcement.

## Recommended sequence

1. **Blocking edges** (#1) — built; the only code this audit justifies.
2. **Browser step** (#2) — write the skill in agent-skills when a UI ticket actually wants
   it, then opt in per repo. No captain change.
3. Record #7/#8/#9/#10 as **explicit non-goals** in `CLAUDE.md` so the read-only-tracker
   invariant is defensible without re-reading this file.

Ticket typing (#5) and decomposition (#6) are documented above but deferred — not current
needs.

## Verification

- `openBlockers` fail-safe over absent/null/empty relations, and the done/open split:
  `src/issue.test.ts`.
- `mapLinearIssue` blocking relations from either orientation, `canceled` and `completed`
  as done, a missing state as still blocking: `src/linear.test.ts`.
- Fan-out skips a blocked issue while launching its unblocked sibling, names only the open
  blocker, and launches both under `--force`: `src/runner.test.ts`.
- A donebear task's images never route through the Linear download path:
  `src/runner.test.ts` (verified to fail without the guard).
- Whole suite green: `npm run typecheck && npm run check && npm run test`.

## Critical files

- `src/types.ts` (`Issue.blockedBy`, `IssueBlocker`), `src/linear.ts` (`toBlockers` + the
  `inverseRelations` selection), `src/issue.ts` (`openBlockers`) — #1.
- `src/runner.ts` (the launch-time filter), `src/cli.ts` (`--force`) — #1.
- `src/config.ts` `.skills` / `CAPTAIN_SKILLS`, `src/prompt.ts:62` — #2, no change needed.
- `CLAUDE.md` — the frontier rule and the non-goals note.
