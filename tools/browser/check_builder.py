#!/usr/bin/env python3
"""Real-browser check of the store builder with a stubbed backend (needs playwright).
Run from the project root: python3 tools/browser/check_builder.py [outdir]"""
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
HOSTILE = 'He said "hi" <b>bold</b> & more'
def open_page(br, w, h, init=""):
    ctx = br.new_context(viewport={"width": w, "height": h}); pg = ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:140]))
    if init: pg.add_init_script(init)
    pg.route("**/cdn.jsdelivr.net/**", lambda r: r.fulfill(body=STUB, content_type="application/javascript"))
    pg.route("**/fonts.g*/**", lambda r: r.abort())
    pg.goto(f"http://127.0.0.1:{PORT}/indexF.html"); pg.wait_for_timeout(900); pg._errs = errs; return pg
state = lambda pg: pg.inner_text("#saveState")
saves = lambda pg: pg.evaluate("window.__saves||[]")
def last_products(pg):
    d = saves(pg)[-1]; fld = [json.loads(f) for f in d["fields"] if json.loads(f)["type"] == "product"][0]; return d, fld["products"]
with sync_playwright() as p:
    br = p.chromium.launch()
    for w, h in ((390, 844), (1280, 900)):
        tag = f"{w}px"
        # ---------- layout ----------
        pg = open_page(br, w, h)
        m = pg.evaluate("()=>({docW:document.documentElement.scrollWidth,vw:document.documentElement.clientWidth})")
        check(m["docW"] <= m["vw"], f"{tag}: sideways scroll"); check(not pg._errs, f"{tag}: load errors {pg._errs}")
        check(state(pg) == "All changes saved", f"{tag}: initial state '{state(pg)}'")
        check(pg.input_value("#titleInput") == "Amaka Bags" and "form.html?fid=u1" in pg.input_value("#formLinkInput"), f"{tag}: title or link not filled")
        check("1 product" in pg.inner_text("#hintProducts"), f"{tag}: product hint '{pg.inner_text('#hintProducts')}'")
        # last section stays clear of the sticky save bar
        pg.evaluate("window.scrollTo(0, document.body.scrollHeight)"); pg.wait_for_timeout(100)
        gap = pg.evaluate("()=>{const l=[...document.querySelectorAll('.bld-sec')].pop().getBoundingClientRect().bottom;return document.querySelector('.bld-savebar').getBoundingClientRect().top-l}")
        check(gap >= 0, f"{tag}: save bar covers the last section by {-gap:.0f}px")
        pg.screenshot(path=f"{OUT}/builder-{w}.png", full_page=True)
        # sections toggle
        pg.click("#secFields > summary"); check(pg.evaluate("document.getElementById('secFields').open"), f"{tag}: section did not open")
        pg.click("#secFields > summary"); check(not pg.evaluate("document.getElementById('secFields').open"), f"{tag}: section did not close")
        # ---------- dirty + save ----------
        pg.fill("#titleInput", "Amaka Bags Ltd"); pg.wait_for_timeout(300)
        check(state(pg) == "Unsaved changes", f"{tag}: not marked unsaved after typing ('{state(pg)}')")
        check(pg.evaluate("(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented})()"), f"{tag}: no leave-page warning while unsaved")
        pg.click("#saveBtn"); pg.wait_for_timeout(500)
        d, prods = last_products(pg)
        check(d["title"] == "Amaka Bags Ltd" and d["storeTheme"] == "r3", f"{tag}: saved payload {d.get('title')}/{d.get('storeTheme')}")
        check(state(pg) == "All changes saved" and not pg.evaluate("document.getElementById('saveBtn').disabled"), f"{tag}: not back to saved ('{state(pg)}')")
        check(not pg.evaluate("(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented})()"), f"{tag}: leave-page warning shown when saved")
        # ---------- theme: click and keyboard ----------
        pg.click(".theme-swatch[data-theme='r6']"); check(pg.get_attribute(".theme-swatch[data-theme='r6']", "aria-checked") == "true", f"{tag}: swatch not marked selected")
        pg.focus(".theme-swatch[data-theme='r8']"); pg.keyboard.press("Enter")
        check(pg.get_attribute(".theme-swatch[data-theme='r8']", "aria-checked") == "true" and pg.get_attribute(".theme-swatch[data-theme='r6']", "aria-checked") == "false", f"{tag}: keyboard theme choice failed")
        # ---------- product editor: hostile text, featured, validation ----------
        pg.click(".product-tile >> nth=0"); pg.wait_for_timeout(200)
        check(pg.is_visible(".product-editor-card"), f"{tag}: editor did not open")
        pg.fill(".product-editor-card input[placeholder='Product name']", HOSTILE); pg.keyboard.press("Tab")
        pg.locator(".product-featured-row").click()
        pg.click(".product-editor-actions .xr-btn--primary"); pg.wait_for_timeout(200)
        check("<b>" not in pg.evaluate("document.querySelector('.product-tile-name').innerHTML"), f"{tag}: markup in a product name was inserted into the page")
        check(pg.inner_text(".product-tile-name") == HOSTILE, f"{tag}: tile shows '{pg.inner_text('.product-tile-name')}'")
        pg.click(".product-tile >> nth=0"); pg.wait_for_timeout(150)
        check(pg.input_value(".product-editor-card input[placeholder='Product name']") == HOSTILE, f"{tag}: editor field changed the name")
        pg.click(".product-editor-close"); pg.click("#saveBtn"); pg.wait_for_timeout(500)
        d, prods = last_products(pg)
        check(prods[0]["name"] == HOSTILE and prods[0]["featured"] is True and d["storeTheme"] == "r8", f"{tag}: payload name/featured/theme {prods[0].get('name')!r} {prods[0].get('featured')} {d['storeTheme']}")
        n_before = len(saves(pg))
        pg.click(".product-tile >> nth=0"); pg.fill(".product-editor-card .xr-input-group input", ""); pg.keyboard.press("Tab"); pg.click(".product-editor-close")
        pg.click("#saveBtn"); pg.wait_for_timeout(400)
        check(len(saves(pg)) == n_before, f"{tag}: saved a product with no price")
        check(pg.is_visible(".product-editor-card"), f"{tag}: invalid product was not opened for editing")
        check("needs a price" in pg.inner_text("#toast-container"), f"{tag}: toast '{pg.inner_text('#toast-container')[:80]}'")
        pg.fill(".product-editor-card .xr-input-group input", "15000"); pg.keyboard.press("Tab"); pg.click(".product-editor-close")
        # ---------- sold out: tile switch, editor switch, saved, shown in the preview ----------
        pg.click(".product-tile-toggle"); pg.wait_for_timeout(150)
        check(pg.locator(".product-tile.is-soldout").count() == 1 and "Back in stock" in pg.inner_text(".product-tile-toggle") and not pg.is_visible(".product-editor-card"), f"{tag}: tile Sold out switch")
        pg.click("text=Preview your store"); pg.wait_for_timeout(700)
        check(pg.frame_locator("#previewFrame").locator(".sf-stock-out").count() == 1, f"{tag}: preview does not show the product as sold out"); pg.click(".preview-close-btn")
        pg.click("#saveBtn"); pg.wait_for_timeout(500); d, prods = last_products(pg)
        check(prods[0].get("soldOut") is True and prods[0]["featured"] is True, f"{tag}: soldOut not saved / other fields lost ({prods[0]})")
        pg.click(".product-tile >> nth=0"); pg.wait_for_timeout(150)
        check(pg.locator(".product-soldout-row input").is_checked(), f"{tag}: editor switch does not show sold out")
        pg.locator(".product-soldout-row").click(); pg.click(".product-editor-actions .xr-btn--primary"); pg.wait_for_timeout(150)
        pg.click("#saveBtn"); pg.wait_for_timeout(500); d, prods = last_products(pg)
        check(prods[0].get("soldOut") is False and pg.locator(".product-tile.is-soldout").count() == 0, f"{tag}: could not put the product back ({prods[0].get('soldOut')})")
        # ---------- add an order-form question ----------
        pg.click("#secFields > summary"); pg.click("#addFieldBtn"); pg.click("text=Text Input"); pg.wait_for_timeout(300)
        check(pg.locator("#fields .field-card").count() == 1 and "1 field" in pg.inner_text("#hintFields"), f"{tag}: field not added ({pg.inner_text('#hintFields')})")
        # ---------- preview ----------
        pg.click("text=Preview your store"); pg.wait_for_timeout(700)
        check(pg.evaluate("!document.getElementById('previewOverlay').classList.contains('hidden')"), f"{tag}: preview did not open")
        check(pg.frame_locator("#previewFrame").locator(".sf-chrome").count() == 1, f"{tag}: store missing in preview")
        pg.click(".preview-close-btn"); check(not pg._errs, f"{tag}: errors {pg._errs}"); pg.context.close()

        # ---------- failed save keeps images ----------
        pg = open_page(br, w, h, "window.__PRODUCT_IMG=1; window.__FAIL_SAVE=true;")
        pg.click(".product-tile >> nth=0"); pg.wait_for_timeout(150)
        pg.set_input_files(".product-editor-card input[type=file]", {"name": "a.png", "mimeType": "image/png", "buffer": b"\x89PNG\r\n\x1a\n"}); pg.wait_for_timeout(400)
        if pg.is_visible(".product-editor-card"): pg.click(".product-editor-close")
        pg.click("#saveBtn"); pg.wait_for_timeout(500)
        check(pg.evaluate("(window.__deletes||[]).length") == 0, f"{tag}: old image deleted although the save failed")
        check("Could not save" in pg.inner_text("#toast-container"), f"{tag}: no error message after a failed save")
        check(not pg.evaluate("document.getElementById('saveBtn').disabled") and state(pg) == "Unsaved changes", f"{tag}: button/state after failed save ('{state(pg)}')")
        pg.evaluate("window.__FAIL_SAVE=false"); pg.click("#saveBtn"); pg.wait_for_timeout(600)
        check(pg.evaluate("window.__deletes") == ["oldimg"], f"{tag}: old image not deleted after a good save ({pg.evaluate('window.__deletes')})")
        pg.context.close()
    br.close()
httpd.shutdown(); print("\nALL BUILDER CHECKS PASSED" if not fails else f"\n{len(fails)} FAILED"); sys.exit(1 if fails else 0)
