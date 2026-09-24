# Grok Bot on the Mac mini: bots, a computer, and cmux coding sessions

Research date: 24 Sep 2026. Four research passes (OpenClaw, Hermes Agent, remote access and computer use on macOS, cmux plus Grok Bot and the remote-control products), read against Expert's Grok Bot research (`mblode/expert` history: `docs/GROK-BOT.md`, `docs/LANDSCAPE.md`, `docs/plans/coding-sessions.md`) and Captain v3 (`docs/plans/captain-v3.md`). Sources are inline. Claims marked **[unverified]** came from secondary sources or model-summarised pages and should be checked against a live install.

## The ask

- A Grok Bot clone that runs on your own Mac mini, reached over Tailscale, with RustDesk for the screen.
- One or a few bots, each with instructions, skills, routines and webhook triggers.
- Computer use of the Mac mini.
- When the work is code, a bot starts a Claude Code or Codex session in cmux on the Mac, the way Grok Bot starts a Cursor Cloud Agent.
- Hermes Agent or OpenClaw are fine if they solve it.

## The answer

**Hermes Agent is the bot layer, Telegram is the front door, and Captain is the coding hand.** Nothing new needs to be built except one Hermes skill and one cmux automation rule.

```
 iPhone ── Telegram ──────────────┐            (you talk to bots, approve cards)
 iPhone ── Tailscale ─┬─ RustDesk / Expert app (you watch or take the screen)
                      └─ Claude app, Remote Control (you drop into a coding session)
 GitHub ── Tailscale Funnel /hooks/github ─┐
                                           ▼
 Mac mini ─ Hermes gateway (launchd) ── bots: "Captain" (code), "Ops" (everything else)
              │  routines (cron), webhooks (HMAC), approvals, memory, skills
              │  computer_use (cua-driver, background) ── the Mac's own desktop
              └─ skill "captain" ── captain add/start/status/approve/send
                                       └─ cmux workspace + git worktree + claude | codex | agent
              ▲
              └──── cmux automation: agent.needs_input / idle ─► Hermes webhook ─► Telegram card
```

Why this split:

- **Hermes already is Grok Bot's shape.** Bot Mode in v0.21 (31 Aug) makes each bot a profile with its own `SOUL.md`, model, skills, memory, credentials, avatar and **routines** (cron jobs named `[bot:<name>] …`), plus group chats of 2–6 bots and bot-to-bot DMs. ([bot mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode), [v2026.8.31 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.31))
- **Its webhooks take GitHub as it is.** Routes require HMAC and verify `X-Hub-Signature-256` natively, with debouncing, idempotency, per-route rate limits and a `github_comment` delivery target. OpenClaw's `/hooks` need a bearer header that GitHub cannot send, so OpenClaw needs a relay. ([Hermes webhooks](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks), [OpenClaw webhooks](https://docs.openclaw.ai/automation/cron-jobs/webhooks))
- **Captain already starts cmux sessions properly.** `captain start` makes the worktree, runs the bootstrap, opens a cmux workspace and launches the full harness with pinned model and effort, gates risky plans, enforces the WIP limit, and derives status from cmux, git and `gh`. Neither Hermes nor OpenClaw has a cmux integration; both would drive raw tmux or `claude -p`. The bot should call Captain, not re-derive it.
- **Telegram is the cheapest good chat.** One BotFather token per bot gives Grok Bot's roster of named contacts, inline Allow/Deny buttons, and long polling, so the Mac only makes outbound connections. Hermes ships Telegram approval cards (Allow once / Session / Always / Deny). An own iOS app is weeks of work for the same thing; WhatsApp needs a second SIM or an unofficial bridge; Slack is better only if other people share the bots.

## Options weighed

