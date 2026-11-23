// site-watch API. Stores watches + push subscriptions in D1.
// Public:   GET  /api/config, GET /api/watches, GET /api/watches/:id
//           POST /api/watches            {url, name?, selector?, contains?, ignore?, mode?}  header X-Invite-Code
//           PATCH /api/watches/:id       same fields                                           header X-Invite-Code
//           DELETE /api/watches/:id                                                            header X-Invite-Code
//           POST /api/subscribe          {watch_id, subscription}
//           POST /api/unsubscribe        {watch_id, endpoint}
//           POST /api/my-subscriptions   {endpoint}  -> [watch_id]
// Checker:  GET  /api/internal/jobs, POST /api/internal/report        header Authorization: Bearer CHECKER_TOKEN

const MODES = ["auto", "plain", "browser", "feed"];
const now = () => new Date().toISOString();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function cors(req, env) {
  const origin = req.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
  return {
    "Access-Control-Allow-Origin": origin && allowed.includes(origin) ? origin : allowed[0] || "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Invite-Code,Authorization",
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

function requireInvite(req, env) {
  if (!env.INVITE_CODE) throw new HttpError(500, "INVITE_CODE not configured");
  if (!timingSafeEqual(req.headers.get("X-Invite-Code") || "", env.INVITE_CODE))
    throw new HttpError(403, "wrong invite code");
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
  "w.id, w.url, w.name, w.selector, w.contains, w.ignore, w.mode, w.created_at, w.last_checked, w.last_change, w.last_diff, w.last_error";

function publicWatch(row) {
  if (!row) return row;
  return { ...row, ignore: JSON.parse(row.ignore || "[]") };
}

async function getWatch(env, id) {
  const row = await env.DB.prepare(
    `SELECT ${PUBLIC_COLS}, (SELECT COUNT(*) FROM subscriptions s WHERE s.watch_id = w.id) AS subscribers
     FROM watches w WHERE w.id = ?`).bind(id).first();
  if (!row) throw new HttpError(404, "watch not found");
  return publicWatch(row);
}

function validSubscription(sub) {
  if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) ||
      !sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string")
    throw new HttpError(400, "invalid push subscription");
  return { endpoint: sub.endpoint.slice(0, 1000), keys: JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }) };
}

async function route(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const m = req.method;
  const idMatch = path.match(/^\/api\/watches\/([\w-]+)$/);

  if (m === "GET" && path === "/api/config")
    return json({ vapidPublicKey: env.VAPID_PUBLIC_KEY });

  if (m === "GET" && path === "/api/watches") {
    const { results } = await env.DB.prepare(
      `SELECT ${PUBLIC_COLS}, (SELECT COUNT(*) FROM subscriptions s WHERE s.watch_id = w.id) AS subscribers
       FROM watches w ORDER BY w.created_at DESC`).all();
    return json(results.map(publicWatch));
  }

  if (m === "GET" && idMatch) return json(await getWatch(env, idMatch[1]));

  if (m === "POST" && path === "/api/watches") {
    requireInvite(req, env);
    const f = cleanFields(await body(req));
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM watches").first();
    if (n >= Number(env.MAX_WATCHES || 100)) throw new HttpError(429, "watch limit reached");
    const id = crypto.randomUUID().slice(0, 8);
    await env.DB.prepare(
      `INSERT INTO watches (id, url, name, selector, contains, ignore, mode, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(id, f.url, f.name, f.selector ?? null, f.contains ?? null, f.ignore ?? "[]", f.mode ?? "auto", now()).run();
    return json(await getWatch(env, id), 201);
  }

  if (m === "PATCH" && idMatch) {
    requireInvite(req, env);
    await getWatch(env, idMatch[1]);
    const f = cleanFields(await body(req), true);
    const keys = Object.keys(f);
    if (keys.length) {
      // Changing what we look at invalidates the baseline, so the next check re-baselines silently.
      const reset = keys.some((k) => ["url", "selector", "contains", "ignore", "mode"].includes(k));
      const sets = keys.map((k) => `${k} = ?`).concat(reset ? ["last_hash = NULL", "last_text = NULL", "last_error = NULL"] : []);
      await env.DB.prepare(`UPDATE watches SET ${sets.join(", ")} WHERE id = ?`).bind(...keys.map((k) => f[k]), idMatch[1]).run();
    }
    return json(await getWatch(env, idMatch[1]));
  }

  if (m === "DELETE" && idMatch) {
    requireInvite(req, env);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM subscriptions WHERE watch_id = ?").bind(idMatch[1]),
      env.DB.prepare("DELETE FROM watches WHERE id = ?").bind(idMatch[1]),
    ]);
    return json({ ok: true });
  }

  if (m === "POST" && path === "/api/subscribe") {
    const b = await body(req);
    await getWatch(env, String(b.watch_id || ""));
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
    const [{ results: watches }, { results: subs }] = await env.DB.batch([
      env.DB.prepare("SELECT * FROM watches"),
      env.DB.prepare("SELECT endpoint, watch_id, keys FROM subscriptions"),
    ]);
    return json(watches.map((w) => ({
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
    }
    for (const endpoint of b.dead_endpoints || [])
      stmts.push(env.DB.prepare("DELETE FROM subscriptions WHERE endpoint = ?").bind(String(endpoint)));
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, updated: stmts.length });
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
};
