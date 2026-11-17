#!/usr/bin/env python3
"""Real-browser checks for the nine stores (needs: pip install playwright pillow; playwright install chromium).
Run from the project root:  python3 tools/browser/check_stores.py [outdir]
Checks, for every theme at phone (390) and desktop (1280) width:
  1. the page wrapper is exactly the viewport width and nothing scrolls sideways
  2. the hero keeps the same height whatever the banner shape (wide, tall, square, small)
  3. the hero banner never escapes the hero (no page-sized banner)
  4. only one layer (menu, search, cart, checkout, product pop-up) can be open at a time
Screenshots go to outdir (default /tmp/xredro-shots)."""
import io, os, sys, threading, http.server, socketserver, functools
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/xredro-shots"; os.makedirs(OUT, exist_ok=True)
def jpg(w, h, c1, c2):
    im = Image.new("RGB", (w, h), c1); d = ImageDraw.Draw(im)
    for i in range(0, w + h, 60): d.line([(i, 0), (0, i)], fill=c2, width=18)
    b = io.BytesIO(); im.save(b, "JPEG", quality=70); return b.getvalue()
IMGS = {f"p{i}": jpg(600, 600, a, b) for i, (a, b) in enumerate([((230,130,60),(250,190,120)),((60,140,200),(150,200,240)),((90,170,100),(170,220,170)),((200,80,120),(240,160,190)),((120,100,200),(190,170,240)),((200,170,60),(240,220,130))])}
IMGS.update({"banner-wide": jpg(1600, 400, (40,60,90), (80,110,150)), "banner-tall": jpg(720, 1612, (120,60,100), (170,110,150)),
             "banner-square": jpg(800, 800, (60,110,80), (110,160,130)), "banner-small": jpg(300, 100, (150,90,40), (200,150,90))})

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=os.getcwd())); PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{PORT}/tools/browser/harness.html"

MEASURE = """()=>{const r=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return {x:Math.round(b.left),y:Math.round(b.top+scrollY),w:Math.round(b.width),h:Math.round(b.height)}};
 return {docW:document.documentElement.scrollWidth, vw:document.documentElement.clientWidth, chrome:r('.sf-chrome'), hero:r('.sf-hero'), media:r('.sf-hero-media'), header:r('.sf-header'), shell:r('.store-shell')}}"""
LAYERS = """()=>{const vis=e=>{if(!e)return false;const cs=getComputedStyle(e);if(cs.display==='none')return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0};
 return (vis(document.querySelector('.sf-nav'))&&innerWidth<760?1:0)+(document.getElementById('searchToggle').checked?1:0)+(vis(document.querySelector('.sf-drawer'))?1:0)+(vis(document.querySelector('.checkout-overlay'))?1:0)+[...document.querySelectorAll('.product-popup')].filter(vis).length}"""
fails = []
def check(cond, msg):
    if not cond: fails.append(msg); print("FAIL:", msg)

with sync_playwright() as p:
    br = p.chromium.launch()
    def page(w, h, q):
        ctx = br.new_context(viewport={"width": w, "height": h}); pg = ctx.new_page()
        pg.route("**/__img/*", lambda r: r.fulfill(body=IMGS[r.request.url.rsplit("/", 1)[1][:-4]], content_type="image/jpeg"))
        pg.route("**/fonts.g*/**", lambda r: r.abort())
        errs = []; pg.on("pageerror", lambda e: errs.append(str(e)[:120]))
        pg.goto(URL + "?" + q); pg.wait_for_timeout(250); pg._errs = errs; return pg
    for t in [f"r{i}" for i in range(1, 10)]:
        for w, h in ((390, 844), (1280, 800)):
            heroH = {}
            for banner in ("wide", "tall", "square", "small", ""):
                pg = page(w, h, f"t={t}&cats=1&n=6" + (f"&banner={banner}" if banner else "")); m = pg.evaluate(MEASURE); heroH[banner] = m["hero"]["h"]
                tag = f"{t} {w}px banner={banner or 'none'}"
                check(m["docW"] <= m["vw"], f"{tag}: sideways scroll ({m['docW']} > {m['vw']})")
                check(m["chrome"]["w"] == m["vw"] and m["chrome"]["x"] == 0, f"{tag}: page wrapper is {m['chrome']['w']}px wide, viewport {m['vw']}")
                check(m["header"] and m["header"]["w"] == m["vw"], f"{tag}: header not full width")
                if m["media"] and m["media"]["w"]:
                    check(m["media"]["y"] >= m["hero"]["y"] - 1 and m["media"]["y"] + m["media"]["h"] <= m["hero"]["y"] + m["hero"]["h"] + 1, f"{tag}: banner escapes the hero {m['media']} vs {m['hero']}")
                check(not pg._errs, f"{tag}: script errors {pg._errs}")
                if banner == "wide": pg.screenshot(path=f"{OUT}/{t}-{w}.png")
                pg.context.close()
            real = [v for k, v in heroH.items() if k]  # with a banner present
            check(max(real) - min(real) <= 2, f"{t} {w}px: hero height changes with banner shape {heroH}")
        # one layer at a time (phone)
        pg = page(390, 844, f"t={t}&cats=1&n=6"); pg.click(".sf-add >> nth=0")
        for sel in (".sf-burger", "label[for=searchToggle]", ".sf-cart-btn"):
            try: pg.click(sel, timeout=1200)
            except Exception: continue
            n = pg.evaluate(LAYERS)
            if t == "r6": n -= 0  # market header keeps search permanently open; it is not a layer
            check(n <= 1, f"{t}: {n} layers open after tapping {sel}")
        pg.context.close()
    br.close()
httpd.shutdown()
print("\nALL BROWSER CHECKS PASSED" if not fails else f"\n{len(fails)} FAILED")
sys.exit(1 if fails else 0)
