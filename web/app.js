"use strict";
// Web Change Watcher PWA. Talks to the Worker API (worker/src/index.js); API base comes from config.js.

const API = window.SITE_WATCH_API;
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

// Storage keys keep the old "site-watch." prefix: renaming them would lose this device's watches.

// ---------- device identity ----------
// No accounts: a random id in localStorage owns this device's watches. Clearing site data loses them.
const DEVICE_KEY = "site-watch.device";
const DEVICE_ID = store.get(DEVICE_KEY) || (() => {
  const id = crypto.randomUUID();
  store.set(DEVICE_KEY, id);
  return id;
})();

// ---------- API ----------
async function api(path, { method = "GET", body } = {}) {
  const headers = { "X-Device-Id": DEVICE_ID };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error("Can't reach the server. Check your connection."), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

// ---------- messages ----------
// Short feedback goes to a toast at the bottom; tap to dismiss. Errors stay a little longer.
let toastTimer;
function say(text, isError = false) {
  const el = $("#toast");
  el.textContent = text;
  el.className = "toast" + (isError ? " error" : "");
  el.hidden = true;            // restart the slide-in animation
  void el.offsetWidth;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 8000 : 3500);
}

// Errors while a dialog is open show inside it: a modal dialog covers the toast.
function formError(form, text) {
  const el = $(".form-error", form);
  el.textContent = text || "";
  el.hidden = !text;
}

// A failed list load stays on screen until the next successful load.
function loadError(text) {
  const el = $("#load-error");
  el.textContent = text || "";
  el.hidden = !text;
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

// "Checked 5 min ago · changed 2 h ago" / "· no changes yet". The first check only stores a baseline.
function metaLine(w) {
  if (!w.last_checked) return "Waiting for the first check";
  return `Checked ${ago(w.last_checked)} · ` + (w.last_change ? `changed ${ago(w.last_change)}` : "no changes yet");
}

// ---------- order ----------
// Card order is per device like the watches themselves, so it lives in localStorage next to the device id.
// Ids the stored order doesn't know yet (just added, or added before reordering existed) go on top, newest first.
const ORDER_KEY = "site-watch.order";
function readOrder() {
  try { const a = JSON.parse(store.get(ORDER_KEY) || "[]"); return Array.isArray(a) ? a : []; } catch { return []; }
}
function applyOrder(list) {
  const pos = new Map(readOrder().map((id, i) => [id, i]));
  const fresh = list.filter((w) => !pos.has(w.id));   // server order: newest first
  const known = list.filter((w) => pos.has(w.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
  return fresh.concat(known);
}

function move(btn) {
  const id = btn.closest(".watch").dataset.id;
  const dir = Number(btn.dataset.dir);
  const i = watches.findIndex((w) => w.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= watches.length) return;
  [watches[i], watches[j]] = [watches[j], watches[i]];
  render();
  // Keep keyboard focus on the moved card; at the top/bottom the pressed arrow is disabled, so use the other one.
  const li = $(`.watch[data-id="${CSS.escape(id)}"]`);
  const same = $(`.move[data-dir="${dir}"]`, li);
  (same.disabled ? $(`.move[data-dir="${-dir}"]`, li) : same).focus();
}

function render() {
  const list = $("#watches");
  list.replaceChildren();
  store.set(ORDER_KEY, watches.length ? JSON.stringify(watches.map((w) => w.id)) : "");
  $("#empty").hidden = watches.length > 0;
  $("#check-now").hidden = watches.length === 0;
  $("#schedule-note").hidden = watches.length === 0;
  const canPush = pushSupported && (!isIOS || isStandalone);
  watches.forEach((w, i) => {
    const li = $("#watch-tpl").content.firstElementChild.cloneNode(true);
    li.dataset.id = w.id;
    const [up, down] = li.querySelectorAll(".move");
    up.hidden = down.hidden = watches.length < 2;
    up.disabled = i === 0;
    down.disabled = i === watches.length - 1;
    const a = $(".name", li);
    a.textContent = w.name;
    a.href = w.url;
    $(".url", li).textContent = w.url;
    const [cls, label] = status(w);
    const badge = $(".badge", li);
    badge.className = `badge ${cls}`;
    badge.textContent = label;
    const meta = $(".meta", li);
    $(".meta-text", meta).textContent = metaLine(w);
    $(".shots-toggle", li).hidden = !w.has_shots;
    if (w.has_shots && openShots.has(w.id)) showShots(li, w);
    meta.title = `Checked: ${w.last_checked || "not yet"}\nLast change: ${w.last_change || "none seen yet"}`;
    if (w.last_diff) { const d = $(".diff", li); d.textContent = w.last_diff; d.hidden = false; }
    if (w.last_error) { const e = $(".error", li); e.textContent = w.last_error; e.hidden = false; }
    const box = $(".alert", li);
    box.checked = busy.has(w.id) ? busy.get(w.id) : mySubs.has(w.id);
    box.disabled = !canPush || busy.has(w.id);
    if (!canPush) $(".toggle", li).title = isIOS ? "Add to Home Screen first" : "Push alerts aren't supported here";
    list.append(li);
  });
}

// ---------- screenshots ----------
// The checker pictures every page. Per watch the server keeps the latest one ("Now") plus a history: the
// first check and each change, newest SHOT_HISTORY. The ▾ on the meta line opens that list; images need
// the X-Device-Id header, so they are fetched and shown as blob URLs. A shot id's image never changes.
const openShots = new Set();   // watch ids whose picture list is open (survives the list re-render)
const shotLists = new Map();   // watch id -> {key, items}; key changes when a new check reported
const shotUrls = new Map();    // shot id -> blob URL (or a promise of one)

const when = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const shotLabel = (s) => s.kind === "latest" ? "Now" : s.kind === "change" ? "Changed" : "First check";

function shotUrl(watchId, shotId) {
  if (!shotUrls.has(shotId)) {
    shotUrls.set(shotId, fetch(`${API}/api/watches/${encodeURIComponent(watchId)}/shots/${shotId}`,
      { headers: { "X-Device-Id": DEVICE_ID } })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); })
      .then((b) => { const u = URL.createObjectURL(b); shotUrls.set(shotId, u); return u; })
      .catch((e) => { shotUrls.delete(shotId); throw e; }));
  }
  return Promise.resolve(shotUrls.get(shotId));
}

