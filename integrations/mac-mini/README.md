# Captain on a Mac mini, driven from Slack

A Grok Bot–style setup on your own Mac mini. A Hermes bot named Captain lives in Slack. It turns what you ask for into Captain tasks, starts Claude Code, Codex or Cursor in cmux worktrees, and posts only decisions back: plans to approve, questions a worker asked, PRs ready to merge. Why it is shaped this way: [`docs/plans/mac-mini-bots.md`](../../docs/plans/mac-mini-bots.md).

```
Slack #captain ─ Socket Mode ─┐
                              ▼
Mac mini ─ Hermes host gateway ─ profile captain-bot (brain on your Claude plan)
             ├─ skill captain ── captain add/start/status/approve/send ── cmux + worktree + claude|codex
             ├─ routine every 15m (board-watch monitor: no tokens when the board is unchanged)
             ├─ routines: weekday morning summary, Friday numbers
             ├─ /p/captain-bot/webhooks/cmux   ◄── cmux automation: a worker needs input
             └─ /p/captain-bot/webhooks/github ◄── Tailscale Funnel ◄── GitHub (HMAC)
Phone ─ Claude app (Remote Control) · RustDesk over Tailscale · Slack
```

## Run it

On the Mac mini, logged in as the user the bot will run as:

```bash
git clone https://github.com/mblode/captain.git ~/code/captain
cd ~/code/captain/integrations/mac-mini
./setup.sh            # every step; safe to re-run
./setup.sh manual     # what only you can do: permissions, the Slack app, the dummy plug
```

Re-run a single step with `./setup.sh <step>`. After you create the Slack app, `./setup.sh bot gateway` saves its tokens and restarts the bot. To send a repo's PR and CI events to the bot: `./setup.sh github-hook owner/repo`.

| Step | What it does |
| --- | --- |
| `preflight` | macOS, not root, Homebrew present |
| `power` | `pmset`: no system sleep, restart after power loss, wake on LAN (asks first) |
| `tools` | node, jq, yq, gh, cmux, RustDesk, `claude`, `codex`; points you to Tailscale and the Cursor CLI |
| `logins` | Checks `claude`, `codex` and `gh` are logged in (workers use your plans) |
| `captain` | `npm i -g cmux-captain`, `captain install` |
| `secrets` | One random HMAC secret per webhook route in `~/.config/captain-bot/secrets.env` (mode 600) |
| `hermes` | Installs Hermes |
| `bot` | Creates the `captain-bot` profile in Bot Mode and installs the Claude plan plugin into it (plugins are per profile): `SOUL.md`, the `captain` skill with Captain's playbook, the Slack tokens you paste, and profile config (Claude plan model, manual approvals, Slack threads). Adds the `github` and `cmux` routes to the host gateway's config, bound to `captain-bot` |
| `slack-manifest` | Writes the Slack app manifest named Captain, with six slash commands (the full set pushes Slack's workspace picker off-screen) |
| `cmux` | Adds a rule to `~/.cmuxterm/automations.json`: when a Captain worker (`t-…` workspace) needs input, sign the event and post it to the bot |
| `remote-control` | A LaunchAgent running `claude remote-control --spawn session` in `~/code`, with the absolute `claude` path and a shim-free PATH baked in (launchd's PATH is minimal), and Remote Control on for every session |
| `routines` | Board check every 15 min, weekday 8:45 summary, Friday 4:45 numbers |
| `gateway` | `hermes gateway install` from the default profile: one host gateway (launchd) serves every profile. Then `hermes doctor` |
| `funnel` | Publishes only `/p/captain-bot/webhooks/github` through Tailscale Funnel (asks first) |

The profile is `captain-bot`, not `captain`: Hermes makes a shell alias per profile, and `captain` would shadow the Captain CLI.

## Files

| Path | Installed to |
| --- | --- |
| `hermes/captain-bot/SOUL.md` | `~/.hermes/profiles/captain-bot/SOUL.md` |
| `hermes/captain-bot/skills/captain/SKILL.md` | `…/captain-bot/skills/captain/` (plus Captain's own skill as `references/captain-chat.md`) |
| `hermes/captain-bot/config.overlay.yaml` | Deep-merged into `…/captain-bot/config.yaml` |
| `hermes/webhooks.overlay.yaml` | Deep-merged into `~/.hermes/config.yaml` (the host gateway), each route with `profile: captain-bot` |
| `bin/hermes-notify` | `~/.local/share/captain-bot/bin/`; signs a body with Hermes's generic V2 HMAC and posts it to a local route |
| `bin/board-watch.sh` | `~/.hermes/profiles/captain-bot/scripts/`; the board routine's monitor script. Prints the actionable rows; Hermes runs the bot only when that output changes |
| `cmux/automations.json` | Merged into `~/.cmuxterm/automations.json` |
| `launchd/co.blode.claude-remote-control.plist` | `~/Library/LaunchAgents/` |

## Check it works

1. In Slack, DM the bot "what needs me?". It should run `captain status` and answer.
2. In `#captain`: "@Captain fix the typo in the README of <repo>". You get a task card; say yes; a cmux workspace opens on the Mac with the worker.
3. Give it an escalate task. When the plan is ready, the Approve and Reject buttons appear in the thread.
4. From the Claude app on your phone, open the worker's session through Remote Control.
5. After `./setup.sh github-hook owner/repo`, GitHub's ping should show a green tick in the repo's webhook settings.

## What the first run on the Mac mini changed

The first live run (Hermes 0.21.5, cmux, 24 Sep) found five gaps, now fixed in the kit:

- cmux puts `claude`, `codex` and `hermes` shims on PATH even when the real tool is missing, so `tools` now checks that `--version` answers instead of trusting `command -v`.
- Plugins are per profile: the Claude plan plugin is installed into `captain-bot`, not the default profile.
- One host gateway serves every profile. It is installed from the default profile, and webhook routes live in its config with `profile: captain-bot`, served at `/p/captain-bot/webhooks/<route>`. `hermes-notify`, Funnel and `github-hook` use that path.
- Routine scripts must sit in the profile's `scripts/` folder. The board check is a `--monitor-script` whose output Hermes hashes each tick, so the bot runs only when the actionable rows change. Schedules are cron expressions.
- launchd starts with a minimal PATH, so the Remote Control LaunchAgent carries the absolute `claude` path and a shim-free PATH, and spawns one session per request (worktree mode needs the folder itself to be a repo).

## Still to confirm

- Slack end to end: a DM, a task card, the Approve and Reject buttons on an escalate plan.
- Hermes config keys `approvals.mode` and `skills.write_approval` (`hermes -p captain-bot doctor`).
- The cmux event carrying `workspace.title` for the `t-` filter (`cmux automation test captain-bot-needs-input --event @sample.json`).
- The `remoteControlAtStartup` settings key.
- A GitHub ping through Funnel reaching the route (green tick in the repo's webhook settings).
