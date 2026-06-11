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
  cli.ts            # Commander entry: doctor | start | status | approve | reject
  runner.ts         # runStart routes on the first token: runLinearWorktree (issue → worktree fan-out) or runDispatch (free-form task → current dir); both share the self-drive brief
  cmux.ts git.ts linear.ts repo.ts issue.ts images.ts launch.ts progress.ts shell.ts home.ts
  config.ts         # PURE-ish: loadSkills (CAPTAIN_SKILLS > ~/.config/captain/config.json .skills > DEFAULT_SKILLS), parseSkills
  prompt.ts         # issue context + <workflow> (plan/implement + the configured skills + finish) + <finishing-protocol> + <fleet-memory>
  rubric.ts         # PURE: renderRubric -> per-worktree .captain/rubric.md (definition of done) + rubricHash
  memory.ts         # per-repo fleet memory ~/.claude/captain/memory/<repo>/learnings.md (Rules + tail-capped Inbox)
  captain/
    view.ts         # 100% PURE (lint-enforced): identity, pendingGate (feed → gate), rowOf (the grouping rule), mergeOrderHints. Start here.
    verdict.ts      # 100% PURE: parseVerdict (fail-safe) + verdictCounts (rubric-hash check)
    surface.ts      # the one fs/cmux composition edge: fleetRows = workspaces ∩ .captain/ + feed + runStates + verdicts
    control.ts      # the CmuxPort seam: realCmux(env) wraps the cmux CLI (workspace.list, feed.list, exit_plan.reply, send, notify, runStates via `cmux top`); tests pass a fake port
    commands.ts     # stateless status/approve/reject + friendly-id resolution
    doctor.ts       # PURE buildChecks(deps) preflight (node/git/claude/cmux/key/skills) + render; realDeps reads the world
    format.ts       # TTY-aware colour + the grouped status renderer (display only)
    log.ts          # thin audit trail: append-only ~/.claude/captain/log.jsonl (approve/reject)
```

## How it works

**Start** (`captain start`, `runStart`): routes on its first token — a Linear issue id/URL →
`runLinearWorktree` (one worktree + cmux workspace per issue); anything else → `runDispatch` (a
free-form task in the **current checkout**, no Linear, no worktree). Either way the agent gets the
same brief: the `<workflow>` pipeline (plan → implement → the configured skills → verifier
finish), the finishing protocol, and fleet memory. The skills run between implement and finish are
config-driven (`config.ts` `loadSkills`: `CAPTAIN_SKILLS` env > `~/.config/captain/config.json`
`.skills` > the default `/simplify` → `/pr-reviewer` → `/pr-creator` → `/pr-babysitter`); plan,
implement, and the verdict finish stay fixed because `status` derives from them. The agent
self-drives; nothing external types commands into it.

For the free-form path, `.captain/` lands in the checkout itself (cwd = repoRoot) — one such
dispatch per checkout at a time: a second clobbers the shared `.captain/rubric.md`/`verdict.json`.
The rubric degrades gracefully with no issue (a coarse "implements `<name>`" criterion + the fixed
verify procedure).

**Surface** (`status`/`approve`/`reject`): stateless, derived fresh on every call —

- membership: a cmux workspace whose cwd has a `.captain/` dir (start writes the rubric there)
- busy/idle: `cmux top --all --flat --format tsv` run-state tags (one call, all workspaces)
- gates: the newest **unresolved** `feed.list` item per cwd (`resolved_at` absent = pending);
  `exitPlan` → the plan gate, `question`/`notification` → blocked
- done: `.captain/verdict.json`, hash-checked against the rubric as it exists now
- grouping (`rowOf` in `view.ts`): gate, failed verdict, or run-state `needs-input` → NEEDS YOU;
  valid passing verdict → READY TO MERGE; otherwise IN FLIGHT

`approve` replies to the exit-plan feed item directly; `reject` replies false **and** types the
feedback into the workspace via `cmux send`. No state means no single-writer constraint, no
intent queue, no daemon to race.

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
- **`.captain/` never reaches a diff**: `start` appends it to the repo's shared
  `.git/info/exclude` (one append covers all linked worktrees) — don't move the rubric/verdict
  into tracked paths. It doubles as the membership marker `surface.ts` filters by.
- **Tests must not touch the real `$HOME`**: `home.ts` `captainHome` resolves `CAPTAIN_HOME` >
  `~/.claude/captain` (the base for both `log.ts` and `memory.ts`; `memory.ts` also honours
  `CAPTAIN_MEMORY_DIR`), and `config.ts` honours `CAPTAIN_CONFIG` (point it at a temp file) —
  runner/commands/config tests set these to temp dirs and drive the real modules through a fake
  `CmuxPort` (no mocking library).
- **Skills config is fail-safe**: `loadSkills` (`config.ts`) never throws — a missing/garbage
  config file or empty array degrades to `DEFAULT_SKILLS`; only a non-empty string array (or a
  non-empty `CAPTAIN_SKILLS`) overrides. The config lives at `~/.config/captain/config.json`
  (XDG, **not** under `~/.claude`), `CAPTAIN_CONFIG` redirects the path.
- **No daemon, ever**: there is no watcher process, no pidfile, no state.json. If you find
  yourself adding persisted fleet state, stop — derive it from cmux + the filesystem instead.
- **Behaviour parity**: `start` must preserve every mode — Linear fan-out, single Linear issue,
  free-form current-dir dispatch, and `--print` for each.

## Env knobs

`LINEAR_API_KEY` (issue fetch + screenshots) · `CAPTAIN_MEMORY_DIR` (fleet memory override) ·
`CAPTAIN_HOME` (data home: log.jsonl + fleet memory base) · `CAPTAIN_SKILLS` (comma-separated
skills, overrides the config file) · `CAPTAIN_CONFIG` (config.json path override) ·
`XDG_CONFIG_HOME` (config dir) · `CAPTAIN_DEBUG=1` (stack traces) · `NO_COLOR`.
