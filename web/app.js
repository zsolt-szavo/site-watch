"use strict";
// Web Watcher PWA. Talks to the Worker API (worker/src/index.js); API base comes from config.js.

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

// A site that blocks the checker usually lets the next run through (it depends on the runner's IP), so a
// block only counts as a problem once it has lasted BLOCK_GRACE_MS; until then the card says "retrying".
const BLOCK_GRACE_MS = 60 * 60 * 1000;
// A site that doesn't answer ("not responding …") gets the same grace: it is usually back by the next run.
const noAnswer = (w) => /^not responding/i.test(w.last_error || "");
const retrying = (w) => Boolean(w.last_error && (/^blocked/i.test(w.last_error) || noAnswer(w)) && w.blocked_since
  && Date.now() - new Date(w.blocked_since) < BLOCK_GRACE_MS);

function status(w) {
  if (retrying(w)) return ["retrying", "retrying"];
  if (w.last_error && /^blocked/i.test(w.last_error)) return ["blocked", "blocked"];
  if (noAnswer(w)) return ["blocked", "not responding"];
  if (w.last_error) return ["error", "error"];
  if (!w.last_checked) return ["pending", "not checked yet"];
  return ["ok", "ok"];
}

// "Checked 5 min ago · changed 2 h ago" / "· no changes yet". The first check only stores a baseline.
function metaLine(w) {
  if (!w.last_checked) return "Waiting for the first check";
  if (retrying(w)) return `The site ${noAnswer(w) ? "didn't answer" : "blocked"} the last check, trying again next run · `
    + (w.last_change ? `changed ${ago(w.last_change)}` : "no changes yet");
  // home_ok within 30 min = the home checker (a computer on a home connection) is the one reading this page.
  const home = w.home_ok && Date.now() - new Date(w.home_ok) < 30 * 60 * 1000 ? " from home" : "";
  return `Checked${home} ${ago(w.last_checked)} · ` + (w.last_change ? `changed ${ago(w.last_change)}` : "no changes yet");
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
    $('.view-toggle[data-view="shots"]', li).hidden = !w.has_shots;
    $('.view-toggle[data-view="text"]', li).hidden = !w.last_checked;
    const view = openView.get(w.id);
    if (view === "shots" && w.has_shots) showShots(li, w);
    if (view === "text" && w.last_checked) showText(li, w);
    meta.title = `Checked: ${w.last_checked || "not yet"}\nLast change: ${w.last_change || "none seen yet"}`;
    if (w.last_error && !retrying(w)) { const e = $(".error", li); e.textContent = w.last_error; e.hidden = false; }
    const box = $(".alert", li);
    box.checked = busy.has(w.id) ? busy.get(w.id) : mySubs.has(w.id);
    box.disabled = !canPush || busy.has(w.id);
    if (!canPush) $(".toggle", li).title = isIOS ? "Add to Home Screen first" : "Push alerts aren't supported here";
    list.append(li);
  });
}

// ---------- pictures & text ----------
// "Pictures ▾" and "Text ▾" under the meta line form an accordion: opening one closes the other.
const openView = new Map();   // watch id -> "shots" | "text" (survives the list re-render)

function setView(li, view) {
  li.querySelectorAll(".view-toggle").forEach((b) => {
    const on = b.dataset.view === view;
    b.setAttribute("aria-expanded", String(on));
    $("span", b).textContent = on ? "▴" : "▾";
  });
  li.querySelectorAll(".view").forEach((p) => { p.hidden = p.dataset.view !== view; });
}

function toggleView(btn) {
  const li = btn.closest(".watch");
  const w = watches.find((x) => x.id === li.dataset.id);
  if (!w) return;
  const view = openView.get(w.id) === btn.dataset.view ? null : btn.dataset.view;
  if (view) openView.set(w.id, view); else openView.delete(w.id);
  setView(li, view);
  if (view === "shots") showShots(li, w);
  if (view === "text") showText(li, w);
}

