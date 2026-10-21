<div align="center">

# [Captain](https://captain.blode.md)

**Drive a fleet of [cmux](https://cmux.com) worktrees from one session, Linear ticket to open PR**

Ask for what you want in plain language. Every ticket gets its own worktree and an agent that plans it, builds it, and opens the PR.

<p align="center">
  <a href="https://www.npmjs.com/package/cmux-captain">
    <img src="https://img.shields.io/npm/v/cmux-captain?style=flat&colorA=000000&colorB=000000" />
  </a>
  <a href="https://github.com/mblode/captain/blob/main/LICENSE.md">
    <img src="https://img.shields.io/github/license/mblode/captain?style=flat&colorA=000000&colorB=000000" />
  </a>
</p>

</div>

## Docs

Setup, every command, the pipeline each agent runs, and how a worktree gets to ready.

<p>
<a href="https://captain.blode.md">
<img alt="View docs" src=".github/assets/documentation.svg" width="200" />
</a>
</p>

## Install

You need [Node 22+](https://nodejs.org), with `git`, `claude`, and [cmux](https://cmux.com) on your PATH.

```bash
npm install -g cmux-captain
captain install
```

`captain install` adds the skills the fleet needs, then tells you what is missing.

## Quickstart

```bash
# One worktree, one cmux workspace, and one agent per Linear issue
captain TIG-430 TIG-431

# The one view: NEEDS YOU / IN FLIGHT / READY, with the command to resolve each row
captain status

# Release a plan so its agent starts building
captain approve tig-430
```

### OpenSpec on one branch

No tracker and no worktrees: write each piece of work as an [OpenSpec](https://github.com/Fission-AI/OpenSpec) change (`openspec/changes/<id>/proposal.md` + `tasks.md`), then launch one agent per change in the current checkout. Your changes live outside the repo, in its OpenSpec home (`captain spec --root`, under `~/.claude/captain/openspec/`), so no OpenSpec file is ever committed. A change already in the repo's own `openspec/` still runs, read-only. Each agent commits `[<id>] …` with only its own paths and pushes to the current branch. The open `tasks.md` boxes become the definition of done.

Done means verified in production. After its verdict passes, the agent waits for you to merge. Then it watches the deploy and runs the `## Smoke test` checks from `tasks.md` in production. On a pass it archives the change in the home. `status` shows SHIPPING while the smoke test runs and DONE once it passed. A failed smoke test lands in NEEDS YOU.

```bash
home="$(captain spec --root)"; mkdir -p "$home" && cd "$home"   # the repo's OpenSpec home
openspec init --tools none && openspec new change add-dark-mode  # init once, then write changes
cd - && captain spec add-dark-mode fix-login-redirect            # or: captain spec --all
captain status
```

From inside a Claude Code session, run `/captain` and steer the same fleet in plain language: fan out these tickets, what is blocked, approve all the plans, what is ready to merge.

## What you control

- **The plan:** each agent presents a plan and waits. Nothing gets built until you approve it.
- **The questions:** an agent that needs an answer shows up under NEEDS YOU with the reply command.
- **The merge:** an agent opens the PR and stops there. Merging stays yours. An OpenSpec agent waits for your merge, then checks production.

Everything between those gates is fixed: plan, implement, the review skills you configured, then a fresh-context verifier that has to pass the worktree's definition of done before the run counts as ready.

## Notes

- Set `LINEAR_API_KEY` to pull ticket details into each brief, or `DONEBEAR_TOKEN` to drive [Done Bear](https://donebear.com) tasks the same way.
- Pick the agent per run with `--agent claude` or `--agent codex`. Codex runs without a plan gate.
- Captain keeps no state. Every view is derived live from cmux and the worktrees, so there is no daemon to start or go stale.

## License

MIT

---

Crafted by [<img src="https://blode.co/avatar-circle.png" width="20" align="top" />](https://blode.co) [Matthew Blode](https://blode.co)
