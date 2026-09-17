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

`research/first-principles-2026-09.md` rebuilds captain from first principles against
Claude Projects, Cursor Projects, Grok Bot, GPT-6 Astra and TypeSafe, states where
captain still brings value and where it does not, and sorts the other System One
candidates (repo routing, verdict-evidence checks, memory curation) as not-now.
