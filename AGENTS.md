# captain

Dispatch a fleet of cmux worktrees (Linear ticket → PR-ready) and surface what needs you. The
worktree + Linear + prompt fan-out is captain-native (`runner.ts` + `git.ts`/`linear.ts`/
`prompt.ts`); each agent's brief carries the whole pipeline and the agent drives it itself.
Captain keeps **no state** — `status` is derived live from cmux-native signals and the
per-worktree `.captain/` files. (The previous watcher-daemon/state-machine architecture was
deleted June 2026 — see `research/` for the history.)

Read [`docs/architecture.md`](docs/architecture.md) before changing start routing, model/agent
selection, the frontier rule, the surface (`status`/`approve`/`reject`/`--watch`), `gain`, the
verdict/plan/memory loops, or before re-proposing anything under Non-goals. It also holds the
full reasoning behind every gotcha below.

## Commands

```bash
npm install                 # setup (requires Node >= 24, per package.json engines)
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
  cli.ts         # Commander entry: install | start | spec | status | gain | approve [--note] | reject --note
  route.ts       # PURE: withImplicitStart (bare `captain tig-123` → `captain start …`; lone non-issue word left alone)
  runner.ts      # runStart: runIssueWorktree (issue → worktree fan-out) or runDispatch (free-form → current dir); resolveAgent
  spec.ts        # runSpec: one agent per OpenSpec change in the CURRENT checkout + branch (no worktree, no PR)
  openspec.ts    # openspecHome (outside the repo, keyed like memory) + read openspec/changes/<id>/ → Issue (unchecked tasks = criteria, `## Smoke test` = smoke)
  source.ts      # THE ISSUE-SOURCE SEAM: IssueSource registry, sourceFor + isIssueToken. A new source touches only this file
  types.ts       # Issue: the source-neutral contract every source maps INTO
  linear.ts      # fetchLinearIssue + mapLinearIssue (sub-issues → criteria, `blocks` relations → blockedBy)
  donebear.ts    # parseDonebearInput (URL/UUID → db-<8hex>) + fetchDonebearTask + mapTaskToIssue (checklist → criteria)
  issue.ts       # PURE: openBlockers (the frontier rule)
  config.ts      # fail-safe loaders: loadSkills/loadDataScope/loadModel/loadEffort/loadAgent, DEFAULT_AGENT_ENV
  prompt.ts      # the brief: issue context + <workflow> + <data-scope> + <finishing-protocol> + <fleet-memory>
  rubric.ts      # PURE: renderRubric → .captain/rubric.md (definition of done) + rubricHash
  memory.ts      # per-repo fleet memory ~/.claude/captain/memory/<repo>/learnings.md (Rules + tail-capped Inbox)
  cmux.ts launch.ts  # agent command builders (claudeCommand/codexCommand; launchPlanMode inline fallback)
  git.ts repo.ts images.ts progress.ts shell.ts home.ts errors.ts  # worktrees, repo resolution, screenshots, IO helpers, CliError
  captain/
    view.ts      # 100% PURE: identity, pendingGate, rowOf (the grouping rule), mergeOrderHints, withHandles. Start here
    verdict.ts   # 100% PURE: parseVerdict (fail-safe) + verdictCounts (rubric-hash check)
    smoke.ts     # 100% PURE: parseSmoke (fail-safe) — the worker's post-merge production check
    gain.ts      # 100% PURE: computeGain (ledger + live snapshot + verdicts → metrics, rework, roster)
    surface.ts   # the one fs/cmux composition edge: fleetRows = workspaces ∩ .captain/ + feed + runStates + verdicts
    control.ts   # CmuxPort seam: realCmux(env) wraps the cmux CLI; tests pass a fake port
    commands.ts  # stateless status/approve/reject/gain + friendly-id resolution (resolveTargets)
    doctor.ts    # PURE buildChecks(deps) preflight + the `install` command
    format.ts    # TTY-aware colour, grouped status renderer, renderGain (display only)
    log.ts       # append-only ~/.claude/captain/log.jsonl (approve/reject/launch; `note` on both decisions)
