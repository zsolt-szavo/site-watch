# Web Change Watcher (repo: site-watch) — plan

Self-hosted "notify me when this page changes". Free tiers only. No accounts or passcode:
each device has a random id (localStorage) and sees only its own watches, at most 5 per device
and 50 in total; the public API is rate-limited to 60 requests/min per IP.

## Architecture

```
 GitHub Pages (PWA)  ──HTTPS──▶  Cloudflare Worker + D1   ◀──HTTPS──  GitHub Actions (started every 10 min by the Worker cron)
 - add URL (per-device list)      - stores watches, push       - GET jobs (Bearer token)
 - list watches + last change       subscriptions, state       - fetch page (plain, fallback headless
 - subscribe/unsubscribe push     - public API + internal        Chromium for JS-heavy sites)
 - service worker shows push        API for the checker        - diff → Web Push (VAPID) to subscribers
                                                               - POST results back
```

- **Frontend**: static PWA on GitHub Pages (`/web`). Works in every modern browser;
  on iOS it must be added to the Home Screen (iOS 16.4+) to receive push.
- **API**: Cloudflare Worker (`/worker`), D1 (SQLite). No CPU-heavy work here.
- **Checker**: GitHub Actions (`/checker`, Python). Public repo ⇒ unlimited minutes.
  Sends Web Push itself (pywebpush), VAPID private key in Actions secrets.
- **Secrets**: `CHECKER_TOKEN` (Worker ↔ Actions),
  `VAPID_PRIVATE_KEY` (Actions), VAPID public key is public.

## Phases (one session each)

1. **Worker API + D1 schema**, tested locally with `wrangler dev`. ✅ done (`cd worker && npm run db:local && npm run dev`, then `npm test`)
2. **Checker** ✅ done (`cd checker && python -m unittest`; local run: see checker/README.md): plain fetch + text extraction (port of `watch.py`), headless
   Chromium fallback (Playwright), diff, Web Push, report back. Local run against
   `wrangler dev`.
3. **PWA** ✅ done (`cd web && python3 -m http.server 8000`; e2e: `web/test/e2e_firefox.py`): add/list/delete watches, per-watch subscribe toggle, service worker,
   manifest + icons, iOS "add to Home Screen" hint. Plain HTML/CSS/JS, no build.
4. **Noise control + test matrix** ✅ done (relative timestamps + bare rank lines scrubbed by default; edit dialog in the PWA, e2e: `web/test/e2e_edit_firefox.py`). Results from a Mac on the office network, 2026-11-23:
   HN newest ok (alerts only on new posts); binance ok with selector `span.text-PrimaryText.whitespace-nowrap.font-semibold`;
   met.hu ok in auto/plain (browser mode flaps on a number); 9gag noisy (vote/comment counts) and needs ignore rules;
   reddit feed answers HTTP 404 to anonymous requests from here; piandefontana.it hangs (plain timeout, browser 429/timeout).
   Re-test both from GitHub Actions in phase 5. Original scope: optional CSS selector / "contains text" filter,
   ignore regexes, RSS/JSON mode for reddit. Test sites: news.ycombinator.com/newest,
   reddit.com/r/…, 9gag.com, binance.com (price ticker ⇒ needs selector), met.hu,
   piandefontana.it (the real target).
5. **Deploy** ✅ done 2026-11-23. Worker https://site-watch.zsolt-szavo.workers.dev in the personal
   Cloudflare account (pinned `account_id`; never the work account). PWA https://zsoltszavo.github.io/site-watch/
   via `pages.yml`; the Worker via `worker.yml` on every push to main touching worker/ (repo secret CLOUDFLARE_API_TOKEN). `check.yml` is started every 10 min by the Worker's cron trigger (workflow_dispatch with GH_DISPATCH_TOKEN) and by *Check now* (one start per 5 min, shared); its own GitHub schedule is an hourly fallback that re-enables itself on each scheduled run (keep-alive).
   Production secrets live in gitignored `checker/.env.prod`. Re-test from GitHub Actions:
   reddit dropped anonymous RSS in mid-November 2026 (HTTP 404), so the feed test watch is now telex.hu/rss.
   piandefontana.it times out in both auto and browser mode over https:// and over http://, and plain curl
   from the office got HTTP 429. It loads in a normal browser, so it likely blocks datacenter IPs and bots. **Open problem:** find out whether it loads in a normal phone browser, and whether it
   has an RSS feed, newsletter or API to watch instead.

## Known limits

- GitHub cron ≥ 5 min and often late or skipped (no scheduled run fired in the first hours after deploy), so the Worker's Cloudflare cron starts the workflow instead; 10 min chosen.
- Some sites block datacenter IPs / bots (Cloudflare challenge). Those will show
  "blocked" in the UI rather than silently failing.
- Push still transits Apple/Google/Mozilla push servers (unavoidable for any
  phone push); payloads are end-to-end encrypted.

`prototype/` holds the first single-file ntfy version; phase 2 ports its text extraction.
