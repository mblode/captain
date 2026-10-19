---
name: captain
description: Conduct a fleet of cmux agents from one driver session — write OpenSpec changes (Markdown in openspec/changes/), launch one self-driving agent per change on the current branch, then surface what needs you. Use when asked to "add this to the list", "write a change for…", "fan out the changes", "start this change", "run these on codex", "what's blocked across my agents", "approve all the plans", "check and approve plans", "show me the plans", "what's done", "start the captain", "run the dev loop", or "drain the queue".
---

# Captain

**IS:** the instrument a long-lived Claude Code driver session uses — you type
`/captain add this to the list` / `/captain start everything` / `/captain check and
approve plans`; this skill writes the specs and runs the CLI. **IS NOT:** a cloud
coordinator, a ticket tracker, or typing cmux keys to approve a plan.

The backlog is **OpenSpec**: each piece of work is a Markdown folder
`openspec/changes/<id>/` in the repo. No Linear. Every agent runs in **the same
checkout on its current branch** — no worktrees, no PRs. Workers self-drive plan →
implement → `/pr-reviewer` → `/tidy` → conditional UI steps → commit `[<id>] …` → push
to the branch → verdict.

Captain keeps **no state**. `status` derives from cmux + `.captain/changes/<id>/`
(rubric, plan, verdict, session id — git-excluded).

## References

| Reference | Read when |
| --- | --- |
| [references/heartbeat.md](references/heartbeat.md) | A fleet is running and you need to poll |
| [references/auto-pickup.md](references/auto-pickup.md) | The user has **explicitly armed** `/captain loop` / "run the dev loop" / "drain the queue" |

## Mental model

- You are the driver. Workers self-drive. Do not send routine "continue" prompts.
- Claude workers have a real plan gate (`--permission-mode plan`). Codex has none —
  `approve`/`reject` do nothing there; the brief says plan then proceed.
- Definition of done is `.captain/changes/<id>/rubric.md`, built from the change's
  open `tasks.md` boxes. A passing `verdict.json` is a label; the commits are already
  on the branch.
- Agents share one working tree and one index. The brief makes them commit only their
  own paths (`git commit -m "[<id>] …" -- <paths>`), never stash/reset/clean/switch
  branch, and `git pull --rebase --autostash` when a push is rejected. Two changes
  that edit the same files will still collide — keep concurrent changes disjoint.
- Fleet memory is `~/.claude/captain/memory/<repo>/learnings.md`. Do not distill unless
  the human asked.

## Writing a change ("add this to the list")

Run from the target repo (or pass `--repo-path`). Write the files directly — the
`openspec` CLI is optional; captain reads the Markdown itself.

1. Pick a kebab-case verb-led id: `add-dark-mode`, `fix-login-redirect`.
2. `openspec/changes/<id>/proposal.md`:
   ```markdown
   # Change: <title>

   ## Why
   <1–3 sentences: the problem or goal>

   ## What changes
   - <concrete behaviour change>

   ## Impact
   - Code: <paths/areas the agent should touch>
   ```
3. `openspec/changes/<id>/tasks.md` — each unchecked box becomes one rubric criterion,
   so make every box verifiable:
   ```markdown
   ## 1. Implementation
   - [ ] 1.1 <observable outcome>
   - [ ] 1.2 Tests cover <behaviour>
   ```
4. Optional: `design.md` for decisions, `specs/<capability>/spec.md` deltas
   (`## ADDED Requirements` / `### Requirement:` / `#### Scenario:`).
5. Keep changes that will run together on disjoint files. Say so if two overlap and
   offer to run them one after the other.
6. Do not launch unless asked. "Add to the list" means write it.

## Launch

- `captain spec <id…>` — one cmux workspace per change, in this checkout, on the
  current branch (refuses a detached HEAD).
- `captain spec --all` — every active change (not under `archive/`) without a live
  agent; already-running ones are skipped, so it is safe to rerun.
- `--repo-path <abs>` from a driver session whose cwd is not the repo. `--agent codex`
  is ungated. `--print` writes the brief without launching.
- Agents tick their boxes in `tasks.md` as they go. When a change is done and you are
  asked to archive it, `git mv openspec/changes/<id> openspec/changes/archive/<date>-<id>`
  (or `openspec archive <id>` if the CLI is installed) and commit.

## The loop

Poll once a fleet is running. Never ask the human whether to poll.