| | Hermes Agent | OpenClaw | DIY: Claude Code Channels + Captain | Grok Bot itself |
|---|---|---|---|---|
| Named bots with own instructions | Bot Mode: profile per bot | `agents.entries` + a Telegram bot per agent via `bindings` | One long-lived session per bot, by hand | Yes |
| Routines | cron per bot, `continuity`, chaining, zero-token script jobs | automations/cron, heartbeat | `/loop`, CronCreate, Desktop local tasks (no API trigger) | Yes, 50 per bot |
| Webhook triggers | Yes, HMAC, GitHub native | Yes, bearer only (relay for GitHub); Gmail Pub/Sub | Custom webhook channel (research preview) | Yes, bearer `crsr_` key, no signature |
| Computer use on the Mac | `computer_use` via cua-driver, background, no cursor steal | `computer` tool via Peekaboo or CUA in OpenClaw.app | Claude Code computer use (Pro/Max, preview) | Its own cloud Linux VM |
| Coding in cmux | Custom skill (Captain) | Custom skill (Captain); ACP spawns headless, not in cmux | Captain, already | Cursor Cloud Agents, not your Mac |
| Model for the bot's own brain | Any; ChatGPT OAuth; your Claude plan through the official `claude` CLI (DirectSDK plugin, experimental) | Any; API key, Claude CLI login, setup-token | Your Max plan, first-party | Undisclosed |
| Security record in 2026 | 5 CVEs, fixed; deny-by-default, HMAC required, smart approvals | ClawBleed (CVSS 8.8, exploited), a 9.9 auth bypass, 341+ malicious ClawHub skills; sandbox off by default | Smallest surface | Cursor's |
| Churn | High (patch releases roll up hundreds of PRs) | Higher: 2.0 broke gateways and automations | Low | n/a |

