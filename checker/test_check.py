"""Offline unit tests: python -m unittest -v (from checker/)."""
import base64, json, threading, unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

import http_ece
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

import check

PAGE = """<html><head><title>t</title><style>.x{}</style></head><body>
<nav>Menu</nav><div id="main"><p>Price: 12 EUR</p><p>Updated 10:42</p><script>var a=1</script></div>
<footer>Footer &amp; co</footer></body></html>"""


class Extract(unittest.TestCase):
    def test_visible_text_only(self):
        self.assertEqual(check.html_to_lines(PAGE), ["Menu", "Price: 12 EUR", "Updated 10:42", "Footer & co"])

    def test_selector(self):
        self.assertEqual(check.html_to_lines(PAGE, "#main"), ["Price: 12 EUR", "Updated 10:42"])

    def test_selector_missing(self):
        with self.assertRaises(ValueError):
            check.html_to_lines(PAGE, "#nope")

    def test_ignore_and_contains(self):
        lines = ["Price: 12 EUR", "Updated 10:42", "Sold out"]
        self.assertEqual(check.apply_filters(lines, {"ignore": [r"\d+:\d+"]}), ["Price: 12 EUR", "Sold out"])
        self.assertEqual(check.apply_filters(lines, {"contains": "sold OUT"}), ["Sold out"])
        self.assertEqual(check.apply_filters(lines[:1], {"contains": "sold out"}), ['(no line contains "sold out")'])

    def test_relative_time_scrubbed(self):
        lines = ["1 point by bob 5 minutes ago | hide", "an hour ago", "posted 3h ago by x", "Frissítve 12 perce",
                 "2 ore fa", "Updated 10:42", "Just now", "History of the ago-ra", "12.", "3)"]
        self.assertEqual(check.apply_filters(lines, {}),
                         ["1 point by bob | hide", "posted by x", "Frissítve", "Updated 10:42", "History of the ago-ra"])

    def test_feed_blocked(self):
        with self.assertRaises(check.Blocked):
            check.extract({"mode": "feed"}, 429, "")

    def test_feed(self):
        rss = "<rss><channel><item><title>A  post</title><link>https://x/1</link></item></channel></rss>"
        atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>B</title><link href="https://x/2"/></entry></feed>'
        self.assertEqual(check.feed_to_lines(rss), ["A post — https://x/1"])
        self.assertEqual(check.feed_to_lines(atom), ["B — https://x/2"])

    def test_blocked(self):
        self.assertTrue(check.looks_blocked(200, "Just a moment... Enable JavaScript and cookies to continue"))
        self.assertTrue(check.looks_blocked(403, "whatever"))
        self.assertFalse(check.looks_blocked(200, "normal page " * 50))
        with self.assertRaises(check.Blocked):
            check.extract({}, 403, "<p>Access denied</p>")


class Compare(unittest.TestCase):
    def test_baseline_unchanged_changed(self):
        w = {"id": "a", "last_hash": None}
        r = check.compare(w, ["x"])
        self.assertFalse(r["changed"])
        w.update(last_hash=r["hash"], last_text=r["text"])
        self.assertFalse(check.compare(w, ["x"])["changed"])
        r2 = check.compare(w, ["x", "y"])
        self.assertTrue(r2["changed"])
        self.assertEqual(r2["diff"], "➕ y")
        w["last_hash"] = "x0:" + r["hash"].split(":")[1]  # stored by an older extraction version
        self.assertFalse(check.compare(w, ["x", "y"])["changed"])


