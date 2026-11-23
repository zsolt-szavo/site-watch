#!/usr/bin/env python3
"""site-watch checker: fetch every watch, diff against the last check, send Web Push, report back.

Env:
  API_URL            Worker base URL, e.g. https://site-watch.<you>.workers.dev
  CHECKER_TOKEN      shared secret with the Worker
  VAPID_PRIVATE_KEY  base64url raw P-256 private key (see gen_vapid.py)
  VAPID_SUBJECT      contact for push services: mailto:… or a bare https origin (default: GitHub Pages origin)

  python check.py            # one full run
  python check.py --dry-run  # fetch + diff + print, no push, no report
"""
import concurrent.futures as cf
import difflib
import hashlib
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

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
    r = requests.get(url, headers={"User-Agent": UA, "Accept-Language": "en,hu;q=0.8"}, timeout=TIMEOUT)
    if r.encoding is None or r.encoding.lower() == "iso-8859-1":  # requests' default when no charset given
        r.encoding = r.apparent_encoding
    return r.status_code, r.text


class Browser:
    """Lazily started headless Chromium, shared across watches. Not thread-safe: use from one thread."""

    def __init__(self):
        self.pw = self.browser = None

    def get(self, url):
        if self.browser is None:
            from playwright.sync_api import sync_playwright
            self.pw = sync_playwright().start()
            self.browser = self.pw.chromium.launch()
        ctx = self.browser.new_context(user_agent=UA, locale="en-US")
        try:
            page = ctx.new_page()
            resp = page.goto(url, timeout=TIMEOUT * 1000, wait_until="domcontentloaded")
            try:
                page.wait_for_load_state("networkidle", timeout=10_000)
            except Exception:
                pass  # long-polling sites never go idle; take what we have
            return (resp.status if resp else 0), page.content()
        finally:
            ctx.close()

    def close(self):
        if self.browser:
            self.browser.close()
        if self.pw:
            self.pw.stop()


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


def check_plain(w):
    """First pass, safe to run in threads. Returns lines, or None when a browser is needed."""
    mode = w.get("mode") or "auto"
    if mode == "browser":
        return None
    try:
        status, body = fetch_plain(w["url"])
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


def send_push(w, diff, vapid_key, subject):
    """Push to every subscriber. Returns endpoints the push service says are gone."""
    from pywebpush import WebPushException, webpush
    payload = json.dumps({
        "title": f"Changed: {w['name']}",
        "body": diff[:1000],
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

def run(api, token, vapid_key, subject, dry_run=False):
    auth = {"Authorization": f"Bearer {token}"}
    r = requests.get(f"{api}/api/internal/jobs", headers=auth, timeout=TIMEOUT)
    r.raise_for_status()
    watches = r.json()
    print(f"{len(watches)} watch(es)")

    lines_by_id, errors, need_browser = {}, {}, []
    with cf.ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(check_plain, w): w for w in watches}
        for f in cf.as_completed(futs):
            w = futs[f]
            try:
                lines = f.result()
                if lines is None:
                    need_browser.append(w)
                else:
                    lines_by_id[w["id"]] = lines
            except Exception as e:
                errors[w["id"]] = str(e) or type(e).__name__

    if need_browser:
        browser = Browser()
        try:
            for w in need_browser:
                try:
                    lines_by_id[w["id"]] = check_browser(w, browser)
                except Exception as e:
                    errors[w["id"]] = (str(e) or type(e).__name__).splitlines()[0]
        finally:
            browser.close()

    results, dead = [], set()
    for w in watches:
        via = "browser" if w in need_browser else "plain"
        if w["id"] in errors:
            print(f"[{w['name']}] ERROR ({via}): {errors[w['id']]}")
            results.append({"id": w["id"], "error": errors[w["id"]]})
            continue
        res = compare(w, lines_by_id[w["id"]])
        results.append(res)
        if not res["changed"] and res["hash"] != w.get("last_hash"):
            print(f"[{w['name']}] baseline ({via}, {len(res['text'])} chars)")
        elif not res["changed"]:
            print(f"[{w['name']}] no change ({via})")
        else:
            subs = len(w.get("subscriptions") or [])
            print(f"[{w['name']}] CHANGED ({via}), pushing to {subs}\n{res['diff']}")
            if subs and not dry_run:
                dead.update(send_push(w, res["diff"], vapid_key, subject))

    if dry_run:
        print("dry run: nothing reported")
        return 0
    r = requests.post(f"{api}/api/internal/report", headers=auth, timeout=TIMEOUT,
                      json={"results": results, "dead_endpoints": sorted(dead)})
    r.raise_for_status()
    print(f"reported {len(results)} result(s), {len(dead)} dead endpoint(s)")
    return 0


def main():
    env = os.environ
    missing = [k for k in ("API_URL", "CHECKER_TOKEN", "VAPID_PRIVATE_KEY") if not env.get(k)]
    dry = "--dry-run" in sys.argv
    if missing and not (dry and missing == ["VAPID_PRIVATE_KEY"]):
        sys.exit(f"missing env: {', '.join(missing)}")
    subject = env.get("VAPID_SUBJECT") or "https://zsolt-szavo.github.io"  # mailto: or bare https origin
    sys.exit(run(env["API_URL"].rstrip("/"), env["CHECKER_TOKEN"], env.get("VAPID_PRIVATE_KEY"), subject, dry))


if __name__ == "__main__":
    main()
