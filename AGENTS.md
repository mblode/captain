# captain

A live driver for a fleet of cmux worktrees (Linear ticket → PR-ready), built on the
`linear-worktree` fan-out. The watcher holds the cmux agent event stream open and advances each
worktree through a state machine, parking human gates.

## Commands

```bash
npm install                 # setup (requires Node >= 22)
npm run build               # tsdown -> dist/
npm run dev                 # tsdown --watch
npm run test                # vitest run
npm run typecheck           # tsc --noEmit
npm run lint                # oxlint .
npm run check               # ultracite check (lint + format, CI-equivalent)
npm run fix                 # ultracite fix (format + lint autofix)
npm link                    # install `captain` globally from this checkout
```

## Architecture

```text
src/
  cli.ts            # Commander entry: fanout | status | audit | approve | reject | stop | watch
  runner.ts         # the inherited fan-out + armWatcher (writes match, ensures the daemon)
  cmux.ts git.ts linear.ts repo.ts issue.ts prompt.ts images.ts launch.ts progress.ts shell.ts
  rubric.ts         # PURE: renderRubric -> per-worktree .captain/rubric.md (definition of done) + rubricHash
  memory.ts         # per-repo fleet memory ~/.claude/captain/memory/<repo>/learnings.md (Rules + tail-capped Inbox)
  captain/
    pipeline.ts     # PURE state machine: (worktree, hook event) -> transition. Start here.
    types.ts        # Stage, Worktree, FleetState, HookEvent, Transition, HistoryRecord
    state.ts        # DEFAULT_FLEET + atomic load/save of ~/.claude/captain/default/state.json + cursor
    history.ts      # append-only audit log ~/.claude/captain/default/history.jsonl (appendHistory/readHistory)
    intents.ts      # append-only intent log ~/.claude/captain/default/intents.jsonl: approve/reject hand decisions to the watcher (single-writer)
    daemon.ts       # singleton watcher: pidfile guard, ensureDaemon (detached spawn), stopDaemon
    control.ts      # cmux wrappers: workspace.list, send, read-screen, notify, feed reply
    events.ts       # spawn `cmux events --category agent --reconnect`, parse agent.hook frames
    verdict.ts      # PURE parse/checkVerdict (+ thin fs reads): the agent-written .captain/verdict.json -> pr-ready gate or BLOCKED
    watch.ts        # the live daemon: adopt -> react to events -> advance / park gates / surface verdicts; records history
    commands.ts     # status + audit (read views) + approve/reject + friendly-id resolution
    format.ts       # TTY-aware colour, stage glyphs, grouped status + the audit view
```

## DX surface

One implicit fleet (`DEFAULT_FLEET`), so no `--fleet` anywhere. `fanout` auto-starts a single
detached watcher (pidfile-guarded in `daemon.ts`), passing the worktrees' shared parent dir as a
`CAPTAIN_MATCH` scope. The watcher is the **sole writer** of `state.json` (it persists that match),
so `fanout` never races its saves; an already-running watcher keeps its boot-time scope and warns
if a later `fanout` falls outside it. `status` is the whole read surface — it folds in the old
`gates`/`ready` by printing each gate's inline resolve command and each PR's merge hint, plus a
watcher-health header. `stop` tears the daemon down. `CAPTAIN_NO_WATCH=1` opts out of auto-driving.

## How the watcher decides

`hook_event_name` drives everything (each frame carries `workspace_id` + `cwd` + `seq`):
`Stop` → advance (send next slash command) · `ExitPlanMode` → PLAN_READY gate ·
`AskUserQuestion`/`Notification` → BLOCKED · `UserPromptSubmit`/`PreToolUse` → busy.
The advance pipeline (`NEXT_ON_STOP` in `pipeline.ts`) is derived from real cadence usage:
`/simplify` → `/pr-reviewer` → `/pr-creator` → `/pr-babysitter`, stopping at PR-ready.

Beyond event-driven advancement, the 30s reconcile timer sweeps for hung loops (`enforceHalts` +
the pure `checkHalt` in `pipeline.ts`): a worktree event-silent past `CAPTAIN_STALL_SECS`
(default 1800 = 30m) while in a working stage (PLANNING/IMPLEMENTING/SIMPLIFY/REVIEW/PR_OPEN) is a
silently-hung agent — no events means `transition` never fires for it — so it's parked at a
`BLOCKED` gate ("needs you"). BABYSITTING (legitimately long-polls a PR), ADOPTED (transient), and
the human gates (PLAN_READY/READY_TO_MERGE/BLOCKED) idle by design and are exempt.

## The verdict gate & fleet memory (the agent-side loops)

Two loops the _agent_ closes against its environment, with captain as the recording gate (design
rationale in `research/loops-fable5.md`). **Verifier loop**: fan-out writes a definition of done
into each worktree (`.captain/rubric.md`, rendered by `rubric.ts` from the Linear issue — no LLM
call) and the prompt's `<finishing-protocol>` section requires a fresh-context verifier sub-agent
to pass it before the agent writes `.captain/verdict.json`. The watcher reads that file on `Stop`
and on the reconcile tick (`applyVerdictFor`/`enforceVerdicts` in `watch.ts`, pure decision in
`verdict.ts`): a pass parks the `pr-ready` gate at `READY_TO_MERGE` (wiring the formerly dead
stage, and assigning `prUrl` when the verdict carries it); a fail escalates to `BLOCKED` with the
verifier's summary. The verdict must cite the sha256 of the rubric body _as it exists now_
(`rubricBody`/`rubricHash`), so editing the criteria after the fact voids it. **Memory loop**:
`memory.ts` keeps `~/.claude/captain/memory/<repo>/learnings.md` (shared by all worktrees of a
repo, survives worktree removal); fan-out injects all of `## Rules` plus the tail-capped
`## Inbox` via the prompt's `<fleet-memory>` section, and instructs agents to append only
_verified_ learnings at end of run. Curation (Inbox → Rules) is human-driven via the captain
skill; reject/halt/verdict reasons land in `HistoryRecord.note` so `captain audit` shows the
why worth distilling.

