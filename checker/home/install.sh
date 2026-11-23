#!/bin/bash
# Installs (or updates) the home checker as a launchd agent: every 10 min, and once at login/wake.
# Uninstall: launchctl bootout gui/$(id -u)/dev.site-watch.home && rm ~/Library/LaunchAgents/dev.site-watch.home.plist
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV="$HOME/.config/site-watch/home.env"
PLIST="$HOME/Library/LaunchAgents/dev.site-watch.home.plist"
LOG="$HOME/Library/Logs/site-watch-home.log"
[ -x "$HERE/../.venv/bin/python" ] || { echo "no checker/.venv: set it up first (checker/README.md, Local)"; exit 1; }
if [ ! -f "$ENV" ]; then
  mkdir -p "$(dirname "$ENV")"
  read -rp "Worker URL [https://site-watch.zsolt-szavo.workers.dev]: " api
  read -rsp "CHECKER_TOKEN (the Worker secret): " tok; echo
  vapid=$(sed -n 's/^VAPID_PRIVATE_KEY=//p' "$HERE/../.env.vapid" 2>/dev/null || true)
  [ -n "$vapid" ] || { read -rsp "VAPID_PRIVATE_KEY: " vapid; echo; }
  umask 077
  printf 'API_URL=%s\nCHECKER_TOKEN=%s\nVAPID_PRIVATE_KEY=%s\n' "${api:-https://site-watch.zsolt-szavo.workers.dev}" "$tok" "$vapid" > "$ENV"
  echo "wrote $ENV (only you can read it)"
fi
chmod +x "$HERE/run.sh"
mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.site-watch.home</string>
  <key>ProgramArguments</key><array><string>$HERE/run.sh</string></array>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/dev.site-watch.home" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed; runs every 10 min. Log: $LOG"