| You say | Run |
| --- | --- |
| "add this to the list" / "write a change for …" | [Writing a change](#writing-a-change-add-this-to-the-list). Do not launch |
| "start everything" / "fan out the changes" / "start <id>" | `captain spec --all` or `captain spec <id…>` (`--repo-path` if not in the repo). Honor skip lists by naming the ids |
| "status" / "what's blocked" / "what's ready" | Known run: `captain status <id…> --json`. Polling: add `--summary` (returns `counts`, `needsYou`, `ready`). Unfiltered `captain status` only when the request is fleet-wide. Copy `nextCommand` / `handle` from the row |
| "show me the plans" / "check and approve plans" | `captain status --needs --json` (or summary `needsYou` with `gate.kind=plan`). One read-only reviewer, at most 8 plans, 6k chars each, 24k total. Card quotes `## Decisions for the reviewer` verbatim, then `{change, scopeDrift, risk, recommendation}`. Then **one** AskUserQuestion. Approve is `captain approve <handle> --note "<card, one line>"`. Reject is `captain reject <handle> --note "…"`. Never `cmux send-key` to accept a plan |
| "approve all plans" | Same as above, one `approve --note` per gate. Bare `captain approve all` only on an explicit blanket instruction — it records no reasoning |
| "send dark-mode back: don't touch auth" | `captain reject add-dark-mode --note "…"` |
| "what's verified" / "what's been done" | READY in `status`; `git log --grep='\[<id>\]'` for the commits; history in `captain gain --json` `roster`. Then `/eli5` if asked. Do not reconstruct from scrollback |
| "this one's gone quiet" | `cmux read-screen --workspace <id>` using the id from status. Nudge only after evidence of a stall: `cmux send` then `cmux send-key enter` |
| "Open <id> in cmux" | `status` row → `cmux read-screen --workspace <id>` (or the cmux skill). Not a plan approval |
| "start the loop" | Arm [heartbeat.md](references/heartbeat.md). Never hand polling back to the human |
| "distill the learnings" | Only if they asked. Edit `~/.claude/captain/memory/<repo>/learnings.md` |

**Codex:** do not call `approve`/`reject`. Track as IN FLIGHT until a verdict or a question.

## Gotchas

- **Wrong dir is the #1 silent failure.** `captain spec` runs in the repo it resolves;
  from a driver session pass `--repo-path`. Confirm `started[].cwd` before approving.
- **`CMUX_UNREACHABLE`:** `cmux ping` failed.
  - Socket refused / not running → start the **cmux app**. Do not `captain install`
    unless `cmux` is missing from PATH.
  - “cmux processes only” / Access denied → the driver is outside cmux (this is
    normal for a driver launched outside cmux). Ask the human to set cmux **Settings → Automation →
    Socket Control Mode → Automation mode**. Do not switch to Full open access.
- **Approve is `captain approve --note`, which speaks `feed.exit_plan.reply` `{request_id,
  mode}` (cmux ≥ 0.64.17).** That is what writes `log.jsonl`. If the CLI errors
  (`no plan-ready` workspace, no `request_id`, cmux unreachable), read the screen and
  report. `cmux send-key` to click the plan menu **does not** record a note — it is a last
  resort after a named CLI error, and you must say so.
- **`cmux send` can no-op** (text parked unsubmitted). After a *send* (not an approve),
  follow with `cmux send-key enter` and re-read.
- **Never approve without a card.** `--note` is the only reasoning `gain` can see.
- **Never guess off-script questions.** `cmux send` the answer, or `reject` if it is a plan.
- **Pushes go straight to the branch.** There is no PR gate; review the plan carefully
  and spot-read the `[<id>]` commits. Rewinding is `git revert`, never a force-push.
- **Never trust a one-line verdict.** Spot-read `verdict.json` criteria; `name` must match
  the rubric; `na` is not a pass.
- **`run=unknown`:** no live `cmux top` tag. Read the screen. Empty shell → rerun
  `captain spec <id>` (with `--repo-path`/`--agent` as before). Never reconstruct from `prompt.txt`.
- **Never close an apparent duplicate workspace** — likely a group anchor.
- **Cap test workers.** Agents launch with `VITEST_MAX_THREADS/FORKS=2`. Briefs say
  `--maxWorkers=2`. Jest ignores env; uncapped repo config is still a hole.

## Reference

- CLI: `captain --help`. Pure core: `src/captain/view.ts`, `verdict.ts`.
- Low-level cmux: the [`cmux`](../cmux/SKILL.md) skill.
