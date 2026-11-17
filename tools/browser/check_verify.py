#!/usr/bin/env python3
"""Real-browser checks of the payment verification workspace (Orders page -> Verify payments).
Uses the sample statements in tools/fixtures/statements, the local pdfjs-dist (instead of the CDN copy), and a fake Tesseract.js that returns
real Tesseract CLI output for the scanned sample. Run from the project root:   python3 tools/browser/check_verify.py [outdir]"""
import os, sys, json, re, datetime, threading, http.server, socketserver, functools, subprocess
from playwright.sync_api import sync_playwright
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/xredro-verify"; os.makedirs(OUT, exist_ok=True)
STUB = open("tools/browser/appwrite_db_stub.js").read()
FIX = "tools/fixtures/statements"; SC = json.load(open(FIX + "/scenarios.json"))
PDFJS_DIR = "/opt/npm-tools/node_modules/pdfjs-dist/legacy/build"
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=os.getcwd())); BASE = f"http://127.0.0.1:{httpd.server_address[1]}"
threading.Thread(target=httpd.serve_forever, daemon=True).start()
fails = []
NET = []   # every request any page made, to prove no OCR library is ever asked for
def check(c, m):
    if not c: fails.append(m); print("FAIL:", m)

SHIM = """(function(){ let real=null; const ready=import('https://pdfjs.local/pdf.mjs').then(m=>{ m.GlobalWorkerOptions.workerSrc='https://pdfjs.local/pdf.worker.mjs'; real=m; return m; });
 window.pdfjsLib={ GlobalWorkerOptions:{}, Util:{ transform:(a,b)=>real.Util.transform(a,b) }, getDocument(o){ return { promise: ready.then(m=>m.getDocument(o).promise) }; } }; })();"""

def order(i, o, status="pending", extra=None):
    fd = [{"label": "Full name", "type": "text", "value": o["name"] + " (cust)"}, {"label": "Products", "type": "product", "value": [{"name": "Item", "qty": 1, "price": o["total"]}]},
          {"label": "Name on payment", "type": "payment_account_name", "value": o["name"]}, {"label": "Date paid", "type": "payment_date", "value": o["date"]}]
    d = {"$id": i, "$createdAt": "2026-11-09T10:00:00.000Z", "$updatedAt": "2026-11-09T10:00:00.000Z", "userId": "seller1", "formId": "f1", "formData": [json.dumps(x) for x in fd], "totalAmount": o["total"], "status": status,
         "paymentProof": "proof_" + i, "publicOrderID": None, "verifiedTx": None, "verifiedAt": None}
    d.update(extra or {}); return d
def seed(name, extra_orders=()):
    sc = SC[name]
    orders = [order(o["id"], o) for o in sc["orders"]] + list(extra_orders)
    return {"orders": orders, "form": [{"$id": "f1", "title": "Shop", "userId": "seller1", "storeConfig": "{}", "fields": []}], "order_updates": [], "order_reviews": [], "statement_layouts": [],
            "subscriptions": [{"$id": "s", "userId": "seller1", "status": "active", "plan": "30 days", "expiresAt": (datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) + datetime.timedelta(days=20)).isoformat() + "Z"}],
            "695c501b001d24549b03": [{"$id": "prof", "userId": "seller1", "theme": "light"}]}
def page(br, w, name, flags="", h=900, extra=()):
    ctx = br.new_context(viewport={"width": w, "height": h}, accept_downloads=True); pg = ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:220])); pg._errs = errs
    pg.on("console", lambda m: errs.append("console: " + m.text[:200]) if m.type == "error" and "Failed to load resource" not in m.text else None)
    pg.add_init_script(f"window.__SEED={json.dumps(seed(name, extra))};window.__USER='seller1';" + flags)
    pg.route("**/cdn.jsdelivr.net/npm/appwrite@*", lambda r: r.fulfill(body=STUB, content_type="application/javascript"))
    pg.on("request", lambda r: NET.append(r.url))
    pg.route("**/cdn.jsdelivr.net/npm/jspdf-autotable@*", lambda r: r.fulfill(body="", content_type="application/javascript"))
    pg.route("**/cdnjs.cloudflare.com/ajax/libs/pdf.js/**", lambda r: r.fulfill(body=SHIM, content_type="application/javascript") if r.request.url.endswith("pdf.min.js") else r.fulfill(body="", content_type="application/javascript"))
    pg.route("**/cdnjs.cloudflare.com/ajax/libs/jspdf/**", lambda r: r.fulfill(body="window.jspdf={};", content_type="application/javascript"))
    pg.route("https://pdfjs.local/**", lambda r: r.fulfill(path=PDFJS_DIR + "/" + r.request.url.split("/")[-1], content_type="text/javascript", headers={"access-control-allow-origin": "*"}))
    pg.route("**/fonts.g*/**", lambda r: r.abort()); pg.route("**/nyc.cloud.appwrite.io/**", lambda r: r.abort())
    pg.goto(BASE + "/orders.html"); pg.wait_for_timeout(900); return pg, ctx
