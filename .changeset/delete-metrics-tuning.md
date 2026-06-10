---
"captain": minor
---

Delete the never-fired metrics/tuning superstructure (~470 LOC): the `captain metrics` command, `metrics.ts`/`tuning.ts`, the `FleetMetrics`/`StageMetric`/`PipelineTuning` types, `transition()`'s tuning param and per-stage retry budgets, `Worktree.retries`, and the unused `isHumanGated`. The stall halt (`checkHalt`, event-silence escalation) and the verdict gate (outcome verification) supersede what retry budgets were for; `history.jsonl` + `captain audit` remain the measurement substrate.
