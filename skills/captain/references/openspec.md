# OpenSpec changes

How "add this to the list" becomes an OpenSpec change when the repo keeps its backlog in
OpenSpec. The change folder is the plan of record; `captain spec` turns it into a task.

## Where changes live

Each change is a Markdown folder `openspec/changes/<id>/` in the repo's **OpenSpec home**,
outside the repo: `captain spec --root` prints it (`~/.claude/captain/openspec/<repo-key>/`).
Nothing OpenSpec is ever committed. Run every `openspec` command from the home, never from
the repo:

```bash
home="$(captain spec --root)"; mkdir -p "$home"; cd "$home"
```

Never write a change into the repo's own `openspec/`; a change already there belongs to the
team and is read-only.

Setup, once per machine and once per home: Node >= 20.19, then
`npm install -g @fission-ai/openspec@latest` (or `brew install openspec`), then
`openspec init --tools none` in the home. Run `openspec update` there after upgrading.

## Writing a change

1. Pick a kebab-case verb-led id: `add-dark-mode`, `fix-login-redirect`. It becomes the
   task id and the `[<id>]` commit tag.
2. `openspec new change <id>`, then fill its artifacts in the current template's shape;
   `openspec instructions <artifact> --change <id>` prints each one's template and rules.
   - `proposal.md`: `## Why` (at least 50 characters), `## What Changes`,
     `## Capabilities`, `## Impact` (the code paths the worker should touch). Keep the
     template's bare `# Proposal` heading.
   - `specs/<capability>/spec.md`: one delta per capability in the proposal. For a pure
     refactor, tooling or docs change, set `skip_specs: true` in `.openspec.yaml` instead
     of inventing a requirement.
   - `tasks.md`: each unchecked box becomes one acceptance criterion, so make every box
     checkable from the diff:
     ```markdown
     # Tasks

     ## 1. Implementation

     - [ ] 1.1 <observable outcome>
     - [ ] 1.2 Tests cover <behaviour>

     ## Smoke test

     - [ ] S.1 Terminal: <a command run against production and the output it must show>
     - [ ] S.2 Browser: <a page in production and what it must show>
     ```
     `## Smoke test` boxes are not criteria: the worker runs them in production after the
     merge, read-only unless a step names a reversible write. Without the section the
     worker derives one terminal and one browser check from the proposal.
   - `design.md` is optional, for decisions and trade-offs.
3. `openspec validate <id>` must pass before you start it.
4. Keep changes that will run together on disjoint files.
5. "Add to the list" means write it. Start nothing before the human's yes.

## Starting

- `captain spec <id…>`: each change becomes a task (or refreshes its not-yet-started
  task) and starts in the shared checkout. Pass `--harness`, `--model`, `--effort` and
  `--risk escalate` the same way as `captain start`.
- `captain spec --all`: every active change without a started or closed task, up to the
  WIP limit. It is safe to rerun; the rest wait.
- Run it from the repo. With no project for that repo yet, `captain spec` creates one
  (shared checkout) named after the repo.
- The worker ticks boxes in the home's `tasks.md`, and runs `openspec archive <id> --yes`
  in the home itself once its smoke test passes. Don't move a change folder by hand: that
  skips the spec merge. Then `captain done <id>` closes the task.
