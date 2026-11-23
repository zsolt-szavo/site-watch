// Web Watcher API (deployed as the "site-watch" Worker). Stores watches + push subscriptions in D1.
// Public:   GET  /api/config, GET /api/watches, GET /api/watches/:id
//           POST /api/watches            {url, name?, selector?, contains?, ignore?, mode?}
//           PATCH /api/watches/:id       same fields
//           DELETE /api/watches/:id
//           GET  /api/watches/:id/shots          [{id, kind, taken_at, diff}] newest first: the latest check,
//                                                then up to SHOT_HISTORY changes / the first baseline
//           GET  /api/watches/:id/shots/:shotId  image/jpeg
//           GET  /api/watches/:id/text           {text, checked}: the page text as last read
//           Every watch route needs header X-Device-Id: each device only sees and changes its own watches.
//           POST /api/subscribe          {watch_id, subscription}
//           POST /api/unsubscribe        {watch_id, endpoint}
//           POST /api/my-subscriptions   {endpoint}  -> [watch_id]
//           POST /api/check-now          start the GitHub check workflow now; one start per CHECK_COOLDOWN_S for everyone
//           GET  /api/check-status       {state: idle|queued|running, dispatched_at, started_at, finished_at, available_at}
// Cron:     every 10 min the Worker starts the same workflow (GitHub's own schedule is late or skipped).
// Checker:  GET  /api/internal/jobs[?start=1], POST /api/internal/report   header Authorization: Bearer CHECKER_TOKEN
//           GET  /api/internal/jobs?home=1, POST /api/internal/report {via: "home"}: the home checker (a computer on a
//                home connection, checker/home/) takes the watches GitHub's runners get blocked on; see HOME_FRESH_MS.
//           POST /api/internal/fetch {url, ua}  -> {status, body}: fetch a page from Cloudflare's network
//                (the checker's fallback when a site throttles GitHub's shared runner IPs)

