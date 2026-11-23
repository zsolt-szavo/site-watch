"use strict";
// site-watch PWA. Talks to the Worker API (worker/src/index.js); API base comes from config.js.

const API = window.SITE_WATCH_API;
const INVITE_KEY = "site-watch.invite";
const $ = (s, el = document) => el.querySelector(s);

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

let watches = [];
let mySubs = new Set();   // watch ids this device gets alerts for
let swReg = null;
const busy = new Map();   // watch id -> wanted state while a toggle request is in flight

// ---------- storage (may throw in private mode) ----------
const store = {
  get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---------- API ----------
async function api(path, { method = "GET", body, invite } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (invite) headers["X-Invite-Code"] = invite;
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error("Can't reach the server. Check your connection."), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

// ---------- messages ----------
let msgTimer;
function say(text, isError = false) {
  const el = $("#msg");
  el.textContent = text;
  el.className = "msg" + (isError ? " error" : "");
  el.hidden = false;
  clearTimeout(msgTimer);
  if (!isError) msgTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

// ---------- rendering ----------
function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} days ago`;
  return new Date(iso).toLocaleDateString();
}

function status(w) {
  if (w.last_error && /^blocked/i.test(w.last_error)) return ["blocked", "blocked"];
  if (w.last_error) return ["error", "error"];
  if (!w.last_checked) return ["pending", "not checked yet"];
  return ["ok", "ok"];
}

function render() {
  const list = $("#watches");
  list.replaceChildren();
  $("#empty").hidden = watches.length > 0;
  const canPush = pushSupported && (!isIOS || isStandalone);
  for (const w of watches) {
    const li = $("#watch-tpl").content.firstElementChild.cloneNode(true);
    li.dataset.id = w.id;
    const a = $(".name", li);
    a.textContent = w.name;
    a.href = w.url;
    $(".url", li).textContent = w.url;
    const [cls, label] = status(w);
    const badge = $(".badge", li);
    badge.className = `badge ${cls}`;
    badge.textContent = label;
    const meta = $(".meta", li);
    meta.textContent = `Checked ${ago(w.last_checked)} · last change ${ago(w.last_change)}` +
      (w.subscribers ? ` · ${w.subscribers} subscribed` : "");
    meta.title = `Checked: ${w.last_checked || "never"}\nLast change: ${w.last_change || "never"}`;
    if (w.last_diff) { const d = $(".diff", li); d.textContent = w.last_diff; d.hidden = false; }
    if (w.last_error) { const e = $(".error", li); e.textContent = w.last_error; e.hidden = false; }
    const box = $(".alert", li);
    box.checked = busy.has(w.id) ? busy.get(w.id) : mySubs.has(w.id);
    box.disabled = !canPush || busy.has(w.id);
    if (!canPush) $(".toggle", li).title = isIOS ? "Add to Home Screen first" : "Push alerts aren't supported here";
    list.append(li);
  }
}

async function load() {
  try {
    watches = await api("/api/watches");
    await loadMySubs();
    render();
  } catch (e) {
    say(`Couldn't load the list: ${e.message}`, true);
  }
}

