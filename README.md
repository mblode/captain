# captain

Dispatch a fleet of [cmux](https://cmux.com/) worktrees from Linear ticket to PR-ready, then
surface the few decisions that are yours. `captain fanout` gives each agent a brief carrying the
whole pipeline (plan → implement → `/simplify` → `/pr-reviewer` → `/pr-creator` →
`/pr-babysitter` → verifier verdict) and the agent drives it itself. Captain keeps **no state**
— `status` is derived live from cmux signals and per-worktree verdict files.

- **Agents self-drive** — the pipeline lives in each agent's brief; nothing puppeteers them.
- **Stateless status** — derived fresh from cmux + the filesystem every call; it can never desync.
- **Batched gates** — every plan approval and question is surfaced to you, never auto-decided.
- **Verified, then stops at PR-ready** — `✓ verified` requires a hash-checked verifier verdict;
  merging and deploying stay with you (no auto-merge).

Built on [`linear-worktree`](https://github.com/mblode/linear-worktree) — its fan-out is the
`captain fanout` command; captain is the dispatch-and-surface layer on top.

## Install

Not yet published to npm. From a checkout of this repo:

```bash
npm install && npm run build && npm link   # puts `captain` on your PATH
```

To install the paired agent skill (teaches Claude Code and other agents to drive this CLI):

```bash
npx skills add mblode/captain -g
```

Requires Node ≥ 22 and `git`, `claude`, [`cmux`](https://cmux.com/) on your PATH. Set
`LINEAR_API_KEY` to pull ticket details into each agent's brief.

## Quick start

```bash
# 1. Fan out — a worktree + self-driving agent per issue
captain fanout TIG-430 TIG-431 TIG-449

# 2. Surface what needs you — one view, with the command to resolve each gate inline
captain status                          # NEEDS YOU first, then in-flight, then ready
captain approve --plans tig-430,tig-431 # or --plans all
captain reject  --ref tig-449 --note "don't touch auth"

# 3. Optional: toasts on new gates, fresh verdicts, and quiet worktrees
captain notify                          # foreground; Ctrl-C stops. --once for a single pass
```

`status` derives everything live, so there is no daemon to start or restart:

| Signal                | Source                                                   |
| --------------------- | -------------------------------------------------------- |
| fleet membership      | cmux workspaces whose worktree has a `.captain/` dir     |
| busy / idle           | `cmux top` per-workspace run-state tags                  |
| gates (plan/question) | the newest unresolved `cmux` feed item per worktree      |
| done (`✓ verified`)   | `.captain/verdict.json`, hash-checked against the rubric |

## Commands

| Command                                    | What it does                                                 |
| ------------------------------------------ | ------------------------------------------------------------ |
| `captain fanout <ISSUE-ID…>`               | worktree + workspace + self-driving agent per Linear issue   |
| `captain status [--json] [--repo <name>]`  | the one view: NEEDS YOU / IN FLIGHT / READY, gates inline    |
| `captain approve --plans <tickets\|all>`   | reply to plan gate(s) → the agent implements                 |
| `captain reject --ref <ticket> --note "…"` | reply false and type the feedback into the agent's workspace |
| `captain notify [--once]`                  | foreground poller: toast on gates, verdicts, quiet worktrees |

Targets accept friendly ticket names (`tig-430`), not UUIDs. Run `captain --help` for the full
workflow.

## How agents finish

Fan-out writes a definition of done into each worktree (`.captain/rubric.md`, derived
mechanically from the Linear issue). Before declaring a ticket done, the agent must run a
fresh-context verifier sub-agent against it and write `.captain/verdict.json` citing the
rubric's hash — editing the criteria after the fact voids the verdict. A valid pass shows the
worktree as READY TO MERGE with the PR's merge command; a fail surfaces as NEEDS YOU with the
verifier's summary. Per-repo fleet memory (`~/.claude/captain/memory/<repo>/learnings.md`)
feeds verified learnings from past runs into every new brief.

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
