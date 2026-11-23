# checker

Runs every 10 min in GitHub Actions (`.github/workflows/check.yml`). Per watch: fetch → extract text →
selector / ignore / contains filters → diff against `last_text` → Web Push to subscribers → report to the Worker.

- `mode=plain`: HTTP only. `mode=browser`: headless Chromium (Playwright). `mode=feed`: RSS/Atom items.
- `mode=auto` (default): HTTP first; falls back to Chromium when the page is a bot wall, the selector
  isn't in the static HTML, or there's < 200 chars of text. Still blocked ⇒ `last_error = "blocked (HTTP …)"`.
- Relative timestamps ("5 minutes ago", "12 perce", "2 ore fa", "yesterday") are cut out of every line before
  comparing, so they never trigger an alert. The rest of the line is still compared.
- `mode=feed`: HTTP 403/429 ⇒ `blocked`. In `auto`, a plain-fetch timeout also falls back to Chromium.
- Push services answering 404/410 ⇒ endpoint sent back as `dead_endpoints` and deleted.
- Changing extraction output? Bump `EXTRACT_VERSION` in `check.py` so watches re-baseline instead of alerting.

## Local

```sh
uv venv .venv && uv pip install -p .venv -r requirements.txt && .venv/bin/python -m playwright install --only-shell chromium
.venv/bin/python -m unittest -v                      # offline tests, incl. encrypted push round-trip
.venv/bin/python gen_vapid.py > .env.vapid           # once; public key goes in worker/wrangler.toml
# with `cd ../worker && npm run db:local && npm run dev` running:
set -a; . ../worker/.dev.vars; . ./.env.vapid; set +a
API_URL=http://localhost:8787 .venv/bin/python check.py      # --dry-run: no push, no report
```

Actions secrets: `API_URL`, `CHECKER_TOKEN`, `VAPID_PRIVATE_KEY` (from `.env.vapid`, never committed).
