# PR 35: what to take (YAGNI)

Authoritative copy for this decision. [PR 35](https://github.com/mblode/captain/pull/35) stays draft; this plan is not "merge it thinner."

## Outcome

Keep captain's residue (gates, hash-pinned rubric, live `status`, greppable ledger, vendor-neutral launch). Take from PR 35 only the pieces that make those cheaper to operate. Do not take a new vendor, a new command, or a second launch path until a named current failure exists.

Acceptance:

- The first-principles **verdict table and residue argument** live in `research/` (trim the "built" sections so they cannot be read as shipped).
- Plans have a **named lead section** the decision card can quote.
- `--summary --json` names **READY rows** the same way it already names NEEDS YOU, so a wake can say what moved without encoding a v2 snapshot.
- Everything else in PR 35 is out of this slice, with reasons below.

## Approach

Mode: **Deepen**, then only as much Harden as the two tiny CLI/prompt slices need (existing tests).

Do not merge the PR branch. Cherry-pick or re-implement the two code slices against `main`.

1. Land `research/first-principles-2026-09.md` as an audit, not as a changelog of features. Keep the TL;DR table, the six residue points, "where it does not," and the System One inventory that says **not now**. Cut or rewrite the "BUILT" rows so they match what actually shipped.
2. In `src/prompt.ts` `planLead`, require the plan to open with `## Decisions for the reviewer` (at most five bullets). In `skills/captain/SKILL.md`, the decision card quotes that section verbatim. No new files.
3. In `src/captain/commands.ts` summary JSON, add a `ready` list of identities (same sort as `needsYou`). On `changed: true` the payload already has current `needsYou`; with `ready` the skill can print both literally. Extend `skills/captain/references/heartbeat.md`: on change, relay those two lists and the counts; do not compose a story. Leave the snapshot as a 16-hex hash of the enlarged projection.

## Decisions

- **The audit's diagnosis is the high-value artifact.** Quote: captain should shrink toward governance, measurement, and locality, not grow to compete with hosted coordinators. PR 35 then adds ~3,500 lines of conversation-layer product. That fights the diagnosis. Keep the diagnosis.
- **Jev / `captain triage` is not earned.** New vendor, `JudgePort`, exit 12, TypeSafe types in the PURE core, plan text on stdin because the feed has no body, wire never live-tested, thresholds unmeasured. The driver already has a bounded read-only reviewer. A System One judge is a third-party network call at the one human leverage point. Revisit only after a measured miss (thin cards, unexplained approvals that a six-question classifier would have caught).
- **Task worktrees / multi-task fan-out is not earned.** The real bug is "second in-checkout dispatch clobbers `.captain/`." That is one isolation flag or "one dispatch per checkout, error on the second," not a Projects-style objective decomposer. Whitespace-as-task plus `--worktree` plus `runTaskFleet` is a second launch path beside `runIssueWorktree` / `runDispatch`. Wait for a current requirement that tickets cannot cover.
- **v2 snapshot digest is not earned.** `fleetSnapshot` already hashes counts + needsYou + missing. `changed: true` already returns `needsYou`. The missing piece is READY identities, not `projectFleet` / base64url / `fleetDigest` / a TTY "SINCE LAST CHECK" block. Driver-held previous JSON plus current summary is enough if READY is in the payload.
- **`firstPassStreak` + approve-all is not earned.** A streak of 5 that batches `triage-clean` low-risk plans is a trust ladder. Captain's plan gate is a hard stop per ticket. Ledger already has rework/unexplained-approval. Do not add a number whose only consumer is a skill policy to approve faster.
- **`gain.memory` is not earned.** Distill is already a skill step over a greppable file. Ranking Inbox traps in `gain` adds an fs edge and a metric nobody asked to watch. One session nudge in the skill ("open `learnings.md` if Inbox is long") is enough if distill never happens; measure that first.

Assumptions (unverified): no live evidence that plan-review cost, not gate quality, is the bottleneck; no log of two concurrent free-form dispatches as a recurring failure.

## Boundaries

- Not merging PR 35.
- Not adding `TYPESAFE_API_KEY`, `judge.ts`, `triage.ts`, exit 12.
- Not changing `route.ts` typo-vs-task.
- Not encoding snapshots, not `gain.rework.firstPassStreak`, not `gain.memory`.
- Not Jev for repo routing, verdict evidence, or Inbox promotion (audit #11–14 already rejects or defers these; keep that).

## Verification

- Audit file exists under `research/` and does not claim `triage` / task fleet / digest as shipped.
- `npm test -- src/prompt.test.ts` (or the file that asserts `planLead`): the brief contains `## Decisions for the reviewer`.
- `npm test -- src/captain/commands.test.ts`: summary JSON on a fleet with a passing verdict includes that row's identity under `ready`; snapshot hash changes when a row moves needs-you → ready.
- Heartbeat doc: on `changed: true`, print `needsYou` and `ready` as returned; no instruction to invent a digest paragraph.

## Recovery

Revert the three files (research, `prompt.ts`, summary JSON + two tests + skill lines). No data migration. Snapshot tokens change shape only by hashing extra `ready` fields; old tokens compare unequal once, which is the existing fail-open (`changed: true`).
