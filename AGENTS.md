# captain

Dispatch a fleet of cmux worktrees (Linear ticket → PR-ready) and surface what needs you. The
worktree + Linear + prompt fan-out is captain-native (`runner.ts` + `git.ts`/`linear.ts`/
`prompt.ts`); each agent's brief carries the whole pipeline and the agent drives it itself.
Captain keeps **no state** — `status` is derived live from cmux-native signals and the
per-worktree `.captain/` files. (The previous watcher-daemon/state-machine architecture was
deleted June 2026 — see `research/` for the history.)

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
  cli.ts            # Commander entry: doctor | fanout | status | approve | reject | notify
  runner.ts         # the fan-out: worktree + workspace + the self-drive brief per issue
  cmux.ts git.ts linear.ts repo.ts issue.ts images.ts launch.ts progress.ts shell.ts
  prompt.ts         # issue context + <workflow> (the self-drive pipeline) + <finishing-protocol> + <fleet-memory>
  rubric.ts         # PURE: renderRubric -> per-worktree .captain/rubric.md (definition of done) + rubricHash
  memory.ts         # per-repo fleet memory ~/.claude/captain/memory/<repo>/learnings.md (Rules + tail-capped Inbox)
  captain/
    view.ts         # 100% PURE (lint-enforced): identity, pendingGate (feed → gate), rowOf (the grouping rule), mergeOrderHints. Start here.
    verdict.ts      # 100% PURE: parseVerdict (fail-safe) + verdictCounts (rubric-hash check)
    surface.ts      # the one fs/cmux composition edge: fleetRows = workspaces ∩ .captain/ + feed + runStates + verdicts
    control.ts      # the CmuxPort seam: realCmux(env) wraps the cmux CLI (workspace.list, feed.list, exit_plan.reply, send, notify, runStates via `cmux top`); tests pass a fake port
    commands.ts     # stateless status/approve/reject + friendly-id resolution
    doctor.ts       # PURE buildChecks(deps) preflight (node/git/claude/cmux/key/skills) + render; realDeps reads the world
    notify.ts       # optional foreground poller: diff the view per tick, toast on change, one quiet nudge
    format.ts       # TTY-aware colour + the grouped status renderer (display only)
    log.ts          # thin audit trail: append-only ~/.claude/captain/log.jsonl (approve/reject/toasts)
```

## How it works

**Dispatch** (`fanout`): per issue — worktree + cmux workspace + a brief containing the issue,
the `<workflow>` pipeline (plan → implement → `/simplify` → `/pr-reviewer` → `/pr-creator` →
`/pr-babysitter`), the finishing protocol, and fleet memory. The agent self-drives; nothing
external types commands into it.

**Surface** (`status`/`approve`/`reject`): stateless, derived fresh on every call —

- membership: a cmux workspace whose cwd has a `.captain/` dir (fanout writes the rubric there)
- busy/idle: `cmux top --all --flat --format tsv` run-state tags (one call, all workspaces)
- gates: the newest **unresolved** `feed.list` item per cwd (`resolved_at` absent = pending);
  `exitPlan` → the plan gate, `question`/`notification` → blocked
- done: `.captain/verdict.json`, hash-checked against the rubric as it exists now
- grouping (`rowOf` in `view.ts`): gate, failed verdict, or run-state `needs-input` → NEEDS YOU;
  valid passing verdict → READY TO MERGE; otherwise IN FLIGHT

`approve` replies to the exit-plan feed item directly; `reject` replies false **and** types the
feedback into the workspace via `cmux send`. No state means no single-writer constraint, no
intent queue, no daemon to race.

**Notify** (`captain notify`, optional): a foreground 30s poller (`CAPTAIN_POLL_SECS`) that diffs
the view in memory and toasts on a new gate, a fresh verdict, or a worktree idle-and-unchanged
past `CAPTAIN_QUIET_SECS` (default 1800; one nudge, never repeated). `--once` runs a single pass.
Kill/restart freely — worst case is one repeat toast.

## The verdict gate & fleet memory (the agent-side loops)

**Verifier loop**: fan-out writes a definition of done into each worktree (`.captain/rubric.md`,
rendered by `rubric.ts` from the Linear issue — no LLM call) and the prompt's
`<finishing-protocol>` requires a fresh-context verifier sub-agent to pass it before the agent
writes `.captain/verdict.json`. `status` reads that file at render time: a valid pass shows
READY TO MERGE + `✓ verified` (+ the PR's merge hint); a fail shows NEEDS YOU with the verifier's
summary. The verdict must cite the sha256 of the rubric body _as it exists now_
(`rubricBody`/`rubricHash`), so editing the criteria after the fact voids it. **Memory loop**:
`memory.ts` keeps `~/.claude/captain/memory/<repo>/learnings.md` (shared by all worktrees of a
repo, survives worktree removal); fan-out injects `## Rules` + the tail-capped `## Inbox` via
`<fleet-memory>`, and agents append only _verified_ learnings at end of run. Curation is
human-driven via the captain skill; approve/reject notes land in `~/.claude/captain/log.jsonl`.

