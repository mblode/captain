# Research: the v2 decision record

Everything in this folder was written for Captain v2 (June to September 2026): the cmux fleet CLI
with ticket fan-out, `status --summary` polling and the `/captain` driver session. v3 replaced that
design on 22 Sep 2026. The current design and its reasons are in `docs/plans/captain-v3.md`.

Read these for **why** v3 is shaped the way it is, not for how anything works today. File paths,
commands and module names in them describe v2 and mostly no longer exist.

| File | What it settled | Still true in v3 |
|---|---|---|
| `session-findings.md`, `PLAN.md`, `architecture.md` | The June 2026 watcher daemon failed live; derive state instead of storing it | Yes: no daemon, a board derived from evidence |
| `loops-fable5.md` | Fresh-context verifier, hash-pinned rubric, fleet memory | Yes, carried over unchanged |
| `builderbot-audit.md` | No persistent listener; one-way notify only | Yes |
| `cross-session-messaging-audit.md` | Messaging between sessions is not a control plane | Yes |
| `wayfinder-browser-harness-audit.md` | Read trackers, never write them; no browser daemon | Yes |
| `ai-native-sdlc-playbook-audit.md` | Plan as an artifact graded by the verifier; what not to adopt | Yes |
| `agent-swarm-economics.md` | Measure judgment, not throughput | Yes |
| `first-principles-2026-09.md` | "Shrink toward governance, don't build a conductor" | Partly reversed: v3 is a conductor (the chat), but it holds no state |
| `v2-captain-for-how-i-use-ai*.md`, `v2-pr-35-high-value-take.md` | The v2 usage plan and the PR 35 triage | History only |
