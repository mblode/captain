# Steal-worthy ideas audit — captain vs. Claude Code cross-session messaging (August 2026)

## Context

Anthropic shipped Claude Code **cross-session messaging** in v2.1.224 (announced
[@ClaudeDevs, Aug 7 2026](https://x.com/ClaudeDevs/status/2085817074816070014);
docs at [code.claude.com/docs/en/cross-session-messaging](https://code.claude.com/docs/en/cross-session-messaging)).
Independent Claude Code sessions on one machine discover each other with `ListAgents` and
deliver plain-text summaries with `SendMessage` over a per-session UDS inbox
(`CLAUDE_CODE_MESSAGING_SOCKET`). Same-machine delivery stays local; cross-machine is
reply-only via Remote Control. No conversation history or files travel — only text the
sending Claude writes. Inbound defaults key off permission-mode class: bypass↔bypass
delivers; mixed classes hold for approval; `-p` sessions cannot show the hold dialog.

The headline use case in the docs is **coordinating parallel worktrees** — which is
exactly captain's shape. Captain already fans out one cmux workspace + worktree per
ticket (`src/runner.ts` → `openIssueWorkspace` / `launchPlanMode`), surfaces gates via
`status`, and coordinates durable learnings through fleet memory (`src/memory.ts`). It
does **not** give agents a live peer channel today; the brief says *"nobody will tell you
to continue"* (`src/prompt.ts`).

This audit asks, capability by capability: **what should captain steal, what should it
adapt, and what is a deliberate non-goal** because it collides with captain's thesis (no
daemon, no persisted fleet state, self-drive agents, human plan/merge gates, isolation
per worktree). Findings are grounded in the actual code (file:line) and in the docs'
delivery / inbound rules.

The intended outcome: a decision doc that (a) names the one cheap ADOPT (pin Claude
session `--name` so the peer roster is addressable), (b) records a light prompt ADAPT for
optional breakage warnings, and (c) writes down why messaging must not become the fleet
control plane or replace fleet memory — so the next proposal to "let the agents talk" has
a written defence.

## TL;DR verdict table

| # | Capability | Verdict | One-line reason |
|---|---|---|---|
| 1 | **Pin Claude session `--name` to the ticket/branch** | **ADOPT — now** | cmux workspace `--name` ≠ Claude peer name; without `claude --name`, `ListAgents` is opaque |
| 2 | **Brief: may `SendMessage` peers on shared-surface breakage** | **ADAPT — light prompt only** | Optional warn; never wait on peers; never use messaging for approval/steering |
| 3 | **Replace / extend fleet memory with messaging** | **REJECT** | Memory is durable cross-run; messaging is ephemeral mid-turn text — different loop |
| 4 | **Messaging as fleet control plane / driver steering** | **REJECT — non-goal** | Two-way conversational control + mid-run puppeteering; keep `cmux send` / approve/reject |
| 5 | **Depend on messaging for ticket coordination** | **REJECT** | Isolation bet: human merge gate is the coordination point; Claude-only; holds strand unattended agents |
| 6 | **Force `crossSessionInbound: accept` on launch** | **N/A for now** | Post-approve fleet is bypass↔bypass → default delivers; driver→agent already uses `cmux send` |
| 7 | **Claude Agent Teams as alternative architecture** | **REJECT — non-goal** | Supervised team ≠ independent worktree-per-ticket fan-out |

---

## ADOPT — pin `claude --name` (S effort, low risk)

**The gap.** `openIssueWorkspace` (`src/cmux.ts`) already passes `--name` to
`cmux new-workspace` using the branch/ticket slug. That names the **cmux workspace**,
not the Claude Code session. Cross-session messaging's roster answers to the name set by
`claude --name` / `/rename` (docs: default is a folder-derived name like `myapp-3f`).
Captain's launch command today is:

```text
claude --model … --effort … --permission-mode plan --allow-dangerously-skip-permissions "$(cat …)"
```

So a fleet of `tig-424` / `tig-430` worktrees shows up to `ListAgents` as opaque
directory names — the feature is on, but unusable for a driver or peer that wants to
address `tig-424`.

**The fix.** Thread the same slug (`options.branch` / `target.label`) into
`claudeCommand` / `agentCommand` as `claude --name <slug>`, and into the inline
`launchPlanMode` argv so the two launch paths cannot drift. Codex is unchanged (no
`SendMessage` / no `--name` equivalent in this feature).

This ADOPT enables the feature without adopting a coordination protocol. It does not
add a CLI, a daemon, a settings write, or a `CmuxPort` change.

## ADAPT — one prompt sentence for optional peer warnings (S effort)

Claude's own guidance for the feature: hand over a finding when one session breaks what
another is building. That can happen in a captain fleet (shared types, migrated schema,
renamed export) without making messaging the control plane.

Add **one** claude-only sentence inside `<workflow>` (`src/prompt.ts`): if you land a
change that breaks another in-flight worktree on this machine, you may `SendMessage` that
session a short warning — **do not wait on peers, do not use messaging for approval or
steering, and do not block your own pipeline on a reply**. Codex briefs omit it (no tool).

This preserves *"nobody will tell you to continue"* while naming the one legitimate use
of the new channel.

## REJECT — messaging is not fleet memory

Fleet memory (`src/memory.ts`, injected via `<fleet-memory>` in `src/prompt.ts`) is the
durable cross-session channel: Rules + tail-capped Inbox, shared by all worktrees of a
repo, surviving worktree removal, curated by humans. Messaging is plain text delivered
between tool calls of a live turn (or starting a new turn when idle). Different lifetime,
different consumer, different verification bar ("append only what this run verified").
Folding one into the other would either lose durability or invent a mailbox on disk —
persisted fleet state, which is the boundary deleted June 2026.

## REJECT — messaging is not the control plane

Driver → agent today is `captain approve` / `reject` (feed `exit_plan.reply`) and ad-hoc
`cmux send` (`src/captain/control.ts`, `src/captain/commands.ts`). Surfacing is
read-only `status` from cmux feed + `cmux top` + `.captain/verdict.json`. Replacing any
of that with `SendMessage` would be:

- **Two-way conversational control** — rejected in `research/builderbot-audit.md` (#6–8)
  as the daemon/listener class.
- **Mid-run puppeteering** — conflicts with the self-drive brief and with
  `research/PLAN.md`'s "surface-and-gate, don't puppeteer" thesis (session-findings: typed
  next-steps collide with agents already advancing).
- **Claude-only** — `CAPTAIN_AGENT=codex` has no peer channel; a control plane that only
  works for one agent is a split brain.

Captain does not call `SendMessage`, does not read inbox sockets, and does not grow a
listener for peer traffic.

## REJECT — do not depend on messaging for ticket coordination

The isolation bet (`research/agent-swarm-economics.md`): one worktree per ticket; the
human merge gate is the coordination point; shared-state contention machinery is N/A.
Launch-time frontier filtering (`Issue.blockedBy` / `openBlockers`) already covers the
graph case without a live channel. Building "wait for tig-1 to message me that the
migration landed" into the brief would:

- Stall agents on held/refused/rate-limited messages (inbound holds need a human dialog;
  unattended bypass agents cannot click Approve unless both sides are bypass — and even
  then delivery is best-effort, not a protocol).
- Invent a peer dependency that `status` cannot see (no network/daemon in the read path,
  no persisted mailbox).
- Fail closed for codex and for Claude versions / providers where the feature is off
  (Bedrock, Foundry, `DISABLE_TELEMETRY`-class flags, native Windows).

## N/A — `crossSessionInbound: accept`

Post-approve, captain agents run under `bypassPermissions` (`src/captain/control.ts`
`REPLY_MODE`). Docs: bypass↔bypass delivers by default. The driver→agent path already
uses `cmux send`, which does not go through the peer inbox. Forcing
`crossSessionInbound: accept` on every launch would widen the inbound surface for no
current consumer. Revisit only if a real hold-strand shows up in a live fleet.

## REJECT — Agent Teams

Claude Code Agent Teams are a supervised multi-agent structure inside one coordination
model (docs point messaging-within-team at a different page). Captain's bet is the
opposite: independent sessions, one issue each, human at plan + merge. Adopting Teams
would re-litigate the fan-out architecture, not add a feature.

---

## What shipped with this audit

1. `claude --name <ticket>` on both launch paths (`src/cmux.ts`, `src/launch.ts`).
2. Claude-only optional peer-warn sentence in `<workflow>` (`src/prompt.ts`).
3. Gotcha in `AGENTS.md` recording the ADOPT/REJECT boundary.

No new CLI. No daemon. No settings file writes. No `CmuxPort` changes.
