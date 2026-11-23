#!/usr/bin/env python3
"""Web Watcher checker: fetch every watch, diff against the last check, send Web Push, report back.

Env:
  API_URL            Worker base URL, e.g. https://site-watch.<you>.workers.dev
  CHECKER_TOKEN      shared secret with the Worker
  VAPID_PRIVATE_KEY  base64url raw P-256 private key (see gen_vapid.py)
  VAPID_SUBJECT      contact for push services: mailto:… or a bare https origin (default: GitHub Pages origin)

  python check.py            # one full run
  python check.py --dry-run  # fetch + diff + print, no push, no report
  python check.py --no-shots # skip the page screenshots
  python check.py --home     # home checker: only the watches GitHub's runners get blocked on (see home/)
"""
import base64
import concurrent.futures as cf
import difflib
import hashlib
import json
import os
import re
import sys
import threading
import time
import xml.etree.ElementTree as ET
from collections import defaultdict
from urllib.parse import urlsplit

import requests
from bs4 import BeautifulSoup

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0 Safari/537.36 site-watch")
SKIP_TAGS = ["script", "style", "noscript", "svg", "head", "iframe", "template"]
BLOCK_TAGS = ["address", "article", "aside", "blockquote", "br", "dd", "details", "dialog", "div", "dl", "dt",
              "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
              "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tr", "ul", "option"]
# Bump when extraction output changes shape, so every watch re-baselines silently instead of alerting.
EXTRACT_VERSION = "x2"  # x2: relative timestamps scrubbed
MIN_TEXT = 200          # auto mode: less visible text than this ⇒ probably JS-rendered, retry in a browser
MAX_TEXT = 200_000      # cap what we store in D1
TIMEOUT = 30
# Screenshot of every watched page (shown in the app next to the one from the last change).
SHOT_VIEWPORT = {"width": 1280, "height": 900}
# The whole page, not just the first screen: a change near the bottom must be in the picture too.
# Very long pages are cut at SHOT_MAX_HEIGHT; a page still too big is retried at lower quality, then shorter.
SHOT_QUALITY = (60, 40, 25)   # JPEG quality ladder, tried in order until the picture fits
SHOT_MAX_HEIGHT = 8000        # CSS px
MAX_SHOT_BYTES = 900_000      # the Worker stores each in a D1 row (2 MB limit) and rejects bigger ones
# Many sites rate-limit per IP, and GitHub's runners share theirs. So one run downloads each URL once,
# spaces requests to the same site, and retries a 429/503 once after the site's Retry-After.
HOST_GAP = 3.0          # seconds between two requests to the same site
MAX_RETRY_WAIT = 20     # longest Retry-After we honour inside one run
BLOCK_STATUSES = (403, 429, 503)
# Signs of a bot wall (Cloudflare & co.). Only checked on short pages so real content mentioning them is fine.
BLOCK_MARKERS = re.compile(
    r"just a moment|attention required|cf-chl|checking your browser|verify you are human|"
    r"enable javascript and cookies|access denied|captcha", re.I)


# Relative timestamps ("5 minutes ago", "2 órája", "3 ore fa") change on every run without the page changing.
# They are cut out of each line (not the whole line), so the rest of the line is still compared.
_UNITS_EN = r"(?:sec(?:ond)?s?|min(?:ute)?s?|h(?:ou)?rs?|hours?|days?|weeks?|months?|years?|[smhdwy])"
RELATIVE_TIME = [
    re.compile(rf"\b(?:\d+|an?|one)\s*{_UNITS_EN}\.?\s+ago\b", re.I),
    re.compile(r"\b(?:just now|moments? ago|yesterday)\b", re.I),
    re.compile(r"\b\d+\s*(?:másodperce|perce|órája|napja|hete|hónapja|éve)\b", re.I),
    re.compile(r"\b(?:\d+|un[ao]?)\s*(?:secondi|secondo|minuti|minuto|ore|ora|giorni|giorno|settimane|settimana|mesi|mese|anni|anno)\s+fa\b", re.I),
]

LIST_NUMBER = re.compile(r"\d{1,4}[.)]")  # a line that is only a rank ("12.") just shifts when items are added


class Blocked(Exception):
    """The site answered with a bot wall instead of content."""


# A site that times out, refuses the connection or answers 5xx is down or overloaded, usually for a
# while only. Reported as "not responding …" so the Worker and the app treat it like a block: one hour of
# "retrying" (and the home checker trying it too) before the card shows a problem.
NO_ANSWER = "not responding"


