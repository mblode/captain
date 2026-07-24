---
"cmux-captain": patch
---

Fix curated fleet memory never reaching a brief, and give verdict criteria an n/a state.

- `memory.ts` located `## Rules`/`## Inbox` with `indexOf`, and the skeleton's own preamble
  named `## Inbox` first — so the rules slice was backwards and empty, and the curated
  section was silently dropped from every brief. Headings are now matched at line start,
  and the skeleton names no heading in its prose. The skeleton also no longer states an
  append policy: it is only written when the file is absent, so a stale policy could never
  be refreshed.
- Verdict criteria accept `na: true` (reason in `evidence`) for a criterion that cannot
  apply to the diff — neither a pass nor a failure, and never tallied by `gain`. The rubric
  pins each criterion `name` verbatim so a softened bar surfaces as a rename.
- `parseVerdict` accepts `ts` as a quoted integer as well as a number; the rubric's schema
  example modelled it as a string, so most verdicts were scored `0` and dropped from
  `gain`'s launch→verdict latency.
- The brief no longer mandates `AskUserQuestion` for codex agents, which have no such tool
  and were left no legal way to surface a blocker. Plans now lead with ambiguities and
  assumptions, and the fleet-memory guidance drops an ineffective dedupe mandate.
