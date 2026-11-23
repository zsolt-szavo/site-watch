#!/usr/bin/env python3
"""Site watcher: fetch pages, extract visible text, notify via ntfy.sh on change.

Stdlib only. Config in watches.json, state in state.json.
  python3 watch.py            # check all watches, notify on change
  python3 watch.py --test     # send a test notification to every topic
"""
import difflib, hashlib, html.parser, json, os, re, ssl, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "watches.json")
STATE = os.path.join(HERE, "state.json")
UA = "Mozilla/5.0 (site-watch)"
# python.org macOS builds ship without CA certs; fall back to the system bundle.
_CA = "/etc/ssl/cert.pem"
SSL_CTX = ssl.create_default_context(cafile=_CA) if os.path.exists(_CA) else ssl.create_default_context()
SKIP_TAGS = {"script", "style", "noscript", "svg", "head", "iframe"}


class TextExtractor(html.parser.HTMLParser):
    """Collect visible text, optionally only inside the element with a given id."""

    def __init__(self, only_id=None):
        super().__init__(convert_charrefs=True)
        self.only_id, self.skip, self.inside, self.depth, self.parts = only_id, 0, only_id is None, 0, []

    def handle_starttag(self, tag, attrs):
        if tag in SKIP_TAGS:
            self.skip += 1
        if self.only_id and not self.inside and dict(attrs).get("id") == self.only_id:
            self.inside, self.depth = True, 0
        elif self.only_id and self.inside and tag not in ("br", "img", "hr", "input", "meta", "link"):
            self.depth += 1

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS and self.skip:
            self.skip -= 1
        if self.only_id and self.inside:
            if self.depth == 0:
                self.inside = False
                self.only_id = "__done__"
            else:
                self.depth -= 1

    def handle_data(self, data):
        if self.inside and not self.skip and data.strip():
            self.parts.append(" ".join(data.split()))


def fetch_text(w):
    req = urllib.request.Request(w["url"], headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as r:
        raw = r.read().decode(r.headers.get_content_charset() or "utf-8", "replace")
    p = TextExtractor(w.get("element_id"))
    p.feed(raw)
    lines = p.parts
    for pat in w.get("ignore", []):  # regexes for noisy lines (counters, dates…)
        lines = [l for l in lines if not re.search(pat, l)]
    return "\n".join(lines)


def notify(topic, title, body, url, priority="default"):
    server = os.environ.get("NTFY_SERVER", "https://ntfy.sh")
    req = urllib.request.Request(
        f"{server}/{topic}", data=body[:3500].encode(), method="POST",
        headers={"Title": title.encode("utf-8").decode("latin-1", "ignore"),
                 "Click": url, "Priority": priority, "Tags": "eyes"})
    urllib.request.urlopen(req, timeout=30, context=SSL_CTX).read()


def summarize(old, new):
    diff = [l for l in difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm="", n=0)
            if l[:1] in "+-" and not l.startswith(("+++", "---"))]
    return "\n".join(("➕ " if l[0] == "+" else "➖ ") + l[1:] for l in diff[:25]) or "(whitespace/order change)"


def main():
    watches = json.load(open(CONFIG))
    state = json.load(open(STATE)) if os.path.exists(STATE) else {}
    test = "--test" in sys.argv
    failed = False
    for w in watches:
        name, topic = w["name"], os.environ.get("NTFY_TOPIC") or w["topic"]
        if test:
            notify(topic, f"site-watch test: {name}", "Notifications work 🎉", w["url"])
            print(f"[test] sent to {topic}"); continue
        try:
            text = fetch_text(w)
        except Exception as e:
            print(f"[{name}] fetch failed: {e}"); failed = True; continue
        h = hashlib.sha256(text.encode()).hexdigest()
        prev = state.get(name)
        if prev is None:
            print(f"[{name}] baseline stored ({len(text)} chars)")
        elif prev["hash"] != h:
            body = summarize(prev["text"], text)
            print(f"[{name}] CHANGED\n{body}")
            notify(topic, f"Changed: {name}", body, w["url"], w.get("priority", "high"))
        else:
            print(f"[{name}] no change")
        state[name] = {"hash": h, "text": text}
    if not test:
        json.dump(state, open(STATE, "w"), indent=1, ensure_ascii=False)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
