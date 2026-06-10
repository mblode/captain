# captain

Run a fleet of [cmux](https://cmux.com/) worktrees, one per Linear ticket.

`captain fanout` opens a worktree per issue and gives each agent a brief with the whole pipeline:
plan → implement → `/simplify` → `/pr-reviewer` → `/pr-creator` → `/pr-babysitter` → verifier
verdict. Each agent runs that brief on its own. `captain status` reads cmux to show what's
blocked, what's in flight, and what's ready to merge. It keeps no daemon and no saved state.

Captain never approves a plan, answers a question, or merges a PR for you. Those are left to
`captain approve`, `captain reject`, and your own `git`/`gh`.

## Requirements

- Node.js >= 22
- `git`, `claude` ([Claude Code](https://claude.com/claude-code)), and
  [`cmux`](https://cmux.com/) on your PATH
- A `LINEAR_API_KEY` (optional, but it pulls ticket details and screenshots into each brief)

## Install

```bash
npm i -g cmux-captain        # puts `captain` on your PATH
```

The agents' pipeline runs on skills, so install those too:

```bash
# the captain skill (teaches Claude Code to run this CLI)
npx skills add mblode/captain -g

# the PR skills the brief runs: /pr-reviewer, /pr-creator, /pr-babysitter.
# Without them that part of the pipeline does nothing.
# (/simplify ships with Claude Code, so there's nothing to install.)
npx skills add mblode/agent-skills -g
```

Then check your setup:

```bash
captain doctor               # checks node, git, claude, cmux, LINEAR_API_KEY, and the skills
```

`doctor` exits non-zero if a required tool is missing and prints the fix for each gap.

<details>
<summary>Install from source instead</summary>

```bash
git clone https://github.com/mblode/captain.git
cd captain
npm install && npm run build && npm link
```

</details>

## Quick start

```bash
# 1. Fan out: a worktree + self-driving agent per issue
captain fanout TIG-430 TIG-431 TIG-449

# 2. See what needs you, with the command to clear each gate inline
captain status                          # NEEDS YOU first, then in flight, then ready
captain approve --plans tig-430,tig-431 # or --plans all
captain reject  --ref tig-449 --note "don't touch auth"

# 3. Optional: toasts on new gates, fresh verdicts, and quiet worktrees
captain notify                          # foreground; Ctrl-C stops. --once for a single pass
```

`status` reads its signals fresh each run, so there's no daemon to start or restart:

| Signal                | Source                                                   |
| --------------------- | -------------------------------------------------------- |
| fleet membership      | cmux workspaces whose worktree has a `.captain/` dir     |
| busy / idle           | `cmux top` per-workspace run-state tags                  |
| gates (plan/question) | the newest unresolved `cmux` feed item per worktree      |
| done (`✓ verified`)   | `.captain/verdict.json`, hash-checked against the rubric |

## Commands

| Command                                    | What it does                                                 |
| ------------------------------------------ | ------------------------------------------------------------ |
| `captain doctor`                           | check prerequisites: node, git, claude, cmux, key, skills    |
| `captain fanout <ISSUE-ID…>`               | worktree + workspace + self-driving agent per Linear issue   |
| `captain status [--json] [--repo <name>]`  | the one view: NEEDS YOU / IN FLIGHT / READY, gates inline    |
| `captain approve --plans <tickets\|all>`   | reply to plan gate(s) so the agent starts implementing       |
| `captain reject --ref <ticket> --note "…"` | reply false and type the feedback into the agent's workspace |
| `captain notify [--once]`                  | foreground poller: toast on gates, verdicts, quiet worktrees |

Use friendly ticket names (`tig-430`), not UUIDs. `fanout` also takes `--print` (preview the
brief without launching) and `--base <ref>` (stack on a prerequisite branch). Run
`captain --help` for everything.

## How agents finish

Fan-out writes a definition of done into each worktree (`.captain/rubric.md`, generated from the
Linear issue). Before marking a ticket done, the agent runs a fresh-context verifier against that
rubric and writes `.captain/verdict.json` citing the rubric's hash. Edit the criteria afterwards
and the verdict no longer matches, so it's void. A pass shows the worktree as READY TO MERGE with
the PR's merge command; a fail shows NEEDS YOU with the verifier's summary.

Each repo also has a fleet memory file (`~/.claude/captain/memory/<repo>/learnings.md`). Agents
append verified learnings to it, and fan-out includes them in the next brief.

## Development

```bash
npm run build      # tsdown → dist/
npm run test       # vitest
npm run typecheck  # tsc --noEmit
npm run check      # ultracite (lint + format, CI-equivalent)
npm run fix        # ultracite fix
```

## License

[MIT](LICENSE.md)
