# web

**Web Change Watcher** (the app's display name; repo, Worker and localStorage keys keep the `site-watch` id). Static PWA, no build step. API base URL is in `config.js` (localhost → `http://localhost:8787`, else the deployed Worker).

```sh
cd web && python3 -m http.server 8000     # with `cd ../worker && npm run dev` running
```

- `app.js`: list (`GET /api/watches`), add/edit/delete; every call sends `X-Device-Id`, a random id kept in localStorage that owns this device's watches,
  per-watch alert toggle (`/api/config` key → `pushManager.subscribe` → `/api/subscribe`, `/api/unsubscribe`,
  `/api/my-subscriptions` to restore toggles). Errors starting with "blocked" show a *blocked* badge.
- Header: *Refresh* re-reads the list; it shares one 60 s cooldown with tab refocus and the 2-minute auto re-read (localStorage, so across tabs too), *Add page* opens the add dialog. *Check now* (`POST /api/check-now`)
  starts the GitHub checker right away; the server allows one start per 5 min shared by all devices, and the button counts down.
  Feedback shows as a toast at the bottom; errors inside a dialog show in the dialog.
- Run status: `GET /api/check-status` after each list load; while a check is *queued* (dispatched, not picked up yet)
  or *running* (checker fetched its jobs, hasn't reported) a banner shows elapsed time and polls every 10 s while visible.
  When it ends the list is re-read at once. The server's `available_at` also syncs the *Check now* countdown across devices.
- Phones (≤ 520 px): Refresh shrinks to ↻ (plus countdown), "Add page" to "+ Add"; touch screens get ≥ 40 px buttons.
- *Pictures ▾* on a card's meta line (when the checker has screenshots) opens the versions stacked one below the
  other, newest first, each labelled with its time (`2026-11-23 22:38`): *Now* (shown once as *Now · new version* when it is the
  newest version itself), then each *New version* and the *First check*, newest 5 kept (`GET /api/watches/:id/shots`).
- *Text ▾* next to it opens the page text as last read (`GET /api/watches/:id/text`) in a 320px scroll box.
- A *blocked* check first shows as *retrying* (grey): bot walls often block one GitHub runner IP and let the next
  through. Only after an hour of blocked checks in a row (`blocked_since`) does the card turn *blocked*.
  Images need `X-Device-Id`, so they're fetched and shown as blob URLs; tapping one opens it full size with that change's diff.
- ↑/↓ on a card reorders the list; the order is per device, kept in localStorage (`site-watch.order`), new watches go on top.
- `sw.js`: shows push `{title, body, url, watch_id}` (tag = watch_id, so a newer alert replaces the older one),
  opens `url` on click, caches the app shell (network first). Bump `CACHE` when changing shell files.
- iOS: push only works from the Home Screen app (iOS 16.4+); the page shows a hint and disables toggles otherwise.
- `icons/make_icons.py` regenerates the PNG icons (stdlib only).
- `test/e2e_firefox.py`: real Firefox subscribes, the checker pushes, the notification is asserted.
- `test/e2e_edit_firefox.py`: adds a watch, edits it in the Edit dialog, checks what the server stored, deletes it.
  Edit sends only changed fields; changing address, filters or mode makes the next check re-baseline silently.