def describe_error(e):
    msg = (str(e) or type(e).__name__).splitlines()[0]
    if isinstance(e, (requests.Timeout, requests.ConnectionError)) or "net::ERR_" in msg \
            or re.search(r"Timeout \d+ms exceeded", msg):
        return f"{NO_ANSWER} (the site didn't answer)"
    m = re.fullmatch(r"HTTP (5\d\d)", msg)
    return f"{NO_ANSWER} (HTTP {m[1]})" if m else msg


# ---------------------------------------------------------------- extraction

def html_to_lines(html, selector=None):
    soup = BeautifulSoup(html, "html.parser")
    roots = [soup]
    if selector:
        roots = soup.select(selector)
        if not roots:
            raise ValueError(f"selector matched nothing: {selector}")
    lines = []
    for root in roots:
        for t in root.find_all(SKIP_TAGS):
            t.decompose()
        # One line per block (row, paragraph, list item…); inline elements stay on their line.
        for t in root.find_all(BLOCK_TAGS):
            t.insert_before("\n")
            t.append("\n")
        for t in root.find_all(["td", "th"]):
            t.append(" ")
        for s in root.get_text().split("\n"):
            s = " ".join(s.split())
            if s:
                lines.append(s)
    return lines


def feed_to_lines(xml):
    """RSS/Atom → one line per item: title — link."""
    root = ET.fromstring(xml.encode() if isinstance(xml, str) else xml)
    strip = lambda tag: tag.rsplit("}", 1)[-1]
    lines = []
    for el in root.iter():
        if strip(el.tag) not in ("item", "entry"):
            continue
        title = link = ""
        for c in el:
            name = strip(c.tag)
            if name == "title":
                title = " ".join((c.text or "").split())
            elif name == "link":
                link = c.get("href") or (c.text or "").strip()
        if title or link:
            lines.append(f"{title} — {link}".strip(" —"))
    if not lines:
        raise ValueError("feed has no items")
    return lines


def scrub(lines):
    out = []
    for l in lines:
        for rx in RELATIVE_TIME:
            l = rx.sub("", l)
        l = " ".join(l.split())
        if l and not LIST_NUMBER.fullmatch(l):
            out.append(l)
    return out


def apply_filters(lines, w):
    lines = scrub(lines)
    for pat in w.get("ignore") or []:
        rx = re.compile(pat)
        lines = [l for l in lines if not rx.search(l)]
    if w.get("contains"):
        needle = w["contains"].lower()
        hits = [l for l in lines if needle in l.lower()]
        lines = hits or [f'(no line contains "{w["contains"]}")']
    return lines


def looks_blocked(status, text):
    return status in (403, 429, 503) or (len(text) < 3000 and BLOCK_MARKERS.search(text) is not None)


# ---------------------------------------------------------------- fetching

def fetch_plain(url):
    """Returns (status, text, retry_after_seconds or None)."""
    r = requests.get(url, headers={"User-Agent": UA, "Accept-Language": "en,hu;q=0.8"}, timeout=TIMEOUT)
    if r.encoding is None or r.encoding.lower() == "iso-8859-1":  # requests' default when no charset given
        r.encoding = r.apparent_encoding
    ra = r.headers.get("Retry-After", "")
    return r.status_code, r.text, (int(ra) if ra.isdigit() else None)


def host_of(url):
    return (urlsplit(url).hostname or "").lower().removeprefix("www.")