Sources: [Hermes docs](https://hermes-agent.nousresearch.com/docs/), [OpenClaw docs](https://docs.openclaw.ai/), [OpenClaw security coverage](https://www.proarch.com/blog/threats-vulnerabilities/openclaw-rce-vulnerability-cve-2026-25253), [ClawHavoc](https://www.koi.ai/blog/clawhavoc-341-malicious-clawedbot-skills-found-by-the-bot-they-were-targeting), [Claude Code channels](https://code.claude.com/docs/en/channels), [Grok Bot routines](https://docs.x.ai/grok-bot/skills-routines-and-automations).

**Why not OpenClaw.** It has the most features (iMessage via `imsg`, 60-odd bundled skills including `tmux`, `peekaboo` and `coding-agent`, ACP spawns of `claude` and `codex`, an iPhone app that pairs over Tailscale Serve). But its CVE record this year, the default-off sandbox, bearer-only webhooks and the reports of each upgrade breaking cron and delivery make it the worse thing to leave running unattended with your logins. Choose it instead if iMessage is the front door you want.

**Why not DIY on Claude Code alone.** It is the smallest and fully first-party (the Captain chat with `--channels` Telegram and Remote Control), but Channels is a research preview, one long-lived session is fragile across compaction, and "a few bots with their own routines and webhooks" means rebuilding what Hermes ships. Keep it as the fallback if Hermes disappoints.

**Why not Grok Bot or Eve.** Grok Bot's computer is a cloud Linux VM and its coding goes to Cursor Cloud Agents; you want your Mac and your Claude and ChatGPT plans. Eve runs on Vercel Functions and Sandbox and cannot drive a local cmux (already settled in `captain-v3.md`).

## What each piece does

### The Mac mini

- **One macOS user for the bots**, standard (not admin), auto-login so a GUI session exists for computer use and cmux. Your own apps and keychain stay elsewhere.
- **Awake and recoverable**: `sudo pmset -a sleep 0 disksleep 0 displaysleep 10 womp 1 autorestart 1`, "Start up automatically after a power failure", Remote Login on.
- **FileVault trade-off.** Auto-login needs FileVault off. With it on, a reboot stops at the unlock screen before Tailscale is up. macOS 26 can unlock over SSH, but only from the LAN. Pick one: FileVault off with auto-login (simplest for a box at home), or FileVault on and `sudo fdesetup authrestart` before every planned reboot. ([Der Flounder](https://derflounder.wordpress.com/2025/10/11/unlocking-filevault-via-ssh-on-macos-tahoe/))
- **An HDMI dummy plug** (about $10). A headless Mac gives RustDesk and computer use a black or missing framebuffer; BetterDisplay virtual screens reportedly capture nothing on macOS 15. ([RustDesk](https://rustdesk.com/blog/rustdesk-connected-waiting-for-image/))

### Tailscale

- Standalone macOS variant, MagicDNS on, the Mac tagged `tag:macmini`, grants so only your devices reach ports 22 (SSH), 5900 (Screen Sharing), 21118 (RustDesk direct IP) and the Hermes dashboard on 9119.
- **Funnel exactly one path** to the Hermes webhook listener (port 8644), for GitHub: `tailscale funnel --bg --set-path /hooks/github http://127.0.0.1:8644` (check the flags with `tailscale funnel --help`). Never funnel the dashboard, the API server or a shell. Funnel needs the `funnel` node attribute scoped to the tag. ([Funnel](https://tailscale.com/docs/features/tailscale-funnel))

### The screen

- **RustDesk** ("rustydeck"; no product by that name exists) with **direct IP access over Tailscale**: no hbbs/hbbr server, no public ports, WireGuard does the encryption. Set a permanent password and grant Accessibility, Screen Recording and Input Monitoring. ([Tailscale + RustDesk](https://tailscale.com/docs/solutions/access-remote-desktops-with-rustdesk))
- From another Mac, Screen Sharing in High Performance mode is better than RustDesk. From the iPhone, RustDesk or Jump Desktop.
- **Expert's iPhone app** is the Grok Bot "Agent Computer" view with a proper takeover gate. Keep it for watching and taking over. Do not also run Expert's Jev agent: Expert's contract is one desktop engine behind its input lease, and Hermes's cua-driver would be a second one.

### Computer use

- **Hermes `computer_use`** (cua-driver): screenshots, mouse, keyboard, scroll, drag, focus. On macOS it sends events to the target app **in the background without moving your cursor or switching Spaces**, so a RustDesk viewer is not fought. Modes: standard (asks before click and type), bounded (a reviewed manifest), unrestricted. Start in standard. Logout, lock and force-delete key combos are always blocked. ([computer use](https://hermes-agent.nousresearch.com/docs/user-guide/features/computer-use))
- Expect permission fiddling: grants for CuaDriver.app have been reported flapping on macOS 27, and Screen Recording breaks after ad-hoc re-signing ([#99732](https://github.com/NousResearch/hermes-agent/issues/99732), [#78361](https://github.com/NousResearch/hermes-agent/pull/78361)).
- Prefer the ladder Grok Bot uses: connector or CLI first, then browser (Hermes can attach to Chrome over CDP), then the desktop. It is cheaper (about 30K screenshot tokens per 20 actions) and more reliable.
- If a task only needs your Claude plan: Claude Desktop computer use now runs in the background on macOS, and Dispatch sends it tasks from the Claude app. Codex computer use in the ChatGPT desktop app can keep working **after the screen locks**, which suits a headless mini. ([Claude computer use](https://code.claude.com/docs/en/computer-use), [ChatGPT computer use](https://learn.chatgpt.com/docs/computer-use))
- Untrusted input (email, arbitrary web pages) belongs on a restricted bot without `computer_use` or shell, or in a Lume/Tart macOS VM (two VMs maximum per Mac under Apple's licence).

### The bots

Start with two, not five:

| Bot | Job | Tools | Routines and triggers |
|---|---|---|---|
| **Captain** | Code: turn a message or ticket into Captain tasks, start workers, bring back plans and PRs | shell (for `captain`, `gh`, `git`), skill `captain`; no `computer_use` | GitHub webhook (PR review requested, CI failed, issue labelled `bot`); morning "what needs me"; cmux `needs_input` webhook |
| **Ops** | Everything else: research, browser and desktop tasks, admin | `computer_use`, browser, web; shell on ask | Scheduled digests you define; no inbound webhooks from the internet |

Rules shared by both (in each `SOUL.md`): never send, publish, pay or delete without an approval card; no secrets in Telegram, logins happen through the screen takeover; `skills.write_approval: true` so a bot cannot rewrite its own skills unreviewed; approval mode `smart` or `manual`, never YOLO.

### Coding sessions: the `captain` skill

The Hermes skill is short because Captain holds the logic. It teaches the bot the Captain skill's loop (`skills/captain/SKILL.md`) with Hermes's terminal tool instead of a Claude Code session:

1. A message or webhook arrives. `captain add "<task>"` (or `captain add TIG-430`). Reply with one decision card: the tasks, harness and model per task, which are `escalate`.
2. On yes, `captain start <id> --harness claude|codex|cursor`. This opens the cmux workspace with the real CLI logged into your plan. Reply with a card like Grok Bot's Cursor card: title, branch, status, and a link to the session.
3. The board is `captain status --json`, never the bot's memory. A cron routine every 15 minutes, `wakeAgent:false` unless the board changed, costs nothing when nothing moved.
4. Plan gates: `captain approve|reject <id> --note` from the Telegram Allow/Deny buttons. Steering: `captain send <id> "<msg>"`.
5. `ready` rows go to you with the PR link. You merge.

The return path is cmux, not polling: an entry in `~/.cmuxterm/automations.json` on `agent.needs_input` with a `webhook` action POSTs to the Hermes webhook on loopback (signed with the route's secret), which delivers a Telegram card to Captain's chat. ([cmux automations](https://github.com/manaflow-ai/cmux/blob/main/docs/automations.md), [feed](https://github.com/manaflow-ai/cmux/blob/main/docs/feed.md) **[unverified: exact rule schema]**)

To take over a worker yourself, open it from the Claude app: run `claude remote-control --spawn worktree` under launchd for new sessions from the phone, and turn on "Enable Remote Control for all sessions" so Captain's workers are reachable too. For Codex workers, the ChatGPT app's "Control this Mac" does the same. The cmux iOS app (TestFlight) is a third view of the same terminals.

**One cmux setting is required.** cmux's socket defaults to `cmuxOnly`, which refuses any process not started inside cmux, and the Hermes gateway runs under launchd. Set Settings → Automation → Socket Control Mode to Automation mode (Captain's own error message says so), preferably with a socket password rather than open access.

### Which plan pays for what

- **Workers** run the official `claude`, `codex` and `agent` CLIs, logged in with Claude Max, ChatGPT Pro and Cursor Ultra. That is first-party use, the same as Captain today.
- **The bots' own brain can run on your Claude plan** through the `claude-subscription-directsdk` plugin (v0.3.0, 23 Sep 2026, experimental). It spawns the official `claude` CLI per request, so Hermes never holds the OAuth token and usage draws on the plan's Agent SDK allowance at the same rate as `claude -p`. Hermes's own tools, approvals and compaction still apply; Claude Code's native tools are disabled. ([plugin docs](https://hermes-agent.nousresearch.com/docs/plugins/claude-subscription-directsdk))

  ```bash
  hermes plugins install claude-subscription-directsdk   # Hermes 0.21.4+
  claude auth login
  hermes model   # choose "Claude Subscription DirectSDK (Experimental)"
  ```

  What it costs you:
  - **No parallel tool calls and no streaming.** Tool batches arrive only after the whole turn finishes, so a bot answers in one lump.
  - **Per-turn history replay.** There is no parked native session, and the docs measured it using more allowance than the interactive TUI for the same task. The page says both "about 1.7x" and 2.36 vs 2.22 list-price units, so treat the exact overhead as **[unverified]**.
  - **One Claude login for every bot.** The plugin uses whichever account `claude` is logged into, with no isolation per bot, and your coding workers share the same weekly limits.
  - **Turn off extra usage** on the Claude account, or overage bills silently. The plugin has no API-key fallback.

  So: put the **Captain** bot on it (it mostly runs `captain` commands, which suits one-lump replies), keep workers on the same plan, and watch the weekly limit in `captain status`. Put **Ops** on ChatGPT OAuth (`hermes auth add openai-codex`) or an API key if the shared Claude limit gets tight. Hermes does not copy provider OAuth logins such as ChatGPT's between bots, so each of those bots logs in separately.
- Anthropic's third-party harness policy moved four times this year (blocked 4 Apr, credits announced 13 May, paused 15 Jun, still paused as of mid-September). The DirectSDK plugin is exactly the case that policy is about: a third-party harness spending the subscription through the official CLI. If Anthropic revives the separate Agent SDK credit, the Captain bot's brain moves onto that credit or an API key; workers are unaffected. ([VentureBeat](https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch), [The New Stack](https://thenewstack.io/anthropic-pauses-claude-agent-sdk-subscription-change/))

## Phases

Each phase ships on its own and is usable when it lands.

**Phase 0: the box (an evening).**
- [ ] Bot macOS user, auto-login, FileVault decision, `pmset`, dummy plug.
- [ ] Tailscale standalone, MagicDNS, `tag:macmini`, grants; Remote Login and Screen Sharing on.
- [ ] RustDesk with direct IP and a permanent password; verify from the iPhone on cellular.
- [ ] cmux, `claude`, `codex`, `agent`, `gh` logged in; cmux socket in Automation mode with a password; `npm i -g cmux-captain && captain install`; one `captain init`.
- [ ] `claude remote-control --spawn worktree` as a LaunchAgent; verify a new session from the Claude app.

Done when: from the phone on cellular you can see the screen, and start and steer a Claude Code session.

**Phase 1: one bot on Telegram.**
- [ ] Install Hermes, `hermes gateway install`, `hermes doctor`. Dashboard bound to loopback or the tailnet IP with auth.
- [ ] Create the **Captain** bot (Bot Mode), a BotFather token, your Telegram user ID as the only allowed user, approvals `manual` to start.
- [ ] Install `claude-subscription-directsdk`, turn off extra usage on the Claude account, and set the Captain bot's model to it.
- [ ] Write the `captain` skill; test add, start, status, approve end to end from Telegram.
- [ ] cmux automation on `agent.needs_input` → Hermes webhook → Telegram card.

Done when: "fix the flaky billing test in app" from Telegram produces a cmux workspace, a plan card, and a PR link.

**Phase 2: triggers and routines.**
- [ ] Tailscale Funnel on `/hooks/github` only; a Hermes GitHub route with the webhook secret; subscribe the repos you want (review requested, check failed, `bot` label).
- [ ] Routines: morning "what needs me" at 08:45, board check every 15 minutes (script pre-check, no tokens when idle), Friday "what got done" from `captain gain`.

**Phase 3: the Ops bot and computer use.**
- [ ] `hermes computer-use install`, grant CuaDriver.app, `hermes computer-use doctor`; standard mode.
- [ ] Create **Ops** with `computer_use` and the browser; no inbound webhooks; approvals on anything outward-facing.
- [ ] Pick three real tasks you would hand Grok Bot and run them while watching in RustDesk or Expert. Turn the ones that work into skills.

**Later, only when the trigger happens.**

| Thing | Add it when |
|---|---|
| A third bot | A job keeps getting mis-routed between Captain and Ops |
| Expert as the computer tool (its MCP bridge) instead of cua-driver | You need the takeover gate to bind the bot, not only the human |
| A Lume VM for Ops | Ops starts reading email or arbitrary web pages unattended |
| Own iOS app (in Expert) | Telegram cards cannot show what you need to approve, such as a screenshot next to the Send button |
| Switch to OpenClaw | You want iMessage as the front door, and its advisories have gone quiet |
| Drop Hermes for Claude Code Channels | Hermes upgrades break routines more than once a month |

## Risks to watch

- **Everything shares one user's logins.** Grok Bot's docs say it twice: separate bots are not a security boundary. Same here. The bot user holds GitHub, Claude, ChatGPT and whatever the browser is signed into. Keep that user's scope small.
- **Workers run with permissions bypassed** (Captain launches Claude Code with `--dangerously-skip-permissions` for ungated tasks and Codex with `--dangerously-bypass-approvals-and-sandbox`). The worktree is hygiene, not containment. Escalate-tier tasks still stop at the plan gate.
- **Webhook text is untrusted.** A PR title or issue body is prompt input from strangers. The Captain bot turns webhooks into task proposals and asks; it does not start workers from a webhook without your yes.
- **Churn.** Hermes shipped five patch releases in September. Pin a version, update deliberately, and keep `hermes doctor` and a routine test in the update checklist.
