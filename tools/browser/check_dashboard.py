#!/usr/bin/env python3
"""Real-browser check of dashboard.html with a stubbed backend (needs playwright).
Run from the project root: python3 tools/browser/check_dashboard.py [outdir]
Checks: counts cover all 130 stub orders (not just 25), values add up, a hostile customer name is shown as text and
never runs, no sideways scroll, each order row is wide enough to read, expanding a row works, dark mode applies."""
import os, sys, threading, http.server, socketserver, functools
from playwright.sync_api import sync_playwright
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/xredro-shots"; os.makedirs(OUT, exist_ok=True)
STUB = open("tools/browser/appwrite_stub.js").read()
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=os.getcwd())); PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
fails = []
def check(c, m):
    if not c: fails.append(m); print("FAIL:", m)
# the stub marks order 4 as cancelled: it counts in "Total orders" but not in submitted value
EXPECT_ALL = sum(10000 + 500 * i for i in range(130) if i != 4)
with sync_playwright() as p:
    br = p.chromium.launch()
    for name, w, h, dark in (("dash-phone", 390, 844, False), ("dash-desk", 1280, 900, False), ("dash-dark", 390, 844, True)):
        ctx = br.new_context(viewport={"width": w, "height": h}); pg = ctx.new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)[:120]))
        pg.route("**/cdn.jsdelivr.net/**", lambda r: r.fulfill(body=STUB, content_type="application/javascript"))
        pg.route("**/fonts.g*/**", lambda r: r.abort())
        if dark: pg.add_init_script("window.__THEME='dark'")
        pg.goto(f"http://127.0.0.1:{PORT}/dashboard.html"); pg.wait_for_timeout(1000)
        g = lambda i: pg.inner_text("#" + i)
        check(g("totalOrders") == "130" and g("paidOrders") == "42" and g("deliveredOrders") == "43" and g("pendingOrders") == "44", f"{name}: counts {g('totalOrders')}/{g('paidOrders')}/{g('deliveredOrders')}/{g('pendingOrders')}")
        check(g("valueAll") == f"₦{EXPECT_ALL:,}", f"{name}: submitted value {g('valueAll')}")
        check(pg.evaluate("window.__xss||0") == 0, f"{name}: hostile name executed")
        check("<img src=x" in pg.inner_text("#ordersList"), f"{name}: hostile name not shown as text")
        m = pg.evaluate("()=>({docW:document.documentElement.scrollWidth,vw:document.documentElement.clientWidth,head:document.querySelector('.dash-order__head').getBoundingClientRect().width,list:document.getElementById('ordersList').getBoundingClientRect().width})")
        check(m["docW"] <= m["vw"], f"{name}: sideways scroll"); check(m["head"] >= m["list"] * 0.9, f"{name}: order row only {m['head']:.0f}px of {m['list']:.0f}px")
        check(pg.evaluate("document.querySelectorAll('.dash-order').length") == 3, f"{name}: expected 3 latest orders")
        pg.click(".dash-order__head >> nth=0"); check(pg.get_attribute(".dash-order__head >> nth=0", "aria-expanded") == "true", f"{name}: row did not expand")
        if dark: check(pg.evaluate("document.body.dataset.theme") == "dark", f"{name}: dark theme not applied")
        check(not errs, f"{name}: script errors {errs}")
        pg.screenshot(path=f"{OUT}/{name}.png", full_page=True); ctx.close()
    br.close()
httpd.shutdown(); print("\nALL DASHBOARD CHECKS PASSED" if not fails else f"\n{len(fails)} FAILED"); sys.exit(1 if fails else 0)
