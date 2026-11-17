#!/usr/bin/env python3
"""Checks that every nav link is readable (WCAG AA, 4.5:1) on every page, in light and dark mode,
on desktop and in the phone menu. Run from the project root: python3 tools/browser/check_nav.py"""
import os, sys, threading, http.server, socketserver, functools
from playwright.sync_api import sync_playwright
STUB = open("tools/browser/appwrite_stub.js").read()
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=os.getcwd())); PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
JS = """()=>{const parse=c=>{const m=c.match(/rgba?\\(([^)]+)\\)/);if(!m)return null;const p=m[1].split(',').map(parseFloat);return{r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1}};
 const bgOf=el=>{const st=[];let e=el;while(e){const c=parse(getComputedStyle(e).backgroundColor);if(c&&c.a>0){st.push(c);if(c.a>=1)break}e=e.parentElement}
  let base=parse(getComputedStyle(document.body).backgroundColor)||{r:255,g:255,b:255};base={r:base.r,g:base.g,b:base.b};
  for(let i=st.length-1;i>=0;i--){const c=st[i];base={r:c.r*c.a+base.r*(1-c.a),g:c.g*c.a+base.g*(1-c.a),b:c.b*c.a+base.b*(1-c.a)}}return base};
 const L=c=>{const f=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)};return .2126*f(c.r)+.7152*f(c.g)+.0722*f(c.b)};
 const out=[];document.querySelector('nav, .nav').querySelectorAll('a').forEach(a=>{const r=a.getBoundingClientRect();if(!r.width||!r.height)return;
  const col=parse(getComputedStyle(a).color),bg=bgOf(a),x=L(col),y=L(bg);out.push({t:(a.textContent||'').trim().slice(0,18)||'logo',active:a.classList.contains('active'),ratio:(Math.max(x,y)+.05)/(Math.min(x,y)+.05)})});return out}"""
PAGES = ["dashboard", "orders", "indexF", "settings", "index", "guides/index", "guides/how-to-take-orders-on-whatsapp-nigeria"]
fails = []; n = 0
with sync_playwright() as p:
    br = p.chromium.launch()
    for theme in ("light", "dark"):
        for page in PAGES:
            for w in (1280, 390):
                ctx = br.new_context(viewport={"width": w, "height": 800}); pg = ctx.new_page()
                pg.add_init_script(f"localStorage.setItem('theme','{theme}'); window.__THEME='{theme}';")
                pg.route("**/cdn.jsdelivr.net/**", lambda r: r.fulfill(body=(STUB if "appwrite" in r.request.url else "window.Tesseract={};"), content_type="application/javascript"))
                pg.route("**/cdnjs.cloudflare.com/**", lambda r: r.fulfill(body="window.pdfjsLib={GlobalWorkerOptions:{}};window.jspdf={};", content_type="application/javascript")); pg.route("**/fonts.g*/**", lambda r: r.abort())
                pg.goto(f"http://127.0.0.1:{PORT}/{page}.html" if not page.endswith("index") or page == "index" else f"http://127.0.0.1:{PORT}/{page}.html"); pg.wait_for_timeout(800)
                if w == 390 and pg.locator(".burger").count() and pg.locator(".burger").is_visible(): pg.click(".burger"); pg.wait_for_timeout(250)
                for it in pg.evaluate(JS):
                    n += 1
                    if it["t"] != "logo" and it["ratio"] < 4.5: fails.append(f"{page} {w}px {theme}: '{it['t']}'{' (active)' if it['active'] else ''} contrast {it['ratio']:.2f}")
                ctx.close()
    br.close()
httpd.shutdown()
for f in fails: print("FAIL:", f)
print(f"\n{n} nav links measured.", "ALL NAV CHECKS PASSED" if not fails else f"{len(fails)} FAILED"); sys.exit(1 if fails else 0)
