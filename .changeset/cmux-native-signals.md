---
"captain": minor
---

Replace the watcher's two screen-scrapes with cmux-native structured signals (verified live on cmux 0.64.14). The pre-send busy check now reads the per-workspace run-state tag from `cmux top --all --flat --format tsv` (`Running` / `Needs input` / `Idle` — process accounting, not the desync-prone workspace status glyph), and the gate hint now comes from the workspace's newest unresolved `question`/`notification` item in `cmux rpc feed.list` (`question_prompt`/`text`, matched by cwd). `CmuxPort` gains `runState(workspaceId)`; feed items carry `question_prompt`, `text`, and `resolved_at`. The old BUSY/PROSE scrapes stay as automatic fallbacks (an `unknown` run-state or an empty feed) and `CAPTAIN_SCRAPE=1` forces scrape-only for one release before they're deleted.
