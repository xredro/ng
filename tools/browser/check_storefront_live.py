#!/usr/bin/env python3
"""Real-browser check of the live store page (form.html) and the sold-out rules, with a stubbed backend.
Run from the project root: python3 tools/browser/check_storefront_live.py [outdir]
Checks: a sold-out product cannot be ordered; a normal order is created; a product the seller marks sold out while the
customer is shopping is removed at submit and no order is sent; a failed re-check does not block the order;
reordering the store in the meantime cannot swap products."""
import os, sys, json, datetime, threading, http.server, socketserver, functools
from playwright.sync_api import sync_playwright
STUB = open("tools/browser/appwrite_stub.js").read()
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=os.getcwd())); PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
fails = []
def check(c, m):
    if not c: fails.append(m); print("FAIL:", m)
def prod(name, price, **kw): return dict({"name": name, "price": str(price), "imageId": "", "imageUrl": "", "category": "General", "description": ""}, **kw)
def store(products): return [{"id": "p1", "type": "product", "label": "Products", "products": products}, {"id": "t1", "type": "text", "label": "Full name"}]
A, B = prod("Handbag", 12000), prod("Watch", 8000)
def open_page(br, w, fields, flip=None, flip_fail=False):
    ctx = br.new_context(viewport={"width": w, "height": 844}); pg = ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:140]))
    pg.add_init_script(f"window.__FORM_FIELDS={json.dumps(fields)};" + (f"window.__FLIP={json.dumps(flip)};" if flip else "") + ("window.__FLIP_FAIL=true;" if flip_fail else ""))
    pg.route("**/cdn.jsdelivr.net/**", lambda r: r.fulfill(body=STUB, content_type="application/javascript")); pg.route("**/fonts.g*/**", lambda r: r.abort())
    pg.goto(f"http://127.0.0.1:{PORT}/form.html?fid=u1"); pg.wait_for_timeout(900); pg._errs = errs; return pg
def checkout(pg, add):
    for sel in add: pg.click(sel)
    pg.click(".sf-cart-btn"); pg.click("#sfCheckoutBtn"); pg.wait_for_timeout(200)
    pg.fill("[data-id=t1]", "Ada Obi"); pg.fill("#paymentAccountName", "Ada Obi"); pg.fill("#datePaid", datetime.date.today().isoformat())
created = lambda pg: pg.evaluate("window.__created||[]")
toasts = lambda pg: pg.inner_text("#toast-container")
with sync_playwright() as p:
    br = p.chromium.launch()
    for w in (390, 1280):
        tag = f"{w}px"
        # 1. sold-out product cannot be ordered
        pg = open_page(br, w, store([A, dict(B, soldOut=True)]))
        check(pg.locator(".sf-card").count() == 2 and pg.locator(".sf-stock-out").count() == 1, f"{tag}: Sold out badge missing")
        check(pg.locator(".sf-card").nth(1).locator(".sf-add").is_disabled(), f"{tag}: Add enabled on a sold-out product")
        pg.locator(".sf-card").nth(1).locator(".sf-card-media").click(); pg.wait_for_timeout(150)
        check(pg.locator(".popup-card button:not([disabled])").count() == 0 or all(b.is_disabled() for b in pg.locator(".product-popup .product-qty button").all() if b.is_visible()), f"{tag}: quantity buttons usable on a sold-out product")
        pg.evaluate("changeQty('p1', 1, 1)"); check(pg.evaluate("cart.p1_1||0") == 0, f"{tag}: sold-out product reached the cart")
        check(not pg._errs, f"{tag}: errors {pg._errs}"); pg.context.close()
        # 2. a normal order goes through
        pg = open_page(br, w, store([A, B]))
        checkout(pg, [".sf-add >> nth=0"]); pg.click(".send-btn"); pg.wait_for_timeout(800)
        c = created(pg); check(len(c) == 1 and float(c[0]["data"]["totalAmount"]) == 12000, f"{tag}: order not created correctly {c}")
        check("Your order has been sent" in pg.inner_text("#formRoot"), f"{tag}: no success screen"); pg.context.close()
        # 3. seller marks it sold out while the customer is shopping
        pg = open_page(br, w, store([A, B]), flip=store([dict(A, soldOut=True), B]))
        checkout(pg, [".sf-add >> nth=0"]); pg.click(".send-btn"); pg.wait_for_timeout(800)
        check(len(created(pg)) == 0, f"{tag}: an order was sent for a product that sold out")
        check("just sold out" in toasts(pg), f"{tag}: customer not told ('{toasts(pg)[:60]}')")
        check(pg.evaluate("Object.values(cart).filter(Boolean).length") == 0, f"{tag}: sold-out item still in the cart")
        check(pg.locator(".sf-card").first.locator(".sf-add").is_disabled() and pg.locator(".sf-stock-out").count() == 1, f"{tag}: store not redrawn with the product sold out")
        check(not pg.is_visible(".cart-bar.visible"), f"{tag}: cart bar still showing"); check(not pg._errs, f"{tag}: errors {pg._errs}")
        pg.screenshot(path=f"/tmp/xredro-shots/soldout-{w}.png") if os.path.isdir("/tmp/xredro-shots") else None; pg.context.close()
        # 3b. only the sold-out line is removed; the rest of the order is kept
        pg = open_page(br, w, store([A, B]), flip=store([dict(A, soldOut=True), B]))
        checkout(pg, [".sf-add >> nth=0", ".sf-add >> nth=1"]); pg.click(".send-btn"); pg.wait_for_timeout(800)
        check(len(created(pg)) == 0 and pg.evaluate("cart.p1_1||0") == 1 and pg.evaluate("cart.p1_0||0") == 0, f"{tag}: other items not kept ({pg.evaluate('JSON.stringify(cart)')})"); pg.context.close()
        # 4. if the re-check cannot run, the order still goes ahead
        pg = open_page(br, w, store([A, B]), flip_fail=True)
        checkout(pg, [".sf-add >> nth=0"]); pg.click(".send-btn"); pg.wait_for_timeout(800)
        check(len(created(pg)) == 1, f"{tag}: order blocked when the availability re-check failed"); pg.context.close()
        # 5. store reordered in the meantime: the order must still be for the product the customer chose
        pg = open_page(br, w, store([A, B]), flip=store([B, A]))
        checkout(pg, [".sf-add >> nth=0"]); pg.click(".send-btn"); pg.wait_for_timeout(800)
        c = created(pg); names = [json.loads(x)["value"][0]["name"] for x in c[0]["data"]["formData"] if json.loads(x).get("type") == "product"] if c else []
        check(len(c) == 1 and names == ["Handbag"] and float(c[0]["data"]["totalAmount"]) == 12000, f"{tag}: reordered store swapped the product {names}"); pg.context.close()
    br.close()
httpd.shutdown(); print("\nALL LIVE STORE CHECKS PASSED" if not fails else f"\n{len(fails)} FAILED"); sys.exit(1 if fails else 0)
