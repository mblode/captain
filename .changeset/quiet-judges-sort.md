---
"cmux-captain": minor
---

Add `captain triage`, an opt-in System One judge for the plan gate, and the
September 2026 first-principles audit.

`captain triage <ticket>` hands one plan-gated worktree's plan, together with the
rubric's contract half (issue context + acceptance criteria), to TypeSafe's Jev and asks
six fixed questions in one parallel call: in scope, blast radius (the auto-pickup tiers
low / moderate / elevated), names files, states the work order, names the proof tests,
resolves an ambiguity silently. The card is `clean` only when every answer is present
and decisive in the safe direction; anything else is `review` with the reasons, and a
missing or malformed answer can never read as clean. It touches no gate and writes no
ledger record — it sorts the driver's review queue, and its `note` is shaped for
`captain approve --note` so a triaged approval enters the ledger explained. Requires
`TYPESAFE_API_KEY`; every other command is unchanged without it. Exit code 12
(`JUDGE_UNAVAILABLE`) is new.

Five UX/DX changes taken from what Claude Projects, Cursor Projects and Grok Bot get
right about talking to a fleet, each landing in the conversation layer rather than a
daemon:

- Several quoted free-form tasks fan out one worktree each (`captain "fix the flaky auth
  test" "tighten the CSP header"`), and a single task takes `--worktree`; the `/captain`
  driver decomposes an objective into those tasks and shows the split as one decision
  card first. Three bare words are still one in-checkout task.
- `captain status --summary --since <token>` now says what changed: the token carries the
  actionable projection, so the next call returns a `digest` — one line per worktree that
  moved — and works on the TTY too. Every driver wake ends with that digest and when the
  next check is due.
- Every plan opens with a `## Decisions for the reviewer` section that the decision card
  quotes verbatim.
- `gain.rework.firstPassStreak` reports per repo how many tickets in a row cleared the
  gate first pass; the driver may batch triage-clean, low-risk plans in a repo with a long
  streak into one approve-all decision.
- `gain.memory` reports each repo's fleet memory: rules vs inbox, bullets beyond the
  injected tail, the oldest bullet's age, and traps two or more bullets name.

`research/first-principles-2026-09.md` rebuilds captain from first principles against
Claude Projects, Cursor Projects, Grok Bot, GPT-6 Astra and TypeSafe, states where
captain still brings value and where it does not, and sorts the other System One
candidates (repo routing, verdict-evidence checks, memory curation) as not-now.
