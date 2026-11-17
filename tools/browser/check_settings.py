#!/usr/bin/env python3
"""Real-browser check of settings.html with a stubbed backend (needs playwright). Run from the project root:
    python3 tools/browser/check_settings.py [outdir]"""
import os, sys, threading, http.server, socketserver, functools
from playwright.sync_api import sync_playwright
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/xredro-shots"; os.makedirs(OUT, exist_ok=True)
STUB = open("tools/browser/appwrite_stub.js").read().replace("class Account { get() {", "class Account { updateName(n) { (window.__acct = window.__acct || []).push(['name', n]); return later({}); } updateEmail(e, p) { (window.__acct = window.__acct || []).push(['email', e, p]); return later({}); } get() {")
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=os.getcwd())); PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
fails = []
def check(c, m):
    if not c: fails.append(m); print("FAIL:", m)
def open_page(br, w, h, init=""):
    ctx = br.new_context(viewport={"width": w, "height": h}); pg = ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:140]))
    if init: pg.add_init_script(init)
    pg.route("**/cdn.jsdelivr.net/**", lambda r: r.fulfill(body=STUB, content_type="application/javascript")); pg.route("**/fonts.g*/**", lambda r: r.abort())
    pg.goto(f"http://127.0.0.1:{PORT}/settings.html"); pg.wait_for_timeout(1000); pg._errs = errs; return pg
with sync_playwright() as p:
    br = p.chromium.launch()
    for w, h in ((390, 844), (1280, 900)):
        tag = f"{w}px"; pg = open_page(br, w, h)
        m = pg.evaluate("()=>({d:document.documentElement.scrollWidth,v:document.documentElement.clientWidth,edit:document.getElementById('userUpdate').getBoundingClientRect().width})")
        check(m["d"] <= m["v"], f"{tag}: sideways scroll"); check(m["edit"] < 140, f"{tag}: Edit button is {m['edit']:.0f}px wide")
        check(pg.inner_text("#subPlan") == "30 days" and pg.inner_text("#subStatus") == "Active" and pg.inner_text("#subExpires") == "20 days", f"{tag}: plan not shown from the real subscription")
        check("System Status" not in pg.inner_text("main"), f"{tag}: the static System Status panel is back")
        # edit flow: locked until Edit; Save only while editing
        check(pg.is_disabled("#username") and pg.is_disabled("#updateAccount"), f"{tag}: fields should be locked at first")
        pg.click("#userUpdate"); check(not pg.is_disabled("#username") and not pg.is_disabled("#updateAccount") and pg.inner_text("#userUpdate") == "Cancel", f"{tag}: Edit did not unlock")
        pg.fill("#username", "Changed Name"); pg.click("#userUpdate")
        check(pg.input_value("#username") == "" and pg.is_disabled("#updateAccount"), f"{tag}: Cancel did not restore ('{pg.input_value('#username')}')")
        # name-only change must NOT ask for a password
        asked = []; pg.on("dialog", lambda d: (asked.append(d.message), d.dismiss()))
        pg.click("#userUpdate"); pg.fill("#username", "Amaka"); pg.click("#updateAccount"); pg.wait_for_timeout(500)
        check(not asked, f"{tag}: asked for a password for a name-only change ({asked})")
        acct = pg.evaluate("window.__acct||[]"); check(acct == [["name", "Amaka"]], f"{tag}: account calls {acct}")
        check(pg.inner_text("#profileNameDisplay") == "Amaka" and pg.is_disabled("#username"), f"{tag}: profile not refreshed/locked")
        # email change asks for the password; cancelling the prompt changes nothing
        pg.click("#userUpdate"); pg.fill("#email", "new@x.com"); pg.click("#updateAccount"); pg.wait_for_timeout(300)
        check(len(asked) == 1 and pg.evaluate("window.__acct").__len__() == 1, f"{tag}: email change prompt/guard ({asked})")
        # invalid email is refused before anything is sent
        pg.fill("#email", "not-an-email"); pg.click("#updateAccount"); pg.wait_for_timeout(200)
        check("valid email" in pg.inner_text("#toast-container") and pg.evaluate("window.__acct").__len__() == 1, f"{tag}: invalid email not refused")
        # password modal
        pg.click("text=Change password"); check(pg.is_visible("#currentPassword"), f"{tag}: password modal did not open")
        pg.click("text=Cancel >> nth=-1") if False else pg.keyboard.press("Escape")
        pg.screenshot(path=f"{OUT}/settings-{w}.png", full_page=True); check(not pg._errs, f"{tag}: errors {pg._errs}"); pg.context.close()
        pg = open_page(br, w, h, "window.__FAIL_SETTINGS=1;")  # sanity: page still loads
        pg.context.close()
    br.close()
httpd.shutdown(); print("\nALL SETTINGS CHECKS PASSED" if not fails else f"\n{len(fails)} FAILED"); sys.exit(1 if fails else 0)
