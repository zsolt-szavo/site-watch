"""E2E in real Firefox: add a watch, edit it in the dialog, check what the server stored, delete it.

Needs `wrangler dev` (worker/) and `python3 -m http.server 8000` (web/) running.
Run: uv run --with selenium python web/test/e2e_edit_firefox.py   (cleans up after itself)
"""
import json, time, urllib.request
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path.home() / "Code/site-watch"
env_vars = dict(l.split("=", 1) for l in (ROOT / "worker/.dev.vars").read_text().split() if "=" in l)
INVITE = env_vars["INVITE_CODE"].strip().strip('"')
API = "http://localhost:8787"
NAME = f"e2e edit {int(time.time())}"


def server_watch(wid):
    with urllib.request.urlopen(f"{API}/api/watches/{wid}") as r:
        return json.load(r)


def card_id(d, name):
    return d.execute_script(
        "const c=[...document.querySelectorAll('.watch')].find(c=>c.querySelector('.name').textContent===arguments[0]);"
        "return c&&c.dataset.id", name)


def edit(d, w8, wid, **fields):
    d.find_element(By.CSS_SELECTOR, f".watch[data-id='{wid}'] .edit").click()
    w8.until(lambda d: d.find_element(By.ID, "edit-dialog").get_attribute("open") is not None)
    f = d.find_element(By.ID, "edit")
    for k, v in fields.items():
        el = f.find_element(By.NAME, k)
        if el.tag_name == "select":
            d.execute_script("arguments[0].value = arguments[1]", el, v)
        else:
            el.clear(); el.send_keys(v)
    f.find_element(By.CSS_SELECTOR, "button[type=submit]").click()
    w8.until(lambda d: d.find_element(By.ID, "edit-dialog").get_attribute("open") is None)


d = webdriver.Firefox()
d.set_window_size(440, 950)
w8 = WebDriverWait(d, 20)
wid = None
try:
    d.get("http://localhost:8000/")
    w8.until(lambda d: d.execute_script("return !!document.querySelector('#watches')"))
    add = d.find_element(By.ID, "add")
    add.find_element(By.NAME, "url").send_keys("example.com")
    add.find_element(By.NAME, "name").send_keys(NAME)
    inv = add.find_element(By.NAME, "invite"); inv.clear(); inv.send_keys(INVITE)
    add.find_element(By.CSS_SELECTOR, "button[type=submit]").click()
    wid = w8.until(lambda d: card_id(d, NAME))

    # Dialog is prefilled from the watch.
    d.find_element(By.CSS_SELECTOR, f".watch[data-id='{wid}'] .edit").click()
    f = d.find_element(By.ID, "edit")
    assert f.find_element(By.NAME, "name").get_attribute("value") == NAME
    assert f.find_element(By.NAME, "invite").get_attribute("value") == INVITE, "invite not remembered"
    f.find_element(By.CSS_SELECTOR, ".cancel").click()
    print("ok   prefilled + cancel")

    edit(d, w8, wid, selector="body > div", contains="domain", ignore="foo\n\\d+ bar", mode="plain")
    w = server_watch(wid)
    assert (w["selector"], w["contains"], w["ignore"], w["mode"]) == ("body > div", "domain", ["foo", r"\d+ bar"], "plain"), w
    print("ok   filters saved")

    edit(d, w8, wid, name=NAME + " renamed", selector="")
    w = server_watch(wid)
    assert w["name"] == NAME + " renamed" and w["selector"] is None and w["contains"] == "domain", w
    w8.until(lambda d: card_id(d, NAME + " renamed") == wid)
    print("ok   rename + clear selector, other filters kept")
    print("PASS")
finally:
    if wid:
        req = urllib.request.Request(f"{API}/api/watches/{wid}", method="DELETE", headers={"X-Invite-Code": INVITE})
        urllib.request.urlopen(req).read()
    d.quit()
