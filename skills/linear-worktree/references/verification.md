# Verification

## Static Checks

Run from `~/Code/mblode/linear-worktree`:

```bash
npm run build
npm run typecheck
npm run lint
npm run test
```

## Global Install

```bash
npm link
command -v linear-worktree
linear-worktree --version
linear-worktree --help
```

## Safe Behavior Check

In a temp or disposable git repo with `origin/HEAD` set:

```bash
linear-worktree --print TST-123
```

Confirm:

- sibling worktree exists
- branch is `tst-123`
- fallback prompt prints
- Claude does not launch

## Live Checks

Only after static and safe checks pass:

- One real issue launch in a known-safe repo
- One small multi-ID fan-out with cmux reachable
- Read one spawned workspace and confirm Claude starts from the created worktree