// ---------- screenshots ----------
// The checker pictures every page in full. Per watch the server keeps the latest picture plus a history:
// the first check and each change, newest SHOT_HISTORY. Only versions are shown: "Now" (the latest picture)
// and, below it, each earlier version of the text. Images need the X-Device-Id header, so they are fetched
// and shown as blob URLs. A shot id's image never changes.
const shotLists = new Map();   // watch id -> {key, items}; key changes when a new check reported
const shotUrls = new Map();    // shot id -> blob URL (or a promise of one)

// "2026-11-23 22:38" in local time: sortable at a glance and the same on every phone locale.
const when = (iso) => {
  const d = new Date(iso), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
// The server sends the latest picture first, then the history newest first. The newest history entry is
// the version the page still shows, so the latest picture stands in for it (keeping its diff): with no
// change yet that leaves one picture, "Now"; each change adds the version before it.
const shotItems = (items) => {
  const latest = items.find((s) => s.kind === "latest");
  const history = items.filter((s) => s.kind !== "latest");
  if (!latest) return history.map((s, i) => ({ ...s, now: i === 0, since: s }));
  const current = history[0];
  return [{ ...latest, now: true, since: current, diff: current?.diff || latest.diff }, ...history.slice(1)];
};
// [bold label, muted detail]. The top picture is the current version; its detail says since when the page
// looks like that ("unchanged since first check …" / "changed …"), older ones say when they appeared.
// The page text uses the same captions ("read" instead of "pictured" when there is no version yet).
const shotCaption = (s, seen = "pictured") => {
  const v = s.now ? s.since : s;
  const start = !v ? "" : v.kind === "baseline" ? `${s.now ? "unchanged since first check" : ""} ${when(v.taken_at)}`.trim()
    : `changed ${when(v.taken_at)}`;
  if (s.now) return ["Current version", start || `${seen} ${when(s.taken_at)}`];
  return [s.kind === "baseline" ? "First check" : "Earlier version", start];
};

function caption(label, detail) {
  const cap = document.createElement("figcaption");
  cap.innerHTML = "<b></b> <span></span>";
  cap.firstChild.textContent = label;
  cap.lastChild.textContent = detail;
  return cap;
}

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
  setView(li, "shots");
  const panel = $(".shots", li), row = $(".shots-row", panel), note = $(".shots-note", panel);
  const key = `${w.last_checked}|${w.shot_count}`;
  let list = shotLists.get(w.id), waited = false;
  if (!list || list.key !== key) {
    waited = true;
    const status = (t) => { note.textContent = t; note.hidden = !t; };
    if (!list) status("Loading pictures…");
    try {
      list = { key, items: await api(`/api/watches/${encodeURIComponent(w.id)}/shots`) };
      shotLists.set(w.id, list);
      status("");
    } catch (e) {
      status(`Couldn't load the pictures: ${e.message}`);
      return;
    }
  }
  if (waited && !li.isConnected) return;   // the list was redrawn meanwhile; the new card loads its own
  const items = shotItems(list.items);
  row.replaceChildren(...items.map((s, i) => {
    const fig = document.createElement("figure");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "shot";
    btn.dataset.shot = s.id;
    const [label, detail] = shotCaption(s);
    btn.setAttribute("aria-label", `${label}, ${detail}: enlarge`);
    const img = document.createElement("img");
    img.alt = "";
    btn.append(img);
    const cap = caption(label, detail);
    const frame = document.createElement("div");
    frame.className = "shot-frame";
    frame.append(btn);
    fig.append(cap, frame);
    shotUrl(w.id, s.id).then((u) => { img.src = u; }, () => { btn.classList.add("broken"); });
    if (items[i + 1]) markChanges(btn, w.id, s.id, items[i + 1].id);   // outline what differs from the version before
    return fig;
  }));
}

// ---------- page text ----------
// The page text as the checker reads it (what changes are detected on), versioned like the pictures: the
// current version on top, each earlier one below it, each in a scroll box.
const texts = new Map();   // watch id -> {key, text, checked, versions}

