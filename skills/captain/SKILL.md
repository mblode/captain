---
name: captain
description: Conduct a fleet of cmux worktrees — fan out Linear/donebear tickets as self-driving agents, then surface what needs you. Use when asked to "conduct my fleet", "fan out these tickets", "start this ticket", "run these on codex", "what's blocked across my agents", "approve all the plans", "check and approve plans", "show me the plans", "what's ready to merge", "start the captain", "run the dev loop", or "drain the queue".
---

# Captain

**IS:** the instrument a long-lived Claude Code driver session uses — you type
`/captain pick up the tickets` / `/captain check and approve plans`; this skill runs the
CLI. **IS NOT:** Claude/Cursor Projects, a cloud coordinator, or typing cmux keys to
approve a plan. The worker self-drives plan → implement → `/tidy` →
conditional UI steps → `/pr-creator` → `/pr-babysitter` → verdict. Merge stays with the
human.

Captain keeps **no state**. `status` derives from cmux + each worktree's `.captain/`.

## References

| Reference | Read when |
| --- | --- |
| [references/heartbeat.md](references/heartbeat.md) | A fleet is running and you need to poll |
| [references/auto-pickup.md](references/auto-pickup.md) | The user has **explicitly armed** `/captain loop` / "run the dev loop" / "drain the queue" |

## Mental model

- You are the driver. Workers self-drive. Do not send routine "continue" prompts.
- Claude workers have a real plan gate (`--permission-mode plan`). Codex has none —
  `approve`/`reject` do nothing there; the brief says plan then proceed.
- Definition of done is `.captain/rubric.md` (hashed). A passing `.captain/verdict.json`
  is a label, not a merge.
- Fleet memory is `~/.claude/captain/memory/<repo>/learnings.md`. Do not distill unless
  the human asked. Briefs already inject only a short Inbox tail.

## Pickup (from `linear-god` this is mandatory)

Your cwd is almost never the ticket's repo. **Never** `captain start` without
`--repo-path` from a driver session. The CLI also refuses a cwd named
`linear-god` (`error.type=DRIVER_CWD`) unless `--repo-path` is set — that is not
success.

1. Read the ticket (description, paths, linked PRs, `Repo & area` if present).
2. Group ids by repo. Honor skip lists (`skip tig-1008`).
3. Per repo: `captain start <ids…> --repo-path <abs> [--json]`. Frontier skips blocked
   tickets in a fan-out; a single blocked issue errors unless `--force`.
4. **Confirm each `started[].cwd` before any approve.** A worktree in the driver checkout
   can never pass its rubric.

`--print` writes the brief without launching. `--agent codex` is ungated. `--base <ref>`
stacks on a prerequisite branch.

`captain TIG-430` equals `captain start TIG-430` only when you already passed `--repo-path`
or you are in that repo.

## The loop

Poll once a fleet is running. Never ask the human whether to poll.

| You say | Run |
| --- | --- |
| "pick up the tickets" / "fan out all" / "skip tig-N" | Pickup recipe above (`--repo-path`, confirm `started[].cwd`). Honor skip lists |
| "status" / "what's blocked" / "what's ready" | Known run: `captain status <ticket…> --json`. Polling: add `--summary` (returns `counts`, `needsYou`, `ready`). Unfiltered `captain status` only when the request is fleet-wide. Copy `nextCommand` / `handle` from the row |
| "show me the plans" / "check and approve plans" | `captain status --needs --json` (or summary `needsYou` with `gate.kind=plan`). One read-only reviewer, at most 8 plans, 6k chars each, 24k total. Card quotes `## Decisions for the reviewer` verbatim, then `{ticket, scopeDrift, risk, recommendation}`. Then **one** AskUserQuestion. Approve is `captain approve <handle> --note "<card, one line>"`. Reject is `captain reject <handle> --note "…"`. Never `cmux send-key` to accept a plan |
| "approve all plans" | Same as above, one `approve --note` per gate. Bare `captain approve all` only on an explicit blanket instruction — it records no reasoning |
| "send 404 back: don't touch auth" | `captain reject tig-404 --note "…"` |
| "what's verified" / "what's been done" | READY in `status`; history in `captain gain --json` `roster`. Then `/eli5` if asked. Do not reconstruct from scrollback |
| "this one's gone quiet" | `cmux read-screen --workspace <id>` using the id from status. Nudge only after evidence of a stall: `cmux send` then `cmux send-key enter` |
| "Open TIG-N in cmux" | `status` row → `cmux read-screen --workspace <id>` (or the cmux skill). Not a plan approval |
| "start the loop" | Arm [heartbeat.md](references/heartbeat.md). Never hand polling back to the human |
| "distill the learnings" | Only if they asked. Edit `~/.claude/captain/memory/<repo>/learnings.md` |

**Codex:** do not call `approve`/`reject`. Track as IN FLIGHT until a verdict or a question.

## Gotchas

- **Wrong dir is the #1 silent failure.** Reroute: close the workspace (never a group
  anchor), `git worktree remove --force`, delete the branch, relaunch with `--repo-path`.
- **`CMUX_UNREACHABLE`:** `cmux ping` failed.
  - Socket refused / not running → start the **cmux app**. Do not `captain install`
    unless `cmux` is missing from PATH.
  - “cmux processes only” / Access denied → the driver is outside cmux (this is
    normal for `linear-god`). Ask the human to set cmux **Settings → Automation →
    Socket Control Mode → Automation mode**. Do not switch to Full open access.
- **Approve is `captain approve --note`, which speaks `feed.exit_plan.reply` `{request_id,
  mode}` (cmux ≥ 0.64.17).** That is what writes `log.jsonl`. If the CLI errors
  (`no plan-ready worktree`, no `request_id`, cmux unreachable), read the screen and
  report. `cmux send-key` to click the plan menu **does not** record a note — it is a last
  resort after a named CLI error, and you must say so.
- **`cmux send` can no-op** (text parked unsubmitted). After a *send* (not an approve),
  follow with `cmux send-key enter` and re-read.
- **Never approve without a card.** `--note` is the only reasoning `gain` can see.
- **Never guess off-script questions.** `cmux send` the answer, or `reject` if it is a plan.
- **Stops at PR-ready.** Merging stays with the human.
- **Never trust a one-line verdict.** Spot-read `verdict.json` criteria; `name` must match
  the rubric; `na` is not a pass.
- **`run=unknown`:** no live `cmux top` tag. Read the screen. Empty shell → rerun the
  original `captain start` including repo/base/agent. Never reconstruct from `prompt.txt`.
- **Never close an apparent duplicate workspace** — likely a group anchor.
- **Cap test workers.** Agents launch with `VITEST_MAX_THREADS/FORKS=2`. Briefs say
  `--maxWorkers=2`. Jest ignores env; uncapped repo config is still a hole.

## Reference

- CLI: `captain --help`. Pure core: `src/captain/view.ts`, `verdict.ts`.
- Low-level cmux: the [`cmux`](../cmux/SKILL.md) skill.