## Gotchas

- **ESM, bundler resolution**: extensionless relative imports (`./view`, not `./view.js`);
  `tsconfig` uses `moduleResolution: "Bundler"` and tsdown bundles to `dist/`.
- **The pure core stays pure** (`view.ts`, `verdict.ts`, `rubric.ts`) — lint-enforced for
  view/verdict (oxlint `no-restricted-imports` bans `node:fs`/`node:child_process` in
  `oxlint.config.ts`). Decisions take plain input data; `surface.ts` is the one fs/cmux edge.
- **The verdict is fail-safe by construction**: a missing/garbage `.captain/verdict.json` is "no
  verdict yet" (`parseVerdict` returns null — a malformed verdict must never read as a pass), and
  the verdict gates the _label_ (`✓ verified`), never the merge — the human merge gate stays
  authoritative.
- **Never trust cmux's built-in workspace status glyph** (it desyncs). The trusted signals are
  `cmux top`'s per-workspace run-state **tag** (live process accounting, `runStates` in
  `control.ts`) and the feed's `resolved_at` field. An unreadable tag parses as "unknown" =
  not busy.
- **The feed is the gate inventory**: always filter `!resolved_at` and pick the newest match per
  cwd (`pendingGate` in `view.ts`) — a stale resolved item must never read as a live gate or
  swallow an `exit_plan.reply`.
- **Colour only on a TTY** (`useColor`) — piped output and `--json` stay plain so the LLM/skill
  can parse them.
- **Friendly ids**: `approve`/`reject` resolve `tig-430` or substrings, never require a uuid.
- **`.captain/` never reaches a diff**: `fanout` appends it to the repo's shared
  `.git/info/exclude` (one append covers all linked worktrees) — don't move the rubric/verdict
  into tracked paths. It doubles as the membership marker `surface.ts` filters by.
- **Tests must not touch the real `$HOME`**: `memory.ts` honours `CAPTAIN_MEMORY_DIR` and
  `log.ts` honours `CAPTAIN_HOME` — runner/commands/notify tests set both to temp dirs and drive
  the real modules through a fake `CmuxPort` (no mocking library).
- **No daemon, ever**: there is no watcher process, no pidfile, no state.json. If you find
  yourself adding persisted fleet state, stop — derive it from cmux + the filesystem instead.
- **Behaviour parity**: preserve the inherited `fanout` modes (single-issue, fan-out, `--print`).

## Env knobs

`LINEAR_API_KEY` (issue fetch + screenshots) · `CAPTAIN_MEMORY_DIR` (fleet memory override) ·
`CAPTAIN_HOME` (log.jsonl override) · `CAPTAIN_POLL_SECS` / `CAPTAIN_QUIET_SECS` (notify) ·
`CAPTAIN_DEBUG=1` (stack traces) · `NO_COLOR`.