## Measurement & the self-improvement loop

Every transition the watcher makes is appended to `history.jsonl` (`history.ts`) — advances,
gates, busy-defer reworks, plus approve/reject from `commands.ts`. That log + `captain audit`
are the measurement substrate; the self-improvement loop itself is agent-side: the verdict gate
(outcome verification) + fleet memory (distilled learnings) — see `research/loops-fable5.md`.
(The old metrics/tuning subsystem — `captain metrics`, per-stage retry budgets — was deleted:
it never fired in real runs, and `checkHalt` + the verdict gate cover what it was for.)

`captain audit` is the governance trail over that same log: every advance, gate, and human
approve/reject rendered chronologically with the actor (watcher vs. you), the stage flow, and the
slash command sent — `filterHistory` (PURE, in `commands.ts`) narrows it by recency (`--since 2h`)
or worktree (`--ref tig-430`), and `--json` stays plain for piping. It reuses `readHistory`; no new
state. (The scoped-permission/policy layer that _constrains_ what the watcher may do unattended is a
planned follow-up; this ships the read-side audit first.)

## Gotchas

- **ESM, bundler resolution**: extensionless relative imports (`./state`, not `./state.js`); `tsconfig` uses `moduleResolution: "Bundler"` and tsdown bundles to `dist/`.
- **The pure core stays pure** (`pipeline.ts`, `verdict.ts`, `rubric.ts`) — keep I/O (cmux, fs) out so they stay unit-testable; decisions take plain input data, not fs reads.
- **Append-only logs, single state writer** (`history.ts`, `intents.ts`): each is one JSON line per record, so it never races the `state.json` temp+rename and a truncated tail line is just skipped on read — safe to append from any process. The **watcher is the sole writer of `state.json`**: `approve`/`reject` never mutate it (that would race the watcher's live saves), they append an `intent` to `intents.jsonl`, and the watcher drains it via a byte-offset cursor (`state.intentsOffset`) — at startup, before each event, and on the reconcile timer — replying to the cmux plan gate and moving the stage itself. Exactly-once: the cursor only advances past complete lines.
- **Idempotent gates**: cmux re-emits some hook frames; only alert on a _new_ gate (see `isNewGate` in `watch.ts`), never double-notify. A re-emitted `ExitPlanMode` (and a bypass-permissions re-plan) must not regress an already-approved worktree — `transition` only gates from the pre-approval stages (`PLANNABLE_FROM` in `pipeline.ts`).
- **Never trust cmux's built-in status** (it desyncs); derive state from the agent event stream.
- **Colour only on a TTY** (`useColor`) — piped output and `--json` stay plain so the LLM/skill can parse them.
- **Friendly ids**: `approve`/`reject` resolve `tig-430` or substrings, never require a uuid.
- **The verdict gate is fail-safe by construction**: a missing/garbage `.captain/verdict.json` is
  "no verdict yet" — the worktree idles at BABYSITTING exactly as before the feature existed, and a
  malformed verdict must never read as a pass (`parseVerdict` returns null). The verdict gates the
  _label_ (READY_TO_MERGE + `✓ verified`), never the merge — the human merge gate stays
  authoritative. `checkVerdict` is idempotent (null once `wt.gate` is set), so the Stop path and
  the reconcile sweep never double-fire.
- **`.captain/` never reaches a diff**: `fanout` appends it to the repo's shared
  `.git/info/exclude` (one append covers all linked worktrees) — don't move the rubric/verdict
  into tracked paths.
- **Tests must not touch real `$HOME` memory**: `memory.ts` honours `CAPTAIN_MEMORY_DIR`; any test
  that drives the fan-out (runner tests) must set it to a temp dir, the same way
  `CAPTAIN_NO_WATCH=1` guards the daemon.
- **Self-exclusion is free**: the auto-started watcher is a detached process, not a cmux workspace, so it never appears in `cmux workspace list` and can't drive itself (no `CMUX_CAPTAIN` needed). The `CMUX_WORKSPACE_ID` fallback in `watch.ts` only matters for a manual in-workspace `captain watch`.
- **Singleton watcher**: `ensureDaemon` is pidfile-guarded — re-running `fanout` never double-spawns. Tests must set `CAPTAIN_NO_WATCH=1` to avoid spawning a real daemon / writing real `~/.claude` state.
- **Stall halt keys off event-silence, not work time**: `checkHalt` measures `wt.lastSeen` (epoch secs of the last _handled event_), NOT `wt.since` (time-in-stage) — a long but healthy turn that keeps emitting hook events resets the clock and is never falsely halted; only a genuinely event-silent agent escalates. The sweep rides the existing 30s reconcile tick (no new timer). Cold-start parity: because it watches silence, not elapsed work, normal/fast runs are unchanged no matter how long a stage legitimately runs. Knobs mirror the watcher opt-outs: `CAPTAIN_STALL_SECS` (default 1800) tunes the threshold, `CAPTAIN_NO_HALT=1` disables the sweep (parallels `CAPTAIN_NO_WATCH=1`). The halt lands in `history.jsonl` as `kind:"gate"` / `gate:"needs-input"` / `event:"halt"`, so `audit` shows it.
- **Behaviour parity**: preserve the inherited `fanout` modes (single-issue, fan-out, `--print`).
