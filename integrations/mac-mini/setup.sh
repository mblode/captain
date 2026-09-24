#!/usr/bin/env bash
# Set up the Mac mini as a Grok Bot-style box: Hermes bots in Slack, Captain
# starting Claude Code and Codex in cmux worktrees, Remote Control for the phone.
# The plan and its reasons: docs/plans/mac-mini-bots.md.
#
#   ./setup.sh               every step in order (safe to re-run)
#   ./setup.sh <step>...     only these steps
#   ./setup.sh github-hook <owner/repo>   send a repo's events to the bot
#   ./setup.sh manual        the steps only you can do (permissions, Slack app)
#
# Steps: preflight power tools logins captain secrets hermes bot cmux
#        remote-control routines gateway funnel manual
#
# Run it on the Mac mini, logged in as the bot's macOS user, from this folder.
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="captain-bot" # not "captain": Hermes adds a CLI alias per profile, which would shadow the captain CLI
PROFILE_DIR="$HOME/.hermes/profiles/$PROFILE"
SHARE="$HOME/.local/share/captain-bot"
BIN="$SHARE/bin"
SECRETS="$HOME/.config/captain-bot/secrets.env"
CODE_DIR="${CODE_DIR:-$HOME/code}"
WEBHOOK_PORT="${WEBHOOK_PORT:-8644}"
PLIST_LABEL="co.blode.claude-remote-control"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok() { printf '   ok  %s\n' "$*"; }
todo() { printf '   \033[33mtodo\033[0m %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }
# cmux puts shims for claude, codex and hermes on PATH that exist even when the
# real tool is missing, so "installed" means the binary answers --version.
works() { "$1" --version >/dev/null 2>&1; }
# PATH without cmux's per-session shim folders, for services that outlive this shell.
clean_path() { tr ':' '\n' <<<"$HOME/.local/bin:$PATH" | grep -v 'cmux-cli-shims' | awk '!seen[$0]++' | paste -sd: -; }
# The first real binary for a command, skipping cmux shims.
real_bin() { PATH="$(clean_path)" command -v "$1" || true; }
ask() { local reply; read -r -p "   $1 [y/N] " reply; [[ "$reply" =~ ^[Yy]$ ]]; }

# Replace or append KEY=value in an env file, keeping it private.
upsert_env() {
  local file="$1" key="$2" value="$3" tmp
  mkdir -p "$(dirname "$file")"
  touch "$file"
  chmod 600 "$file"
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" 'BEGIN{done=0} $0 ~ "^"k"=" {print k"="v; done=1; next} {print} END{if(!done) print k"="v}' "$file" >"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

env_get() { [[ -f "$1" ]] && grep -E "^$2=" "$1" | tail -1 | cut -d= -f2- || true; }

tailscale_cli() {
  if has tailscale; then echo tailscale
  elif [[ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]]; then echo /Applications/Tailscale.app/Contents/MacOS/Tailscale
  fi
}

# ------------------------------------------------------------------ steps

step_preflight() {
  say "Preflight"
  [[ "$(uname -s)" == "Darwin" ]] || die "run this on the Mac mini"
  [[ "$EUID" -ne 0 ]] || die "run as the bot's user, not root"
  ok "macOS $(sw_vers -productVersion) on $(uname -m), user $(whoami)"
  has brew || die "install Homebrew first: https://brew.sh"
  ok "Homebrew"
}

step_power() {
  say "Power: stay awake, restart after a power cut"
  if pmset -g | grep -qE '^ *sleep +0'; then
    ok "system sleep already off"
  elif ask "Run sudo pmset (no system sleep, display sleeps after 10 min, wake on LAN, auto-restart)?"; then
    sudo pmset -a sleep 0 disksleep 0 displaysleep 10 womp 1 autorestart 1
    ok "pmset applied"
  else
    todo "pmset skipped"
  fi
}

step_tools() {
  say "Tools"
  local formula
  for formula in node jq yq gh; do
    if has "$formula"; then ok "$formula"; else brew install "$formula"; fi
  done
  if [[ -d /Applications/cmux.app ]] || has cmux; then ok "cmux"; else brew install --cask cmux; fi
  if [[ -d /Applications/RustDesk.app ]]; then ok "RustDesk"; else brew install --cask rustdesk; fi
  if works claude; then ok "claude $(claude --version 2>/dev/null | head -1)"; else curl -fsSL https://claude.ai/install.sh | bash; fi
  if works codex; then ok "codex"; else npm install -g @openai/codex; fi
  if [[ -n "$(tailscale_cli)" ]]; then ok "Tailscale"; else todo "install Tailscale (standalone): https://tailscale.com/download/mac"; fi
  has agent && ok "Cursor CLI (optional)" || todo "optional: Cursor CLI for --harness cursor: https://cursor.com/cli"
}

step_logins() {
  say "Logins (your plans; workers use these)"
  if claude auth status >/dev/null 2>&1; then ok "claude logged in"; else todo "claude auth login"; fi
  if codex login status >/dev/null 2>&1; then ok "codex logged in"; else todo "codex login"; fi
  if gh auth status >/dev/null 2>&1; then ok "gh logged in"; else todo "gh auth login"; fi
}

step_captain() {
  say "Captain"
  if works captain; then ok "captain $(captain --version)"; else npm install -g cmux-captain; fi
  captain install || todo "captain install reported something missing (above)"
  mkdir -p "$CODE_DIR"
  todo "create a project per repo: captain init <name> --repo $CODE_DIR/<repo> --wip 4"
}

step_secrets() {
  say "Webhook secrets"
  local route var
  for route in github cmux; do
    var="HERMES_ROUTE_SECRET_$(printf '%s' "$route" | tr '[:lower:]' '[:upper:]')"
    if [[ -n "$(env_get "$SECRETS" "$var")" ]]; then
      ok "$var"
    else
      upsert_env "$SECRETS" "$var" "$(openssl rand -hex 32)"
      ok "$var generated"
    fi
  done
  upsert_env "$SECRETS" WEBHOOK_PORT "$WEBHOOK_PORT"
  ok "secrets in $SECRETS (mode 600)"
}

step_hermes() {
  say "Hermes Agent"
  if works hermes; then
    ok "hermes $(hermes --version 2>/dev/null | head -1)"
  else
    curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
    export PATH="$HOME/.local/bin:$PATH"
    works hermes || die "hermes not on PATH after install; open a new shell and re-run"
  fi
}

step_bot() {
  say "Bot: $PROFILE"
  if [[ -d "$PROFILE_DIR" ]]; then ok "profile exists"; else hermes profile create "$PROFILE"; fi

  touch "$PROFILE_DIR/profile.yaml"
  yq -i '.ui_meta."hermes-bots" = (.ui_meta."hermes-bots" // {})' "$PROFILE_DIR/profile.yaml"
  ok "Bot Mode on"

  # A profile has its own plugin folder; a plugin installed for the default
  # Hermes home is invisible to it ("Unknown provider").
  if [[ -d "$PROFILE_DIR/plugins/claude-subscription-directsdk-experimental" ]]; then
    ok "Claude plan plugin"
  else
    hermes -p "$PROFILE" plugins install claude-subscription-directsdk </dev/null || todo "plugin install failed; Hermes 0.21.4+ is required (hermes update)"
  fi

  cp "$KIT/hermes/captain-bot/SOUL.md" "$PROFILE_DIR/SOUL.md"
  mkdir -p "$PROFILE_DIR/skills/captain/references"
  cp "$KIT/hermes/captain-bot/skills/captain/SKILL.md" "$PROFILE_DIR/skills/captain/SKILL.md"
  local playbook
  playbook="$(npm root -g)/cmux-captain/skills/captain/SKILL.md"
  if [[ -f "$playbook" ]]; then
    cp "$playbook" "$PROFILE_DIR/skills/captain/references/captain-chat.md"
    ok "SOUL.md, skill and Captain playbook installed"
  else
    todo "Captain playbook not found at $playbook (run the captain step)"
  fi

  mkdir -p "$BIN"
  cp "$KIT/bin/hermes-notify" "$BIN/"
  chmod 755 "$BIN/"*
  ok "helpers in $BIN"

  # Slack: tokens go only in the profile's private .env.
  local env="$PROFILE_DIR/.env" key value=""
  for key in SLACK_BOT_TOKEN SLACK_APP_TOKEN SLACK_ALLOWED_USERS SLACK_HOME_CHANNEL; do
    value=""
    if [[ -n "$(env_get "$env" "$key")" ]]; then ok "$key set"; continue; fi
    case "$key" in
      SLACK_BOT_TOKEN) read -r -s -p "   Slack bot token (xoxb-…, blank to skip): " value || true; echo ;;
      SLACK_APP_TOKEN) read -r -s -p "   Slack app token (xapp-…, blank to skip): " value || true; echo ;;
      SLACK_ALLOWED_USERS) read -r -p "   Your Slack member ID (U…, blank to skip): " value || true ;;
      SLACK_HOME_CHANNEL) read -r -p "   #captain channel ID (C…, blank to skip): " value || true ;;
    esac
    if [[ -n "$value" ]]; then upsert_env "$env" "$key" "$value"; ok "$key saved"; else todo "$key (see ./setup.sh manual)"; fi
  done

  # Config: model, approvals, Slack threading.
  touch "$PROFILE_DIR/config.yaml"
  yq -i ". *= load(\"$KIT/hermes/captain-bot/config.overlay.yaml\")" "$PROFILE_DIR/config.yaml"
  chmod 600 "$PROFILE_DIR/config.yaml"
  ok "profile config merged (model on the Claude plan, manual approvals, Slack threads)"

  # Webhook routes belong to the host gateway (the default profile); each route
  # names the profile that handles it and is served at /p/$PROFILE/webhooks/<route>.
  # shellcheck source=/dev/null
  source "$SECRETS"
  local channel overlay
  channel="$(env_get "$env" SLACK_HOME_CHANNEL)"
  overlay="$(mktemp)"
  sed -e "s|__SECRET_GITHUB__|${HERMES_ROUTE_SECRET_GITHUB}|" \
      -e "s|__SECRET_CMUX__|${HERMES_ROUTE_SECRET_CMUX}|" \
      -e "s|__SLACK_CHANNEL__|${channel}|" \
      "$KIT/hermes/webhooks.overlay.yaml" >"$overlay"
  touch "$HOME/.hermes/config.yaml"
  yq -i ". *= load(\"$overlay\")" "$HOME/.hermes/config.yaml"
  chmod 600 "$HOME/.hermes/config.yaml"
  rm -f "$overlay"
  upsert_env "$HOME/.hermes/.env" WEBHOOK_ENABLED true
  upsert_env "$HOME/.hermes/.env" WEBHOOK_PORT "$WEBHOOK_PORT"
  ok "webhook routes github + cmux on the host gateway, bound to $PROFILE"
  todo "turn off extra usage on your Claude account so the bot cannot bill overage"
}