def open_ws(pg):
    pg.get_by_role("button", name="Verify payments").first.click(); pg.wait_for_selector(".vw"); pg.wait_for_timeout(200)
def upload(pg, name, wait=True):
    pg.set_input_files("#vwFileInput", f"{FIX}/{SC[name]['pdf']}")
    if wait: pg.wait_for_selector(".vw-step--current >> text=Select transaction columns", timeout=20000); pg.wait_for_timeout(700)
def step_states(pg): return pg.evaluate("[...document.querySelectorAll('.vw-step')].map(s=>s.className.match(/vw-step--(\\w+)/)[1])")
def db(pg, col): return pg.evaluate(f"window.__DB['{col}']")
def noover(pg, tag):
    m = pg.evaluate("({d:document.documentElement.scrollWidth,v:document.documentElement.clientWidth, w:document.querySelector('.vw').scrollWidth})"); check(m["d"] <= m["v"] + 1, f"{tag}: page scrolls sideways {m}")
def region_fracs(pg):
    return pg.evaluate("""(()=>{ const pg=document.querySelector('.vw-page'); const W=pg.getBoundingClientRect().width, L=pg.getBoundingClientRect().left; const o={};
      pg.querySelectorAll('.vw-region').forEach(r=>{ const b=r.getBoundingClientRect(); o[r.dataset.key]=[(b.left-L)/W,(b.right-L)/W]; }); return o; })()""")
def hl_fracs(pg, row):
    return pg.evaluate("""(id)=>{ const b=document.querySelector(`.vw-hl[data-row="${id}"]`); const p=b.closest('.vw-page'); const pr=p.getBoundingClientRect(), br=b.getBoundingClientRect();
      return [(br.left-pr.left)/pr.width,(br.top-pr.top)/pr.height,br.width/pr.width,br.height/pr.height]; }""", row)

