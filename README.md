<div align="center">

# Captain

**Drive a fleet of [cmux](https://cmux.com) worktrees from one session, Linear ticket to open PR**

Ask for what you want in plain language and every ticket gets its own worktree and an agent that plans it, builds it, and opens the PR.

<p align="center">
  <a href="https://www.npmjs.com/package/cmux-captain">
    <img src="https://img.shields.io/npm/v/cmux-captain?style=flat&colorA=000000&colorB=000000" />
  </a>
  <a href="https://github.com/mblode/captain/blob/main/LICENSE.md">
    <img src="https://img.shields.io/github/license/mblode/captain?style=flat&colorA=000000&colorB=000000" />
  </a>
</p>

</div>

## Install

```bash
npm install -g cmux-captain
```

## Quickstart

```bash
# Install the skills the fleet needs, then check your setup
captain install

# One worktree, one cmux workspace, and one agent per Linear issue
captain TIG-430 TIG-431

# The one view: NEEDS YOU / IN FLIGHT / READY, with the command to resolve each row
captain status

# Release a plan so its agent starts building
captain approve tig-430
```

From inside a Claude Code session, run `/captain` and steer the same fleet in plain language: fan out these tickets, what is blocked, approve all the plans, what is ready to merge.

## Commands

| Command                       | Description                                                     |
| ----------------------------- | --------------------------------------------------------------- |
| `captain TIG-430`             | Fan Linear issues out into a worktree and an agent each         |
| `captain "tidy the README"`   | Run a free-form task in the current checkout, no ticket needed  |
| `captain status`              | The live fleet, grouped by what it needs from you               |
| `captain approve tig-430`     | Approve a plan, a whole repo's plans, or `all`                  |
| `captain reject tig-430`      | Send a plan back to planning with `--note` feedback             |
| `captain gain`                | Fleet telemetry: the decisions ledger plus a live snapshot      |
| `captain install`             | Install the pipeline skills, then run the preflight checks      |

## What you control

- **The plan:** each agent presents a plan and waits. Nothing gets built until you approve it.
- **The questions:** an agent that needs an answer shows up under NEEDS YOU with the reply command.
- **The merge:** an agent opens the PR and stops there. Merging stays yours.

Everything between those gates is fixed: plan, implement, the review skills you configured, then a fresh-context verifier that has to pass the worktree's definition of done before the run counts as ready.

## Notes

- Node 22 or newer, with `git`, `claude`, and cmux on your PATH. `captain install` checks all of it and tells you what is missing.
- Set `LINEAR_API_KEY` to pull ticket details into each brief, or `DONEBEAR_TOKEN` to drive [Done Bear](https://donebear.com) tasks the same way.
- Pick the agent per run with `--agent claude` or `--agent codex`, or set a default with `CAPTAIN_AGENT`. Codex runs without a plan gate.
- Configure the review skills that run before the PR in `~/.config/captain/config.json` or with `CAPTAIN_SKILLS=/tidy,/pr-creator`.
- Captain keeps no state. Every view is derived live from cmux and the worktrees, so there is no daemon to start or go stale.
- Full command and configuration reference in the [docs](https://captain.blode.md).

## License

MIT

---

Crafted by [<img src="https://blode.co/avatar-circle.png" width="20" align="top" />](https://blode.co) [Matthew Blode](https://blode.co)