async function showShots(li, w) {
  const panel = $(".shots", li), row = $(".shots-row", panel), note = $(".shots-note", panel);
  const toggle = $(".shots-toggle", li);
  toggle.setAttribute("aria-expanded", "true");
  $("span", toggle).textContent = "▴";
  panel.hidden = false;
  const key = `${w.last_checked}|${w.shot_count}`;
  let list = shotLists.get(w.id), waited = false;
  if (!list || list.key !== key) {
    waited = true;
    if (!list) note.textContent = "Loading pictures…";
    try {
      list = { key, items: await api(`/api/watches/${encodeURIComponent(w.id)}/shots`) };
      shotLists.set(w.id, list);
    } catch (e) {
      note.textContent = `Couldn't load the pictures: ${e.message}`;
      return;
    }
  }
  if (waited && !li.isConnected) return;   // the list was redrawn meanwhile; the new card loads its own
  const changes = list.items.filter((s) => s.kind === "change").length;
  note.textContent = changes ? `Latest check, then ${changes > 1 ? `the last ${changes} changes` : "the last change"}. Tap one to enlarge.`
    : "Latest check and the first one. Tap one to enlarge.";
  row.replaceChildren(...list.items.map((s) => {
    const fig = document.createElement("figure");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "shot";
    btn.dataset.shot = s.id;
    btn.setAttribute("aria-label", `${shotLabel(s)}, ${when(s.taken_at)}: enlarge`);
    const img = document.createElement("img");
    img.alt = "";
    btn.append(img);
    const cap = document.createElement("figcaption");
    cap.innerHTML = "<b></b><span></span>";
    cap.firstChild.textContent = shotLabel(s);
    cap.lastChild.textContent = when(s.taken_at);
    fig.append(btn, cap);
    shotUrl(w.id, s.id).then((u) => { img.src = u; }, () => { btn.classList.add("broken"); });
    return fig;
  }));
}

function toggleShots(btn) {
  const li = btn.closest(".watch");
  const w = watches.find((x) => x.id === li.dataset.id);
  if (!w) return;
  if (openShots.has(w.id)) {
    openShots.delete(w.id);
    btn.setAttribute("aria-expanded", "false");
    $("span", btn).textContent = "▾";
    $(".shots", li).hidden = true;
  } else {
    openShots.add(w.id);
    showShots(li, w);
  }
}

async function enlargeShot(btn) {
  const w = watches.find((x) => x.id === btn.closest(".watch").dataset.id);
  const s = w && (shotLists.get(w.id)?.items || []).find((x) => String(x.id) === btn.dataset.shot);
  if (!s) return;
  const d = $("#shot-dialog");
  $(".title", d).textContent = `${w.name} · ${shotLabel(s)} ${when(s.taken_at)}`;
  const diff = $(".diff", d);
  diff.textContent = s.diff || "";
  diff.hidden = !s.diff;
  const img = $("img", d);
  img.removeAttribute("src");
  img.alt = `Screenshot of ${w.name}, ${when(s.taken_at)}`;
  d.showModal();
  try { img.src = await shotUrl(w.id, s.id); } catch (e) { say(`Couldn't load the picture: ${e.message}`, true); }
}