// Like shotItems: the newest version is what the page says now; the latest text read stands in for it.
const textItems = (t) => {
  const [current, ...older] = t.versions || [];
  return [{ now: true, since: current, taken_at: t.checked, text: t.text || current?.text || "" }, ...older];
};

// A stored diff ("➖ old line" / "➕ new line", in order) as "Removed" and "Added" blocks.
function changesBlock(diff) {
  if (!diff) return null;
  const box = document.createElement("div");
  box.className = "changes";
  let group = null;
  for (const line of diff.split("\n")) {
    const m = line.match(/^(➕|➖|\+|-) ?(.*)$/s);
    if (!m) {   // "(whitespace/order change)"
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = /whitespace|order/.test(line) ? "Only spacing or the order of lines changed." : line;
      box.append(p);
      group = null;
      continue;
    }
    const kind = m[1] === "➕" || m[1] === "+" ? "add" : "del";
    if (group?.dataset.kind !== kind) {
      group = document.createElement("div");
      group.className = `chg ${kind}`;
      group.dataset.kind = kind;
      group.innerHTML = `<h3>${kind === "add" ? "Added" : "Removed"}</h3>`;
      box.append(group);
    }
    const p = document.createElement("p");
    p.textContent = m[2];
    group.append(p);
  }
  return box;
}

async function showText(li, w) {
  setView(li, "text");
  const box = $(".text-versions", li), note = $(".text-note", li);
  const status = (s) => { note.textContent = s; note.hidden = !s; };
  const key = w.last_checked;
  let t = texts.get(w.id);
  if (!t || t.key !== key) {
    if (!t) status("Loading text…");
    try {
      t = { key, ...(await api(`/api/watches/${encodeURIComponent(w.id)}/text`)) };
      texts.set(w.id, t);
      status("");
    } catch (e) {
      status(`Couldn't load the text: ${e.message}`);
      return;
    }
    if (!li.isConnected) return;
  }
  box.replaceChildren(...textItems(t).map((v) => {
    const fig = document.createElement("figure");
    const pre = document.createElement("pre");
    pre.className = "page-text";
    pre.textContent = v.text || "(no text read yet)";
    fig.append(caption(...shotCaption(v, "read")));
    const changes = changesBlock(v.now ? v.since?.diff : v.diff);
    if (changes) fig.append(changes);
    if (v.now) fig.append(pre);
    else {   // older versions: what changed, with their full text folded away
      const more = document.createElement("details");
      more.innerHTML = "<summary>Full text</summary>";
      more.append(pre);
      fig.append(more);
    }
    return fig;
  }));
}

// ---------- what changed in a picture ----------
// Both pictures are shrunk to SAMPLE_W wide and read as a grid of CELL-wide columns (average colour per
// 1-pixel row, summed so any CELL-high band can be averaged at any height). The newer picture is walked in
// CELL-high bands; each band looks for itself in the older picture at the current vertical shift, then at
// shifts up to MAX_SHIFT away (nearest first); a new shift must hold for CONTEXT bands in a row, so a slice of
// a changed line can't "match" some other line that happens to look alike. Found: unchanged, just moved (an insertion above pushes the
// rest down, and that shouldn't be marked). Not found: its cells are compared with the older picture at the
// current shift, and the ones that differ are marked. Marked cells are merged into boxes and outlined on the
// newer picture. All in the browser, from the blobs already loaded.
const SAMPLE_W = 256, CELL = 4, CONTEXT = 4, COLS = SAMPLE_W / CELL, CELL_DIFF = 14, MAX_SHIFT = 1200, MAX_MARKS = 12;
const markCache = new Map();   // "newId|oldId" -> promise of [[x, y, w, h], ...] as fractions of the newer picture

const loadImg = (url) => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });

