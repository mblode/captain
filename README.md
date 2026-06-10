# captain

Captain a fleet of [cmux](https://cmux.com/) worktrees from one Claude Code session, one worktree
per Linear ticket.

Each worktree runs its own agent on a brief covering the whole job: plan, implement, review, open
a PR. From your captain session you watch them all with `captain status`, approve their plans,
and answer what they're blocked on. The child agents do the work; you steer.

## Requirements

- Node.js >= 22
- `git`, `claude` ([Claude Code](https://claude.com/claude-code)), and
  [`cmux`](https://cmux.com/) on your PATH
- `LINEAR_API_KEY` (optional, pulls ticket details and screenshots into each brief)

## Install

```bash
npm i -g cmux-captain                 # the CLI
npx skills add mblode/captain -g      # the captain skill
npx skills add mblode/agent-skills -g # the PR skills the brief runs
captain doctor                        # check your setup
```

## Use

```bash
captain fanout TIG-430 TIG-431        # one worktree + agent per issue
captain status                        # what's blocked, in flight, and ready
captain approve --plans tig-430       # or --plans all
captain reject --ref tig-431 --note "don't touch auth"
captain notify                        # optional: toast when something needs you
```

`captain --help` lists every command and flag.

## How agents finish

Each worktree gets a definition of done (`.captain/rubric.md`, from the Linear issue). The agent
runs a verifier against it and writes a verdict: a pass shows READY TO MERGE, a fail shows NEEDS
YOU. Verified learnings are saved per repo and fed into the next brief.

## Development

```bash
npm run build      # tsdown → dist/
npm run test       # vitest
npm run typecheck  # tsc --noEmit
npm run check      # ultracite (lint + format)
```

## License

[MIT](LICENSE.md)
