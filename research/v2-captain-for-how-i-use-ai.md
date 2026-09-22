# Captain as a tool for how Matthew uses AI

Authoritative copy. Research date: 18 Sep 2026. Execute this file, not chat.

Evidence gathered with `chat-history` (`scripts/history.py` on Claude, Codex, Grok, Cursor) plus `~/.claude/captain/log.jsonl` and fleet memory. Parallel agents: Claude fleet phrases, multi-host habits, Codex/Grok split, Cursor composers, captain ledger.

## Outcome

Build captain for the loop that already exists, not for Claude Projects.

Matthew does not type `captain status --summary`. He sits in a long Claude Code session (`linear-god`) and says `/captain pick up the tickets`, `/captain check and approve plans`, `start the loop`. The **driver agent** runs the CLI. He merges. Codex is an ungated worker. Cursor is where he plans and redesigns. Personal products (Done Bear, Expert) are freeform and mostly not captain.

The CLI must be a reliable instrument for that driver. The skill must match what the files show, not an ideal poll-and-approve essay.

Acceptance when all of these are true:

- A plan approval from `/captain check and approve plans` writes `approve` plus `--note` into `log.jsonl` (no silent `cmux send-key` bypass).
- `captain status` shows a pending plan gate when the worker is actually on one (the `request_id` / pid-tag class of miss is gone or named as a cmux version floor).
- Pickup fails loud on missing `--repo-path` when the ticket has no contract field; it does not land in `linear-god`.
- The `/captain` skill is short enough to follow: pickup, status, approve-with-note, merge-is-human. No Projects-shaped conductor.
- Inbox distill either happens once per heavy repo or the brief stops promising it.

## How he actually uses AI

### Host split

| Host | Job |
|---|---|
| Claude Code `linear-god` | Steering desk. Files Linear tickets, `/captain` pickup, check/approve, skip lists |
| `captain` CLI | Typed by the driver agent, almost never by Matthew |
| cmux | Panes + fallback when captain approve/status miss (`read-screen`, `send-key`) |
| Codex | Ungated fleet worker (`Work on Linear issue` + rubric); also personal-product implementer |
| Cursor | Planning, this redesign, Bugbot comments dumped into Claude; not the fleet driver |
| Grok | Almost unused as a coding host (one Claude-resume). A product to copy for computer-use, not a captain agent |
| Claude / Cursor Projects | Not the fleet control plane in any searched transcript |

### What he types (quoted)

- `"now use /captain to pick up the linear tickets and execute"`
- `"use /captain to fan out all!"` / `"pick all possible tickets with /captain"` / `"skip tig-1008"`
- `"start the loop with captain"`
- `"[screenshot] /captain check and approve plans"`
- `"Open TIG-623 in cmux … use /cmux or /captain"`
- `"i want to deprecate linear-worktree and subsume by this tool"` (`captain tig-123` = worktree + cmux + plan mode + Linear)
- `"captain needs to be as simple as possible, no simpler. YAGNI"`
- Merge stays with him. Fleet briefs: do not merge.

### What the ledger shows (to 25 Aug 2026)

- **212 launches, 0 approve, 0 reject** after the daemon died. `--note` is a dead letter.
- Fan-out is real: chat 66, linkiq 56, frontyard 31, plus Pulse spanning the same tickets. No `db-` names.
- Last launch **25 Aug**; cmux `done` hooks still fire in Sep. Captain-the-product has been idle ~3 weeks while sessions continue.
- Fleet memory: chat Inbox **286** bullets / 3 Rules; frontyard **172** / 0 Rules; linkiq **184** / 3. Distill does not run.
- Memory file on captain itself tells agents to approve with **cmux keys** because `captain approve` often matched nothing.

### Pain he actually hit

1. Wrong-repo start (worktree in `linear-god`).
2. `captain approve` sending feed `id` instead of `request_id` (session `1cdd2194` / captain `9f06d840`).
3. Status `run=unknown`, `gate=None` while the agent sits on a plan / AskUserQuestion menu.
4. Wedged cmux, session bleed.
5. Verifier loops masking a real gap (`Stop spawning verifiers`).
6. Heartbeat / ScheduleWakeup missing in some environments.
7. PRs that did not fix the ticket; he files a new one and `/captain` again.

### What not to build (usage evidence, not taste)

Projects' loop (goal + repos, suggested threads, 10–15 cloud tasks, auto-resolved, routines, phone) does not appear in how he runs software. Rebuilding it would be a tool for someone else.

## Approach

Keep residue: Linear ingest, frontier, rubric, plan mode on Claude, derived `status`, launch log, vendor-neutral launch.

