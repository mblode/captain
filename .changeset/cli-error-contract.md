---
"cmux-captain": patch
---

Fix three CLI defects found by a developer-experience audit.

**`captain install` told new users to run a command that does not exist.** Its
success line, the degraded-setup line, the empty-fleet hint in `status`, and a
worktree-recovery note all said `captain fanout …`. There is no `fanout`
subcommand — and typing it did not error. `withImplicitStart` only guarded a
single bare word, so `captain fanout TIG-430` was treated as a free-form task and
launched an agent in the user's current directory, overwriting that checkout's
`.captain/rubric.md`. The same hole made `captain aprove tig-430` start an agent
instead of suggesting `approve`. A bare word followed by issue tokens is now left
for commander, which errors and names the near miss.

**`--json` did not always emit JSON.** Commander's own parse failures (unknown
command, unknown option, missing argument) never reach an action handler, so they
bypassed the documented error envelope: `captain approve --json` wrote prose to
stderr and left a driver's `JSON.parse` with empty stdout. Those failures now emit
`{"error":{"message","type"}}` on stdout with the human hint still on stderr.

**`--interval` accepted anything.** `captain status --watch --interval abc`
silently fell back to 5 seconds. It now fails at the boundary and names the value.

**Usage errors all exit 2 now.** `errors.ts` documents `EXIT.USAGE = 2` so a
driver can branch on the number, but only some paths used it: a bad flag
combination exited 2 while a missing argument or unknown command exited 1.
Commander's parse failures now map to the same code as every other usage error.

Also: the doctor checked `Node >= 22` while `engines.node` required `>=24`, so a
Node 22 machine passed setup and then failed to install. One constant now, pinned
to `engines` by a test. `reject --json` no longer emits `undelivered`, which was
hardcoded `[]` and unreachable since rejection became fail-closed.
