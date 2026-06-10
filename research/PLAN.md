# captain — improvement plan (June 2026)

Synthesized from a live 10-worktree session (see `session-findings.md`) + a 4-agent
research swarm (cmux-native overlap, Claude Code packaging, codebase audit, orchestration
landscape). Raw agent reports are summarized in `findings-*.md` siblings.

## The three answers, up front

**1. Should captain be more lightweight? — YES, substantially.**
~685 LOC (≈40% of the captain core) is superstructure the real session never exercised:
the metrics + tuning + retry-budget subsystem and the dead PR-merge path. Cut it. Then
delegate gate-detection, notifications, and busy/idle to **cmux-native primitives**
(cmux 0.64.13 now has a structured **Feed** and real run-state) instead of re-deriving
them from raw hook frames and scraping `read-screen` for "esc to interrupt". Captain
shrinks to its irreducible value: the SDLC state machine, Linear fan-out, friendly-ids,
and a single state-owning control plane.

**2. Should captain be an installed skill? — YES: a Claude Code _plugin_, not an npm-link.**
The current shape (npm-linked CLI + hand-managed `nohup`/pidfile daemon + a separate
skill) was the single most fragile thing in the session (daemon death, 4 manual restarts,
pidfile repointing). June-2026 gold standard for a Claude Code extension is a **plugin**
that bundles the skill + hooks + (the daemon as a) **background monitor**, installed from
a marketplace. ⚠️ _Verify the plugin "background monitor" feature and skill namespacing
before committing to it (Phase 5) — the research cites it but I have not confirmed it
first-hand._

**3. Gold-standard pattern for June 2026 — surface-and-gate, don't puppeteer.**
Every reference point (OpenAI Symphony, Linear-for-Agents, cmux/ACPX/OMX, Claude Code
Agent Teams) converges on: a **single state-mutating control plane** that talks to agents
over **structured RPC (not CLI-scraping)**, keeps humans **on the loop at milestone gates**
(not in the loop per step), and treats the **tracker (Linear) as source of truth**.
Captain's long-lived state-owning daemon + single-writer append-only logs are _aligned_
with this. Its **per-`Stop` slash-command driving is the obsolete "conductor" pattern** —
and the session proved it actively conflicts with reality: cmux agents launch in
bypass-permissions mode, self-drive past the plan gate, and collide with captain's
next-step send. The fix is twofold: make the gate _real_ (launch agents with
`--permission-mode plan`), and let agents _self-drive_ the cadence while captain only
surfaces state and parks gates.

---

## Guiding thesis

> Make captain a **lightweight surface-and-gate control plane over cmux-native
> primitives, shipped as a Claude Code plugin** — not a heavyweight per-step puppeteer
> shipped as an npm-linked daemon.

---

## Phases & todos

### Phase 0 — Land & de-risk what's already in flight _(fast, do first)_

The session already fixed 5 real bugs; lock them in before refactoring on top.

- [ ] Commit the 5 in-flight fixes (event-stream adoption, no-prune-on-empty, ExitPlanMode
      regression guard, pipeline reorder, single-writer intent log) + AGENTS.md.
- [x] Add the missing regression tests for the bugs the session hit (they were ALL in
      untested code): the "empty `workspace.list` must not prune" invariant,
      `drainIntents`/`applyIntent` ordering vs live events, and adoption-from-event-stream.
      **Done in architecture.md slice 2** (`watch.test.ts` + `state.test.ts`, driven through
      the real modules with a fake CmuxPort).

### Phase 1 — Make the plan gate REAL _(highest leverage, smallest change)_

This is the keystone: it converts captain's central feature (human plan approval) from
"partly moot" to authoritative, and it makes cmux Feed trustworthy.

- [ ] Launch fan-out agents with `claude --permission-mode plan` instead of
      `--allow-dangerously-skip-permissions` (in the `linear-worktree`/`fanout` launch path),
      so agents actually PAUSE at ExitPlanMode until `captain approve`.
- [ ] Confirm cmux's launch flags / how the Claude wrapper is invoked, and that the Feed
      `exitPlan` item then becomes a hard gate (not the 120s soft-wait).
- [ ] Re-validate end-to-end that approve→implement no longer races self-driving.

### Phase 2 — Slim the core _(lightweight; ~685 LOC out, near-zero risk)_

- [x] Delete `tuning.ts`, the metrics subsystem (`metrics.ts`, `renderMetrics`, the
      `metrics` command), `Worktree.retries`, and the 30s history re-read hot-path
      (`watch.ts` `refreshTuning`). (~600 LOC; nothing depends on it; never fired in the
      real session.) **Replaced, not just removed**: the verdict gate + fleet memory
      (see `loops-fable5.md`, shipped) are the self-improvement loop now — outcome
      verification supersedes retry-budget heuristics. **Done** (architecture.md
      Slice 1): ~470 LOC deleted; `checkHalt` + the verdict gate cover escalation.
- [x] ~~Delete the dead PR-merge path … or wire it (pick one).~~ **Resolved: wired.**
      `READY_TO_MERGE` is now the verified PR-ready gate (a passing
      `.captain/verdict.json` moves the worktree there) and `prUrl` is assigned from the
      verdict. `isHumanGated` is still unused — fold its removal into the slim pass.
