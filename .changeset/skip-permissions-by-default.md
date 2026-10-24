---
"cmux-captain": minor
---

Claude agents now launch with `--dangerously-skip-permissions` and run unattended from the first turn, instead of stopping in plan mode for `captain approve`. Pass `--gate` to `captain start` or `captain spec` to keep the plan-mode gate for a risky change. Both commands also take `--model` and `--effort` for the run, so the driver can put routine changes on a cheaper tier and hard ones on a frontier model. The brief's plan step changes to match: an ungated plan records the choice made for each unknown and keeps going, instead of waiting for an approval.
