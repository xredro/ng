#!/usr/bin/env python3
"""Real-browser check of the account pages at 320 and 390 px (needs playwright). Run from the project root:
    python3 tools/browser/check_account.py
Checks: no sideways scroll, inputs are 16px or larger, every visible link/button/input is at least 44px tall."""
import os, sys, threading, http.server, socketserver, functools
from playwright.sync_api import sync_playwright
STUB = open("tools/browser/appwrite_stub.js").read().replace("class Account { get() {", "class Account { get() { return Promise.reject({code:401}); } getX() {")
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=os.getcwd())); PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
fails = []
MEASURE = """()=>{const out=[];document.querySelectorAll('a[href],button,input:not([type=hidden])').forEach(e=>{const r=e.getBoundingClientRect(),cs=getComputedStyle(e);
 if(r.width===0||r.height===0||cs.visibility==='hidden'||e.closest('.hidden'))return; const tag=e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+' '+(e.textContent||'').trim().slice(0,22);
 out.push({tag,h:Math.round(r.height),fs:parseFloat(cs.fontSize),isInput:e.tagName==='INPUT'})});return {items:out,d:document.documentElement.scrollWidth,v:document.documentElement.clientWidth}}"""
with sync_playwright() as p:
    br = p.chromium.launch()
    for page in ("login", "signup", "reset-password", "verify", "verifyInfo"):
        for w in (320, 390):
            ctx = br.new_context(viewport={"width": w, "height": 740}); pg = ctx.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)[:100]))
            pg.route("**/cdn.jsdelivr.net/**", lambda r: r.fulfill(body=STUB, content_type="application/javascript")); pg.route("**/fonts.g*/**", lambda r: r.abort())
            pg.goto(f"http://127.0.0.1:{PORT}/{page}.html"); pg.wait_for_timeout(700)
            m = pg.evaluate(MEASURE)
            if m["d"] > m["v"]: fails.append(f"{page} {w}px: sideways scroll")
            for it in m["items"]:
                if it["h"] < 44 and not it["tag"].startswith("a ") or (it["tag"].startswith("a") and it["h"] < 44): fails.append(f"{page} {w}px: '{it['tag']}' only {it['h']}px tall")
                if it["isInput"] and it["fs"] < 16: fails.append(f"{page} {w}px: input '{it['tag']}' font {it['fs']}px (iPhones zoom below 16px)")
            if errs: fails.append(f"{page} {w}px: errors {errs}")
            if w == 390: pg.screenshot(path=f"/tmp/xredro-shots/account-{page}.png") if os.path.isdir("/tmp/xredro-shots") else None
            ctx.close()
    br.close()
httpd.shutdown()
for f in sorted(set(fails)): print("FAIL:", f)
print("\nALL ACCOUNT PAGE CHECKS PASSED" if not fails else f"\n{len(set(fails))} FAILED"); sys.exit(1 if fails else 0)
