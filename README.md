<h1 align="center">captain</h1>

<p align="center">Run a fleet of <a href="https://cmux.com/">cmux</a> worktrees from one Claude Code session. Linear ticket to PR, steered in plain language.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cmux-captain"><img src="https://img.shields.io/npm/v/cmux-captain.svg" alt="npm version"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

Run `/captain` from a Claude Code session and ask for what you want: "fan out these tickets", "what's blocked", "approve all the plans", "what's ready to merge". Each ticket gets its own worktree and an agent that drives it from plan to PR.

## Install

```bash
npm install -g cmux-captain && captain install
```

`captain install` adds the skills the fleet needs and checks your setup. You need Node 22+ and `git`, `claude`, and [`cmux`](https://cmux.com/) on your PATH. Set `LINEAR_API_KEY` to pull ticket details into each brief.

## How it works

Each agent gets a brief covering the whole job: plan, implement, review, open a PR. You control three gates: approving each plan, answering questions, and the merge.

You configure the review skills that run between implement and PR; the rest is fixed. Captain keeps no state. Every view is derived live from cmux, so there is no daemon to start or go stale.

See the [docs](https://captain.blode.md) for the commands and configuration.

## License

[MIT](LICENSE.md)

---

Crafted by [<img src="https://matthewblode.com/avatar-sm.png" width="20" align="top" />](https://matthewblode.com) [Matthew Blode](https://matthewblode.com)
