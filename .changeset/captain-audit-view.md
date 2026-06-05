---
"captain": minor
---

Add `captain audit`: a governance trail over the append-only history log. It renders every advance, gate, and human approve/reject chronologically — with the actor (watcher vs. you), the stage flow, and the slash command sent — and narrows by recency (`--since 2h`/`1d`) or worktree (`--ref tig-430`), with `--json` for piping. Read-only over the existing `history.jsonl` (no new state); the `filterHistory` helper stays pure for unit testing.
