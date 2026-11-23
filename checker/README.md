# checker

Runs every 10 min in GitHub Actions (`.github/workflows/check.yml`). Per watch: fetch → extract text →
selector / ignore / contains filters → diff against `last_text` → Web Push to subscribers → report to the Worker.

- `mode=plain`: HTTP only. `mode=browser`: headless Chromium (Playwright). `mode=feed`: RSS/Atom items.
- `mode=auto` (default): HTTP first; falls back to Chromium when the page is a bot wall, the selector
  isn't in the static HTML, or there's < 200 chars of text. Still blocked ⇒ `last_error = "blocked (HTTP …)"`.
- Screenshots: after the text pass, one Chromium run takes a 1280×900 viewport JPEG (quality 60, retried at 35 if
  > 900 kB) of every page that was read; browser-mode pages reuse their load, plain ones get one extra load. It goes
  to the Worker base64 as `shot`; a failed picture never fails the watch. `--no-shots` skips them.
- Relative timestamps ("5 minutes ago", "12 perce", "2 ore fa", "yesterday") are cut out of every line before
  comparing, so they never trigger an alert. The rest of the line is still compared.
- Politeness / rate limits: each URL is downloaded once per run (watches sharing a page share the download),
  requests to one host are spaced 3 s apart (one thread per host), a 429/503 is retried once after `Retry-After` (≤ 20 s),
  and a still-blocked plain fetch (or a timeout) is retried through the Worker (`POST /api/internal/fetch`, Cloudflare's IPs
  instead of GitHub's shared ones). Some sites refuse Cloudflare too (piandefontana.it answers 520), so this only helps sometimes.
- `mode=feed`: HTTP 403/429 ⇒ `blocked`. In `auto`, a plain-fetch timeout also falls back to Chromium.
- Push services answering 404/410 ⇒ endpoint sent back as `dead_endpoints` and deleted.
- Changing extraction output? Bump `EXTRACT_VERSION` in `check.py` so watches re-baseline instead of alerting.

## Home checker (sites that block GitHub)

Some sites (telex.hu since Nov 2026) answer every data-center IP with Cloudflare's "Just a moment…" challenge, so
neither the GitHub runners nor the Worker detour get through. `home/` runs the same checker from a Mac on a home
connection, for just those watches, every 10 min via launchd: no browser tab needed, alerts arrive as usual.

- `GET /api/internal/jobs?home=1` lists the watches with a blocked streak (`blocked_since`) or already read at
  home (`home_ok`); its report carries `"via": "home"`, which stamps `home_ok`.
- While `home_ok` is under 30 min old the GitHub run skips that watch. When the Mac sleeps it goes stale and
  GitHub tries again, so the card shows *retrying*/*blocked* rather than going quiet. The app says "Checked from home".
- Install: `checker/home/install.sh` (needs `checker/.venv`; asks for the Worker URL and `CHECKER_TOKEN` once and
  keeps them in `~/.config/site-watch/home.env`, mode 600). Log: `~/Library/Logs/site-watch-home.log`.

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
