<h1 align="center">captain</h1>

<p align="center">Run a fleet of <a href="https://cmux.com/">cmux</a> worktrees from one Claude Code session — Linear ticket to PR, steered in plain language.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cmux-captain"><img src="https://img.shields.io/npm/v/cmux-captain.svg" alt="npm version"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

Run `/captain` from a Claude Code session and ask for what you want — _"fan out these tickets"_, _"what's blocked"_, _"approve all the plans"_, _"what's ready to merge"_. Each ticket gets its own worktree and an agent that drives it from plan to PR. The agents do the work; you make the calls.

## Install

```bash
npm install -g cmux-captain && captain install
```

`captain install` adds the skills the fleet needs and checks your setup. You need Node 22+ and `git`, `claude`, and [`cmux`](https://cmux.com/) on your PATH. Set `LINEAR_API_KEY` to pull ticket details into each brief.

## How it works

Each agent gets a brief covering the whole job — plan, implement, review, open a PR — and drives it itself. You stay in control of three gates: approving each plan, answering anything an agent asks, and the merge. Everything else flows on its own.

You configure the review skills that run between implement and PR; the rest is fixed. Captain keeps no state — every view is derived live from cmux, so there's no daemon to start or go stale.

See the [docs](docs/) for the commands and configuration.

## License

[MIT](LICENSE.md)
