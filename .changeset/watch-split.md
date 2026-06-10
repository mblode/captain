---
"captain": patch
---

Pure refactor + tests (architecture.md slice 2): split the `watch.ts` god-file into
`commit.ts` (the single state mutator), `adopt.ts`, `sweeps.ts`, and `intents-drain.ts`;
made `control.ts` an injectable `CmuxPort` seam (`realCmux(env)`); moved the verdict fs
readers to `sweeps.ts` so `verdict.ts` is 100% pure; added lint-enforced contracts
(no fs in the pure domain, no `saveState` outside `commit.ts`) and the five session-bug
regression tests plus `state.ts` coverage. No behaviour change.
