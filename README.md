<div align="center">

# [Captain](https://captain.blode.md)

**One chat that runs your coding agents: a task list, full harnesses in [cmux](https://cmux.com) worktrees, and only the decisions come back to you**

Tell it what you want, or hand it a ticket. It keeps the list, starts Claude Code, Codex or Cursor on each task in its own worktree, and brings you plans to approve and PRs to merge.

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

Setup, every command, and how a task gets from a message to a merged PR.

<p>
<a href="https://captain.blode.md">
<img alt="View docs" src=".github/assets/documentation.svg" width="200" />
</a>
</p>

## Install

You need [Node 24+](https://nodejs.org), with `git`, `gh`, `claude` and [cmux](https://cmux.com) on your PATH. `codex` and `cursor-agent` are optional extra harnesses.

```bash
npm install -g cmux-captain
captain install
```

`captain install` adds the skills the chat and workers need, then tells you what is missing.

## Quickstart

```bash
# A project: a task folder tied to one repo, with a WIP limit
captain init rebuild --repo ~/code/app --wip 4

# Then open Claude Code in its own cmux workspace and run /captain.
# Talk to it: "rebuild billing settings, same behaviour as the old app", "pick up TIG-430",
# "what needs me?". It runs the commands below for you.

captain add "rebuild billing settings"   # a task from a message (or: captain add TIG-430)
captain start t-1 --harness codex        # worktree + cmux workspace + agent
captain status                           # NEEDS YOU / READY TO MERGE / CAPTAIN'S MOVE / WORKING
captain review t-1                       # the other vendor reviews the PR
captain done t-1                         # close it once merged
```

## What you control

- **What gets started:** the chat shows you a card for every batch of tasks, with the harness and model it picked. Nothing starts before your yes.
- **Risky plans:** tasks touching auth, billing, data migrations or releases run in Claude Code plan mode and wait for `captain approve`.
- **How much is in flight:** `start` refuses past the WIP limit, because every started task is a PR you have to review.
- **The merge:** a task is READY TO MERGE only when CI is green, a fresh-context verifier passed its definition of done, and a model from the other vendor reviewed the PR. Merging stays yours.

## Notes

- Tasks are plain markdown files in `~/captain/<project>/tasks/`. The chat maintains them, and you can edit them.
- Status is derived live from cmux, git and GitHub every time. There is no daemon, so there is nothing to restart or go stale.
- Set `LINEAR_API_KEY` or `DONEBEAR_TOKEN` to add tasks from tickets.

## License

MIT

---

Crafted by [<img src="https://blode.co/avatar-circle.png" width="20" align="top" />](https://blode.co) [Matthew Blode](https://blode.co)