Change the **driver instrument** so the phrases he already says work end to end. Shrink the skill. Do not add a conductor.

Vertical slice first: **approve from `linear-god` writes a noted ledger line.** That is the contract the rest of `gain` already assumes and his files violate.

Affected surfaces: `src/captain/control.ts` (reply wire), `commands.ts` (approve/status), `skills/captain/SKILL.md` + `heartbeat.md`, maybe `surface.ts` / feed matching. Not `judge.ts`, not task fleets, not snapshot codecs.

## Decisions

- **CLI is for the `/captain` agent, UX is the skill.** Optimize the skill's verbs and the CLI's fail-loud errors. Do not add a TTY threads pane.
- **Codex stays ungated.** Do not invent an approve path for it. Status still tracks it as IN FLIGHT.
- **Personal products stay out** until he asks. Done Bear / Expert are screenshot + skills, not `captain start`.
- **`gain` without approvals is a launch roster.** Do not invent decision metrics from cmux keys. Fix the write path instead.
- **Assume current `request_id` wiring in `control.ts` may already be correct in git** and still unused in the wild. Phase 1 starts by proving a live approve against cmux, not by rewriting the parser.

Unverified: why launches stopped 25 Aug (broken approve vs busy vs moved to Cursor). Invalidation: if he says he abandoned the fleet on purpose, Phase 1 still ships; pickup volume is his.

## Boundaries

- Not Claude Projects, Cursor Projects, Grok Bot, Jev, task-worktree fan-out, v2 snapshot digest, firstPassStreak, `gain.memory`.
- Not tracker writes (he already tells the driver to create Linear tickets).
- Not merging.
- Not a persistent listener / auto-pickup unless he arms it in so many words (tiger-agent already drew that line).

## Phases (tick these)

Copy into the executor's todo list. Do not start Phase N+1 until Phase N's verification command passes.

### Phase 0 — Evidence (this document)

- [x] Search Claude JSONL for `/captain` phrases
- [x] Search Codex/Grok/Cursor for host split
- [x] Read `log.jsonl` + fleet memory
- [x] Write this plan

### Phase 1 — The gate write path (highest leverage)

Problem: 212 launches, 0 decisions. The skill's approve loop is fiction.

- [x] Wire already sends `request_id` (`control.ts` + `control.test.ts` / `commands.test.ts`); installed cmux is 0.64.22 (≥ 0.64.17 floor)
- [x] `approve --note` appends `{kind:approve, note}` in unit tests (`commands.test.ts`)
- [x] Live cmux approve: throwaway `captain-approve-probe-eBeu` showed `gate.kind=plan` + `replyId`; `captain approve … --note "probe: live ledger from outside cmux" --json` → `log.jsonl` `{"kind":"approve",…,"note":"probe: live ledger from outside cmux"}`. Gate cleared (row back to in-flight).
- [x] Matching stays feed-derived; skill no longer teaches send-key as the matcher workaround
- [x] Deleted cmux-key approval from `~/.claude/captain/memory/captain/learnings.md`; promoted the remaining verified bullets to Rules
- [x] Skill: `/captain check and approve plans` → `captain approve --note`; send-key only after a named CLI error (or after `cmux send`)

**Verify (unit):** `vitest run src/captain/commands.test.ts src/captain/control.test.ts` — 106 tests, including request_id + noted approve.
**Verify (live):** `cmux ping` → `PONG`. Status showed a pending plan on `captain-approve-probe-eBeu`. `captain approve --note` wrote `kind:approve` + note to `~/.claude/captain/log.jsonl`.

**Rollback:** revert the control/commands/skill diff. Ledger lines stay (append-only).

### Phase 2 — Pickup that matches his mouth

Problem: he says pick up unblocked tickets; wrong dir is the #1 silent failure.

- [x] Driver recipe in the skill: group by repo, `--repo-path` mandatory from a driver session, confirm `started[].cwd`
- [x] CLI refuses cwd basename `linear-god` without `--repo-path` (`DRIVER_CWD`, exit 2); `--repo-path` still wins. Skill matches.
- [x] Skip lists stay in the skill (`skip tig-1008`)
- [x] Frontier unchanged; skill says fan-out skips blocked, single blocked issue errors

**Verify:** `cd linear-god && node dist/cli.js start TST-123 --print --json` → `{error:{type:"DRIVER_CWD"}}`, exit 2. `vitest` repo+runner 41 passed. Skill names `--repo-path` as mandatory.

### Phase 3 — Status honesty