async function load() {
  try {
    watches = applyOrder(await api("/api/watches"));
    await loadMySubs();
    loadError("");
    render();
    pollStatus();
  } catch (e) {
    loadError(`Couldn't load the list: ${e.message}`);
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
      say("🔔 Alerts on. You'll get a notification when this page changes.");
    } else {
      const sub = await currentSub();
      if (sub) await api("/api/unsubscribe", { method: "POST", body: { watch_id: id, endpoint: sub.endpoint } });
      mySubs.delete(id);
      say("🔕 Alerts off for this page.");
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
  const body = { url: v("url"), name: v("name"), mode: f.elements.mode.value };
  if (v("selector")) body.selector = v("selector");
  if (v("contains")) body.contains = v("contains");
  const ignore = f.elements.ignore.value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (ignore.length) body.ignore = ignore;
  const btn = $("button[type=submit]", f);
  btn.disabled = true;
  formError(f, "");
  try {
    const w = await api("/api/watches", { method: "POST", body });
    f.reset();
    $("#add-dialog").close();
    say(`Added ${w.name}. The first check stores a baseline; alerts start after that.`);
    await load();
  } catch (e) {
    formError(f, e.message);
  } finally {
    btn.disabled = false;
  }
}

async function deleteWatch(btn) {
  const li = btn.closest(".watch");
  const w = watches.find((x) => x.id === li.dataset.id);
  if (!confirm(`Stop watching ${w ? w.name : "this page"}?`)) return;
  btn.disabled = true;
  try {
    await api(`/api/watches/${encodeURIComponent(li.dataset.id)}`, { method: "DELETE" });
    say("Deleted.");
    await load();
  } catch (e) {
    say(e.message, true);
    btn.disabled = false;
  }
}

// ---------- edit ----------
let editing = null;   // id of the watch open in the edit dialog

function openAdd() {
  const f = $("#add");
  formError(f, "");
  $("#add-dialog").showModal();
  f.elements.url.focus();
}

function openEdit(btn) {
  const w = watches.find((x) => x.id === btn.closest(".watch").dataset.id);
  if (!w) return;
  editing = w.id;
  const f = $("#edit");
  $(".title", f).textContent = w.name;
  for (const n of ["url", "name", "selector", "contains"]) f.elements[n].value = w[n] || "";
  f.elements.ignore.value = (w.ignore || []).join("\n");
  f.elements.mode.value = w.mode || "auto";
  formError(f, "");
  $("#edit-dialog").showModal();
}

async function saveEdit(ev) {
  ev.preventDefault();
  const f = ev.target;
  const v = (n) => f.elements[n].value.trim();
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
    const w = await api(`/api/watches/${encodeURIComponent(editing)}`, { method: "PATCH", body });
    $("#edit-dialog").close();
    say(`Saved ${w.name}.`);
    await load();
  } catch (e) {
    formError(f, e.message);
  } finally {
    btn.disabled = false;
  }
}

// Refresh only re-reads the list (checks run every 10 min, or via Check now), so once a minute is plenty.
// Every background re-read (button, tab refocus, auto timer, page load) goes through refresh(), so they
// share one 60 s cooldown. It lives in localStorage, so other tabs of this app respect it too.
// The real limit is per IP in the Worker; this keeps the client from ever needing it.
const REFRESH_COOLDOWN_S = 60;
const AUTO_REFRESH_S = 120;   // while visible; longer than the cooldown so the button stays usable
const REFRESH_KEY = "site-watch.refreshedAt";
let refreshTimer;
const refreshLeft = () =>
  Math.ceil(REFRESH_COOLDOWN_S - (Date.now() - Number(store.get(REFRESH_KEY) || 0)) / 1000);

// force: page load only (the list must show up); everything else is skipped during the cooldown.
function refresh({ force = false } = {}) {
  if (!force && refreshLeft() > 0) return;
  store.set(REFRESH_KEY, String(Date.now()));
  load();
  startRefreshCooldown();
}
function startRefreshCooldown() {
  const btn = $("#refresh");
  clearTimeout(refreshTimer);
  const tick = () => {
    const left = refreshLeft();
    btn.disabled = left > 0;
    btn.toggleAttribute("data-cooling", left > 0);
    $(".lbl", btn).textContent = left > 0 ? `${left}s` : "Refresh";
    if (left > 0) refreshTimer = setTimeout(tick, 1000);
  };
  tick();
}