step_cmux() {
  say "cmux: tell the bot when a worker needs input"
  local dir="$HOME/.cmuxterm" file new
  file="$dir/automations.json"
  mkdir -p "$dir"
  new="$(mktemp)"
  sed "s|__BIN__|$BIN|" "$KIT/cmux/automations.json" >"$new"
  if [[ -f "$file" ]]; then
    cp "$file" "$file.bak"
    jq --slurpfile add "$new" \
      '.version = (.version // 1) | .rules = ([(.rules // [])[] | select(.id != "captain-bot-needs-input")] + $add[0].rules)' \
      "$file.bak" >"$file"
    ok "rule merged (previous file: $file.bak)"
  else
    cp "$new" "$file"
    ok "rule written"
  fi
  rm -f "$new"
  if has cmux && cmux ping >/dev/null 2>&1; then
    cmux automation reload && ok "cmux reloaded"
  else
    todo "open cmux, then: cmux automation reload"
  fi
  todo "cmux Settings → Automation → Socket Control Mode: Automation mode (not full open access)"
}

step_remote_control() {
  say "Claude Code Remote Control (start sessions from the Claude app)"
  local plist="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist" settings="$HOME/.claude/settings.json"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$CODE_DIR"
  local claude_bin agent_path
  claude_bin="$(real_bin claude)"
  [[ -n "$claude_bin" ]] || { todo "claude not found; run the tools step"; return; }
  agent_path="$(clean_path)"
  sed -e "s|__CODE_DIR__|$CODE_DIR|" -e "s|__HOME__|$HOME|g" \
      -e "s|__CLAUDE__|$claude_bin|" -e "s|__PATH__|$agent_path|" \
      "$KIT/launchd/$PLIST_LABEL.plist" >"$plist"
  launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  ok "LaunchAgent loaded; log: ~/Library/Logs/claude-remote-control.log"

  # Make Captain's workers reachable from the phone too.
  mkdir -p "$(dirname "$settings")"
  [[ -f "$settings" ]] || echo '{}' >"$settings"
  jq '.remoteControlAtStartup = true' "$settings" >"$settings.tmp" && mv "$settings.tmp" "$settings"
  ok "Remote Control on for every session"
}