class Fetching(unittest.TestCase):
    """Fetcher: one download per URL, pacing per host, one retry on 429, Worker fallback when blocked."""

    def setUp(self):
        self.calls, self.slept, self.answers = [], [], {}
        self.orig = check.fetch_plain
        check.fetch_plain = lambda url: (self.calls.append(url), self.answers[url].pop(0))[1]

    def tearDown(self):
        check.fetch_plain = self.orig

    def fetcher(self, **kw):
        return check.Fetcher(sleep=self.slept.append, **kw)

    def test_dedupe_and_host_gap(self):
        self.answers = {"https://a.it/": [(200, "x", None)], "https://www.a.it/p": [(200, "y", None)]}
        f = self.fetcher()
        for u in ["https://a.it/", "https://a.it/", "https://www.a.it/p"]:
            f.get(u)
        self.assertEqual(self.calls, ["https://a.it/", "https://www.a.it/p"])  # same URL fetched once
        self.assertEqual(len(self.slept), 1)                                     # second request waited its turn
        self.assertGreater(self.slept[0], check.HOST_GAP - 1)

    def test_retry_after_429(self):
        self.answers = {"https://a.it/": [(429, "slow down", 7), (200, "ok", None)]}
        self.assertEqual(self.fetcher(gap=0).get("https://a.it/"), (200, "ok"))
        self.assertEqual(self.slept[0], 7)

    def test_worker_fallback(self):
        self.answers = {"https://a.it/": [(429, "", None), (429, "", None)]}
        f = self.fetcher(gap=0)
        f.via_worker = lambda url: (200, "from worker")
        self.assertEqual(f.get("https://a.it/"), (200, "from worker"))
        f.via_worker = lambda url: (520, "")   # worker refused too: keep the original answer
        f.cache.clear()
        self.answers = {"https://a.it/": [(429, "", None), (429, "", None)]}
        self.assertEqual(f.get("https://a.it/")[0], 429)

    def test_worker_5xx_after_timeout_is_no_answer(self):
        f = self.fetcher(gap=0)
        def timeout(url): raise check.requests.Timeout("read timed out")
        check.fetch_plain, saved = timeout, check.fetch_plain
        try:
            f.via_worker = lambda url: (520, "")   # Cloudflare couldn't reach the site either
            with self.assertRaises(check.requests.Timeout):
                f.get("https://slow.it/")
            f.cache.clear()
            f.via_worker = lambda url: (200, "from worker")
            self.assertEqual(f.get("https://slow.it/"), (200, "from worker"))
        finally:
            check.fetch_plain = saved

    def test_describe_error(self):
        d = check.describe_error
        self.assertEqual(d(check.requests.Timeout("x")), "not responding (the site didn't answer)")
        self.assertEqual(d(RuntimeError("Page.goto: Timeout 30000ms exceeded.\nCall log: …")),
                         "not responding (the site didn't answer)")
        self.assertEqual(d(RuntimeError("net::ERR_CONNECTION_REFUSED at http://a.it/")), "not responding (the site didn't answer)")
        self.assertEqual(d(RuntimeError("HTTP 520")), "not responding (HTTP 520)")
        self.assertEqual(d(RuntimeError("HTTP 404")), "HTTP 404")
        self.assertEqual(d(check.Blocked("blocked (HTTP 403)")), "blocked (HTTP 403)")


class Shots(unittest.TestCase):
    def test_with_shot(self):
        r = {"id": "a", "changed": False}
        self.assertEqual(check.with_shot(r, None), r)
        self.assertEqual(base64.b64decode(check.with_shot(r, b"\xff\xd8jpeg")["shot"]), b"\xff\xd8jpeg")

    def test_screenshot_quality_then_height_fallback(self):
        big = check.MAX_SHOT_BYTES + 1
        class Page:
            def __init__(self, sizes, height=3000): self.sizes, self.height, self.calls = sizes, height, []
            def evaluate(self, js): return self.height
            def screenshot(self, type, quality, full_page, clip, timeout):
                assert full_page
                self.calls.append((quality, clip["height"]))
                return b"x" * self.sizes.pop(0)
        p = Page([10])
        self.assertEqual(check.screenshot(p), b"x" * 10)
        self.assertEqual(p.calls, [(60, 3000)])
        p = Page([big, 20])
        self.assertEqual(check.screenshot(p), b"x" * 20)
        self.assertEqual(p.calls, [(60, 3000), (40, 3000)])
        # Too big at every quality: half the height, then give up once at one screen.
        p = Page([big] * 3 + [30])
        self.assertEqual(check.screenshot(p), b"x" * 30)
        self.assertEqual(p.calls[3], (60, 1500))
        p = Page([big] * 15, height=99_999)
        self.assertIsNone(check.screenshot(p))
        self.assertEqual([h for _, h in p.calls[::3]], [check.SHOT_MAX_HEIGHT, 4000, 2000, 1000, 900])
        self.assertIsNone(check.screenshot(Page([big] * 3, height=100)))   # one screen, never fits

    def test_browser_shot_reuses_load_and_survives_errors(self):
        b = check.Browser()
        loads = []
        def fake_get(url):
            loads.append(url)
            if "bad" in url:
                raise RuntimeError("net::ERR")
            b.shots[url] = b"jpeg:" + url.encode()
            return 200, "<p>x</p>"
        b._get = fake_get
        b.get("https://a.it/")                       # browser-mode check
        self.assertEqual(b.shot("https://a.it/"), b"jpeg:https://a.it/")
        self.assertEqual(b.shot("https://b.it/"), b"jpeg:https://b.it/")   # plain-mode page: loaded for its picture
        self.assertIsNone(b.shot("https://bad.it/"))
        self.assertEqual(loads, ["https://a.it/", "https://b.it/", "https://bad.it/"])

    @unittest.skipUnless(__import__("importlib").util.find_spec("playwright"), "playwright not installed")
    def test_real_browser_screenshot(self):
        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(PAGE.encode())
            def log_message(self, *a):
                pass
        srv = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        b = check.Browser()
        try:
            jpeg = b.shot(f"http://127.0.0.1:{srv.server_port}/")
        except Exception as e:  # browser binary missing locally
            self.skipTest(f"no chromium: {e}")
        finally:
            b.close()
            srv.shutdown()
        if jpeg is None and b.cache and isinstance(next(iter(b.cache.values())), Exception):
            self.skipTest(f"no chromium: {next(iter(b.cache.values()))}")
        self.assertTrue(jpeg.startswith(b"\xff\xd8\xff"))
        self.assertLess(len(jpeg), check.MAX_SHOT_BYTES)


