---
"cmux-captain": patch
---

Drop the retired `/pr-reviewer` step from the default worker pipeline. `/tidy` now does the review and the fixes in one pass, so workers review once instead of twice, and `captain install` checks for `tidy` instead of reinstalling `pr-reviewer`.