step_routines() {
  say "Routines"
  # Routine scripts must live in the profile's own scripts folder; .sh runs via bash.
  mkdir -p "$PROFILE_DIR/scripts"
  cp "$KIT/bin/board-watch.sh" "$PROFILE_DIR/scripts/board-watch.sh"
  chmod 755 "$PROFILE_DIR/scripts/board-watch.sh"
  local existing
  existing="$(hermes -p "$PROFILE" cron list 2>/dev/null || true)"
  add_routine() {
    local name="$1"; shift
    if grep -qF "$name" <<<"$existing"; then ok "$name exists"; return; fi
    hermes -p "$PROFILE" cron create --name "$name" "$@" && ok "$name" || todo "$name failed; create it in the dashboard"
  }
  # The board check runs the bot only when the actionable rows change.
  add_routine "captain-board" "every 15m" \
    "The Captain board changed. Act on the rows as the captain skill says, and post only what needs Matt." \
    --skill captain --monitor-script board-watch.sh --deliver slack
  add_routine "captain-morning" "45 8 * * 1-5" \
    "Morning summary as the captain skill says: READY TO MERGE with links, then NEEDS YOU, then one line on what ran overnight." \
    --skill captain --deliver slack
  add_routine "captain-weekly" "45 16 * * 5" \
    "Weekly numbers: run captain gain --since 7d --json. Three lines, then one suggested change." \
    --skill captain --deliver slack
}

