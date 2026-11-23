// Service worker: shows push alerts and keeps the app shell available offline.
const CACHE = "site-watch-v8";   // cache name is internal: keep the prefix so old caches get cleaned up
const SHELL = ["./", "index.html", "style.css", "app.js", "config.js", "manifest.json", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first for our own files (so updates show up), cache as offline fallback. API calls are cross-origin: untouched.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request)
    .then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    })
    .catch(() => caches.match(e.request).then((r) => r || caches.match("./"))));
});

// Payload from checker/check.py: {title, body, url, watch_id}
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Web Watcher: new version", {
    body: d.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: d.watch_id || undefined,   // a newer alert for the same site replaces the older one
    renotify: Boolean(d.watch_id),
    data: { url: d.url || self.registration.scope },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data && e.notification.data.url || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    const open = wins.find((w) => w.url === url);
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});