// ---------- push ----------
function b64urlToBytes(s) {
  const raw = atob((s + "=".repeat((4 - s.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const sameKey = (buf, bytes) => {
  if (!buf) return false;
  const a = new Uint8Array(buf);
  return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
};

async function currentSub() {
  return swReg ? swReg.pushManager.getSubscription() : null;
}

async function loadMySubs() {
  mySubs = new Set();
  const sub = await currentSub().catch(() => null);
  if (!sub) return;
  try { mySubs = new Set(await api("/api/my-subscriptions", { method: "POST", body: { endpoint: sub.endpoint } })); }
  catch { /* list still renders, toggles just show off */ }
}

// Get this browser's push subscription, creating it (and asking permission) if needed.
async function ensureSub() {
  if (!swReg) throw new Error("Service worker isn't ready yet. Try again in a moment.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications are blocked for this site. Allow them in the browser's site settings.");
  const { vapidPublicKey } = await api("/api/config");
  if (!vapidPublicKey) throw new Error("Server has no push key configured.");
  const key = b64urlToBytes(vapidPublicKey);
  let sub = await swReg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options && sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();   // server key changed: old subscription can't receive our pushes
    sub = null;
  }
  return sub || swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

async function toggleAlert(box) {
  const id = box.closest(".watch").dataset.id;
  const want = box.checked;
  busy.set(id, want);
  box.disabled = true;
  try {
    if (want) {
      const sub = await ensureSub();
      await api("/api/subscribe", { method: "POST", body: { watch_id: id, subscription: sub.toJSON() } });
      mySubs.add(id);
      say("Alerts on. You'll get a notification when this page changes.");
    } else {
      const sub = await currentSub();
      if (sub) await api("/api/unsubscribe", { method: "POST", body: { watch_id: id, endpoint: sub.endpoint } });
      mySubs.delete(id);
      say("Alerts off for this page.");
    }
  } catch (e) {
    say(e.message, true);
  } finally {
    busy.delete(id);
    render();   // the list may have been redrawn meanwhile; redraw from mySubs so the toggle is accurate
  }
}

// ---------- add / delete ----------
async function addWatch(ev) {
  ev.preventDefault();
  const f = ev.target;
  const v = (n) => f.elements[n].value.trim();
  const invite = v("invite");
  const body = { url: v("url"), name: v("name"), mode: f.elements.mode.value };
  if (v("selector")) body.selector = v("selector");
  if (v("contains")) body.contains = v("contains");
  const ignore = f.elements.ignore.value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (ignore.length) body.ignore = ignore;
  const btn = $("button[type=submit]", f);
  btn.disabled = true;
  try {
    const w = await api("/api/watches", { method: "POST", body, invite });
    store.set(INVITE_KEY, invite);
    for (const n of ["url", "name", "selector", "contains", "ignore"]) f.elements[n].value = "";
    f.elements.mode.value = "auto";
    say(`Added ${w.name}. The first check stores a baseline; alerts start after that.`);
    await load();
  } catch (e) {
    if (e.status === 403) { store.set(INVITE_KEY, ""); f.elements.invite.value = ""; f.elements.invite.focus(); }
    say(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function deleteWatch(btn) {
  const li = btn.closest(".watch");
  const w = watches.find((x) => x.id === li.dataset.id);
  let invite = store.get(INVITE_KEY) || $("#add").elements.invite.value.trim();
  if (!invite) invite = (prompt("Passcode:") || "").trim();
  if (!invite || !confirm(`Stop watching ${w ? w.name : "this page"} for everyone?`)) return;
  btn.disabled = true;
  try {
    await api(`/api/watches/${encodeURIComponent(li.dataset.id)}`, { method: "DELETE", invite });
    store.set(INVITE_KEY, invite);
    say("Deleted.");
    await load();
  } catch (e) {
    if (e.status === 403) store.set(INVITE_KEY, "");
    say(e.message, true);
    btn.disabled = false;
  }
}

// ---------- edit ----------
let editing = null;   // id of the watch open in the edit dialog

function openEdit(btn) {
  const w = watches.find((x) => x.id === btn.closest(".watch").dataset.id);
  if (!w) return;
  editing = w.id;
  const f = $("#edit");
  $(".title", f).textContent = w.name;
  for (const n of ["url", "name", "selector", "contains"]) f.elements[n].value = w[n] || "";
  f.elements.ignore.value = (w.ignore || []).join("\n");
  f.elements.mode.value = w.mode || "auto";
  f.elements.invite.value = store.get(INVITE_KEY) || $("#add").elements.invite.value.trim();
  $("#edit-dialog").showModal();
}

async function saveEdit(ev) {
  ev.preventDefault();
  const f = ev.target;
  const v = (n) => f.elements[n].value.trim();
  const invite = v("invite");
  const w0 = watches.find((x) => x.id === editing) || {};
  const all = {
    url: v("url"), name: v("name"), selector: v("selector") || null, contains: v("contains") || null,
    ignore: f.elements.ignore.value.split("\n").map((s) => s.trim()).filter(Boolean), mode: f.elements.mode.value,
  };
  // Send only what changed: the server re-baselines when a filter field is in the request.
  const same = (k) => k === "ignore" ? JSON.stringify(all.ignore) === JSON.stringify(w0.ignore || [])
    : (all[k] || null) === (w0[k] || null);
  const body = Object.fromEntries(Object.entries(all).filter(([k]) => !same(k)));
  if (!Object.keys(body).length) { $("#edit-dialog").close(); return; }
  const btn = $("button[type=submit]", f);
  btn.disabled = true;
  try {
    const w = await api(`/api/watches/${encodeURIComponent(editing)}`, { method: "PATCH", body, invite });
    store.set(INVITE_KEY, invite);
    $("#edit-dialog").close();
    say(`Saved ${w.name}.`);
    await load();
  } catch (e) {
    if (e.status === 403) { store.set(INVITE_KEY, ""); f.elements.invite.value = ""; f.elements.invite.focus(); }
    say(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// Refresh only re-reads the list (checks run on GitHub's schedule), so once a minute is plenty.
const REFRESH_COOLDOWN_S = 60;
// The real limit is per IP in the Worker; this just keeps the button honest across page reloads.
const REFRESH_KEY = "site-watch.refreshedAt";
function refreshWithCooldown() {
  store.set(REFRESH_KEY, String(Date.now()));
  load();
  startRefreshCooldown();
}
function startRefreshCooldown() {
  const btn = $("#refresh");
  const tick = () => {
    const left = Math.ceil(REFRESH_COOLDOWN_S - (Date.now() - Number(store.get(REFRESH_KEY) || 0)) / 1000);
    btn.disabled = left > 0;
    btn.textContent = left > 0 ? `Refresh (${left}s)` : "Refresh";
    if (left > 0) setTimeout(tick, 1000);
  };
  tick();
}

// ---------- boot ----------
async function boot() {
  $("#add").elements.invite.value = store.get(INVITE_KEY);
  $("#ios-hint").hidden = !(isIOS && !isStandalone);
  $("#push-unsupported").hidden = pushSupported || isIOS;

  $("#add").addEventListener("submit", addWatch);
  $("#refresh").addEventListener("click", refreshWithCooldown);
  startRefreshCooldown();
  $("#watches").addEventListener("change", (e) => { if (e.target.matches(".alert")) toggleAlert(e.target); });
  $("#watches").addEventListener("click", (e) => {
    if (e.target.matches(".delete")) deleteWatch(e.target);
    else if (e.target.matches(".edit")) openEdit(e.target);
  });
  $("#edit").addEventListener("submit", saveEdit);
  $("#edit .cancel").addEventListener("click", () => $("#edit-dialog").close());

  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("sw.js");
      swReg = await navigator.serviceWorker.ready;
    } catch (e) {
      console.warn("service worker registration failed", e);
    }
  }
  await load();
  setInterval(() => { if (document.visibilityState === "visible") load(); }, 60_000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load(); });
}

boot();
