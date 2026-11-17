#!/usr/bin/env python3
"""Smoke test: loads every seller and account page with a stubbed backend and checks for script errors and
sideways scrolling at phone width. Run from the project root: python3 tools/browser/check_pages.py"""
import os, sys, threading, http.server, socketserver, functools
from playwright.sync_api import sync_playwright
STUB = open("tools/browser/appwrite_stub.js").read()
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=os.getcwd())); PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
PAGES = ["index.html", "login.html", "signup.html", "reset-password.html", "dashboard.html", "orders.html", "settings.html", "indexF.html", "guides/", "guides/how-to-take-orders-on-whatsapp-nigeria.html", "design-system.html"]
fails = []
with sync_playwright() as p:
    br = p.chromium.launch()
    for page in PAGES:
        for w in (390, 1280):
            ctx = br.new_context(viewport={"width": w, "height": 844}); pg = ctx.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)[:110]))
            pg.route("**/cdn.jsdelivr.net/**", lambda r: r.fulfill(body=(STUB if "appwrite" in r.request.url else "window.Tesseract=window.Tesseract||{};"), content_type="application/javascript"))
            pg.route("**/cdnjs.cloudflare.com/**", lambda r: r.fulfill(body="window.pdfjsLib=window.pdfjsLib||{GlobalWorkerOptions:{}};window.jspdf=window.jspdf||{};", content_type="application/javascript"))
            pg.route("**/fonts.g*/**", lambda r: r.abort())
            try: pg.goto(f"http://127.0.0.1:{PORT}/{page}", wait_until="load"); pg.wait_for_timeout(700)
            except Exception as e: fails.append(f"{page} {w}px: did not load ({str(e)[:60]})"); ctx.close(); continue
            m = pg.evaluate("()=>({d:document.documentElement.scrollWidth,v:document.documentElement.clientWidth})")
            if m["d"] > m["v"]: fails.append(f"{page} {w}px: sideways scroll ({m['d']} > {m['v']})")
            if errs: fails.append(f"{page} {w}px: script errors {errs}")
            ctx.close()
    br.close()
httpd.shutdown()
for f in fails: print("FAIL:", f)
print("\nALL PAGE SMOKE CHECKS PASSED" if not fails else f"\n{len(fails)} FAILED"); sys.exit(1 if fails else 0)
