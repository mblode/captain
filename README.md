<h1 align="center">captain</h1>

<p align="center">Conduct a fleet of <a href="https://cmux.com/">cmux</a> worktrees from one Claude Code session. Linear ticket to PR-ready, steered in plain language.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cmux-captain"><img src="https://img.shields.io/npm/v/cmux-captain.svg" alt="npm version"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

Run `/captain` from a Claude Code session and steer in plain language: _"fan out these tickets"_, _"what's blocked"_, _"approve all the plans"_, _"what's ready to merge"_. Each ticket gets its own worktree and a self-driving agent that takes it from plan to PR. The agents do the work, you make the calls.

## Install

```bash
npx skills add mblode/captain -g      # the /captain skill (what you drive)
npm install -g cmux-captain           # the CLI it runs underneath
npx skills add mblode/agent-skills -g # the review/PR skills the brief invokes
captain doctor                        # check your setup
```

You need Node 22+, plus `git`, `claude`, and [`cmux`](https://cmux.com/) on your PATH. Set `LINEAR_API_KEY` to pull ticket details into each brief.

## Usage

Run `/captain` and ask for what you want:

| You say                       | Captain does                                              |
| ----------------------------- | -------------------------------------------------------- |
| "fan out TIG-430 and TIG-431" | a worktree + self-driving agent per issue                |
| "what's blocked"              | the live view, each gate shown with how to resolve it    |
| "show me the plans"           | reads each pending plan and returns a decision card      |
| "approve all the plans"       | replies to every pending plan gate                       |
| "send 431 back: skip auth"    | rejects the plan and types the feedback to the agent     |

You stay in control of three gates: approving each plan, answering anything an agent asks, and the merge itself.

## License

[MIT](LICENSE.md)
