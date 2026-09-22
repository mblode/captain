# Captain v3: implementation notes

Kept next to `captain-v3.md`. Log every deviation from the plan here as it happens, and record how the run ended.

## Deviations

- Plan said: branches named `t/<id>-<slug>`.
  Code required: `ensureWorktree` already names branches `<id>-<slug>` and handles reuse and locking.
  Taken: kept `<id>-<slug>`. Evidence lookup is by branch name either way.
- Plan said: the chat runs the cross-vendor review as part of what "done" means.
  Code required: a review needs its own evidence file for the board to read, and its own workspace so it doesn't collide with the worker.
  Taken: `captain review <id>` opens `<branch>:review` running the other vendor on a review-only brief that writes `.captain/review.json`. READY TO MERGE requires it.
- Plan said: the WIP limit counts PRs waiting on you.
  Code required: counting only open PRs lets unlimited workers run before any PR exists.
  Taken: WIP counts every started task that isn't merged yet. Each one becomes a PR you'll review.
- Plan said: the chat re-prompts stalled workers.
  Code required: `captain send` needs something to read first.
  Taken: added `captain peek <id>` (the end of the worker's screen), plus `done`, `drop` and a new `gain` over the task files and log.
- Plan said: harness defaults come from the bake-off.
  Taken: until then, low-risk tasks default to `codex`, escalate tasks always run on `claude`, and each harness's model and effort default is configurable under `.harness` in `config.json`.
- Checked 22 Sep (not run live): every flag Captain launches with exists in Claude Code 2.1.280 and Codex 0.156.0 `--help`, and in the Cursor CLI parameter docs. The Cursor binary is now `agent`, not `cursor-agent`, so Captain defaults to `agent` with a `bin` override in config.
- GPT-6 Sol and Luna shipped 22 Sep (`gpt-6-sol`, `gpt-6-luna`; $2/$10 and $0.10/$0.50 per M tokens). Codex workers now pin `gpt-6-sol` by default, reviews default to high effort, and GPT-6 Sol replaces Astra as Claude's default reviewer. There is no cmux in this environment, so the three live Phase 0 proofs are still open.
- No backwards compatibility (per the user): the v2 fan-out, dispatch, bare-token routing, `--agent`, `--repo-path`, `status --summary/--since/--watch`, and the `~/.claude/captain` log and memory are deleted, not ported.

## How the run ended

The capability exists on the real code path, and 203 tests pass, including `commands.test.ts`. That file runs `init`, `add`, `start`, `status`, `approve`, `reject`, `send`, `peek`, `review` and `done` against a real temp git repo with an origin, a fake `cmux` binary, and in-memory cmux and GitHub ports. The CLI binary was also smoke-tested: `init`, `add`, `status`, `start --print`, and the JSON error when cmux is missing.

Still open: the three live Phase 0 proofs.
1. One real task goes from a chat message to a merged PR.
2. Killing the chat mid-run loses nothing.
3. `start` refuses at the WIP limit, in a real cmux session.