const MODES = ["auto", "plain", "browser", "feed"];
const now = () => new Date().toISOString();
// A watch the home checker read within this long is left to it: the GitHub run skips it. Older (the computer is
// asleep or off) and GitHub tries again, so a card never goes quiet without saying why.
const HOME_FRESH_MS = 30 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function cors(req, env) {
  const origin = req.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
  return {
    "Access-Control-Allow-Origin": origin && allowed.includes(origin) ? origin : allowed[0] || "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Device-Id,Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

async function body(req) {
  try { return await req.json(); } catch { throw new HttpError(400, "invalid JSON body"); }
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Random id the PWA keeps in localStorage. There are no accounts: knowing the id is what owns the watches.
function deviceId(req) {
  const id = req.headers.get("X-Device-Id") || "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) throw new HttpError(400, "missing or invalid device id");
  return id;
}

function requireChecker(req, env) {
  if (!env.CHECKER_TOKEN) throw new HttpError(500, "CHECKER_TOKEN not configured");
  if (!timingSafeEqual(req.headers.get("Authorization") || "", `Bearer ${env.CHECKER_TOKEN}`))
    throw new HttpError(401, "unauthorized");
}

export function validateUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim().match(/^https?:\/\//i) ? String(raw).trim() : `https://${String(raw || "").trim()}`); }
  catch { throw new HttpError(400, "not a valid URL"); }
  if (!["http:", "https:"].includes(u.protocol)) throw new HttpError(400, "only http(s) URLs");
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") ||
      /^(\d+\.){3}\d+$/.test(h) && /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) ||
      h.startsWith("["))
    throw new HttpError(400, "private/local addresses are not allowed");
  if (u.href.length > 2000) throw new HttpError(400, "URL too long");
  return u.href;
}

function cleanFields(input, partial = false) {
  const out = {};
  if (!partial || "url" in input) out.url = validateUrl(input.url);
  if (!partial || "name" in input) {
    const name = String(input.name || "").trim().slice(0, 80);
    out.name = name || (out.url ? new URL(out.url).hostname.replace(/^www\./, "") : "");
    if (!out.name) delete out.name;
  }
  for (const k of ["selector", "contains"]) {
    if (k in input) out[k] = input[k] ? String(input[k]).trim().slice(0, 300) || null : null;
  }
  if ("ignore" in input) {
    const arr = Array.isArray(input.ignore) ? input.ignore : [];
    for (const r of arr) { try { new RegExp(r); } catch { throw new HttpError(400, `bad ignore regex: ${r}`); } }
    out.ignore = JSON.stringify(arr.map(String).slice(0, 20));
  }
  if ("mode" in input) {
    if (!MODES.includes(input.mode)) throw new HttpError(400, `mode must be one of ${MODES.join(", ")}`);
    out.mode = input.mode;
  }
  return out;
}

const PUBLIC_COLS =
  "w.id, w.url, w.name, w.selector, w.contains, w.ignore, w.mode, w.created_at, w.last_checked, w.last_change, w.last_diff, w.last_error, " +
  "(SELECT COUNT(*) FROM shots WHERE watch_id = w.id) AS shot_count, " +
  // When the site started blocking the checker (consecutive blocked checks), kept in meta to avoid a migration.
  "(SELECT v FROM meta WHERE k = 'blocked_since:' || w.id) AS blocked_since, " +
  "(SELECT v FROM meta WHERE k = 'home_ok:' || w.id) AS home_ok";   // last time the home checker read it

function publicWatch(row) {
  if (!row) return row;
  return { ...row, ignore: JSON.parse(row.ignore || "[]"), has_shots: row.shot_count > 0 };
}

// ---------- screenshots ----------
const MAX_SHOT_BYTES = 1_000_000;   // D1 rows max out at 2 MB; the checker aims for < 900 kB

// Base64 JPEG from the checker -> bytes, or null when it isn't a plausible JPEG.
export function decodeShot(b64) {
  if (typeof b64 !== "string" || !b64 || b64.length > Math.ceil(MAX_SHOT_BYTES / 3) * 4) return null;
  let bin;
  try { bin = atob(b64); } catch { return null; }
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? bytes : null;
}

const shotHistory = (env) => Number(env.SHOT_HISTORY || 5);

// Statements that file one checker screenshot. Each is skipped when the watch was deleted while the check
// ran (the foreign key would otherwise fail the whole report batch).
function shotStmts(env, r, t, bytes) {
  const live = "EXISTS (SELECT 1 FROM watches WHERE id = ?1)";
  const hist = "SELECT 1 FROM shots WHERE watch_id = ?1 AND kind != 'latest'";
  const ins = (kind, cond, diff = null) => env.DB.prepare(
    `INSERT INTO shots (watch_id, kind, taken_at, diff, jpeg) SELECT ?1, '${kind}', ?2, ?3, ?4 WHERE ${cond}`)
    .bind(r.id, t, diff, bytes);
  return [
    env.DB.prepare("DELETE FROM shots WHERE watch_id = ? AND kind = 'latest'").bind(r.id),
    ins("latest", live),
    r.changed
      ? ins("change", live, String(r.diff || "").slice(0, 4000))
      : ins("baseline", `${live} AND NOT EXISTS (${hist})`),   // first check (or first since a re-baseline)
    env.DB.prepare(
      `DELETE FROM shots WHERE watch_id = ?1 AND kind != 'latest' AND id NOT IN
       (SELECT id FROM shots WHERE watch_id = ?1 AND kind != 'latest' ORDER BY id DESC LIMIT ?2)`)
      .bind(r.id, shotHistory(env)),
  ];
}

async function getWatch(env, id, dev) {
  const row = await env.DB.prepare(
    `SELECT ${PUBLIC_COLS}, (SELECT COUNT(*) FROM subscriptions s WHERE s.watch_id = w.id) AS subscribers
     FROM watches w WHERE w.id = ? AND w.device_id = ?`).bind(id, dev).first();
  if (!row) throw new HttpError(404, "watch not found");
  return publicWatch(row);
}

function validSubscription(sub) {
  if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) ||
      !sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string")
    throw new HttpError(400, "invalid push subscription");
  return { endpoint: sub.endpoint.slice(0, 1000), keys: JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }) };
}