class Fetcher:
    """Plain downloads for one run.

    Each URL is fetched once (several watches often share a page), requests to one host are spaced
    HOST_GAP apart, a 429/503 is retried once, and an answer that is still blocked (or a timeout) is
    retried through the Worker: Cloudflare's network instead of GitHub's, whose shared IPs sites throttle.
    Thread-safe as long as each host is handled by one thread (run() groups watches by host).
    """

    def __init__(self, api=None, token=None, gap=HOST_GAP, sleep=time.sleep):
        self.api, self.token, self.gap, self.sleep = api, token, gap, sleep
        self.cache, self.via = {}, {}       # url -> (status, body) | exception; url -> "worker" when proxied
        self.last = defaultdict(lambda: float("-inf"))   # host -> time.monotonic() of the last request
        self.lock = threading.Lock()

    def wait_turn(self, url):
        h = host_of(url)
        with self.lock:
            wait = self.last[h] + self.gap - time.monotonic()
        if wait > 0:
            self.sleep(wait)
        with self.lock:
            self.last[h] = time.monotonic()

    def get(self, url):
        if url not in self.cache:
            try:
                self.cache[url] = self._get(url)
            except requests.RequestException as e:
                self.cache[url] = e
        r = self.cache[url]
        if isinstance(r, Exception):
            raise r
        return r

    def _get(self, url):
        self.wait_turn(url)
        try:
            status, body, retry_after = fetch_plain(url)
            if status in (429, 503):
                self.sleep(min(retry_after or 5, MAX_RETRY_WAIT))
                self.wait_turn(url)
                status, body, _ = fetch_plain(url)
        except requests.RequestException:
            # No answer here. A 5xx from the detour (Cloudflare says 520-524 when the site doesn't answer it
            # either) is no answer too: re-raise so auto mode still lets a real browser try.
            proxied = self.via_worker(url)
            if proxied is None or proxied[0] >= 500:
                raise
            return proxied
        if status in BLOCK_STATUSES:
            proxied = self.via_worker(url)
            if proxied is not None and proxied[0] < 400:   # e.g. 520 when the site drops Cloudflare too
                return proxied
        return status, body

    def via_worker(self, url):
        if not self.api:
            return None
        try:
            r = requests.post(f"{self.api}/api/internal/fetch", headers={"Authorization": f"Bearer {self.token}"},
                              json={"url": url, "ua": UA}, timeout=TIMEOUT + 10)
            r.raise_for_status()
            d = r.json()
        except (requests.RequestException, ValueError) as e:
            print(f"  worker fetch failed for {url}: {e}")
            return None
        self.via[url] = "worker"
        return d["status"], d["body"]


class Browser:
    """Lazily started headless Chromium, shared across watches. Not thread-safe: use from one thread.

    Every page it loads is also screenshotted (viewport JPEG), so a watch the browser already checked
    costs nothing extra in shot(); a plain-mode watch gets one browser load just for its picture.
    """

    def __init__(self, fetcher=None):
        self.pw = self.browser = None
        self.fetcher, self.cache, self.shots = fetcher, {}, {}

    def get(self, url):
        if url not in self.cache:
            if self.fetcher:
                self.fetcher.wait_turn(url)
            try:
                self.cache[url] = self._get(url)
            except Exception as e:
                self.cache[url] = e
        r = self.cache[url]
        if isinstance(r, Exception):
            raise r
        return r

    def shot(self, url):
        """JPEG bytes of the page, or None when it couldn't be loaded or pictured."""
        try:
            self.get(url)
        except Exception:
            return None
        return self.shots.get(url)

    def _get(self, url):
        if self.browser is None:
            from playwright.sync_api import sync_playwright
            self.pw = sync_playwright().start()
            self.browser = self.pw.chromium.launch()
        ctx = self.browser.new_context(user_agent=UA, locale="en-US", viewport=SHOT_VIEWPORT)
        try:
            page = ctx.new_page()
            resp = page.goto(url, timeout=TIMEOUT * 1000, wait_until="domcontentloaded")
            try:
                page.wait_for_load_state("networkidle", timeout=10_000)
            except Exception:
                pass  # long-polling sites never go idle; take what we have
            html = page.content()
            try:
                self.shots[url] = screenshot(page)
            except Exception as e:
                print(f"  screenshot failed for {url}: {(str(e) or type(e).__name__).splitlines()[0]}")
            return (resp.status if resp else 0), html
        finally:
            ctx.close()

    def close(self):
        if self.browser:
            self.browser.close()
        if self.pw:
            self.pw.stop()


