#!/bin/bash
# Home checker: reads the watches GitHub's runners get blocked on, from this computer's own connection.
# launchd runs it every 10 min (see install.sh). Settings: ~/.config/site-watch/home.env
#   API_URL=https://site-watch.zsolt-szavo.workers.dev
#   CHECKER_TOKEN=…        (the Worker's CHECKER_TOKEN secret)
#   VAPID_PRIVATE_KEY=…    (from checker/.env.vapid)
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . "$HOME/.config/site-watch/home.env"; set +a
exec .venv/bin/python check.py --home