- [ ] Cut or thin `audit` (`commands.ts`, `format.ts`) — `history.jsonl` is still the
      audit trail; the rendered view is optional. (Records now carry a `note` — the why
      behind rejects/blocks/verdicts — which the memory-distill workflow reads; keep that.)

### Phase 3 — Delegate to cmux-native primitives _(lighter + more robust)_

cmux 0.64.13 now provides structured signals captain currently re-implements by scraping.

- [ ] Read gates from the cmux **Feed** (`feed.list` / `cmux events --category feed`)
      instead of re-deriving PLAN_READY/BLOCKED from raw `agent.hook.*` frames.
- [ ] Drop captain's `notify()`; rely on cmux's native Feed notifications (inline
      Allow/Deny/Submit buttons).
- [ ] Replace the `read-screen` "esc to interrupt" busy-scrape and the `gateHint` PROSE
      regex with native run-state (`cmux list-status` / `cmux top`) and the Feed item payload.
- [ ] **Fix the broken read command in `status` (bug #5):** print a valid
      `cmux read-screen --workspace <workspace:N|uuid>` (map name→ref) so copy-paste works.
- [ ] Use the frame's `session_id` as the stable identity key (alongside cwd).

### Phase 4 — Shift the driving model to surface-and-gate _(the conceptual fix)_

- [ ] Stop per-`Stop` puppeteering. Let agents self-drive the
      `/pr-reviewer → /simplify → /pr-creator` cadence themselves (a per-worktree
      "finish" instruction/skill, or agent-side chaining), so captain never collides
      with a self-driving agent.
      The shipped `<finishing-protocol>` prompt section + `.captain/rubric.md` (see
      `loops-fable5.md`) is the first slice of this: the _end_ of the run is already
      agent-driven (verify → write verdict) and captain only reads the verdict file —
      extending the same pattern to the mid-run cadence is what remains. The
      verdict/rubric/memory modules survive this phase unchanged (they're fs-based,
      not event-based).
- [ ] Make the cadence **not hardcoded**: move it to a per-fleet config or to the agent
      side (e.g. a project finish-skill / Linear Agent Guidance), killing the rebuild-to-
      reorder pain (bug #12).
- [ ] Add **reconcile-against-ground-truth**: refresh stage/busy from the Feed + run-state
      so a manual `cmux send` no longer permanently desyncs `status` (bug #11).
- [ ] Keep captain owning exactly two gates: **plan approval** and **PR-ready** (+ BLOCKED
      passthrough). Everything else flows on the agents.

### Phase 5 — Repackage as a Claude Code plugin _(installed, not npm-link)_

⚠️ Verify the specifics (background-monitor feature, skill namespacing, marketplace flow)
against current docs before building — high value but the research was not first-hand.

- [ ] Author `.claude-plugin/plugin.json`; bundle the existing `captain` skill into the
      plugin (accepting `/captain:status`-style namespacing).
- [ ] Replace the hand-managed detached daemon with a plugin **background monitor**
      (Claude-Code-supervised `captain watch`) — _or_, if that feature isn't real/robust, add
      `captain restart` + a self-heal/health path to the existing daemon (`daemon.ts`).
- [ ] Distribute via a plugin marketplace (`/plugin install …`); drop `npm link`.
- [ ] Keep the pure core importable so it stays unit-testable.

### Phase 6 — Harden the IO layer _(the real engineering debt)_

The pure core is well-tested; every bug this session hit lived in untested `watch.ts` /
`daemon.ts` / `control.ts` / `events.ts`.

- [ ] Add tests for daemon child survival + boot adoption (the actual death bug), and for
      watch.ts adoption/prune/drain paths. _(Partially done in architecture.md slice 2:
      adoption/prune/drain/busy/verdict paths are covered; daemon child survival remains.)_
- [x] Split the `watch.ts` god-file (adoption · intents · gate-hinting · busy · event loop).
      **Done in architecture.md slice 2**: `commit.ts` (single mutator) + `adopt.ts` +
      `sweeps.ts` + `intents-drain.ts`; `watch.ts` is wiring only.

---

## Sequencing & impact

| Phase               | Effort | Risk | Payoff                                |
| ------------------- | ------ | ---- | ------------------------------------- |
| 0 land+test         | S      | low  | locks in the wins                     |
| 1 real gate         | S      | low  | **highest** — fixes the core conflict |
| 2 slim core         | S–M    | low  | −685 LOC, lighter                     |
| 3 cmux-native       | M      | med  | lighter + robust, fewer scrapes       |
| 4 surface-not-drive | M      | med  | aligns with 2026 best practice        |
| 5 plugin            | M      | med  | install UX, kills daemon fragility    |
| 6 IO tests          | M      | low  | pays down the real debt               |

Do **0 → 1 → 2** first: they're small, low-risk, and 1 removes the biggest design flaw.
3–5 are the "lightweight + gold-standard" reshaping. 6 runs alongside everything.

## Open questions to confirm before building

- Plugin **background monitors**: real, supervised, auto-restart? (Phase 5 hinges on it.)
- cmux **Feed as a hard gate** once agents launch with `--permission-mode plan`? (Phase 1.)
- Is keeping captain's vendored `linear-worktree` fan-out worth ~1000 LOC, or shell out to
  the `linear-worktree` CLI? (deferred; behaviour-parity sensitive.)
