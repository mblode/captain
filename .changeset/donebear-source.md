---
"cmux-captain": patch
---

Add donebear.com as a second issue source: `captain start <task-url|uuid>` fetches a Done Bear task (title + checklist) and drives it through the same worktree → rubric → prompt → verdict pipeline, with each unchecked checklist item becoming an acceptance criterion. Read-only (needs `DONEBEAR_TOKEN`). Internally, issue-source handling now goes through a `source.ts` registry and a source-neutral `Issue` contract, so Linear and donebear share one path and adding a source touches one file.
