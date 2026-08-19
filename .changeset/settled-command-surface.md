---
"cmux-captain": major
---

Release 1.0.

Captain is driven through its commands and flags, and the 0.x line moved that
surface more than once: `captain doctor` was folded into `captain install`, and
`.repoMap` config routing was removed outright. Both were breaking, and 0.x gave no
way to say so that a consumer's version range would respect.

1.0 is the commitment that a command or flag going away now costs a major, and that
a minor is safe to take.
