# Change: Keep plan and question gates visible after their feed item expires

## Why
cmux expires a feed item about 2 minutes after it lands. The agent then waits on its own
plan or question menu, but `captain status` showed the row as "working" and
`captain approve` failed with "no plan-ready worktree matches". Plans sat unapproved, and
the only way through was a raw `cmux send-key enter` that records no note.

## What changes
- `status` reads the screen of each workspace that has no live feed gate and treats a Claude
  plan menu or question menu as the same gate, marked `onScreen`.
- `approve` answers an `onScreen` plan with `enter`, and still writes its `--note` to the log.
  It refuses with `PLAN_MENU_UNRECOGNISED` unless option 1 is the highlighted
  bypass-permissions approval, checked for every target before any is answered.
- `reject` answers an `onScreen` plan with `escape` before typing the feedback.

## Impact
- Code: `src/captain/view.ts` (pure screen parsers, `rowOf` fallback), `control.ts`
  (`readScreen`, `pressKey` on `CmuxPort`), `surface.ts`, `commands.ts`, and their tests.
- Docs: AGENTS.md "Surface" section.
- Cost: one `cmux read-screen` per workspace without a feed gate on each `status` call.
