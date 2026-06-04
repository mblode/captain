# Usage Modes

Use the smallest mode that matches the user's request.

## One Issue

```bash
linear-worktree ENG-423
```

Creates a sibling worktree, changes launch cwd to that worktree, and starts:

```bash
claude --dangerously-skip-permissions "<prompt>"
```

The prompt is Linear's issue context plus local screenshot paths when `LINEAR_API_KEY` is set.

## Many Issues

```bash
linear-worktree ENG-423 ENG-424 WEB-12
```

Every token must be a bare issue ID. The CLI creates one cmux workspace per issue. Each workspace runs `linear-worktree <id>`, so the worktree is created inside that workspace before Claude opens from the created worktree.

## Print Only

```bash
linear-worktree --print ENG-423
```

Use this for validation, review, or handoff. It creates the worktree, prints the prompt, copies the `cd` command when clipboard tooling exists, and does not launch Claude.

## ID Plus Slug

```bash
linear-worktree ENG-423 add launch mode
```

Treats the first token as the issue ID and the rest as the branch slug. This is single-issue mode, not fan-out.
