---
"captain": minor
---

Add a self-improving metrics layer: an append-only event history, a `captain metrics` view (per-stage durations, throughput, autonomy and intervention rates), and a self-tuning pipeline that learns per-stage retry budgets and escalates chronically-stuck stages to a human gate. Wires up the previously-unused `Worktree.retries` field; cold-start parity preserves existing driving behaviour until real outcomes accrue.