class Push(unittest.TestCase):
    """Real pywebpush call against a local push endpoint; decrypts the payload like a browser would."""

    def test_push_roundtrip_and_dead_endpoint(self):
        received = []

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                received.append((self.path, self.headers, self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(410 if self.path == "/gone" else 201)
                self.end_headers()

            def log_message(self, *a):
                pass

        srv = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{srv.server_port}"

        b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
        client = ec.generate_private_key(ec.SECP256R1())
        auth = b"0123456789abcdef"
        keys = {"p256dh": b64(client.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)), "auth": b64(auth)}
        vapid = ec.generate_private_key(ec.SECP256R1())
        vapid_b64 = b64(vapid.private_numbers().private_value.to_bytes(32, "big"))

        w = {"id": "a", "name": "Site", "url": "https://example.com/",
             "subscriptions": [{"endpoint": f"{base}/ok", "keys": keys}, {"endpoint": f"{base}/gone", "keys": keys}]}
        dead = check.send_push(w, vapid_b64, "https://example.com")
        srv.shutdown()

        self.assertEqual(dead, [f"{base}/gone"])
        path, headers, body = received[0]
        self.assertEqual(path, "/ok")
        self.assertIn("vapid", headers["Authorization"].lower())
        msg = json.loads(http_ece.decrypt(body, private_key=client, auth_secret=auth, version="aes128gcm"))
        self.assertEqual(msg, {"title": "New version for example.com", "body": "Site", "url": "https://example.com/", "watch_id": "a"})


class RunReportTest(unittest.TestCase):
    """Each watch is reported on its own: a rejected report loses only that watch, and its change isn't pushed."""
    def test_one_failed_report_keeps_the_rest(self):
        jobs = [{"id": i, "name": i, "url": f"https://{i}.example/", "last_hash": f"{check.EXTRACT_VERSION}:old",
                 "last_text": "old", "subscriptions": [{"endpoint": "https://push.example/x", "keys": {}}]}
                for i in ("a", "b", "c")]
        posts = []

        class Api(BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def do_GET(self):
                body = json.dumps(jobs).encode()
                self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
                self.wfile.write(body)
            def do_POST(self):
                b = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                posts.append(b)
                bad = any(r["id"] == "b" for r in b["results"])
                self.send_response(500 if bad else 200); self.send_header("Content-Length", "2"); self.end_headers()
                self.wfile.write(b"{}")

        srv = HTTPServer(("127.0.0.1", 0), Api)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        pushed = []
        orig = (check.check_plain, check.Browser, check.send_push, check.time.sleep)
        class NoBrowser:
            def __init__(self, *a): pass
            def shot(self, url): return None
            def close(self): pass
        check.check_plain = lambda w, f: ["new"]
        check.Browser = NoBrowser
        check.send_push = lambda w, *a: pushed.append(w["id"]) or []
        check.time.sleep = lambda s: None
        try:
            rc = check.run(f"http://127.0.0.1:{srv.server_address[1]}", "t", "k", "s")
        finally:
            check.check_plain, check.Browser, check.send_push, check.time.sleep = orig
            srv.shutdown()
        self.assertEqual(rc, 1)
        self.assertEqual(sorted(pushed), ["a", "c"])
        ids = [r["id"] for p in posts for r in p["results"]]
        self.assertEqual(sorted(ids), ["a", "b", "b", "c"])          # b retried once
        self.assertTrue(all(p.get("partial") for p in posts if p["results"]))
        self.assertEqual(posts[-1], {"results": [], "dead_endpoints": []})   # closing report ends "Checking…"

    def test_long_diff_lines_are_clipped(self):
        d = check.summarize("x" * 1000, "y" * 1000)
        self.assertTrue(all(len(l) <= check.DIFF_LINE_MAX + 3 for l in d.splitlines()))


if __name__ == "__main__":
    unittest.main()