```

## Gotchas

Each rule's full rationale is in `docs/architecture.md` § Gotchas in full.

- **ESM, bundler resolution**: extensionless relative imports (`./view`, not `./view.js`); tsdown bundles to `dist/`.
- **PURE means no filesystem, no subprocess** (`node:crypto` is fine). The pure list in `oxlint.config.ts` is the contract: adding a module here without adding it there writes a rule nobody enforces.
- **The verdict is fail-safe**: a missing/garbage `verdict.json` is "no verdict yet", and it gates the `✓ verified` label, never the merge.
- **A criterion has three states** (pass, fail, `na` with reason in `evidence`); the rubric pins `name` verbatim so a softened bar shows as a rename. Don't add a fourth state.
- **The plan criterion's `na` is a file-existence test** ("only when `.captain/plan.md` does not exist"); don't soften it to an arguable exemption.
- **Plan deviations are appended under `## Deviations`**, never merged in, and never framed around a commit: `.captain/` is in no commit.
- **Changing `rubric.ts` voids no in-flight verdict**: the hash is recomputed from each worktree's rubric on disk, which captain never rewrites.
- **`parseVerdict` accepts `ts` as a number or a quoted integer**; tolerate at the parser, don't also patch the rubric.
- **Fleet-memory headings match at line start** (`headingAt`), and `SKELETON` must never name a heading in its prose, or the rules silently drop from every brief.
- **`SKELETON` states no append policy**: `prompt.ts` owns it, because the skeleton is only written when the file is absent and can never be refreshed.
- **Never trust cmux's workspace status glyph** (it desyncs); trust `cmux top` run-state tags (`runStates`) and the feed's `resolved_at`.
- **The feed is the gate inventory**: filter `!resolved_at` and take the newest per cwd (`pendingGate`), so a stale item never reads as live.
- **`feed.exit_plan.reply` takes `{request_id, mode}`**, not `{id, approve}`; approve → `bypassPermissions`, reject → `deny`. Pinned by a wire test in `control.test.ts`.
- **Colour only on a TTY** (`useColor`): piped output and `--json` stay plain for parsing.
- **Friendly ids**: `approve`/`reject` take `tig-430` or substrings; an ambiguous ticket across repos must be passed as `${repo}-${ticket}`.
- **`.captain/` never reaches a diff**: `start` appends it to `.git/info/exclude`; it is also the membership marker `surface.ts` filters by.
- **Tests must not touch the real `$HOME`**: set `CAPTAIN_HOME`, `CAPTAIN_MEMORY_DIR` and `CAPTAIN_CONFIG` to temp paths and use a fake `CmuxPort` (no mocking library).
- **Pipeline order is correctness**: `/tidy` (review and fix in one pass) runs before `/pr-creator`. Pinned in `config.test.ts`.
- **A pipeline step is a `/skill` token or plain English**; plain English is how a step becomes conditional. Don't add a condition DSL.
- **Skills config is fail-safe**: `loadSkills` never throws; `"$defaults"` expands in place, and a non-empty list without it replaces the defaults.
- **No daemon, ever**: no watcher, pidfile or `state.json`; derive from cmux + the filesystem. `status --watch` is a foreground re-render, not a violation.
- **Behaviour parity**: `start` must preserve every mode — Linear fan-out, single Linear issue, donebear task (URL or bare UUID, fannable alongside Linear ids), free-form current-dir dispatch, `--repo-path`, the bare-token form, and `--print` for each. A blocked fan-out issue is skipped; a single blocked issue errors; `--print`/`--force` are unaffected.
- **codex is best-effort, claude is the gated default**: only claude produces the `ExitPlanMode` gate; don't wire `approve`/`reject` to codex.
- **Claude `--name` is the ticket slug; messaging is not a control plane**: keep `cmux send`/`approve`/`reject` and fleet memory, not `SendMessage`/`ListAgents`.

## Non-goals

Decided boundaries; the reasoning and audits are in `docs/architecture.md` § Gotchas in full.

- Anything from the AI-native SDLC playbook beyond the three plays already built (plan.md, plan contents, `gain.rework`): no `/security-review` step or criterion, SIEM streaming, egress/sandbox control, risk-tier enum, hooks/managed settings, LLM evals in CI, deploy/rollback tooling or per-environment autonomy (verifying in production after the human merge is in scope), captain-owned breach triggers, or Slack listeners.
- Captain reads trackers; it never writes them. `IssueSource` gains no write verb.
- No browser daemon and no graded UI criterion; browser checks are an opt-in `.skills` entry, kept out of `DEFAULT_SKILLS`.

## Env knobs

| Variable | Purpose |
|----------|---------|
| `LINEAR_API_KEY` | Linear issue fetch + screenshots (download gated on the issue's source) |
| `DONEBEAR_TOKEN` | donebear task fetch (`db_` key, read scope is enough) |
| `CAPTAIN_HOME` | data home: `log.jsonl` + fleet memory base |
| `CAPTAIN_MEMORY_DIR` | fleet memory override |
| `CAPTAIN_OPENSPEC_HOME` | base of the per-repo OpenSpec homes (default `~/.claude/captain/openspec`) |
| `CAPTAIN_SKILLS` | comma-separated pipeline steps, `$defaults` keeps the built-ins |
| `CAPTAIN_DATA_SCOPE` | overrides the data-scope guardrail |
| `CAPTAIN_MODEL` / `CAPTAIN_EFFORT` | agent `--model` (default `default`) / `--effort` (default `high`) |
| `CAPTAIN_AGENT` | `claude` (default) or `codex` |
| `CAPTAIN_CONFIG` / `XDG_CONFIG_HOME` | config.json path / config dir |
| `CAPTAIN_DEBUG=1`, `NO_COLOR` | stack traces, plain output |

`~/.config/captain/config.json` keys (all fail-safe): `.skills`, `.dataScope`, `.model`, `.effort`,
`.agent`, `.openspecHome`, `.agentEnv` (merged over `DEFAULT_AGENT_ENV`, which caps vitest workers at 2).
