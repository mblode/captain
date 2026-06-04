# Troubleshooting

## Command Missing

```bash
cd ~/Code/mblode/linear-worktree
npm install
npm run build
npm link
command -v linear-worktree
```

`command -v linear-worktree` should resolve to the npm-linked TypeScript CLI, not `/Users/mblode/dotfiles/bin/linear-worktree`.

## Repo Detection Fails

Run from inside the target repo or pass:

```bash
linear-worktree --repo ~/Code/acme/web ENG-423
```

## Default Branch Fails

The source repo needs `origin/HEAD`:

```bash
git remote set-head origin --auto
```

## cmux Fan-out Fails

Confirm both commands are reachable:

```bash
command -v cmux
cmux ping
command -v claude
```

## Launch Fails

Use `--print` to validate worktree and prompt generation without launching:

```bash
linear-worktree --print ENG-423
```
