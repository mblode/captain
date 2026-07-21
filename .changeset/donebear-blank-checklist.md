---
"cmux-captain": patch
---

Skip blank donebear checklist rows (empty title) when building acceptance criteria, so a task with an empty checklist item no longer renders an empty `<criterion>` in the agent brief. The rubric already ignored blank rows; this aligns the prompt.
