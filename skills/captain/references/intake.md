# Intake

How a message, a ticket, or a big goal becomes tasks the board can run.

## A message

1. Decide whether it is one task or several. It is several only when there are two
   things the human could notice separately. Steps of one change stay one task.
2. For each task, write a contract the worker can finish without asking you:
   - what should work when it's done, from the user's side;
   - `- [ ]` acceptance criteria, each checkable from the diff and the repo alone
     ("the list still renders when the API returns 500", never "works correctly");
   - what is out of scope, when something nearby could be mistaken for it.
3. `captain add "<contract>" --title "<short title>"` with `--risk`, `--harness`,
   `--blocked-by` as needed. Or write the file in `tasks/` directly and `captain status`
   to check it parses.
4. One decision card for the batch. Start nothing before the human's yes.

## A ticket

`captain add TIG-430` (Linear id or URL) or a Done Bear URL or UUID. The ticket's
description, checklist and open blockers are copied in, with a link back in `source`.
Then read the task file. If the contract is thin, sharpen the body before starting. The
file is the record from here on. Captain never writes back to the tracker.

Tickets the human labels `captain` in Linear: on each heartbeat, when the human has asked
you to watch the label, list them (Linear MCP or CLI) and `captain add` any that aren't in
the task list yet. Treat them as messages: card first, start after a yes.

## A big goal (an epic, a rebuild area)

1. Read the code and docs the goal touches before slicing anything.
2. Slice vertically. Each task is a thin path through every layer it touches, demoable
   on main alone, and small enough for one fresh context window.
3. A blocker is a task whose absence makes this one impossible to build or verify.
   "Touches the same files" is not a blocker. Keep the graph shallow: most tasks
   unblocked, one chain where the dependency is real.
4. A wide mechanical change (a rename across the codebase) is expand, then migrate in
   batches, then contract. Three or more tasks, each green on its own.
5. Put setup work first as its own task: make the change easy, then make the easy change.
6. Present the whole slice list as one card: title, blocked by, what works when it
   closes, harness and model. Iterate until the human approves, then add them all.

## Risk

Mark `--risk escalate` for anything touching auth, billing, payments, data migrations,
deletes, permissions, public contracts, or build and release config. Escalate tasks run in
Claude Code plan mode and wait for `captain approve`. Everything else is `low` and runs
unattended to a PR. When unsure, escalate.
