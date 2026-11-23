// API base URL. Local dev (python3 -m http.server 8000) talks to `wrangler dev`;
// anything else uses the deployed Worker (set in phase 5).
window.SITE_WATCH_API = ["localhost", "127.0.0.1"].includes(location.hostname)
  ? "http://localhost:8787"
  : "https://site-watch.zsolt-szavo.workers.dev";
