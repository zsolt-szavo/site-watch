"""E2E in real Firefox: PWA → subscribe (Mozilla autopush) → checker → push → notification.

Needs `wrangler dev` (worker/) and `python3 -m http.server 8000` (web/) running, checker/.venv + checker/.env.vapid.
Run: uv run --with selenium python web/test/e2e_firefox.py   (adds a test watch; delete it in the UI afterwards)
"""
import subprocess, sys, time
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path.home() / "Code/site-watch"
env_vars = dict(l.split("=", 1) for l in (ROOT / "worker/.dev.vars").read_text().split() if "=" in l)
INVITE = env_vars["INVITE_CODE"].strip().strip('"')
NAME = f"e2e FF {int(time.time())}"
HERE = Path(__file__).parent  # screenshot lands here (git-ignored)

def sh(cmd, cwd):
    out = subprocess.run(["bash", "-c", cmd], cwd=cwd, capture_output=True, text=True)
    return out.returncode, out.stdout + out.stderr

def checker():
    rc, out = sh("set -a; . ../worker/.dev.vars; . ./.env.vapid; set +a; API_URL=http://localhost:8787 .venv/bin/python check.py", ROOT / "checker")
    print("checker rc", rc, "|", " / ".join(l for l in out.splitlines() if NAME in l or "reported" in l or "push failed" in l))

def card_id(d):  # id of our card, found in-page (the list is redrawn often)
    return d.execute_script("const c=[...document.querySelectorAll('.watch')].find(c=>c.textContent.includes(arguments[0]));return c&&c.dataset.id", NAME)

def js(d, body):  # run async JS, body ends by calling done(value)
    return d.execute_async_script("const done = arguments[arguments.length-1];" + body)

o = webdriver.FirefoxOptions()
o.set_preference("permissions.default.desktop-notification", 1)
o.set_preference("dom.webnotifications.allowinsecure", True)
o.set_preference("remote.prefs.recommended", False)        # automation defaults disable push
o.set_preference("dom.push.enabled", True)
o.set_preference("dom.push.connection.enabled", True)
o.set_preference("dom.push.serverURL", "wss://push.services.mozilla.com/")
d = webdriver.Firefox(options=o)
d.set_window_size(440, 950)
d.set_script_timeout(60)
w8 = WebDriverWait(d, 30)
try:
    d.get("http://localhost:8000/")
    w8.until(lambda d: d.execute_script("return !!document.querySelector('#watches')"))
    d.find_element(By.NAME, "url").send_keys("news.ycombinator.com/newest")
    d.find_element(By.NAME, "name").send_keys(NAME)
    inv = d.find_element(By.NAME, "invite"); inv.clear(); inv.send_keys(INVITE)
    d.find_element(By.CSS_SELECTOR, "button[type=submit]").click()
    wid = w8.until(card_id); print("added", wid)

    time.sleep(1)
    d.find_element(By.CSS_SELECTOR, f".watch[data-id='{wid}'] .alert").click()
    w8.until(lambda d: not d.find_element(By.ID, "msg").text.startswith("Added"))
    print("msg:", d.find_element(By.ID, "msg").text)
    ep = js(d, "navigator.serviceWorker.ready.then(r=>r.pushManager.getSubscription()).then(s=>done(s&&s.endpoint))")
    print("endpoint:", (ep or "")[:60]); assert ep

    d.refresh()
    w8.until(card_id); time.sleep(1)
    assert d.execute_script("return document.querySelector(`.watch[data-id='${arguments[0]}'] .alert`).checked", wid); print("toggle restored after reload")

    checker()
    rc, out = sh(f"npx wrangler d1 execute site-watch --local --command \"UPDATE watches SET last_text='old line', last_hash=substr(last_hash,1,instr(last_hash,':'))||'x' WHERE id='{wid}'\"", ROOT / "worker")
    assert rc == 0, out[-400:]
    checker()

    ns = []
    for _ in range(60):
        ns = js(d, "navigator.serviceWorker.ready.then(r=>r.getNotifications()).then(n=>done(n.map(x=>({title:x.title, body:x.body.slice(0,100), tag:x.tag, url:x.data&&x.data.url}))))")
        if ns: break
        time.sleep(1)
    print("NOTIFICATIONS:", ns or "none within 60 s")
    d.refresh(); time.sleep(2)
    d.save_full_page_screenshot(str(HERE / "e2e_ff.png"))
finally:
    d.quit()
sys.exit(0 if ns else 1)
