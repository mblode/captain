# Evaluation Scenarios

Use these scenarios when changing the skill or CLI.

## Scenario 1: Single Issue

Query:

```text
linear-worktree ENG-423
```

Expected behavior:

- Confirms `linear-worktree` is installed if needed
- Runs one-issue mode
- Creates a sibling worktree
- Launches Claude with `--dangerously-skip-permissions`
- Starts Claude from the worktree directory

## Scenario 2: Safe Validation

Query:

```text
test linear-worktree without launching Claude
```

Expected behavior:

- Uses `linear-worktree --print <id>`
- Verifies worktree and branch
- Does not use live cmux or Claude

## Scenario 3: Multi-Issue Fan-out

Query:

```text
spin up ENG-423 ENG-424 WEB-12
```

Expected behavior:

- Uses multi-ID mode
- Resolves repo per issue
- Creates one cmux workspace per issue
- Does not manually reimplement the worktree logic
