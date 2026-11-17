#!/usr/bin/env python3
"""Real-browser check of orders.html with a stubbed backend (needs playwright). Run from the project root:
    python3 tools/browser/check_orders.py [outdir]"""
import os, sys, json, threading, http.server, socketserver, functools
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
def open_page(br, w, h, init=""):
    ctx = br.new_context(viewport={"width": w, "height": h}); pg = ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:140]))
    if init: pg.add_init_script(init)
    pg.route("**/cdn.jsdelivr.net/**", lambda r: r.fulfill(body=(STUB if "appwrite" in r.request.url else "window.Tesseract={};"), content_type="application/javascript"))
    pg.route("**/cdnjs.cloudflare.com/**", lambda r: r.fulfill(body="window.pdfjsLib={GlobalWorkerOptions:{}};window.jspdf={};", content_type="application/javascript"))
    pg.route("**/fonts.g*/**", lambda r: r.abort()); pg.route("**/nyc.cloud.appwrite.io/**", lambda r: r.abort())
    pg.goto(f"http://127.0.0.1:{PORT}/orders.html"); pg.wait_for_timeout(1000); pg._errs = errs; return pg
chips = lambda pg: pg.evaluate("[...document.querySelectorAll('.ord-filters button')].map(b=>b.textContent)")
cards = lambda pg: pg.locator(".ord-card").count()
with sync_playwright() as p:
    br = p.chromium.launch()
    for w, h in ((390, 844), (1280, 900)):
        tag = f"{w}px"; pg = open_page(br, w, h)
        check(chips(pg) == ["All 130", "Unpaid 44", "Needs review 1", "Updated 0", "Paid 42", "Delivered 43", "Cancelled 1"], f"{tag}: chips {chips(pg)}")
        m = pg.evaluate("()=>({d:document.documentElement.scrollWidth,v:document.documentElement.clientWidth,hw:document.querySelector('.ord-head').getBoundingClientRect().width,cw:document.querySelector('.ord-card').getBoundingClientRect().width})")
        check(m["d"] <= m["v"], f"{tag}: sideways scroll"); check(m["hw"] >= m["cw"] * 0.95, f"{tag}: order header squeezed ({m['hw']:.0f} of {m['cw']:.0f})")
        check(cards(pg) == 30 and "Show 30 more (100 left)" in pg.inner_text(".ord-more"), f"{tag}: first page {cards(pg)} cards / '{pg.inner_text('.ord-more') if pg.locator('.ord-more').count() else 'no button'}'")
        pg.click(".ord-more"); check(cards(pg) == 60, f"{tag}: Show more gave {cards(pg)} cards")
        check(pg.evaluate("window.__xss||0") == 0, f"{tag}: hostile customer name executed")
        check("<img src=x" in pg.inner_text(".ord-card"), f"{tag}: hostile name not shown as text")
        # filters + search
        pg.click("[data-filter=review]"); check(cards(pg) == 1 and "Proof uploaded" in pg.inner_text(".ord-card"), f"{tag}: Needs review shows {cards(pg)}")
        pg.click("[data-filter=cancelled]"); check(cards(pg) == 1 and "Cancelled" in pg.inner_text(".ord-card"), f"{tag}: Cancelled filter")
        pg.click("[data-filter=all]"); pg.fill("#orderSearch", "Customer 12"); pg.wait_for_timeout(150)
        check(0 < cards(pg) <= 12 and all("Customer 12" in t for t in pg.locator(".ord-name").all_inner_texts()), f"{tag}: search results {pg.locator('.ord-name').all_inner_texts()[:3]}")
        pg.fill("#orderSearch", "zzzz-nothing"); pg.wait_for_timeout(150); check("No orders match" in pg.inner_text("#ordersList"), f"{tag}: empty search message")
        pg.fill("#orderSearch", ""); pg.wait_for_timeout(150)
        # expand + change status (optimistic) + record
        pg.click("[data-filter=pending]"); head = pg.locator(".ord-head").first; head.click()
        check(head.get_attribute("aria-expanded") == "true" and pg.locator(".ord-details").first.is_visible(), f"{tag}: card did not expand")
        pg.locator(".ord-card.is-open").get_by_role("button", name="Paid", exact=True).click(); pg.wait_for_timeout(300)
        check(chips(pg)[1] == "Unpaid 43" and chips(pg)[4] == "Paid 43", f"{tag}: counts after marking paid {chips(pg)}")
        check(pg.evaluate("(window.__saves||[]).slice(-1)[0]") == {"status": "paid"}, f"{tag}: saved {pg.evaluate('(window.__saves||[]).slice(-1)[0]')}")
        # cancel (native confirm) and restore
        pg.once("dialog", lambda d: d.accept()); pg.locator(".ord-head").first.click(); pg.locator(".ord-card.is-open").get_by_text("Cancel order").click(); pg.wait_for_timeout(300)
        check(chips(pg)[6] == "Cancelled 2", f"{tag}: cancel not counted {chips(pg)}")
        pg.click("[data-filter=cancelled]"); pg.locator(".ord-head").first.click(); pg.locator(".ord-card.is-open").get_by_text("Restore as unpaid").click(); pg.wait_for_timeout(300)
        check(chips(pg)[6] == "Cancelled 1", f"{tag}: restore not counted {chips(pg)}")
        pg.screenshot(path=f"{OUT}/orders-{w}.png"); check(not pg._errs, f"{tag}: errors {pg._errs}"); pg.context.close()
        # failed status change rolls back
        pg = open_page(br, w, h, "window.__FAIL_SAVE=true;"); pg.click("[data-filter=pending]"); pg.locator(".ord-head").first.click()
        pg.locator(".ord-card.is-open").get_by_role("button", name="Delivered", exact=True).click(); pg.wait_for_timeout(400)
        check(chips(pg)[1] == "Unpaid 44" and "Could not update" in pg.inner_text("#toast-container"), f"{tag}: failed update not rolled back {chips(pg)}")
        pg.context.close()
        # load failure shows a message and Try again works
        pg = open_page(br, w, h, "window.__FAIL_ORDERS=true;")
        check("Could not load your orders" in pg.inner_text("#ordersList"), f"{tag}: no error message when loading fails")
        pg.evaluate("window.__FAIL_ORDERS=false"); pg.get_by_text("Try again").click(); pg.wait_for_timeout(800)
        check(cards(pg) == 30, f"{tag}: Try again did not load orders ({cards(pg)})"); pg.context.close()
    br.close()
httpd.shutdown(); print("\nALL ORDERS CHECKS PASSED" if not fails else f"\n{len(fails)} FAILED"); sys.exit(1 if fails else 0)
