# Drive Spawned Workspaces

After fan-out, use cmux tools to inspect and drive each workspace. Do not start duplicate sessions.

## Inspect

```bash
cmux read-screen --workspace <workspace> --lines 40
```

Look for whether Claude is asking a question, presenting a plan, or ready for implementation.

## Answer

```bash
cmux send --workspace <workspace> "answer text\n"
cmux send-key --workspace <workspace> down
cmux send-key --workspace <workspace> enter
```

Use free text for clarifying questions. Use key presses for selecting plan options when the UI presents a menu.

## Ship

When a workspace has completed the requested implementation:

```bash
cmux send --workspace <workspace> "commit and open a PR\n"
```

Read the relevant ticket and local screenshots before answering questions for a spawned workspace.