def screenshot(page):
    """Full-page JPEG (cut at SHOT_MAX_HEIGHT), retried at lower quality and then half the height while too
    big; None when it never fits."""
    try:
        # Scroll through once so lazy-loaded images further down are in the picture.
        height = int(page.evaluate("""async () => {
            const h = () => document.documentElement.scrollHeight;
            for (let y = 0; y < Math.min(h(), %d); y += innerHeight) { scrollTo(0, y); await new Promise(r => setTimeout(r, 100)); }
            scrollTo(0, 0);
            return h();
        }""" % SHOT_MAX_HEIGHT))
    except Exception:
        height = SHOT_VIEWPORT["height"]
    height = max(SHOT_VIEWPORT["height"], min(height, SHOT_MAX_HEIGHT))
    while True:
        clip = {"x": 0, "y": 0, "width": SHOT_VIEWPORT["width"], "height": height}
        for q in SHOT_QUALITY:
            jpeg = page.screenshot(type="jpeg", quality=q, full_page=True, clip=clip, timeout=TIMEOUT * 1000)
            if len(jpeg) <= MAX_SHOT_BYTES:
                return jpeg
        if height <= SHOT_VIEWPORT["height"]:
            return None
        height = max(SHOT_VIEWPORT["height"], height // 2)


def extract(w, status, body):
    if w.get("mode") == "feed":
        if status in (403, 429):
            raise Blocked(f"blocked (HTTP {status})")
        if status >= 400:
            raise RuntimeError(f"HTTP {status}")
        return apply_filters(feed_to_lines(body), w)
    visible = "\n".join(html_to_lines(body))
    if looks_blocked(status, visible):
        raise Blocked(f"blocked (HTTP {status})")
    if status >= 400:
        raise RuntimeError(f"HTTP {status}")
    return apply_filters(html_to_lines(body, w.get("selector")), w)


def check_plain(w, fetcher):
    """First pass, safe to run in threads (one per host). Returns lines, or None when a browser is needed."""
    mode = w.get("mode") or "auto"
    if mode == "browser":
        return None
    try:
        status, body = fetcher.get(w["url"])
    except requests.RequestException:
        if mode == "auto":
            return None  # timeout / reset: some sites only answer real browsers
        raise
    try:
        lines = extract(w, status, body)
    except (Blocked, ValueError):
        if mode == "auto":
            return None  # bot wall or selector not in the static HTML: let a real browser try
        raise
    if mode == "auto" and len("\n".join(lines)) < MIN_TEXT and not w.get("contains") and not w.get("selector"):
        return None  # near-empty ⇒ likely rendered by scripts
    return lines


def check_browser(w, browser):
    status, body = browser.get(w["url"])
    return extract(w, status, body)


# ---------------------------------------------------------------- diff + push

def summarize(old, new):
    diff = [l for l in difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm="", n=0)
            if l[:1] in "+-" and not l.startswith(("+++", "---"))]
    return "\n".join(("➕ " if l[0] == "+" else "➖ ") + l[1:] for l in diff[:25]) or "(whitespace/order change)"


def compare(w, lines):
    text = "\n".join(lines)[:MAX_TEXT]
    h = f"{EXTRACT_VERSION}:{hashlib.sha256(text.encode()).hexdigest()}"
    base = {"id": w["id"], "hash": h, "text": text}
    prev = w.get("last_hash") or ""
    if not prev.startswith(f"{EXTRACT_VERSION}:") or prev == h:
        return {**base, "changed": False}  # first baseline, extraction changed (re-baseline silently), or unchanged
    return {**base, "changed": True, "diff": summarize(w.get("last_text") or "", text)}


def send_push(w, vapid_key, subject):
    """Push to every subscriber. Returns endpoints the push service says are gone."""
    from pywebpush import WebPushException, webpush
    host = urlsplit(w["url"]).hostname or w["url"]
    host = host[4:] if host.startswith("www.") else host
    payload = json.dumps({
        "title": f"New version for {host}",
        "body": w["name"] if w["name"] != host else "Tap to open the page.",
        "url": w["url"],
        "watch_id": w["id"],
    }, ensure_ascii=False)
    dead = []
    for sub in w.get("subscriptions") or []:
        try:
            webpush(sub, payload, vapid_private_key=vapid_key, vapid_claims={"sub": subject},
                    ttl=24 * 3600, timeout=TIMEOUT)
        except WebPushException as e:
            code = e.response.status_code if e.response is not None else None
            if code in (404, 410):
                dead.append(sub["endpoint"])
            else:
                print(f"  push failed ({code}) {sub['endpoint'][:60]}…: {e}", file=sys.stderr)
        except Exception as e:
            print(f"  push failed {sub['endpoint'][:60]}…: {e}", file=sys.stderr)
    return dead


# ---------------------------------------------------------------- main

def with_shot(result, jpeg):
    """Attach the page's screenshot (base64) to its report entry. The Worker keeps it as the 'after'
    picture and also as 'before' when the page changed or has no 'before' yet (first baseline)."""
    return {**result, "shot": base64.b64encode(jpeg).decode()} if jpeg else result


