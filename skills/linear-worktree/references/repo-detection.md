# Repo Detection

The CLI chooses a repo per issue. First match wins:

1. `--repo <path>`
2. Current git repo (the directory you run the command from)

If neither resolves, the CLI errors. Run it from inside the target repo, or
pass `--repo <path>` when you're outside it.

## Worktree Location

Worktrees are siblings of the resolved repo:

```text
~/Code/acme/web      -> ~/Code/acme/web-eng-423
~/Code/acme/api       -> ~/Code/acme/api-web-12
```

Do not create nested worktrees inside the source repo.