function sampled(img) {   // -> {h, P}: P[(y * COLS + c) * 3 + rgb] = sum of cell c's colour over rows 0..y-1
  const h = Math.max(CELL, Math.min(12000, Math.round(img.naturalHeight * SAMPLE_W / img.naturalWidth)));
  const cv = document.createElement("canvas");
  cv.width = SAMPLE_W; cv.height = h;
  const g = cv.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0, SAMPLE_W, h);
  const px = g.getImageData(0, 0, SAMPLE_W, h).data, K = COLS * 3, P = new Float64Array((h + 1) * K);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < SAMPLE_W; x++) {
      const k = (y * SAMPLE_W + x) * 4, j = (y + 1) * K + Math.floor(x / CELL) * 3;
      P[j] += px[k] / CELL; P[j + 1] += px[k + 1] / CELL; P[j + 2] += px[k + 2] / CELL;
    }
  for (let y = 1; y <= h; y++) for (let j = 0; j < K; j++) P[y * K + j] += P[(y - 1) * K + j];
  return { h, P };
}

function band(S, y) {   // average colour of each cell over rows y..y+CELL-1
  const K = COLS * 3, out = new Float32Array(K);
  for (let j = 0; j < K; j++) out[j] = (S.P[(y + CELL) * K + j] - S.P[y * K + j]) / CELL;
  return out;
}

const cellDiff = (a, b, j) => (Math.abs(a[j] - b[j]) + Math.abs(a[j + 1] - b[j + 1]) + Math.abs(a[j + 2] - b[j + 2])) / 3;
const sameBand = (a, b) => { for (let j = 0; j < a.length; j += 3) if (cellDiff(a, b, j) > CELL_DIFF) return false; return true; };

function changedCells(A, B) {   // A newer, B older (from sampled) -> {marked: Set of "row,col" in A, rows, cols}
  const marked = new Set(), rows = Math.floor(A.h / CELL), fits = (y) => y >= 0 && y + CELL <= B.h;
  const bandsA = Array.from({ length: rows }, (_, r) => band(A, r * CELL));
  const holds = (r, s) => {   // bands r.. (up to CONTEXT of them) sit at shift s in the older picture
    for (let k = r; k < Math.min(rows, r + CONTEXT); k++)
      if (!fits(k * CELL + s) || !sameBand(bandsA[k], band(B, k * CELL + s))) return false;
    return true;
  };
  let shift = 0;
  for (let r = 0; r < rows; r++) {
    const y = r * CELL, a = bandsA[r];
    if (fits(y + shift) && sameBand(a, band(B, y + shift))) continue;
    let found = false;
    for (let d = 1; d <= MAX_SHIFT && !found; d++)
      for (const s of [shift - d, shift + d])
        if (holds(r, s)) { shift = s; found = true; break; }
    if (found) continue;
    // Not in the older picture: compare each cell with what was at this spot (best of a pixel up or down:
    // a shift by a fraction of a sample pixel blurs sharp edges differently), or, past the older picture's
    // end, with this band's own left edge, i.e. the page background.
    const near = [-1, 0, 1].filter((d) => fits(y + shift + d)).map((d) => band(B, y + shift + d));
    if (!near.length) near.push(Float32Array.from(a, (_, k) => a[k % 3]));
    for (let c = 0; c < COLS; c++)
      if (Math.min(...near.map((b) => cellDiff(a, b, c * 3))) > CELL_DIFF) marked.add(`${r},${c}`);
  }
  return { marked, rows, cols: COLS };
}

