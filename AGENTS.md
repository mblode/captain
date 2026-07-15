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
  cli.ts            # Commander entry: install | start | status | approve | reject; bare-token routing via withImplicitStart
  route.ts          # PURE: withImplicitStart (bare `captain tig-123` → `captain start …`; single non-Linear word = likely typo, untouched)
  runner.ts         # runStart routes on the first token: runLinearWorktree (issue → worktree fan-out) or runDispatch (free-form task → current dir); both share the self-drive brief; resolveAgent picks claude|codex
  cmux.ts git.ts linear.ts repo.ts issue.ts images.ts launch.ts progress.ts shell.ts home.ts
  config.ts         # PURE-ish, all fail-safe: loadSkills, loadDataScope (CAPTAIN_DATA_SCOPE > .dataScope > DEFAULT_DATA_SCOPE)
  prompt.ts         # issue context + <workflow> (plan/implement + the configured skills + finish) + <data-scope> guardrail + <finishing-protocol> + <fleet-memory>
  rubric.ts         # PURE: renderRubric -> per-worktree .captain/rubric.md (definition of done) + rubricHash
  memory.ts         # per-repo fleet memory ~/.claude/captain/memory/<repo>/learnings.md (Rules + tail-capped Inbox)
  captain/
    view.ts         # 100% PURE (lint-enforced): identity, pendingGate (feed → gate), rowOf (the grouping rule), mergeOrderHints. Start here.
    verdict.ts      # 100% PURE: parseVerdict (fail-safe) + verdictCounts (rubric-hash check)
    surface.ts      # the one fs/cmux composition edge: fleetRows = workspaces ∩ .captain/ + feed + runStates + verdicts
    control.ts      # the CmuxPort seam: realCmux(env) wraps the cmux CLI (workspace.list, feed.list, exit_plan.reply, send, notify, runStates via `cmux top`); tests pass a fake port
    commands.ts     # stateless status/approve/reject/gain + friendly-id resolution
    gain.ts         # 100% PURE: computeGain (decisions + launch ledger + live fleet snapshot + verdict tallies → metrics incl. launch→detection latency); the gain command's fs/cmux edge lives in commands.ts
    doctor.ts       # PURE buildChecks(deps) preflight (node/git/claude/cmux/key/skills) + missingBundles + render; the `install` command + realDeps read/mutate the world (skills add)
    format.ts       # TTY-aware colour + the grouped status renderer + renderGain (display only)
    log.ts          # thin audit trail: append-only ~/.claude/captain/log.jsonl (approve/reject/launch); readLog feeds gain
