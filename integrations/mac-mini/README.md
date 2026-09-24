# Captain on a Mac mini, driven from Slack

A Grok Bot–style setup on your own Mac mini. A Hermes bot named Captain lives in Slack. It turns what you ask for into Captain tasks, starts Claude Code, Codex or Cursor in cmux worktrees, and posts only decisions back: plans to approve, questions a worker asked, PRs ready to merge. Why it is shaped this way: [`docs/plans/mac-mini-bots.md`](../../docs/plans/mac-mini-bots.md).

```
Slack #captain ─ Socket Mode ─┐
                              ▼
Mac mini ─ Hermes gateway (profile captain-bot, brain on your Claude plan)
             ├─ skill captain ── captain add/start/status/approve/send ── cmux + worktree + claude|codex
             ├─ routine every 15m (board-changed pre-check: no tokens when idle)
             ├─ routines: weekday morning summary, Friday numbers
             ├─ webhook /webhooks/cmux   ◄── cmux automation: a worker needs input
             └─ webhook /webhooks/github ◄── Tailscale Funnel ◄── GitHub (HMAC)
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
| `hermes` | Installs Hermes and the `claude-subscription-directsdk` plugin |
| `bot` | Creates the `captain-bot` profile in Bot Mode: `SOUL.md`, the `captain` skill with Captain's playbook, the Slack tokens you paste, and config (Claude plan model, manual approvals, Slack threads, the two routes) |
| `cmux` | Adds a rule to `~/.cmuxterm/automations.json`: when a Captain worker (`t-…` workspace) needs input, sign the event and post it to the bot |
| `remote-control` | A LaunchAgent running `claude remote-control --spawn worktree` in `~/code`, and Remote Control on for every session |
| `routines` | Board check every 15 min, weekday 8:45 summary, Friday 4:45 numbers |
| `gateway` | `hermes gateway install` for the profile (launchd), then `hermes doctor` |
| `funnel` | Publishes only `/webhooks/github` through Tailscale Funnel (asks first) |

The profile is `captain-bot`, not `captain`: Hermes makes a shell alias per profile, and `captain` would shadow the Captain CLI.

## Files

| Path | Installed to |
| --- | --- |
| `hermes/captain-bot/SOUL.md` | `~/.hermes/profiles/captain-bot/SOUL.md` |
| `hermes/captain-bot/skills/captain/SKILL.md` | `…/captain-bot/skills/captain/` (plus Captain's own skill as `references/captain-chat.md`) |
| `hermes/captain-bot/config.overlay.yaml` | Deep-merged into `…/captain-bot/config.yaml` |
| `bin/hermes-notify` | `~/.local/share/captain-bot/bin/`; signs a body with Hermes's generic V2 HMAC and posts it to a local route |
| `bin/board-changed` | Same folder; the routine's pre-check. Prints `{"wakeAgent": false}` unless an actionable row changed |
| `cmux/automations.json` | Merged into `~/.cmuxterm/automations.json` |
| `launchd/co.blode.claude-remote-control.plist` | `~/Library/LaunchAgents/` |

## Check it works

1. In Slack, DM the bot "what needs me?". It should run `captain status` and answer.
2. In `#captain`: "@Captain fix the typo in the README of <repo>". You get a task card; say yes; a cmux workspace opens on the Mac with the worker.
3. Give it an escalate task. When the plan is ready, the Approve and Reject buttons appear in the thread.
4. From the Claude app on your phone, open the worker's session through Remote Control.
5. After `./setup.sh github-hook owner/repo`, GitHub's ping should show a green tick in the repo's webhook settings.

## What was not verified

This kit was written and tested off the Mac: shellcheck clean, the webhook signature checked against a verifier implementing Hermes's documented V2 scheme, the board pre-check run against sample boards, and the config and cmux merges run with yq v4 and jq. It has not run against a live Hermes, cmux or Slack. Check these on the first run:

- Hermes config keys `approvals.mode` and `skills.write_approval`, and the profile skills folder (`hermes -p captain-bot doctor`, `hermes -p captain-bot skills list`).
- `hermes cron create` accepting `--script` with an absolute path, and `--deliver slack` using `SLACK_HOME_CHANNEL`.
- The cmux event carrying `workspace.title` for the `t-` filter (`cmux automation test captain-bot-needs-input --event @sample.json`).
- The `remoteControlAtStartup` settings key.
- Whether `platforms.webhook.extra.port` is honoured (Hermes issue #10206 says no; the kit sets `WEBHOOK_PORT` in the profile `.env` for that reason).