step_gateway() {
  say "Hermes gateway (launchd)"
  # One host gateway (the default profile's) serves every profile on the Mac.
  PATH="$(clean_path)" hermes gateway install
  ok "host gateway installed; re-run this step after installing new tools (it captures PATH)"
  hermes -p "$PROFILE" doctor || todo "hermes doctor reported problems (above)"
}

step_funnel() {
  say "Tailscale Funnel: publish the GitHub route only"
  local ts
  ts="$(tailscale_cli)"
  [[ -n "$ts" ]] || { todo "install Tailscale first"; return; }
  local path="/p/$PROFILE/webhooks/github"
  if "$ts" funnel status 2>/dev/null | grep -q "$path"; then ok "already published"; return; fi
  if ask "Publish https://<this Mac>.ts.net$path to the internet (HMAC-checked by Hermes)?"; then
    "$ts" funnel --bg --set-path "$path" "http://127.0.0.1:$WEBHOOK_PORT$path"
    "$ts" funnel status
    todo "Funnel needs the funnel node attribute in your tailnet policy; if refused, add it and re-run"
  else
    todo "funnel skipped; GitHub triggers stay off"
  fi
}

step_github_hook() {
  local repo="${1:?usage: ./setup.sh github-hook <owner/repo>}" ts host
  ts="$(tailscale_cli)"
  host="$("$ts" status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
  # shellcheck source=/dev/null
  source "$SECRETS"
  local url="https://$host/p/$PROFILE/webhooks/github"
  say "GitHub webhook: $repo → $url"
  gh api "repos/$repo/hooks" -X POST \
    -f name=web -F active=true \
    -f 'events[]=pull_request' -f 'events[]=pull_request_review' -f 'events[]=check_suite' \
    -f 'events[]=issues' -f 'events[]=issue_comment' \
    -f "config[url]=$url" \
    -f config[content_type]=json \
    -f "config[secret]=$HERMES_ROUTE_SECRET_GITHUB" \
    --jq '"   ok  hook \(.id); GitHub sends a ping now: check it in the repo settings"'
}

step_manual() {
  say "Only you can do these"
  cat <<EOF
   1. Hardware: an HDMI dummy plug, so the screen is never black for RustDesk or computer use.
   2. Login: System Settings → Users & Groups → automatic login as $(whoami).
      Needs FileVault off; otherwise run 'sudo fdesetup authrestart' before planned reboots.
   3. Sharing: turn on Remote Login (SSH over Tailscale). RustDesk is the screen; Screen Sharing can stay off.
   4. Tailscale: sign in, MagicDNS on, tag this Mac (tag:macmini), and limit access to your devices.
   5. RustDesk: Settings → Security → Enable direct IP access; set a permanent password;
      grant Accessibility, Screen Recording and Input Monitoring. Connect from the phone to
      $(hostname -s) over Tailscale on cellular to prove it.
   6. cmux: Settings → Automation → Socket Control Mode → Automation mode.
   7. Slack app (personal workspace):
        hermes -p $PROFILE slack manifest --agent-view --write
      Create the app at https://api.slack.com/apps from that manifest; enable Socket Mode with an
      app token (connections:write); install it; turn on the Messages tab; make #captain and
      /invite the bot. Then: ./setup.sh bot gateway  (to save the tokens and restart).
   8. Claude account: turn off extra usage.
   9. Claude app: Code → your Mac appears under Remote Control; start a session to prove it.
  10. First task, from Slack in #captain: "@Captain fix <something small> in <repo>".
EOF
}

# ------------------------------------------------------------------ main

ALL=(preflight power tools logins captain secrets hermes bot cmux remote-control routines gateway funnel manual)

run_step() {
  case "$1" in
    preflight) step_preflight ;;
    power) step_power ;;
    tools) step_tools ;;
    logins) step_logins ;;
    captain) step_captain ;;
    secrets) step_secrets ;;
    hermes) step_hermes ;;
    bot) step_secrets; step_bot ;;
    cmux) step_cmux ;;
    remote-control) step_remote_control ;;
    routines) step_routines ;;
    gateway) step_gateway ;;
    funnel) step_funnel ;;
    manual) step_manual ;;
    *) die "unknown step: $1 (steps: ${ALL[*]}, github-hook)" ;;
  esac
}

if [[ "${1:-}" == "github-hook" ]]; then
  step_github_hook "${2:-}"
elif [[ $# -eq 0 ]]; then
  for s in "${ALL[@]}"; do run_step "$s"; done
else
  for s in "$@"; do run_step "$s"; done
fi
