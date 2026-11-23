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
        dead = check.send_push(w, "➕ new line", vapid_b64, "https://example.com")
        srv.shutdown()

        self.assertEqual(dead, [f"{base}/gone"])
        path, headers, body = received[0]
        self.assertEqual(path, "/ok")
        self.assertIn("vapid", headers["Authorization"].lower())
        msg = json.loads(http_ece.decrypt(body, private_key=client, auth_secret=auth, version="aes128gcm"))
        self.assertEqual(msg, {"title": "Changed: Site", "body": "➕ new line", "url": "https://example.com/", "watch_id": "a"})


if __name__ == "__main__":
    unittest.main()