// ---------- starting the checker (GitHub Actions workflow_dispatch) ----------
// One run checks every watch, so the cooldown is global: devices share it, and the cron uses it too,
// which keeps a manual check and the next scheduled one from both running.
const cooldownS = (env) => Number(env.CHECK_COOLDOWN_S || 300);

// Atomically take the dispatch slot. Returns {ok:true, prev} or {ok:false, availableAt}.
async function claimDispatch(env, minGapS) {
  const t = new Date();
  const cutoff = new Date(t.getTime() - minGapS * 1000).toISOString();
  const prev = (await env.DB.prepare("SELECT v FROM meta WHERE k = 'last_dispatch'").first())?.v || null;
  const r = await env.DB.prepare(
    `INSERT INTO meta (k, v) VALUES ('last_dispatch', ?1)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE meta.v < ?2`).bind(t.toISOString(), cutoff).run();
  if (r.meta.changes === 1) return { ok: true, prev };
  const last = (await env.DB.prepare("SELECT v FROM meta WHERE k = 'last_dispatch'").first())?.v;
  return { ok: false, availableAt: new Date(new Date(last).getTime() + minGapS * 1000).toISOString() };
}

async function releaseDispatch(env, prev) {
  if (prev) await env.DB.prepare("UPDATE meta SET v = ? WHERE k = 'last_dispatch'").bind(prev).run();
  else await env.DB.prepare("DELETE FROM meta WHERE k = 'last_dispatch'").run();
}

