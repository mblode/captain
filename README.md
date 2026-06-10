# captain

Run a fleet of [cmux](https://cmux.com/) worktrees, one per Linear ticket.

`captain fanout` opens a worktree per issue and gives each agent a brief covering the whole job:
plan, implement, review, and open a PR. Each agent runs it on its own. `captain status` then
shows what's blocked, in flight, and ready to merge.

Captain never approves a plan, answers a question, or merges for you. You do that with `captain
approve`, `captain reject`, and your usual `git`/`gh`.

## Requirements

- Node.js >= 22
- `git`, `claude` ([Claude Code](https://claude.com/claude-code)), and
  [`cmux`](https://cmux.com/) on your PATH
- A `LINEAR_API_KEY` (optional, but it pulls ticket details and screenshots into each brief)

## Install

```bash
npm i -g cmux-captain        # puts `captain` on your PATH
```

The pipeline runs on skills, so install those too:

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

`status` reads everything fresh from cmux and the worktrees each run, so there's no daemon to
start and nothing to keep in sync.

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
Linear issue). Before marking a ticket done, the agent runs a fresh-context verifier against it
and writes `.captain/verdict.json` with the rubric's hash. A pass shows READY TO MERGE plus the
merge command; a fail shows NEEDS YOU with the verifier's summary. Edit the rubric afterwards and
the hash stops matching, so the verdict is void.

Each repo keeps a fleet memory file (`~/.claude/captain/memory/<repo>/learnings.md`). Agents
append verified learnings, and fan-out feeds them into the next brief.

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