def run(api, token, vapid_key, subject, dry_run=False, no_shots=False, home=False):
    auth = {"Authorization": f"Bearer {token}"}
    # ?start=1 tells the Worker a run began, which the app shows as "Checking…" until the report arrives.
    # The home checker runs on its own clock and leaves that indicator to the GitHub run.
    params = {"home": "1"} if home else None if dry_run else {"start": "1"}
    r = requests.get(f"{api}/api/internal/jobs", params=params, headers=auth, timeout=TIMEOUT)
    r.raise_for_status()
    watches = r.json()
    print(f"{len(watches)} watch(es)")
    if not watches:
        return 0

    fetcher = Fetcher(None if home else api, token)   # at home the Worker detour is never better than the direct line
    by_host = defaultdict(list)
    for w in watches:
        by_host[host_of(w["url"])].append(w)

    lines_by_id, errors, need_browser = {}, {}, []

    def plain_host(ws):  # one thread per host, so that host's requests go one after another
        out = []
        for w in ws:
            try:
                out.append((w, check_plain(w, fetcher), None))
            except Exception as e:
                out.append((w, None, describe_error(e)))
        return out

    with cf.ThreadPoolExecutor(max_workers=8) as pool:
        for f in cf.as_completed([pool.submit(plain_host, ws) for ws in by_host.values()]):
            for w, lines, err in f.result():
                if err:
                    errors[w["id"]] = err
                elif lines is None:
                    need_browser.append(w)
                else:
                    lines_by_id[w["id"]] = lines

    # One browser for the whole run: watches the plain pass couldn't read, then a screenshot of every page
    # that was read (plain-mode pages are loaded once more just for that).
    browser = Browser(fetcher)
    shots = {}
    try:
        for w in need_browser:
            try:
                lines_by_id[w["id"]] = check_browser(w, browser)
            except Exception as e:
                errors[w["id"]] = describe_error(e)
        if not no_shots:
            for w in watches:
                if w["id"] in lines_by_id:
                    shots[w["id"]] = browser.shot(w["url"])
    finally:
        browser.close()

    results, dead = [], set()
    for w in watches:
        via = "browser" if w in need_browser else fetcher.via.get(w["url"], "plain")
        if w["id"] in errors:
            print(f"[{w['name']}] ERROR ({via}): {errors[w['id']]}")
            results.append({"id": w["id"], "error": errors[w["id"]]})
            continue
        res = compare(w, lines_by_id[w["id"]])
        results.append(with_shot(res, shots.get(w["id"])))
        if w["id"] not in shots or shots[w["id"]] is None:
            via += ", no screenshot"
        if not res["changed"] and res["hash"] != w.get("last_hash"):
            print(f"[{w['name']}] baseline ({via}, {len(res['text'])} chars)")
        elif not res["changed"]:
            print(f"[{w['name']}] no change ({via})")
        else:
            subs = len(w.get("subscriptions") or [])
            print(f"[{w['name']}] CHANGED ({via}), pushing to {subs}\n{res['diff']}")
            if subs and not dry_run:
                dead.update(send_push(w, vapid_key, subject))

    if dry_run:
        print("dry run: nothing reported")
        return 0
    r = requests.post(f"{api}/api/internal/report", headers=auth, timeout=TIMEOUT,
                      json={"results": results, "dead_endpoints": sorted(dead), **({"via": "home"} if home else {})})
    r.raise_for_status()
    print(f"reported {len(results)} result(s), {len(dead)} dead endpoint(s)")
    return 0


def main():
    env = os.environ
    missing = [k for k in ("API_URL", "CHECKER_TOKEN", "VAPID_PRIVATE_KEY") if not env.get(k)]
    dry = "--dry-run" in sys.argv
    if missing and not (dry and missing == ["VAPID_PRIVATE_KEY"]):
        sys.exit(f"missing env: {', '.join(missing)}")
    subject = env.get("VAPID_SUBJECT") or "https://zsoltszavo.github.io"  # mailto: or bare https origin
    sys.exit(run(env["API_URL"].rstrip("/"), env["CHECKER_TOKEN"], env.get("VAPID_PRIVATE_KEY"), subject, dry,
                 no_shots="--no-shots" in sys.argv, home="--home" in sys.argv))


if __name__ == "__main__":
    main()