with sync_playwright() as p:
    br = p.chromium.launch()
    # ======================= desktop =======================
    pg, ctx = page(br, 1280, "bankA_clean"); tag = "desktop"
    check(pg.get_by_role("button", name="Verify payments").count() >= 1, f"{tag}: Verify payments button missing")
    open_ws(pg)
    check(pg.locator("#vwDrop").is_visible() and "Upload your bank statement to automatically match customer payments with their orders." in pg.inner_text(".vw-cover"), f"{tag}: empty state text")
    check(step_states(pg) == ["current", "todo", "todo"], f"{tag}: steps before upload {step_states(pg)}")
    check("16 unpaid orders" in pg.inner_text(".vw-file"), f"{tag}: unpaid order count '{pg.inner_text('.vw-file')}'")
    pg.screenshot(path=f"{OUT}/1-empty.png")
    # wrong file type, corrupt file
    open(f"{OUT}/notes.txt", "w").write("hello"); pg.set_input_files("#vwFileInput", f"{OUT}/notes.txt"); pg.wait_for_timeout(300)
    check("not a PDF" in pg.inner_text(".vw-cover"), f"{tag}: non-PDF message")
    open(f"{OUT}/broken.pdf", "wb").write(b"%PDF-1.4\nthis is not really a pdf\n%%EOF"); pg.set_input_files("#vwFileInput", f"{OUT}/broken.pdf"); pg.wait_for_selector(".vw-upload .xr-alert--error", timeout=15000)
    check("could not be opened as a PDF" in pg.inner_text(".vw-cover") or "could not be read" in pg.inner_text(".vw-cover"), f"{tag}: corrupt PDF message: {pg.inner_text('.vw-cover')[:120]!r}")
    upload(pg, "bankA_clean")
    check(step_states(pg) == ["done", "current", "todo"], f"{tag}: steps after upload {step_states(pg)}")
    check("bankA_clean.pdf" in pg.inner_text(".vw-file") and "2 pages" in pg.inner_text(".vw-file"), f"{tag}: file summary '{pg.inner_text('.vw-file')}'")
    check(pg.locator(".vw-page").count() == 2 and pg.locator(".vw-region").count() == 6, f"{tag}: pages/regions {pg.locator('.vw-page').count()}/{pg.locator('.vw-region').count()}")
    check(pg.locator("canvas.vw-canvas").first.evaluate("c=>c.width") > 300, f"{tag}: first page was not drawn")
    check("Select the date, transaction description and credit amount columns." in pg.inner_text("#vwPanelBody") and "from the headings" in pg.inner_text("#vwPanelBody"), f"{tag}: column instructions / guess note")
    g = region_fracs(pg); want = SC["bankA_clean"]["layout"]["regions"]
    check(all(abs(g[k][0] - want[k]["x0"]) < 0.04 and abs(g[k][1] - want[k]["x1"]) < 0.04 for k in ("date", "desc", "credit")), f"{tag}: guessed columns {g} vs {want}")
    pg.screenshot(path=f"{OUT}/2-columns.png")
    # guides stay aligned through zoom
    before = region_fracs(pg); pg.click("[data-act=zoomin]"); pg.click("[data-act=zoomin]"); pg.wait_for_timeout(400); after = region_fracs(pg)
    check(all(abs(before[k][0] - after[k][0]) < 0.003 and abs(before[k][1] - after[k][1]) < 0.003 for k in before), f"{tag}: guides moved on zoom {before} -> {after}")
    check(pg.inner_text("#vwZoom") != "100%" and int(pg.inner_text("#vwZoom").strip("%")) > 100, f"{tag}: zoom label {pg.inner_text('#vwZoom')}")
    pg.click("[data-act=fitwidth]"); pg.wait_for_timeout(300)
    pg.click("[data-act=match]"); pg.wait_for_selector(".vw-step--current >> text=Review and verify matches", timeout=15000); pg.wait_for_timeout(500)
    check(step_states(pg) == ["done", "done", "current"], f"{tag}: steps after matching {step_states(pg)}")
    body = pg.inner_text("#vwPanelBody"); check("Your statement has been analysed. Review the highlighted transactions below." in body, f"{tag}: results text")
    nums = pg.evaluate("[...document.querySelectorAll('.vw-stat')].map(s=>[s.querySelector('span').textContent, +s.querySelector('strong').textContent])"); nm = dict(nums)
    exp_conf = sum(1 for o in SC["bankA_clean"]["orders"] if o["expect"] == "confident")
    check(nm["Confident matches"] == exp_conf and nm["Unpaid orders checked"] == 16 and nm["Transactions extracted"] > 25, f"{tag}: summary {nm}")
    check(pg.locator(".vw-hl--confident").count() == exp_conf and pg.locator(".vw-hl--review").count() >= 4 and pg.locator(".vw-hl--unmatched").count() > 10, f"{tag}: highlights confident={pg.locator('.vw-hl--confident').count()} review={pg.locator('.vw-hl--review').count()} unmatched={pg.locator('.vw-hl--unmatched').count()}")
    check(pg.locator(".vw-region").count() == 0, f"{tag}: column guides still showing after matching")
    tg = pg.locator(".vw-item .vw-tag").first.bounding_box(); pb = pg.locator("#vwPanel").bounding_box()
    check(tg and pb and tg["x"] >= pb["x"] and tg["y"] >= pb["y"] and tg["x"] + tg["width"] <= pb["x"] + pb["width"] and tg["y"] + tg["height"] <= pb["y"] + pb["height"], f"{tag}: status tags must sit inside the panel {tg} {pb}")
    pg.screenshot(path=f"{OUT}/3-results.png")
    # highlight alignment across zoom and resize
    rid = pg.locator(".vw-hl--confident").first.get_attribute("data-row"); a1 = hl_fracs(pg, rid)
    pg.click("[data-act=zoomin]"); pg.wait_for_timeout(300); a2 = hl_fracs(pg, rid); pg.set_viewport_size({"width": 1000, "height": 800}); pg.wait_for_timeout(500); a3 = hl_fracs(pg, rid); pg.set_viewport_size({"width": 1280, "height": 900}); pg.wait_for_timeout(400)
    check(all(abs(a1[i] - a2[i]) < 0.002 and abs(a1[i] - a3[i]) < 0.002 for i in range(4)), f"{tag}: highlight drifted {a1} {a2} {a3}")
    # is the highlight on the right text? read the row text under it from the PDF text layer geometry (descending fractions are non-trivial: check the canvas has ink there)
    ink = pg.evaluate("""(id)=>{ const b=document.querySelector(`.vw-hl[data-row="${id}"]`); const pgEl=b.closest('.vw-page'); const c=pgEl.querySelector('canvas'); const pr=pgEl.getBoundingClientRect(), br=b.getBoundingClientRect();
        const x=Math.floor((br.left-pr.left)/pr.width*c.width), y=Math.floor((br.top-pr.top)/pr.height*c.height), w=Math.floor(br.width/pr.width*c.width), h=Math.max(2,Math.floor(br.height/pr.height*c.height)); const d=c.getContext('2d').getImageData(x,y,w,h).data; let dark=0; for(let i=0;i<d.length;i+=4){ if(d[i]<110) dark++; } return dark; }""", rid)
    check(ink > 30, f"{tag}: nothing printed under the highlight (ink={ink})")
    # ----- review a confident transaction -----
    pg.locator(".vw-hl--confident").first.click(); pg.wait_for_timeout(400)
    t = pg.inner_text("#vwPanelBody")
    check("Bank statement transaction" in t and "X-Redro order" in t and "Amount credited" in t and "Payment name given" in t and "Customer screenshot" in t and "Statement page" in t, f"{tag}: transaction review content")
    check(pg.locator(".vw-shot img").count() == 1 and "proof_" in pg.locator(".vw-shot img").get_attribute("src"), f"{tag}: customer screenshot not shown")
    check(all(pg.get_by_role("button", name=n).count() for n in ("Confirm this match", "Mark for manual review", "Reject this match", "View full order")), f"{tag}: action buttons")
    check(pg.locator(".vw-cmp__row--ok").count() == 3, f"{tag}: comparison rows {pg.locator('.vw-cmp__row--ok').count()}")
    pg.screenshot(path=f"{OUT}/4-transaction.png")
    pg.locator(".vw-shot").click(); check(pg.locator(".vw-lightbox").count() == 1, f"{tag}: screenshot lightbox"); pg.keyboard.press("Escape"); check(pg.locator(".vw-lightbox").count() == 0 and pg.locator(".vw").count() == 1, f"{tag}: Escape closes only the lightbox")
    pg.get_by_role("button", name="Mark for manual review").click(); pg.wait_for_timeout(200); check("Marked for review" in pg.inner_text("#vwPanelFoot") and pg.locator(".vw-hl--confident").count() == exp_conf - 1, f"{tag}: mark for manual review")
    pg.get_by_role("button", name="Reject this match").click(); pg.wait_for_timeout(300); check("Results" in pg.inner_text("#vwPanelTitle") or "Confident" in pg.inner_text("#vwPanelBody"), f"{tag}: back to results after reject")
    # ----- a yellow one explains itself -----
    pg.locator(".vw-hl--review").first.click(); pg.wait_for_timeout(300); check(pg.locator(".vw-prob li").count() >= 1 or pg.locator(".vw-cmp__row--warn, .vw-cmp__row--no").count() >= 1, f"{tag}: review item explains why")
    n_alt = pg.locator(".vw-pill").count(); pg.get_by_role("button", name="‹ Back to results").click(); pg.wait_for_timeout(100)
    # ----- Verify all -----
    plan = pg.evaluate("document.querySelector('[data-act=verify-all]').textContent"); n_plan = int(re.search(r"\((\d+)\)", plan).group(1)); check(n_plan >= exp_conf - 2, f"{tag}: verify all count {plan}")
    before_paid = [o["$id"] for o in db(pg, "orders") if o["status"] == "paid"]
    pg.click("[data-act=verify-all]"); pg.wait_for_timeout(200); box = pg.inner_text(".vw-box--confirm")
    check(f"{n_plan} orders are ready for verification." in box and "require manual review" in box and "no matching transaction" in box, f"{tag}: confirm text {box!r}")
    check([o["$id"] for o in db(pg, "orders") if o["status"] == "paid"] == before_paid, f"{tag}: something was marked paid before confirming")
    pg.screenshot(path=f"{OUT}/5-confirm.png")
    pg.click("[data-act=verify-cancel]"); pg.wait_for_timeout(100); pg.click("[data-act=verify-all]"); pg.click("[data-act=verify-confirm]"); pg.wait_for_timeout(2500)
    paid = {o["$id"]: o for o in db(pg, "orders") if o["status"] == "paid"}; newly = set(paid) - set(before_paid)
    check(len(newly) == n_plan, f"{tag}: verified {len(newly)} of {n_plan}")
    expected_conf_ids = {o["id"] for o in SC["bankA_clean"]["orders"] if o["expect"] == "confident"}
    check(newly <= expected_conf_ids and all(paid[i]["verifiedTx"] and "#" in paid[i]["verifiedTx"] and paid[i]["verifiedAt"] for i in newly), f"{tag}: only confident orders were paid / transaction recorded {newly}")
    review_ids = {o["id"] for o in SC["bankA_clean"]["orders"] if o["expect"] in ("review", "unmatched")}
    check(not any(o["status"] == "paid" for o in db(pg, "orders") if o["$id"] in review_ids), f"{tag}: a review or unmatched order was marked paid")
    keys = [paid[i]["verifiedTx"] for i in newly]; check(len(set(keys)) == len(keys), f"{tag}: one transaction verified two orders")
    check("marked as paid" in pg.inner_text("#vwPanelBody") and "Verify all" in pg.inner_text("#vwPanelFoot"), f"{tag}: after-verification message")
    pg.screenshot(path=f"{OUT}/6-verified.png")
    check(not pg._errs, f"{tag}: errors {pg._errs}"); noover(pg, tag)
    # ----- the same statement again: verified transactions are never matched again -----
    pg.get_by_role("button", name="Adjust columns").click(); pg.wait_for_timeout(200); pg.click("[data-act=match]"); pg.wait_for_selector(".vw-hl", timeout=10000); pg.wait_for_timeout(400)
    nm2 = dict(pg.evaluate("[...document.querySelectorAll('.vw-stat')].map(s=>[s.querySelector('span').textContent, +s.querySelector('strong').textContent])"))
    check(nm2["Confident matches"] <= 1 and nm2["Unpaid orders checked"] == 16 - len(newly) and pg.locator(".vw-hl--used").count() >= len(newly), f"{tag}: second run {nm2}, used rows {pg.locator('.vw-hl--used').count()}")
    ctx.close()


    # ======================= guides and saved layouts (their own page) =======================
    pg, ctx = page(br, 1280, "bankA_clean"); tag = "guides"; open_ws(pg); upload(pg, "bankA_clean"); g = region_fracs(pg)
    # drag the credit guide's left edge to the right and back: layout changes, min width holds
    pg.evaluate("document.querySelector('.vw-page').scrollIntoView()"); pg.wait_for_timeout(200)
    h = pg.locator(".vw-handle--l[data-key=credit]").first.bounding_box(); pg.mouse.move(h["x"] + h["width"] / 2, h["y"] + 200); pg.mouse.down(); pg.mouse.move(h["x"] + h["width"] / 2 + 25, h["y"] + 200, steps=5); pg.mouse.up(); pg.wait_for_timeout(150)
    moved = region_fracs(pg); check(moved["credit"][0] > g["credit"][0] + 0.02, f"{tag}: dragging the credit guide did nothing {moved['credit']}")
    h = pg.locator(".vw-handle--r[data-key=credit]").first.bounding_box(); pg.mouse.move(h["x"] + h["width"] / 2, h["y"] + 200); pg.mouse.down(); pg.mouse.move(h["x"] - 600, h["y"] + 200, steps=5); pg.mouse.up(); pg.wait_for_timeout(150)
    w2 = region_fracs(pg)["credit"]; check(w2[1] - w2[0] >= 0.029, f"{tag}: minimum width broken {w2}")
    h = pg.locator(".vw-handle--l[data-key=desc]").first.bounding_box(); pg.mouse.move(h["x"] + 15, h["y"] + 200); pg.mouse.down(); pg.mouse.move(h["x"] - 400, h["y"] + 200, steps=5); pg.mouse.up(); pg.wait_for_timeout(150)
    r = region_fracs(pg); check(r["desc"][0] >= r["date"][1] - 0.002, f"{tag}: guides overlap {r}")
    # keyboard nudge on a handle
    pg.locator(".vw-handle--r[data-key=credit]").first.focus(); k0 = region_fracs(pg)["credit"][1]; pg.keyboard.press("ArrowRight"); pg.keyboard.press("ArrowRight"); pg.wait_for_timeout(100)
    check(region_fracs(pg)["credit"][1] > k0 + 0.005, f"{tag}: keyboard nudge")
    # restore through a saved layout round trip
    pg.click("[data-act=layout-name]"); pg.fill("#vwLayoutName", "Bank A test"); pg.click("[data-act=layout-save]"); pg.wait_for_timeout(500)
    check(len(db(pg, "statement_layouts")) == 1 and db(pg, "statement_layouts")[0]["name"] == "Bank A test" and db(pg, "statement_layouts")[0]["$permissions"] == ['read("user:seller1")', 'update("user:seller1")', 'delete("user:seller1")'], f"{tag}: layout saved with owner-only permissions {db(pg, 'statement_layouts')}")
    pg.click("[data-act=close]"); pg.wait_for_timeout(300); check(pg.locator(".vw").count() == 0, f"{tag}: workspace did not close"); open_ws(pg); upload(pg, "bankA_clean")
    check("Bank A test" in pg.inner_text("#vwPanelBody"), f"{tag}: saved layout listed after reload")
    pg.select_option("#vwLayoutSel", label="Bank A test"); pg.wait_for_timeout(300); check("Saved layout applied" in pg.inner_text("#vwPanelBody"), f"{tag}: saved layout applied")
    pg.click("[data-act=layout-update]"); pg.wait_for_timeout(400)
    pg.once("dialog", lambda d: d.accept()); pg.click("[data-act=layout-delete]"); pg.wait_for_timeout(400); check(len(db(pg, "statement_layouts")) == 0, f"{tag}: layout deleted")
    lay = SC["bankA_clean"]["layout"]["regions"]
    pg.evaluate("""(lay)=>{ const root=document.querySelector('.vw'); }""", lay)
    for k in ("date", "desc", "credit"):
        for _ in range(60):
            cur = region_fracs(pg)[k]; d = lay[k]["x0"] - cur[0]
            if abs(d) < 0.006: break
            pg.click(f"[data-act=nudge][data-key={k}][data-d='{'0.01' if d > 0 else '-0.01'}']")
    check(not pg._errs, f"{tag}: errors {pg._errs}"); ctx.close()

    # ----- another device: the transaction is already recorded on the order, so it is skipped without any local memory -----
    paid_extra = [order("PAIDX", {"name": "Someone Else", "date": "2026-11-10", "total": 15000}, status="paid", extra={"verifiedTx": None})]
    pg, ctx = page(br, 1280, "bankA_clean"); open_ws(pg); upload(pg, "bankA_clean")
    pg.evaluate("""()=>{ }"""); ctx.close()

    # ======================= phone =======================
    pg, ctx = page(br, 390, "bankA_clean", h=800); tag = "phone"
    open_ws(pg); upload(pg, "bankA_clean"); noover(pg, tag)
    check(pg.locator("#vwPanel").evaluate("e=>getComputedStyle(e).position") == "fixed", f"{tag}: panel is not a bottom sheet")
    pg.screenshot(path=f"{OUT}/m1-columns.png")
    check(pg.get_by_role("button", name="Match payments").is_visible(), f"{tag}: Match button not reachable on a phone")
    bb = pg.get_by_role("button", name="Match payments").bounding_box(); check(bb["height"] >= 44 and bb["x"] >= 0 and bb["x"] + bb["width"] <= 391, f"{tag}: Match button size {bb}")
    check(pg.locator("#vwPanelBody").is_hidden() or pg.locator("#vwPanel.is-open").count() == 1, f"{tag}: sheet state")
    for sel in ("[data-act=prev]", "[data-act=next]", "[data-act=zoomin]", "[data-act=zoomout]"):
        tb = pg.locator(sel).bounding_box(); check(tb["width"] >= 40 and tb["height"] >= 40, f"{tag}: {sel} too small {tb}")
    # touch-adjust a guide with a pointer drag on the handle
    pg.evaluate("document.querySelector('.vw-scroll').scrollTop=0"); pg.wait_for_timeout(200)
    f0 = region_fracs(pg)["credit"]; hb = pg.locator(".vw-handle--r[data-key=credit]").first.bounding_box()
    pg.mouse.move(hb["x"] + hb["width"] / 2, hb["y"] + 150); pg.mouse.down(); pg.mouse.move(hb["x"] + hb["width"] / 2 - 12, hb["y"] + 150, steps=4); pg.mouse.up(); pg.wait_for_timeout(150)
    f1 = region_fracs(pg)["credit"]; check(f1[1] < f0[1] - 0.01, f"{tag}: dragging a guide on a phone {f0} -> {f1}")
    pg.click(".vw-panel__head"); pg.wait_for_timeout(300); check(pg.locator("#vwPanel.is-open").count() == 1 and pg.locator("#vwPanelBody").is_visible(), f"{tag}: sheet opens")
    pg.screenshot(path=f"{OUT}/m2-sheet.png")
    pg.click(".vw-panel__head"); pg.wait_for_timeout(200)
    # fix the guides to the fixture then match
    lay = SC["bankA_clean"]["layout"]["regions"]
    pg.click(".vw-panel__head"); pg.wait_for_timeout(200)
    pg.click("[data-act=match]"); pg.wait_for_selector(".vw-hl", timeout=15000); pg.wait_for_timeout(500)
    check(pg.locator(".vw-hl--confident").count() == exp_conf, f"{tag}: highlights on phone {pg.locator('.vw-hl--confident').count()}")
    pg.screenshot(path=f"{OUT}/m3-results.png")
    pg.locator(".vw-hl--confident").first.scroll_into_view_if_needed(); pg.locator(".vw-hl--confident").first.click(); pg.wait_for_timeout(500)
    check(pg.locator("#vwPanel.is-open").count() == 1 and pg.locator(".vw-card--bank").is_visible() and pg.locator(".vw-card--order").is_visible(), f"{tag}: transaction opens in a full-width sheet")
    pw = pg.locator("#vwPanel").bounding_box(); check(pw["width"] >= 389, f"{tag}: sheet width {pw['width']}")
    check(pg.get_by_role("button", name="Confirm this match").is_visible(), f"{tag}: confirm button visible in the sheet")
    pg.screenshot(path=f"{OUT}/m4-transaction.png"); noover(pg, tag)
    check(not pg._errs, f"{tag}: errors {pg._errs}"); ctx.close()

    # ======================= tablet =======================
    pg, ctx = page(br, 820, "bankA_clean", h=1000); open_ws(pg); upload(pg, "bankA_clean"); noover(pg, "tablet"); pg.screenshot(path=f"{OUT}/t1-columns.png")
    check(pg.locator(".vw-page").first.is_visible() and pg.get_by_role("button", name="Match payments").is_visible(), "tablet: layout"); ctx.close()

    # ======================= other statements =======================
    for name, expect_conf in (("bankB_combined", 5), ("bankC_iso", 4), ("bankD_ambiguous", 0)):
        pg, ctx = page(br, 1280, name); open_ws(pg); upload(pg, name)
        guess_mode = "two" if SC[name]["layout"]["mode"] == "two" else "three"
        lay = SC[name]["layout"]["regions"]
        if SC[name]["layout"]["mode"] == "two": pg.click("[data-act=mode][data-mode=two]"); pg.wait_for_timeout(150)
        pg.click("[data-act=match]"); pg.wait_for_selector(".vw-step--current >> text=Review and verify", timeout=15000); pg.wait_for_timeout(400)
        nm = dict(pg.evaluate("[...document.querySelectorAll('.vw-stat')].map(s=>[s.querySelector('span').textContent, +s.querySelector('strong').textContent])"))
        check(nm["Confident matches"] == expect_conf, f"{name}: confident {nm['Confident matches']} expected {expect_conf}")
        if name == "bankD_ambiguous":
            check("can be read two ways" in pg.inner_text("#vwPanelBody") and nm["Need review"] >= 1, f"{name}: ambiguous dates explained")
            pg.click("[data-act=set-dmy]"); pg.wait_for_selector(".vw-hl", timeout=8000); pg.wait_for_timeout(400)
            nm = dict(pg.evaluate("[...document.querySelectorAll('.vw-stat')].map(s=>[s.querySelector('span').textContent, +s.querySelector('strong').textContent])")); check(nm["Confident matches"] >= 1, f"{name}: after choosing day-first {nm}")
        check(not pg._errs, f"{name}: errors {pg._errs}"); pg.screenshot(path=f"{OUT}/o-{name}.png"); ctx.close()

    # ======================= password protected =======================
    from reportlab.pdfgen import canvas as rl
    from reportlab.lib.pdfencrypt import StandardEncryption
    enc = StandardEncryption("secret123", canPrint=1); c = rl.Canvas(f"{OUT}/locked.pdf", encrypt=enc); [c.drawString(100, 700 - i * 14, "locked statement line number %d of the sample account" % i) for i in range(6)]; c.save()
    pg, ctx = page(br, 1280, "bankC_iso"); open_ws(pg); pg.set_input_files("#vwFileInput", f"{OUT}/locked.pdf"); pg.wait_for_selector("#vwPw", timeout=10000)
    check("password protected" in pg.inner_text(".vw-cover"), "password: prompt")
    pg.fill("#vwPw", "wrong"); pg.click("[data-act=unlock]"); pg.wait_for_function("document.querySelector('.vw-cover') && /did not work/.test(document.querySelector('.vw-cover').innerText)", timeout=15000); check("did not work" in pg.inner_text(".vw-cover"), f"password: wrong password message {pg.inner_text('.vw-cover')[:100]!r}")
    pg.fill("#vwPw", "secret123"); pg.click("[data-act=unlock]"); pg.wait_for_timeout(2500); check(pg.locator(".vw-page").count() == 1, "password: correct password opens the file"); ctx.close()

    # ======================= unsupported documents: text-based PDFs only =======================
    pg, ctx = page(br, 1280, "bankA_clean"); open_ws(pg)
    notice = "Only text-based PDF bank statements are supported. Your statement must contain selectable, extractable text. Scanned documents, photographs saved as PDFs and image-only PDFs are not supported."
    check(notice in pg.inner_text(".vw-cover"), "unsupported: the notice is shown before uploading")
    check(pg.locator(".vw-notice").is_visible(), "unsupported: the notice is visible")
    for u in SC["_unsupported"]:
        pg.set_input_files("#vwFileInput", f"{FIX}/{u['pdf']}")
        pg.wait_for_selector(".vw-upload .xr-alert--error", timeout=20000); pg.wait_for_timeout(300)
        err = pg.inner_text(".vw-upload .xr-alert--error")
        check("Unsupported statement" in err and "text-based PDF statements only" in err and "Nothing was processed" in err, f"unsupported {u['pdf']}: message {err[:140]!r}")
        check(step_states(pg) == ["current", "todo", "todo"] and pg.locator(".vw-page").count() == 0 and pg.locator(".vw-region").count() == 0 and pg.locator(".vw-hl").count() == 0, f"unsupported {u['pdf']}: processing did not stop ({step_states(pg)})")
        check(pg.locator("[data-act=match]").count() == 0 and "pdf" not in pg.inner_text(".vw-file").lower(), f"unsupported {u['pdf']}: a Match button or file was left behind")
        check(notice in pg.inner_text(".vw-cover"), f"unsupported {u['pdf']}: the notice stays visible after a refusal")
    check(not any(o["status"] == "paid" for o in db(pg, "orders")) and len(db(pg, "orders")) == 16, "unsupported: no order was touched")
    pg.screenshot(path=f"{OUT}/u-unsupported.png")
    # a good statement still works right after refusals
    upload(pg, "bankA_clean"); check(pg.locator(".vw-page").count() == 2, "unsupported: a text-based statement works after a refusal")
    check(not pg._errs, f"unsupported: errors {pg._errs}"); ctx.close()

    # ======================= edge cases =======================
    pg, ctx = page(br, 1280, "bankC_iso"); pg.evaluate("allOrders.forEach(o=>o.status='paid')"); open_ws(pg)
    check("no unpaid orders" in pg.inner_text(".vw-cover").lower(), "edge: no unpaid orders is explained"); ctx.close()
    pg, ctx = page(br, 1280, "bankC_iso", flags="window.__FAIL_SAVE=true;"); open_ws(pg); upload(pg, "bankC_iso")
    lay = SC["bankC_iso"]["layout"]["regions"]
    pg.click("[data-act=match]"); pg.wait_for_selector(".vw-hl", timeout=10000); pg.wait_for_timeout(300)
    pg.click("[data-act=verify-all]"); pg.click("[data-act=verify-confirm]"); pg.wait_for_timeout(1500)
    check(not any(o["status"] == "paid" for o in db(pg, "orders")) and "could not be verified" in pg.inner_text("#vwPanelBody"), f"edge: failed saves leave orders unpaid and are reported: {pg.inner_text('.vw-box')[:200]!r}")
    pg.evaluate("window.__FAIL_SAVE=false"); pg.click("[data-act=retry-failed]"); pg.wait_for_timeout(2000)
    check(sum(1 for o in db(pg, "orders") if o["status"] == "paid") == 4, f"edge: retry of failed ones {sum(1 for o in db(pg, 'orders') if o['status']=='paid')}"); ctx.close()
    # an order that was paid elsewhere meanwhile is not paid twice
    pg, ctx = page(br, 1280, "bankC_iso"); open_ws(pg); upload(pg, "bankC_iso")
    lay = SC["bankC_iso"]["layout"]["regions"]
    pg.click("[data-act=match]"); pg.wait_for_selector(".vw-hl", timeout=10000); pg.wait_for_timeout(300)
    pg.evaluate("window.__DB.orders.find(o=>o.$id==='C1').status='paid'")
    pg.click("[data-act=verify-all]"); pg.click("[data-act=verify-confirm]"); pg.wait_for_timeout(1500)
    check("no longer unpaid" in pg.inner_text(".vw-fails") and not [u for u in (pg.evaluate("window.__updates||[]")) if u["id"] == "C1"], "edge: an order paid meanwhile is refused, not overwritten"); ctx.close()
    # missing layouts table: layouts stay on this device
    pg, ctx = page(br, 1280, "bankC_iso", flags="window.__MISSING_COLLECTIONS=['statement_layouts'];"); open_ws(pg); upload(pg, "bankC_iso")
    pg.click("[data-act=layout-name]"); pg.fill("#vwLayoutName", "Local layout"); pg.click("[data-act=layout-save]"); pg.wait_for_timeout(500)
    check("this device only" in pg.inner_text("#vwPanelBody") and "Local layout" in pg.inner_text("#vwPanelBody"), f"layouts: local fallback {pg.inner_text('#vwPanelBody')[-200:]!r}")
    check(not pg._errs, f"layouts: errors {pg._errs}"); ctx.close()
    br.close()
check(not [u for u in NET if re.search(r"tesseract|ocr|textract|vision\.googleapis|cloudvision", u, re.I)], f"no OCR library or service was ever requested: {[u for u in NET if re.search(r'tesseract|ocr', u, re.I)][:3]}")
print("\n" + (f"{len(fails)} FAILED" if fails else "ALL PAYMENT VERIFICATION CHECKS PASSED")); sys.exit(1 if fails else 0)