```

## How it works

**Start** (`captain start`, `runStart`): routes on its first token — a Linear issue id/URL →
`runLinearWorktree` (one worktree + cmux workspace per issue); anything else → `runDispatch` (a
free-form task in the **current checkout**, no Linear, no worktree). The `start` subcommand is
implicit: a bare first argument that isn't a known subcommand or a flag is treated as `start`
(`withImplicitStart` in `route.ts` splices `start` into argv before commander parses it; the
known-commands set is derived from the commander registry so it can't drift), so `captain tig-123`
and `captain "tidy the readme"` work like `captain start …` — this is the `linear-worktree`
invocation, subsumed. One guard: a **single** bare word that isn't a Linear id/URL and has no
spaces (`captain statsu`) is left alone so commander errors — it's far more likely a typo'd
subcommand than a one-word task, and splicing would launch an agent and clobber the checkout's
`.captain/` rubric (voiding an in-flight dispatch's verdict hash). Either way the agent gets the
same brief: the `<workflow>` pipeline (plan → implement → the configured skills → verifier
finish), the `<data-scope>` guardrail (source/config only — no customer data, secrets, or PII;
`loadDataScope`, on by default), the finishing protocol, and fleet memory. The skills run between implement and finish are
config-driven (`config.ts` `loadSkills`: `CAPTAIN_SKILLS` env > `~/.config/captain/config.json`
`.skills` > the default `/tidy` → `/pr-reviewer` → `/pr-creator` → `/pr-babysitter`); plan,
implement, and the verdict finish stay fixed because `status` derives from them. The agent
self-drives; nothing external types commands into it.

Every launch pins the agent's **model + effort** so it never inherits the driver's ambient tier
(a driver on a cheap/fast model would otherwise fan the whole fleet onto it). Both launch paths —
`claudeCommand` (`cmux.ts`, the fan-out `--command`) and `launchPlanMode` (`launch.ts`, the inline
fallback) — pass `--model`/`--effort` from `loadModel`/`loadEffort` (`config.ts`: `CAPTAIN_MODEL`/
`CAPTAIN_EFFORT` env > config `.model`/`.effort` > `DEFAULT_MODEL` `default` / `DEFAULT_EFFORT`
`high`, fail-safe like the rest). `default` resolves to the machine's configured default model.
`cmux.ts` shell-quotes the model because a full id can carry glob metacharacters (the `[1m]` in
`claude-opus-4-8[1m]`); the inline path passes it as a discrete argv element, so no quoting.

The launched **agent** is selectable: `--agent <claude|codex>` (flag) > `CAPTAIN_AGENT` env /
`.agent` config > `DEFAULT_AGENT` `claude` (`loadAgent`/`resolveAgent`, fail-safe — any unknown
value degrades to `claude`). `claude` (the default) is the only agent wired into the plan-gate
flow: it launches in plan mode (`--permission-mode plan`) and its `ExitPlanMode` feed item is what
`approve`/`reject` gate on. `codex` is **best-effort**: it has no plan mode, so it launches with
full autonomy (`--dangerously-bypass-approvals-and-sandbox`, the analog of claude's skip-perms) and
drives straight from the brief — no plan gate, no `approve` step. The brief's plan step is
agent-aware (`renderPromptExtras` takes `agent`): claude is told to present the plan for approval;
codex is told to plan then proceed, because telling it to wait for an approval that can never
arrive would stall every codex run at step 1. The command builders branch by
agent (`agentCommand` → `claudeCommand`/`codexCommand` in `cmux.ts`; `launchPlanMode` in
`launch.ts`), and the launch-time binary probe checks the selected agent's binary. Codex maps
effort to `-c model_reasoning_effort=<effort>` and omits `-m` on the `default` model sentinel (that
sentinel is claude-only). `status` still tracks a codex workspace as IN FLIGHT — `runStates`
(`control.ts`) fills any workspace's state from its `cmux top` tag row, so a non-`claude_code` tag
still registers; only the plan-gate label is claude-specific.

For the free-form path, `.captain/` lands in the checkout itself (cwd = repoRoot) — one such
dispatch per checkout at a time: a second clobbers the shared `.captain/rubric.md`/`verdict.json`.
The rubric degrades gracefully with no issue (a coarse "implements `<name>`" criterion + the fixed
verify procedure).

**Repo selection**: `runner.ts` resolves a run's repo from `--repo-path` (`repoOverride`), else the
cwd git toplevel (`resolveRepo`) — there is **no** config-based routing. Spanning several repos in
one session is the `/captain` driver's job: it reads each ticket and passes `--repo-path` per repo,
because routing can't be a static map — a Linear team _and_ a single project both span repos (see
the `/captain` skill). worktree/rubric/memory key off the resolved `repoRoot`. (`memory.ts` keys
per-repo by basename, now disambiguated by a path hash on collision while keeping any existing
legacy dir.)

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

`status --watch [--interval <s>]` re-renders that same derivation on a timer for a human watching
a terminal (Ctrl-C exits, default 5s). It is **not** a daemon: it persists nothing, every tick is
an independent `statusOnce` (the `--json`/`--summary` machine paths short-circuit before the git
merge-order cost), and it returns a `stop()` handle so the loop tears down deterministically. The
agent _driver_ does **not** use `--watch` (a blocking foreground loop can't yield turns); its
heartbeat is a backgrounded `sleep` whose exit re-invokes its turn — see the captain skill's
heartbeat ladder.

`gain` (alias `audit`) derives fleet telemetry the same stateless way: the gap-free `log.jsonl`
ledger (`readLog` — approve/reject decisions plus per-launch records appended by `start`) + a
live fleet snapshot + verdict tallies → `computeGain` (PURE), with an honesty footer (`--json`
plain). Launch records join decisions/verdicts by the qualified `${repo}-${ticket}` name to give
**latency to detection** (launch→decision from the ledger, launch→verdict from the live verdict
files); `--print` never logs a launch. `--git` opt-in approximates merged-PR counts via `gh`,
fail-soft. No counters, no event stream — operation-level throughput is not recorded, by design.

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
`<fleet-memory>`, and agents append only _verified_ learnings at end of run — including, when a
verifier run failed before eventually passing, the root cause of that failure as a preventive
rule (the eventual pass is its verification). Curation is human-driven via the captain skill;
approve/reject notes land in `~/.claude/captain/log.jsonl`.

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
  When one ticket is fanned into two repos (e.g. `tig-424` → frontyard **+** ltfollowers), the
  bare ticket is ambiguous: `resolveTargets` refuses to guess and reports the qualified
  `${repo}-${ticket}` names (`frontyard-tig-424`, `ltfollowers-tig-424`) — pass one of those, not
  a workspace uuid. `status` already prints the qualified handle for colliding tickets
  (`withHandles` in `view.ts`), so the displayed approve/reject command is always resolvable.
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
  This is a deliberate boundary against Builderbot-style bets: Slack/webhook ticket ingestion,
  real-time multi-user steering, and two-way conversational control **all** require a persistent
  listener — the exact watcher-daemon class deleted June 2026, where every live-session bug lived
  (daemon death, fleet-wipe on a flaky RPC, gate-flap, two-writer clobber). A **one-way**
  `notify`→external push is the only thesis-safe slice; two-way control stays a non-goal. The
  reasoning is written up in `research/builderbot-audit.md`. (`status --watch` is **not** a
  violation: it is a foreground, stateless re-render loop the human starts and Ctrl-Cs — it holds
  no state, listens to nothing, and coordinates no writers. The forbidden class is a _persistent
  background listener_, not a polling loop.)
- **Behaviour parity**: `start` must preserve every mode — Linear fan-out, single Linear issue,
  free-form current-dir dispatch, an explicit `--repo-path`, the bare-token form (`captain tig-123`
  == `captain start tig-123`, via `withImplicitStart`), and `--print` for each. Repo selection
  is `--repo-path` else cwd; spanning repos in one session is the driver's job (per-ticket
  `--repo-path`), not config.
- **codex is best-effort, claude is the gated default**: only `claude` produces the `ExitPlanMode`
  gate that `approve`/`reject` act on; `codex` launches with full autonomy and no plan gate. Don't
  wire `approve`/`reject` to codex or assume a codex workspace pauses for a plan.

## Env knobs

`LINEAR_API_KEY` (issue fetch + screenshots) · `CAPTAIN_MEMORY_DIR` (fleet memory override) ·
`CAPTAIN_HOME` (data home: log.jsonl + fleet memory base) · `CAPTAIN_SKILLS` (comma-separated
skills, overrides the config file) · `CAPTAIN_DATA_SCOPE` (overrides the data-scope guardrail) ·
`CAPTAIN_MODEL` (agent `--model`, default `default`) · `CAPTAIN_EFFORT` (agent `--effort`, default
`high`) · `CAPTAIN_AGENT` (which agent to launch, `claude` | `codex`, default `claude`) ·
`CAPTAIN_CONFIG` (config.json path override) · `XDG_CONFIG_HOME` (config dir) ·
`CAPTAIN_DEBUG=1` (stack traces) · `NO_COLOR`.

`~/.config/captain/config.json` keys (all fail-safe): `.skills` (string[]), `.dataScope` (string),
`.model` (string), `.effort` (string), `.agent` (string, `claude` | `codex`).
