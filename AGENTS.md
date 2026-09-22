# captain

One chat that runs coding agents locally. The `/captain` skill turns a Claude Code session into
the chat; the `captain` CLI is its hands. Tasks are plain markdown files in a project folder;
each started task gets a git worktree, a cmux workspace and a full harness (Claude Code, Codex or
Cursor). The board is derived live from cmux, git, GitHub and each worktree's `.captain/` files.
Nothing about progress is stored, so there is no daemon. The design and its reasoning are in
`docs/plans/captain-v3.md`; the history is in `research/`.

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
  cli.ts          # Commander entry: init | add | start | status | approve | reject | send | peek | review | done | drop | gain | install
  commands.ts     # every command, taking its world as Deps (env, stdout, ports) so tests run the real code
  task.ts         # PURE: the task file (frontmatter + contract body), parse/render, criteria, ids, otherVendor
  board.ts        # PURE: the grouping rule. rowOf(task, evidence) -> group + why + next command; WIP count. Start here.
  gate.ts         # PURE: pendingGate (the cmux feed -> a plan or question gate for a worktree)
  stats.ts        # PURE: computeGain over the task files + the log
  evidence.ts     # the fs/cmux/GitHub edge: gathers each active task's evidence, then board.ts decides
  project.ts      # the project folder: project.json, tasks/*.md, learnings.md, log.jsonl, its own git history
  github.ts       # the GithubPort: `gh pr list --head <branch>` -> PR state + CI rollup (rollup is pure)
  cmux.ts         # harnessCommand (claude | codex | cursor-agent launch lines), openWorkspace, cmux reachability
  prompt.ts       # the worker brief (<workflow>, <data-scope>, <finishing-protocol>, <fleet-memory>) and the review brief
  rubric.ts       # PURE: renderRubric -> .captain/rubric.md (definition of done) + rubricHash; the .captain/ paths
  memory.ts       # learnings.md (Rules + tail-capped Inbox) excerpt for briefs
  config.ts       # fail-safe config: skills pipeline, data scope, agent env, per-harness model/effort
  git.ts          # ensureWorktree (lock, prune, reuse), gitCommonDir
  source.ts       # THE TICKET-SOURCE SEAM: Linear and Done Bear registry used by `captain add`
  linear.ts donebear.ts issue.ts types.ts shell.ts errors.ts format.ts
  captain/
    control.ts    # the CmuxPort seam: realCmux(env) wraps the cmux CLI; tests pass a fake
    verdict.ts    # PURE: parseVerdict (fail-safe) + verdictCounts (rubric-hash check)
    log.ts        # append-only <project>/log.jsonl: add | start | approve | reject | review | done | drop
    doctor.ts     # `captain install`: pure buildChecks + skill install
skills/captain/   # the chat: SKILL.md + references/heartbeat.md + references/intake.md
```

## How it works

**Projects.** `captain init <name> --repo <path>` makes `~/captain/<name>/` (`CAPTAIN_DIR`
overrides the root): `project.json` (`repo`, `wip`, optional `bootstrap`), `tasks/`,
`learnings.md`, `log.jsonl`, and a git repo that `commit()` updates after each write.
Commands pick the project from `--project`, then `CAPTAIN_PROJECT`, then the only one there is;
anything ambiguous is an error. The project's `repo` is the only repo its worktrees branch from,
which removes v2's wrong-repo launches by construction.

**Tasks.** One file per task (`task.ts`). The chat edits them directly; commands write through
`writeTask`. `parseTask` is fail-safe: a bad enum value falls back to its default, never loses
the task. Ids are lowercase ticket ids (`tig-430`, `db-35a2097c`) or `t-<n>` for a message.
`add` copies a ticket's description, checklist and open blockers in; after that the file is the
record and captain never writes back to a tracker.

**Start.** Refuses a closed task, a task with a live worker, an open blocker, and a start past
the WIP limit (`inProgress(rows) >= project.wip`); `--force` overrides the last two. Then:
`ensureWorktree` (`<parent>/<repo>-<id>` on branch `<id>-<slug>`), `.captain/rubric.md`,
`.captain/brief.md`, `.captain/` appended to `.git/info/exclude`, and `cmux new-workspace` named
after the branch running `harnessCommand`. An `escalate` task always runs on Claude in plan mode
(`--permission-mode plan --allow-dangerously-skip-permissions`); everything else runs unattended
(`--dangerously-skip-permissions`, codex `--dangerously-bypass-approvals-and-sandbox`,
`cursor-agent --force`). The project `bootstrap` runs first in the same shell. Every launch gets
the agent env (test pool caps) plus `CAPTAIN_SLOT`.

**The board** (`status`, `evidence.ts` + `board.ts`). For each active task: the worker workspace
(by name = branch, else by cwd), its `cmux top` run state, the newest unresolved feed gate for the
worktree, the PR and CI via `gh`, the hash-checked verdict, the review file, and whether a
`<branch>:review` workspace is open. `rowOf` walks one rule, first match wins: merged, then
anything waiting on a human (plan, question, needs-input, failed verifier), then the open PR
(red CI, no CI, pending, no verdict, no review, failed review, ready). Each row carries `next`,
the one command that moves it forward, so the chat acts without parsing prose.

**Review.** `captain review` opens a second workspace in the same worktree running the other
vendor (`otherVendor`) on a review-only brief that writes `.captain/review.json`. READY TO MERGE
needs CI green, a passing verdict and a passing review.

## Gotchas

- **ESM, bundler resolution**: extensionless relative imports; `tsconfig` uses
  `moduleResolution: "Bundler"` and tsdown bundles to `dist/`.
- **PURE means no filesystem and no subprocess** (`node:crypto` is fine). The list in
  `oxlint.config.ts` is the contract: `task.ts`, `board.ts`, `gate.ts`, `stats.ts`,
  `captain/verdict.ts`, `rubric.ts`, `issue.ts`. A module documented as pure but missing there
  is a rule nobody enforces.
- **Status comes from evidence, never from an agent's word.** Don't add a path where a worker
  can mark itself done. A verdict counts only when its `rubricHash` matches the rubric as it is
  on disk now; a missing or garbage verdict or review reads as "none", never as a pass.
- **A PR with no CI checks is NEEDS YOU, not green** (`rollup` returns `none`). CI is part of
  done; a repo without it must never read as ready.
- **A criterion has three states.** `na: true` means it cannot apply to this diff, with the
  reason in `evidence`. It is neither a pass nor a failure. Don't add a fourth.
- **Plan deviations are APPENDED under `## Deviations` in `.captain/plan.md`**, never merged in.
  `.captain/` is excluded from git, so there is no history; rewriting would erase what was
  approved.
