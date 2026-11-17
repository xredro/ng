#!/usr/bin/env python3
"""Real-browser check of the builder's preview frame (needs playwright). Run from the project root:
    python3 tools/browser/check_builder_preview.py [outdir]
For several themes it opens the preview, taps every in-page link (store name, Home, Shop, About, Contact, the hero
button, Featured) and checks the preview stays a store: the frame is still the preview document (never the builder
page), the overlay and its bar are still open, and tapping Shop really scrolls. Also checks Close, the size switch,
and that only one preview frame exists."""
import os, sys, json, threading, http.server, socketserver, functools
from playwright.sync_api import sync_playwright
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/xredro-shots"; os.makedirs(OUT, exist_ok=True)
STUB = open("tools/browser/appwrite_stub.js").read()
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=os.getcwd())); PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
CFG = json.dumps({"tagline": "Handmade in Lagos", "about": "We make bags in Lagos.", "phone": "08012345678", "instagram": "myshop", "policy": "Delivery 2 to 4 days"})
fails = []
def check(c, m):
    if not c: fails.append(m); print("FAIL:", m)
STATE = """()=>{const f=document.getElementById('previewFrame'); const o=document.getElementById('previewOverlay'); let d=null,url='',chromes=-1,y=0,hasBar=false;
 try{d=f.contentDocument;url=f.contentWindow.location.href;chromes=d.querySelectorAll('.sf-chrome').length;y=Math.round(f.contentWindow.scrollY);}catch(e){url='ERR '+e}
 const r=o.getBoundingClientRect();
 return {url,chromes,y,overlayOpen:!o.classList.contains('hidden')&&r.width>0,bar:!!document.querySelector('.preview-bar'),frames:document.querySelectorAll('#previewFrame').length,topUrl:location.href}}"""
LINKS = [("store name", ".sf-brand"), ("Home", ".sf-nav a[href='#sfHome']"), ("Shop", ".sf-nav a[href='#shop']"), ("About", ".sf-nav a[href='#sfAbout']"),
         ("Contact", ".sf-nav a[href='#sfContact']"), ("hero button", ".sf-hero .sf-btn"),
         ("footer phone", ".sf-footer a[href^='tel:']")]
with sync_playwright() as p:
    br = p.chromium.launch()
    for theme in ("r3", "r1", "r5", "r6", "r9"):
        for w, h in ((1280, 800), (390, 844)):
            ctx = br.new_context(viewport={"width": w, "height": h}); pg = ctx.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)[:120]))
            pg.add_init_script(f"window.__THEME_ID='{theme}'; window.__STORE_CONFIG={json.dumps(CFG)};")
            pg.route("**/cdn.jsdelivr.net/**", lambda r: r.fulfill(body=STUB, content_type="application/javascript"))
            pg.route("**/fonts.g*/**", lambda r: r.abort())
            pg.goto(f"http://127.0.0.1:{PORT}/indexF.html"); pg.wait_for_timeout(700)
            top0 = pg.evaluate("location.href")
            pg.click("text=Preview your store"); pg.wait_for_timeout(800)
            fr = pg.frame_locator("#previewFrame")
            tag = f"{theme} {w}px"
            for name, sel in LINKS:
                # nav links live in the mobile menu on phones: open it first
                if sel.startswith(".sf-nav") and pg.evaluate("document.getElementById('previewFrame').clientWidth") < 760 and fr.locator(".sf-burger").count(): fr.locator(".sf-burger").click()  # the frame, not the screen, decides whether the nav is a menu
                loc = fr.locator(sel)
                if loc.count() == 0: check(False, f"{tag}: '{name}' link missing"); continue
                if name == 'hero button' and not loc.first.is_visible(): continue  # compact heroes (Marketplace, Listings) have no button by design
                try: loc.first.click(timeout=5000)
                except Exception as ex:
                    check(False, f"{tag}: could not tap '{name}' ({str(ex).splitlines()[0][:90]})"); continue
                pg.wait_for_timeout(450)
                s = pg.evaluate(STATE)
                check(s["url"].startswith("about:srcdoc"), f"{tag}: after '{name}' the frame navigated away ({s['url'][:70]})")
                check(s["chromes"] == 1, f"{tag}: after '{name}' the store is gone ({s['chromes']} stores in the frame)")
                check(s["overlayOpen"] and s["bar"], f"{tag}: after '{name}' the preview overlay/bar is not open")
                check(s["frames"] == 1, f"{tag}: {s['frames']} preview frames")
                check(s["topUrl"] == top0, f"{tag}: builder page address changed to {s['topUrl']}")
                if name == "Shop": check(s["y"] > 50, f"{tag}: tapping Shop did not scroll (y={s['y']})")
            # featured card opens a product pop-up (label), must not navigate either
            if fr.locator(".sf-feat-card").count():
                try: fr.locator(".sf-feat-card").first.click(timeout=5000)
                except Exception as ex: check(False, f"{tag}: could not tap featured ({str(ex).splitlines()[0][:80]})")
                pg.wait_for_timeout(300); s = pg.evaluate(STATE)
                check(s["url"].startswith("about:srcdoc") and s["chromes"] == 1, f"{tag}: featured card broke the preview")
            pg.screenshot(path=f"{OUT}/builder-preview-{theme}-{w}.png")
            # size switch and close still work
            pg.click("#pvFull"); pg.click("#pvPhone")
            pg.click(".preview-close-btn"); pg.wait_for_timeout(200)
            check(pg.evaluate("document.getElementById('previewOverlay').classList.contains('hidden')"), f"{tag}: Close did not close the preview")
            check(not errs, f"{tag}: script errors {errs}")
            ctx.close()
    br.close()
httpd.shutdown(); print("\nALL BUILDER PREVIEW CHECKS PASSED" if not fails else f"\n{len(fails)} FAILED"); sys.exit(1 if fails else 0)
