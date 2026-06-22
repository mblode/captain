<h1 align="center">captain</h1>

<p align="center">Conduct a fleet of <a href="https://cmux.com/">cmux</a> worktrees from one Claude Code session — Linear ticket to PR-ready, plain-language steering.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cmux-captain"><img src="https://img.shields.io/npm/v/cmux-captain.svg" alt="npm version"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

You run `/captain` from a long-lived Claude Code session and steer in plain language — _"fan out these tickets"_, _"what's blocked"_, _"show me the plans"_, _"approve all the plans"_, _"what's ready to merge"_. The skill is the steering wheel; the `cmux-captain` CLI underneath is the engine that owns the worktrees, Linear, and the fan-out. The child agents do the work, you make the calls.

- **Skill-driven steering:** the `/captain` skill turns plain requests into fleet actions, escalating only the decisions that are yours.
- **Self-driving agents:** each worktree gets a brief carrying the whole pipeline (plan → implement → `/simplify` → `/pr-reviewer` → `/pr-creator` → `/pr-babysitter` → verifier verdict) and drives it itself.
- **One live view:** `captain status` derives NEEDS YOU / IN FLIGHT / READY fresh from cmux signals and per-worktree `.captain/` files. No daemon, no stored state, nothing to desync.
- **Three human gates:** plan approval (implementation never starts un-approved), any question a blocked agent raises, and the merge itself.
- **Verdict gate:** each worktree gets a definition of done, and an agent's own verifier must pass it before a row reads READY TO MERGE.
- **Fleet memory:** verified learnings accumulate per repo at `~/.claude/captain/memory/<repo>/learnings.md` and feed into the next brief.

## Requirements

- Node.js >= 22
- `git`, `claude` ([Claude Code](https://claude.com/claude-code)), and [`cmux`](https://cmux.com/) on your PATH
- `LINEAR_API_KEY` (optional, pulls ticket details and screenshots into each brief)

## Install

```bash
npx skills add mblode/captain -g      # the /captain skill (what you drive)
npm install -g cmux-captain           # the CLI it runs underneath
npx skills add mblode/agent-skills -g # the review/PR skills the brief invokes
captain doctor                        # verify node, git, claude, cmux, the key, the skills
```

## Usage

Run `/captain` from a Claude Code session and ask for what you want:

| You say                              | Captain does                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| "fan out TIG-430 and TIG-431"        | a worktree + cmux workspace + self-driving agent per issue                       |
| "start on: tidy the README"          | a free-form task in the current checkout, no Linear, no worktree                 |
| "what's blocked / in flight / ready" | one live view: NEEDS YOU / IN FLIGHT / READY, each gate with its resolve command |
| "show me the plans"                  | a read-only subagent reads each gated plan and returns a decision card           |
| "approve all the plans"              | replies to every pending plan gate                                               |
| "send 431 back: don't touch auth"    | rejects the plan and types the feedback into the workspace                       |
| "what's verified"                    | READY rows carry `✓ verified` plus the verifier's summary                        |

The skill arms its own heartbeat with native Claude Code scheduling (ScheduleWakeup, cron, or `/loop`), polls status on each wakeup, and batches changed rows into a single question so you aren't interrupted per gate.

### The CLI underneath

Everything above maps to the `captain` CLI, which you can also drive directly:

```bash
captain start TIG-430 TIG-431                  # Linear issues → one worktree + agent each
captain start "tidy the README"                # a free-form task, no Linear, current dir
captain status                                 # what's blocked, in flight, and ready (--json to parse)
captain approve tig-430                         # or: captain approve all
captain reject tig-431 --note "don't touch auth"
```

`captain --help` lists every command and flag.

## How agents finish

Fan-out writes a definition of done into each worktree (`.captain/rubric.md`, derived from the Linear issue). The agent runs a fresh-context verifier against it and writes a verdict citing the rubric's hash: a valid pass shows READY TO MERGE + `✓ verified`, a fail shows NEEDS YOU with the verifier's summary. The verdict gates the label, never the merge, so merging and deploying stay with you.

## Development

```bash
npm run build      # tsdown → dist/
npm run test       # vitest
npm run typecheck  # tsc --noEmit
npm run check      # ultracite (lint + format)
```

## License

[MIT](LICENSE.md)