- **Memory headings are matched at LINE START** (`headingAt`), and `SKELETON` names no heading
  in its prose and states no append policy (`prompt.ts` owns that). Both were real bugs.
- **Never trust cmux's workspace status glyph.** The trusted signals are `cmux top` run-state
  tags (`runStates`) and the feed's `resolved_at`.
- **`feed.exit_plan.reply` takes `{request_id, mode}`**, where `request_id` is NOT the feed
  item's `id`. Approve is `bypassPermissions` (the gated launch allows it), reject is `deny`.
  Pinned by a wire test in `control.test.ts`; re-verify there after a cmux upgrade.
- **The review workspace shares the worker's cwd**, so worker lookup is by workspace name
  (the branch) first. Keep the `<branch>:review` naming in `reviewName`.
- **Tests never touch real `$HOME`**: set `CAPTAIN_DIR` and `CAPTAIN_CONFIG` to temp paths.
  `commands.test.ts` runs the real commands against a temp repo with an origin, a fake `cmux`
  binary on PATH, and in-memory CmuxPort and GithubPort. No mocking library.
- **The pipeline order is a correctness property.** `/tidy` (review plus fixes) runs before
  `/pr-creator`, so the PR carries fixes, not findings. Pinned in `config.test.ts`.
- **A pipeline step is a `/skill` token OR plain English.** Prose renders verbatim, which is
  how a step becomes conditional. Don't add a condition DSL.
- **Config is fail-safe**: `loadSkills`, `loadHarnessDefaults` and friends never throw. A bad
  file degrades to defaults. `"$defaults"` expands in place inside `.skills`.
- **No daemon.** The chat wakes itself (the skill's heartbeat) and every wake re-derives the
  board. If you find yourself persisting progress, derive it instead. The only persisted state
  is what a human or the chat decided: the task files and the log.
- **Trackers are read-only.** `add` reads Linear or Done Bear; nothing writes back. If a
  tracker needs updating, the chat or a worker does it with its own tools.
- **Messaging between sessions is not a control plane.** Workers are steered with
  `captain send` and gated with `approve`/`reject`, never Claude Code `SendMessage`.
- **Harness flags are unverified against live `cursor-agent`.** `--model`/`--force` match its
  documented CLI; confirm on first real use and pin a test if it changes.

## Env knobs

`CAPTAIN_DIR` (projects root, default `~/captain`) · `CAPTAIN_PROJECT` (default project) ·
`CAPTAIN_CONFIG` (config.json path; default `$XDG_CONFIG_HOME/captain/config.json`) ·
`CAPTAIN_SKILLS` (comma-separated pipeline, `$defaults` keeps the built-in steps) ·
`CAPTAIN_DATA_SCOPE` (overrides the data-scope guardrail) · `LINEAR_API_KEY` · `DONEBEAR_TOKEN` ·
`CAPTAIN_DEBUG=1` (stack traces) · `NO_COLOR`.

`config.json` keys (all fail-safe): `.skills` (string[]), `.dataScope` (string), `.agentEnv`
(string map merged over the `VITEST_MAX_FORKS/THREADS=2` defaults; `""` drops a key),
`.harness.<claude|codex|cursor>.model` / `.effort` (each harness's defaults; a task's own values
win).
