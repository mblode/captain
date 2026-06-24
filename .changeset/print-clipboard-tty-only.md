---
"cmux-captain": patch
---

`captain start --print` now copies the `cd` command to the clipboard only for an interactive terminal (TTY). Previously it ran `pbcopy`/`wl-copy`/`xclip` unconditionally, so piped runs, `--json`, the `/captain` skill driver, and the test suite all clobbered the real system clipboard (e.g. with a temp worktree path). Piped/automated runs now print the command without touching the clipboard.