async function dispatchWorkflow(env) {
  const res = await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW || "check.yml"}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "site-watch-worker",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: env.GH_REF || "main" }),
    });
  if (res.status !== 204) throw new Error(`GitHub dispatch failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

// Claim the slot, start the workflow, give the slot back if GitHub refused.
async function startCheck(env, minGapS) {
  const c = await claimDispatch(env, minGapS);
  if (!c.ok) return c;
  try { await dispatchWorkflow(env); }
  catch (e) { await releaseDispatch(env, c.prev); throw e; }
  return { ok: true, availableAt: new Date(Date.now() + minGapS * 1000).toISOString() };
}

// ---------- run status (shown in the app while a check is queued or running) ----------
// meta keys: last_dispatch (Worker started the workflow), run_started (checker fetched its jobs with ?start=1),
// run_finished (checker reported). A run that never reports (crashed job) stops counting after RUN_MAX_MS.
const RUN_MAX_MS = 20 * 60e3, QUEUE_MAX_MS = 10 * 60e3;
const setMeta = (env, k, v) =>
  env.DB.prepare("INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, v);

export function runState({ last_dispatch: d, run_started: s, run_finished: f }, t = Date.now()) {
  const age = (iso) => (iso ? t - Date.parse(iso) : Infinity);
  if (s && (!f || f < s) && age(s) < RUN_MAX_MS) return "running";
  if (d && (!s || s < d) && age(d) < QUEUE_MAX_MS) return "queued";
  return "idle";
}

async function checkStatus(env) {
  const { results } = await env.DB.prepare(
    "SELECT k, v FROM meta WHERE k IN ('last_dispatch', 'run_started', 'run_finished')").all();
  const m = Object.fromEntries(results.map((r) => [r.k, r.v]));
  const d = m.last_dispatch;
  return {
    state: runState(m),
    dispatched_at: d || null,
    started_at: m.run_started || null,
    finished_at: m.run_finished || null,
    available_at: d ? new Date(Date.parse(d) + cooldownS(env) * 1000).toISOString() : null,
  };
}

const FETCH_MAX_CHARS = 3_000_000;

async function route(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const m = req.method;
  const idMatch = path.match(/^\/api\/watches\/([\w-]+)$/);
  const shotsMatch = path.match(/^\/api\/watches\/([\w-]+)\/shots(?:\/(\d+))?$/);
  const textMatch = path.match(/^\/api\/watches\/([\w-]+)\/text$/);

  // Per-IP rate limit on the public API (the checker's internal routes have their own token).
  if (env.API_LIMIT && !path.startsWith("/api/internal/")) {
    const ip = req.headers.get("CF-Connecting-IP") || "local";
    const { success } = await env.API_LIMIT.limit({ key: ip });
    if (!success) throw new HttpError(429, "too many requests, try again in a minute");
  }

  if (m === "GET" && path === "/api/config")
    return json({ vapidPublicKey: env.VAPID_PUBLIC_KEY });

  if (m === "GET" && path === "/api/watches") {
    const { results } = await env.DB.prepare(
      `SELECT ${PUBLIC_COLS}, (SELECT COUNT(*) FROM subscriptions s WHERE s.watch_id = w.id) AS subscribers
       FROM watches w WHERE w.device_id = ? ORDER BY w.created_at DESC`).bind(deviceId(req)).all();
    return json(results.map(publicWatch));
  }

  if (m === "GET" && idMatch) return json(await getWatch(env, idMatch[1], deviceId(req)));

  if (m === "GET" && shotsMatch && !shotsMatch[2]) {
    await getWatch(env, shotsMatch[1], deviceId(req));
    const { results } = await env.DB.prepare(
      `SELECT id, kind, taken_at, diff FROM shots WHERE watch_id = ?
       ORDER BY kind = 'latest' DESC, id DESC`).bind(shotsMatch[1]).all();
    return json(results);
  }

  if (m === "GET" && textMatch) {
    await getWatch(env, textMatch[1], deviceId(req));
    const row = await env.DB.prepare("SELECT last_text, last_checked FROM watches WHERE id = ?").bind(textMatch[1]).first();
    return json({ text: row.last_text || "", checked: row.last_checked });
  }

  if (m === "GET" && shotsMatch) {
    await getWatch(env, shotsMatch[1], deviceId(req));
    const row = await env.DB.prepare("SELECT jpeg FROM shots WHERE id = ? AND watch_id = ?")
      .bind(Number(shotsMatch[2]), shotsMatch[1]).first();
    if (!row) throw new HttpError(404, "screenshot not found");
    // A shot id never changes content, so the browser may keep it.
    return new Response(new Uint8Array(row.jpeg), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" },
    });
  }

  if (m === "POST" && path === "/api/watches") {
    const dev = deviceId(req);
    const f = cleanFields(await body(req));
    const { total, mine } = await env.DB.prepare(
      "SELECT COUNT(*) AS total, COALESCE(SUM(device_id = ?), 0) AS mine FROM watches").bind(dev).first();
    const perDevice = Number(env.MAX_WATCHES_PER_DEVICE || 5), overall = Number(env.MAX_WATCHES || 50);
    if (mine >= perDevice) throw new HttpError(429, `this device already has ${perDevice} watches; delete one first`);
    if (total >= overall) throw new HttpError(429, `all ${overall} watch slots are in use`);
    const id = crypto.randomUUID().slice(0, 8);
    await env.DB.prepare(
      `INSERT INTO watches (id, device_id, url, name, selector, contains, ignore, mode, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(id, dev, f.url, f.name, f.selector ?? null, f.contains ?? null, f.ignore ?? "[]", f.mode ?? "auto", now()).run();
    return json(await getWatch(env, id, dev), 201);
  }

  if (m === "PATCH" && idMatch) {
    const dev = deviceId(req);
    await getWatch(env, idMatch[1], dev);
    const f = cleanFields(await body(req), true);
    const keys = Object.keys(f);
    if (keys.length) {
      // Changing what we look at invalidates the baseline, so the next check re-baselines silently.
      const reset = keys.some((k) => ["url", "selector", "contains", "ignore", "mode"].includes(k));
      const sets = keys.map((k) => `${k} = ?`).concat(reset ? ["last_hash = NULL", "last_text = NULL", "last_error = NULL"] : []);
      const stmts = [env.DB.prepare(`UPDATE watches SET ${sets.join(", ")} WHERE id = ?`).bind(...keys.map((k) => f[k]), idMatch[1])];
      // The old pictures show what we no longer look at; the next check starts a new history with its baseline.
      if (reset) stmts.push(env.DB.prepare("DELETE FROM shots WHERE watch_id = ?").bind(idMatch[1]));
      await env.DB.batch(stmts);
    }
    return json(await getWatch(env, idMatch[1], dev));
  }

  if (m === "DELETE" && idMatch) {
    await getWatch(env, idMatch[1], deviceId(req));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM subscriptions WHERE watch_id = ?").bind(idMatch[1]),
      env.DB.prepare("DELETE FROM shots WHERE watch_id = ?").bind(idMatch[1]),
      env.DB.prepare("DELETE FROM meta WHERE k IN (?, ?)").bind(`blocked_since:${idMatch[1]}`, `home_ok:${idMatch[1]}`),
      env.DB.prepare("DELETE FROM watches WHERE id = ?").bind(idMatch[1]),
    ]);
    return json({ ok: true });
  }

  if (m === "POST" && path === "/api/check-now") {
    const dev = deviceId(req);
    if (!env.GH_DISPATCH_TOKEN || !env.GH_REPO) throw new HttpError(503, "Check now isn't set up on the server yet");
    // Only devices that watch something may start a run.
    const { mine } = await env.DB.prepare("SELECT COUNT(*) AS mine FROM watches WHERE device_id = ?").bind(dev).first();
    if (!mine) throw new HttpError(400, "add a page first");
    const r = await startCheck(env, cooldownS(env)).catch((e) => {
      console.error(e);
      throw new HttpError(502, "GitHub didn't accept the check request. Try again later.");
    });
    if (!r.ok) return json({ error: "a check was started recently", available_at: r.availableAt }, 429);
    return json({ ok: true, available_at: r.availableAt }, 202);
  }

  if (m === "GET" && path === "/api/check-status") return json(await checkStatus(env));

  if (m === "POST" && path === "/api/subscribe") {
    const b = await body(req);
    await getWatch(env, String(b.watch_id || ""), deviceId(req));
    const s = validSubscription(b.subscription);
    await env.DB.prepare(
      `INSERT INTO subscriptions (endpoint, watch_id, keys, created_at) VALUES (?,?,?,?)
       ON CONFLICT(endpoint, watch_id) DO UPDATE SET keys = excluded.keys`)
      .bind(s.endpoint, b.watch_id, s.keys, now()).run();
    return json({ ok: true });
  }

  if (m === "POST" && path === "/api/unsubscribe") {
    const b = await body(req);
    await env.DB.prepare("DELETE FROM subscriptions WHERE endpoint = ? AND watch_id = ?")
      .bind(String(b.endpoint || ""), String(b.watch_id || "")).run();
    return json({ ok: true });
  }

  if (m === "POST" && path === "/api/my-subscriptions") {
    const b = await body(req);
    const { results } = await env.DB.prepare("SELECT watch_id FROM subscriptions WHERE endpoint = ?")
      .bind(String(b.endpoint || "")).all();
    return json(results.map((r) => r.watch_id));
  }

  if (m === "GET" && path === "/api/internal/jobs") {
    requireChecker(req, env);
    if (url.searchParams.get("start") === "1") await setMeta(env, "run_started", now()).run();
    const [{ results: all }, { results: subs }] = await env.DB.batch([
      env.DB.prepare(`SELECT w.*, (SELECT v FROM meta WHERE k = 'blocked_since:' || w.id) AS blocked_since,
                      (SELECT v FROM meta WHERE k = 'home_ok:' || w.id) AS home_ok FROM watches w`),
      env.DB.prepare("SELECT endpoint, watch_id, keys FROM subscriptions"),
    ]);
    // home=1: the watches GitHub got blocked on, and those the home checker already handles.
    // Otherwise: everything except what the home checker read recently.
    const fresh = new Date(Date.now() - HOME_FRESH_MS).toISOString();
    const watches = url.searchParams.get("home") === "1"
      ? all.filter((w) => w.blocked_since || w.home_ok)
      : all.filter((w) => !(w.home_ok && w.home_ok > fresh));
    return json(watches.map(({ blocked_since, home_ok, ...w }) => ({
      ...w,
      ignore: JSON.parse(w.ignore || "[]"),
      subscriptions: subs.filter((s) => s.watch_id === w.id).map((s) => ({ endpoint: s.endpoint, keys: JSON.parse(s.keys) })),
    })));
  }

  if (m === "POST" && path === "/api/internal/report") {
    requireChecker(req, env);
    const b = await body(req);
    const t = now();
    const stmts = [];
    for (const r of b.results || []) {
      // Sites behind bot walls block some runs and not others (it depends on the runner's IP), so the app
      // only raises the alarm once a page has been blocked for a while: remember when the streak began.
      const blockKey = `blocked_since:${r.id}`;
      stmts.push(/^blocked/i.test(String(r.error || ""))
        ? env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM watches WHERE id = ?)")
          .bind(blockKey, t, r.id)
        : env.DB.prepare("DELETE FROM meta WHERE k = ?").bind(blockKey));
      if (b.via === "home" && !r.error)
        stmts.push(env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM watches WHERE id = ?)")
          .bind(`home_ok:${r.id}`, t, r.id));
      if (r.error) {
        stmts.push(env.DB.prepare("UPDATE watches SET last_checked = ?, last_error = ? WHERE id = ?")
          .bind(t, String(r.error).slice(0, 500), r.id));
      } else if (r.changed) {
        stmts.push(env.DB.prepare(
          "UPDATE watches SET last_checked = ?, last_change = ?, last_hash = ?, last_text = ?, last_diff = ?, last_error = NULL WHERE id = ?")
          .bind(t, t, r.hash, r.text, String(r.diff || "").slice(0, 4000), r.id));
      } else {
        // Unchanged or first baseline: store hash/text without bumping last_change.
        stmts.push(env.DB.prepare(
          "UPDATE watches SET last_checked = ?, last_hash = ?, last_text = ?, last_error = NULL WHERE id = ?")
          .bind(t, r.hash, r.text, r.id));
      }
      const shot = r.error ? null : decodeShot(r.shot);
      if (shot) stmts.push(...shotStmts(env, r, t, shot));
    }
    for (const endpoint of b.dead_endpoints || [])
      stmts.push(env.DB.prepare("DELETE FROM subscriptions WHERE endpoint = ?").bind(String(endpoint)));
    if (b.via !== "home") stmts.push(setMeta(env, "run_finished", t));   // the app's "Checking…" tracks the GitHub run
    await env.DB.batch(stmts);
    return json({ ok: true, updated: stmts.length });
  }

  if (m === "POST" && path === "/api/internal/fetch") {
    requireChecker(req, env);
    const b = await body(req);
    const target = validateUrl(b.url);
    let res;
    try {
      res = await fetch(target, {
        redirect: "follow",
        headers: {
          "User-Agent": String(b.ua || "Mozilla/5.0").slice(0, 300),
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en,hu;q=0.8",
        },
      });
    } catch (e) {
      throw new HttpError(502, `fetch failed: ${e.message}`);
    }
    const text = await res.text();
    return json({ status: res.status, body: text.slice(0, FETCH_MAX_CHARS) });
  }

  throw new HttpError(404, "not found");
}

export default {
  async fetch(req, env) {
    const headers = cors(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    let res;
    try {
      res = await route(req, env);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      res = json({ error: e instanceof HttpError ? e.message : "internal error" }, status);
    }
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  },

  // Cron trigger (wrangler.toml): start the check workflow on Cloudflare's punctual clock.
  async scheduled(controller, env, ctx) {
    if (!env.GH_DISPATCH_TOKEN || !env.GH_REPO) { console.warn("cron: GH_DISPATCH_TOKEN/GH_REPO not set, skipping"); return; }
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM watches").first();
    if (!n) return;
    // A manual "Check now" within the cooldown already covers this tick (ticks are 10 min apart, so they never block each other).
    const r = await startCheck(env, cooldownS(env));
    if (!r.ok) console.log(`cron: skipped, a check started recently (next at ${r.availableAt})`);
  },
};