Problem: `run=unknown` / `gate=None` while he is staring at a plan menu. He then opens cmux by ticket name.

- [x] Skill gotcha names cmux ≥ 0.64.17 and `{request_id, mode}`; `control.ts` already comments the floor
- [x] Skill: copy `nextCommand` / `handle` from the status row
- [x] `needs-input` already maps to NEEDS YOU (`view.test.ts`)
- [x] `pendingGate` joins `/private` cwd aliases; treats `permissionRequest` as a question gate (not a plan)
- [x] Live ping after opening the app: Access denied (cmuxOnly). Named in CLI + skill: Settings → Automation → Socket Control Mode → Automation mode. Not a captain-install miss.

**Verify (unit):** `rowOf` + summary tests. **Verify (live):** still open with Phase 1.

### Phase 4 — Shrink the skill to the real conductor

The conductor is Matthew + `linear-god`, not a new CLI.

- [x] Cut `/captain` SKILL.md to pickup, status, approve-with-note, reject, merge-is-human, wrong-dir, CLI-first approve
- [x] Heartbeat still backgrounded sleep; `--summary --json` keeps `ready`; approve path documented
- [x] Distill only if the human asked. No suggested-threads / streak language
- [x] Codex: one line, do not call `approve`/`reject`

Also copied to `~/.agents/skills/captain` (what Claude Code loads).

**Verify:** a fresh-context agent given only the skill can execute `/captain check and approve plans` without reading AGENTS.md. Grep the skill for `send-key` and ensure it is in a fallback section.

### Phase 5 — Memory that a human can curate

- [x] Chose the cap, not a 600-bullet distill: `memory.ts` already injects `INBOX_MAX_ENTRIES = 20`. Skill no longer implies distill-every-session
- [x] No `gain.memory`. Live chat/frontyard/linkiq files left for a human distill; they are not in git

**Verify:** injection cap is in `src/memory.ts`. Did not rewrite Linktree Inboxes this session.

### Phase 6 — Explicit non-goals (do not tick as work)

Leave unchecked forever unless usage changes:

- Claude/Cursor Projects coordinator, routines, mobile, auto-resolved threads
- Jev / `captain triage`
- Multi-task free-form worktrees
- Tracker writes
- Auto-merge
- Teaching Matthew to type the CLI

## Verification (plan-level)

| Criterion | Command / observation |
|---|---|
| Approve lands in the ledger | Phase 1 tail of `log.jsonl` |
| Pickup does not silently use `linear-god` as repo | Phase 2 `DRIVER_CWD` + skill `--repo-path` |
| Plan gates show in status | Phase 3 `--needs` |
| Skill matches mouth | Phase 4: the phrases in "What he types" map 1:1 to skill table rows |
| Inbox is readable | Phase 5: Rules non-empty or tail cap documented |

`npm test`, `npm run typecheck`, `oxlint .` on every code phase.

## Recovery

Code phases revert with git. Ledger and memory edits are append / human files: do not rewind `log.jsonl`. Distill is reversible via git only if those files are not in git (they are under `~/.claude/captain/memory`); keep a copy before Phase 5.

## STOP conditions

Stop and report if any of these is false:

- `src/captain/control.ts` still documents `feed.exit_plan.reply` as `{request_id, mode}` (or the test in `control.test.ts` still pins that wire)
- `~/.claude/captain/log.jsonl` is still the ledger path (`captainHome`)
- Matthew has not asked to merge PRs or to ingest Slack
- `skills/captain/SKILL.md` is still the driver skill shipped with the CLI (`package.json` `files` includes `skills`)

## Finish line

- **Success:** From `linear-god`, `/captain check and approve plans` produces noted `approve` lines; pickup uses `--repo-path`; status shows live plan gates; skill is the short table above.
- **Blocked:** cmux feed still has no `request_id` on this machine → name the version, keep send-key as a dated fallback, do not expand scope.
- **Out of scope:** Projects-like conductor, personal-product dispatch, donebear (unused in the ledger).

## Implementation notes

Executor: keep `docs/plans/captain-for-how-i-use-ai.notes.md` with Deviations and How the run ended.

## Sources

- Claude `linear-god` sessions (e.g. `5866dee5`, `80d82dea`, `1cdd2194`, `c7023437`)
- Captain product session `adb829ce` (subsume linear-worktree)
- Approve bug `9f06d840`
- Codex Aug 25 fleet rollouts; Grok almost empty
- Cursor composer `ed0c1844` (this redesign)
- `~/.claude/captain/log.jsonl`, `memory/*/learnings.md`
- `research/first-principles-2026-09.md`
