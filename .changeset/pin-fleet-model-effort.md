---
"cmux-captain": minor
---

Pin each fleet agent's model and effort at launch so it never inherits the driver's ambient tier. Both launch paths (`cmux` fan-out and the inline plan-mode fallback) now pass `--model`/`--effort` to `claude`, defaulting to `default` / `high` (`default` resolves to the machine's configured default model). Override per fleet with `CAPTAIN_MODEL` / `CAPTAIN_EFFORT` or the config-file `.model` / `.effort` keys (fail-safe, same precedence as `.skills` / `.dataScope`).