// ---------- check now ----------
// Starts the GitHub checker right away. The server allows one start per 5 min for everyone and
// returns when the next one is allowed; we remember that so the button can count down.
const CHECK_KEY = "site-watch.checkAvailableAt";
let checkTimer;
async function checkNow() {
  const btn = $("#check-now");
  btn.disabled = true;
  try {
    const r = await api("/api/check-now", { method: "POST" });
    store.set(CHECK_KEY, r.available_at);
    run = { ...run, state: "queued", dispatched_at: new Date().toISOString() };
    renderRun();
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollStatus, POLL_S * 1000);
    say("Check started. It usually takes 1–5 minutes.");
  } catch (e) {
    if (e.status === 429 && e.data && e.data.available_at) {
      store.set(CHECK_KEY, e.data.available_at);
      say("A check is already on its way.");
      pollStatus();
    } else {
      say(e.message, true);
    }
  }
  startCheckCooldown();
}
function startCheckCooldown() {
  const btn = $("#check-now");
  clearTimeout(checkTimer);
  const tick = () => {
    const left = Math.ceil((new Date(store.get(CHECK_KEY) || 0).getTime() - Date.now()) / 1000);
    btn.disabled = left > 0;
    btn.textContent = left > 0 ? `Check now (${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")})` : "Check now";
    if (left > 0) checkTimer = setTimeout(tick, 1000);
  };
  tick();
}

// ---------- background check status ----------
// The Worker records when a check was started, when the checker picked it up and when it reported back.
// While one is queued or running we ask every POLL_S seconds and show its progress; when it ends, the
// list is re-read at once so the new results appear without waiting for the next auto refresh.
const POLL_S = 10;
let run = { state: "idle" }, pollTimer, runTimer;

async function pollStatus() {
  clearTimeout(pollTimer);
  const was = run.state;
  try { run = await api("/api/check-status"); } catch { return; }   // keep the last known state
  if (run.available_at && new Date(run.available_at) > Date.now()) {
    store.set(CHECK_KEY, run.available_at);   // a check another device or the cron started also counts
    startCheckCooldown();
  }
  renderRun();
  if (was !== "idle" && run.state === "idle") {
    say("Check finished. The list is up to date.");
    refresh({ force: true });
  } else if (run.state !== "idle" && document.visibilityState === "visible") {
    pollTimer = setTimeout(pollStatus, POLL_S * 1000);
  }
}

function renderRun() {
  clearTimeout(runTimer);
  const el = $("#run-status");
  const active = run.state !== "idle" && watches.length > 0;
  el.hidden = !active;
  if (active) {
    const since = Date.parse(run.state === "running" ? run.started_at : run.dispatched_at) || Date.now();
    const s = Math.max(0, Math.round((Date.now() - since) / 1000));
    const t = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
    $(".text", el).textContent = run.state === "running"
      ? `Checking all pages… ${t}`
      : `Queued, waiting for GitHub to start the check… ${t}`;
    runTimer = setTimeout(renderRun, 1000);
  }
  $("#schedule-note").textContent =
    (run.finished_at ? `Last check finished ${ago(run.finished_at)}. ` : "") + "Pages are checked every 10 minutes.";
}

// ---------- boot ----------
async function boot() {
  $("#ios-hint").hidden = !(isIOS && !isStandalone);
  $("#push-unsupported").hidden = pushSupported || isIOS;

  $("#add").addEventListener("submit", addWatch);
  $("#open-add").addEventListener("click", openAdd);
  $("#add .cancel").addEventListener("click", () => $("#add-dialog").close());
  $("#check-now").addEventListener("click", checkNow);
  startCheckCooldown();
  $("#toast").addEventListener("click", (e) => { e.currentTarget.hidden = true; });
  $("#refresh").addEventListener("click", () => refresh());
  startRefreshCooldown();
  $("#watches").addEventListener("change", (e) => { if (e.target.matches(".alert")) toggleAlert(e.target); });
  $("#watches").addEventListener("click", (e) => {
    if (e.target.matches(".move")) move(e.target);
    else if (e.target.matches(".delete")) deleteWatch(e.target);
    else if (e.target.matches(".edit")) openEdit(e.target);
    else if (e.target.closest(".shots-toggle")) toggleShots(e.target.closest(".shots-toggle"));
    else if (e.target.closest(".shot")) enlargeShot(e.target.closest(".shot"));
  });
  // Tap outside the picture (on the backdrop) closes it too.
  $("#shot-dialog").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
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
  refresh({ force: true });
  setInterval(() => { if (document.visibilityState === "visible") refresh(); }, AUTO_REFRESH_S * 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    refresh();
    if (run.state !== "idle") pollStatus();   // polling pauses in the background
  });
}

boot();