function boxesOf({ marked, rows, cols }) {   // connected changed cells (touching or one cell apart) -> boxes
  const seen = new Set(), boxes = [];
  for (const key of marked) {
    if (seen.has(key)) continue;
    let [r0, c0] = key.split(",").map(Number), r1 = r0, c1 = c0;
    const stack = [key]; seen.add(key);
    let size = 0;
    while (stack.length) {
      const [r, c] = stack.pop().split(",").map(Number);
      size++;
      r0 = Math.min(r0, r); r1 = Math.max(r1, r); c0 = Math.min(c0, c); c1 = Math.max(c1, c);
      for (let dr = -2; dr <= 2; dr++) for (let dc = -4; dc <= 4; dc++) {
        const k = `${r + dr},${c + dc}`;
        if (marked.has(k) && !seen.has(k)) { seen.add(k); stack.push(k); }
      }
    }
    c0 = Math.max(0, c0 - 1); c1 = Math.min(cols - 1, c1 + 1);   // a cell of air, so the outline frames rather than cuts
    if (size > 2) boxes.push([c0 / cols, r0 / rows, (c1 - c0 + 1) / cols, (r1 - r0 + 1) / rows]);   // 1-2 cells: resampling noise
  }
  // Biggest first.
  return boxes.sort((a, b) => b[2] * b[3] - a[2] * a[3]).slice(0, MAX_MARKS);
}

function markChanges(host, watchId, newId, oldId) {
  const key = `${newId}|${oldId}`;
  if (!markCache.has(key)) {
    markCache.set(key, Promise.all([shotUrl(watchId, newId), shotUrl(watchId, oldId)])
      .then((urls) => Promise.all(urls.map(loadImg)))
      .then(([a, b]) => boxesOf(changedCells(sampled(a), sampled(b))))
      .catch(() => []));
  }
  markCache.get(key).then((boxes) => {
    host.querySelectorAll(".mark").forEach((m) => m.remove());
    for (const [x, y, w, h] of boxes) {
      const m = document.createElement("span");
      m.className = "mark";
      m.style.cssText = `left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%`;
      host.append(m);
    }
  });
}

async function enlargeShot(btn) {
  const w = watches.find((x) => x.id === btn.closest(".watch").dataset.id);
  const s = w && shotItems(shotLists.get(w.id)?.items || []).find((x) => String(x.id) === btn.dataset.shot);
  if (!s) return;
  const d = $("#shot-dialog");
  $(".title", d).textContent = `${w.name} · ${shotCaption(s).join(", ")}`;
  const img = $("img", d);
  const wrap = img.parentElement;
  wrap.querySelectorAll(".mark").forEach((m) => m.remove());
  const items = shotItems(shotLists.get(w.id).items);
  const prev = items[items.indexOf(s) + 1];
  if (prev) markChanges(wrap, w.id, s.id, prev.id);
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
    if (pendingFocus) focusWatch(pendingFocus);
  } catch (e) {
    loadError(`Couldn't load the list: ${e.message}`);
  }
}

// ---------- open from a notification ----------
// A tapped alert opens the app at #watch=<id> (or messages the open app): scroll to that card, open its
// pictures and flash it.
let pendingFocus = new URLSearchParams(location.hash.slice(1)).get("watch") || "";
function focusWatch(id) {
  pendingFocus = "";
  history.replaceState(null, "", location.pathname + location.search);
  const w = watches.find((x) => x.id === id);
  if (!w) return;
  if (w.has_shots) { openView.set(id, "shots"); render(); }
  const li = $(`.watch[data-id="${CSS.escape(id)}"]`);
  if (!li) return;
  li.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  li.classList.remove("flash");
  void li.offsetWidth;   // restart the animation when the same card is focused twice
  li.classList.add("flash");
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
  $("#check-now").title = (run.finished_at ? `Last check finished ${ago(run.finished_at)}. ` : "")
    + "Pages are checked every 10 minutes; this checks them now.";
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
    else if (e.target.closest(".view-toggle")) toggleView(e.target.closest(".view-toggle"));
    else if (e.target.closest(".shot")) enlargeShot(e.target.closest(".shot"));
  });
  // Tap outside the picture (on the backdrop) closes it too.
  $("#shot-dialog").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  $("#edit").addEventListener("submit", saveEdit);
  $("#edit .cancel").addEventListener("click", () => $("#edit-dialog").close());

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.type === "show-watch") { pendingFocus = String(e.data.watch_id); refresh({ force: true }); }
    });
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
