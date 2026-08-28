---
"cmux-captain": minor
---

Bind the merged diff to the approved plan, and report rework at the plan gate.

The brief now tells the agent to write its approved plan verbatim to `.captain/plan.md`
before it touches code, and to append any later departure under a `## Deviations` heading
in that same file rather than rewriting the plan; the
rubric grades the diff against it (with a mechanical `na` when the file does not exist),
and the verifier is handed it alongside the rubric and the branch diff. A plan is also
now asked to name the files that change, the work order, and the tests that prove it.

`gain` gains a `rework` block — first-pass rate and the tickets that kept coming back,
derived from the existing ledger with no new state, and omitted entirely when no ticket
carries a decision.
