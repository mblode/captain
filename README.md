<h1 align="center">captain</h1>

<p align="center">Conduct a fleet of <a href="https://cmux.com/">cmux</a> worktrees from one Claude Code session. Linear ticket to PR-ready, steered in plain language.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cmux-captain"><img src="https://img.shields.io/npm/v/cmux-captain.svg" alt="npm version"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

Run `/captain` from a Claude Code session and steer in plain language: _"fan out these tickets"_, _"what's blocked"_, _"approve all the plans"_, _"what's ready to merge"_. Each ticket gets its own worktree and a self-driving agent that takes it from plan to PR. The agents do the work, you make the calls.

## Install

```bash
npm install -g cmux-captain && captain install
```

`captain install` adds the skills the fleet needs (the `/captain` skill you drive, plus the `/pr-reviewer` → `/pr-creator` → `/pr-babysitter` skills each brief invokes) and checks your setup. It's idempotent — re-run it any time to re-check.

You need Node 22+, plus `git`, `claude`, and [`cmux`](https://cmux.com/) on your PATH. Set `LINEAR_API_KEY` to pull ticket details into each brief.

## Usage

Run `/captain` and ask for what you want:

| You say                       | Captain does                                          |
| ----------------------------- | ----------------------------------------------------- |
| "fan out TIG-430 and TIG-431" | a worktree + self-driving agent per issue             |
| "what's blocked"              | the live view, each gate shown with how to resolve it |
| "show me the plans"           | reads each pending plan and returns a decision card   |
| "approve all the plans"       | replies to every pending plan gate                    |
| "send 431 back: skip auth"    | rejects the plan and types the feedback to the agent  |

You stay in control of three gates: approving each plan, answering anything an agent asks, and the merge itself. Everything else flows on its own.

## The pipeline

Each agent's brief carries the whole software dev lifecycle and the agent self-drives it:

```text
plan → implement → /simplify → /pr-reviewer → /pr-creator → /pr-babysitter → verifier verdict
```

Plan, implement, and the verifier verdict are fixed (`status` derives from them); the skills in between are yours to configure — set `.skills` in `~/.config/captain/config.json`, or `CAPTAIN_SKILLS=/simplify,/pr-creator`. Each worktree gets a definition of done (`.captain/rubric.md`, from the Linear issue); the agent runs a fresh-context verifier against it and writes a verdict, so a pass surfaces as READY TO MERGE and a fail as NEEDS YOU. Captain itself keeps **no state** — every view is derived live from cmux and the worktrees, so there's no daemon to start or go stale.

See the [docs](docs/) for the full command and configuration reference.

## License

[MIT](LICENSE.md)
