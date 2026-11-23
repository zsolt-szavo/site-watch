# web

Static PWA, no build step. API base URL is in `config.js` (localhost → `http://localhost:8787`, else the deployed Worker).

```sh
cd web && python3 -m http.server 8000     # with `cd ../worker && npm run dev` running
```

- `app.js`: list (`GET /api/watches`), add/delete (header `X-Invite-Code`, remembered in localStorage),
  per-watch alert toggle (`/api/config` key → `pushManager.subscribe` → `/api/subscribe`, `/api/unsubscribe`,
  `/api/my-subscriptions` to restore toggles). Errors starting with "blocked" show a *blocked* badge.
- `sw.js`: shows push `{title, body, url, watch_id}` (tag = watch_id, so a newer alert replaces the older one),
  opens `url` on click, caches the app shell (network first). Bump `CACHE` when changing shell files.
- iOS: push only works from the Home Screen app (iOS 16.4+); the page shows a hint and disables toggles otherwise.
- `icons/make_icons.py` regenerates the PNG icons (stdlib only).
- `test/e2e_firefox.py`: real Firefox subscribes, the checker pushes, the notification is asserted.
- `test/e2e_edit_firefox.py`: adds a watch, edits it in the Edit dialog, checks what the server stored, deletes it.
  Edit sends only changed fields; changing address, filters or mode makes the next check re-baseline silently.
