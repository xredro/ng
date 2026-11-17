#!/usr/bin/env python3
"""Browser check of admin batch mode and the shared time-left display. Run from the project root:
    python3 tools/browser/check_admin_batch.py [outdir]"""
import os, sys, json, datetime, threading, http.server, socketserver, functools
from playwright.sync_api import sync_playwright
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/xredro-admin"; os.makedirs(OUT, exist_ok=True)
STUB = open("tools/browser/appwrite_db_stub.js").read()
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=os.getcwd())); BASE = f"http://127.0.0.1:{httpd.server_address[1]}"
threading.Thread(target=httpd.serve_forever, daemon=True).start()
fails = []
def check(c, m):
    if not c: fails.append(m); print("FAIL:", m)
NOW = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
iso = lambda d: d.isoformat() + "Z"
def order(i, email, product, status="paid", name="Cust"):
    fd = [{"label": "Full name", "type": "text", "value": name}]
    if email: fd.append({"label": "Your email", "type": "text", "value": email})
    fd.append({"label": "Plan", "type": "product", "value": [{"name": product, "description": "", "qty": 1, "price": 1500}]})
    return {"$id": i, "$createdAt": iso(NOW - datetime.timedelta(hours=int(i[-1]))), "userId": "seller1", "status": status, "totalAmount": 1500, "formData": [json.dumps(x) for x in fd]}
def seed():
    return {
        "orders": [order("o1", "ann@x.com", "Weekly plan (7 days)"), order("o2", "bob@x.com", "Monthly plan - 30 days"), order("o3", "", "Weekly plan (7 days)"),
                   order("o4", "dee@x.com", "Premium"), order("o5", "ghost@x.com", "Weekly plan (7 days)"), order("o6", "ann@x.com", "Weekly plan (7 days)", status="delivered"), order("o7", "ann@x.com", "Weekly plan (7 days)", status="pending")],
        "695c501b001d24549b03": [{"$id": "pa", "userId": "ua", "email": "ann@x.com", "username": "Ann"}, {"$id": "pb", "userId": "ub", "email": "bob@x.com", "username": "Bob"}, {"$id": "pd", "userId": "ud", "email": "dee@x.com"},
                                  {"$id": "pc", "userId": "uc", "email": "cy@x.com", "username": "Cy"}],
        "subscriptions": [{"$id": "sb", "userId": "ub", "status": "active", "plan": "weekly", "durationDay": 7, "expiresAt": iso(NOW + datetime.timedelta(days=3, hours=1))}], "form": [], "subs": []}
def page(br, w, flags="", url="/admin.html"):
    ctx = br.new_context(viewport={"width": w, "height": 844}); pg = ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:200])); pg._errs = errs
    pg.add_init_script(f"window.__SEED={json.dumps(seed())};window.__USER='seller1';" + flags)
    pg.route("**/cdn.jsdelivr.net/**", lambda r: r.fulfill(body=STUB, content_type="application/javascript"))
    pg.route("**/fonts.g*/**", lambda r: r.abort()); pg.route("**/nyc.cloud.appwrite.io/**", lambda r: r.abort())
    pg.goto(BASE + url); pg.wait_for_timeout(700); return pg, ctx
with sync_playwright() as p:
    br = p.chromium.launch()
    for w in (390, 1280):
        tag = f"{w}px"
        pg, ctx = page(br, w)
        check(pg.locator("#batchPanel").is_visible(), f"{tag}: batch panel hidden")
        pg.click("#batchLoadBtn"); pg.wait_for_timeout(1500)
        rows = pg.locator(".batch-row"); check(rows.count() == 5, f"{tag}: rows {rows.count()} (delivered and unpaid orders must not appear)")
        txt = pg.inner_text("#batchList")
        r1 = pg.locator(".batch-row", has_text="ann@x.com"); r2 = pg.locator(".batch-row", has_text="bob@x.com")
        check("Activate 7 days" in r1.inner_text(), f"{tag}: new customer row: {r1.inner_text()!r}")
        check("Extend: keeps 3 days" in r2.inner_text() and "adds 30 days" in r2.inner_text(), f"{tag}: running plan row: {r2.inner_text()!r}")
        check(pg.locator("[data-email]").count() == 1 and "No email found" in txt, f"{tag}: order without an email")
        r4 = pg.locator(".batch-row", has_text="dee@x.com"); check(r4.locator("[data-pick]").is_disabled() and r4.locator("select").input_value() == "", f"{tag}: unknown plan must not be selectable")
        r5 = pg.locator(".batch-row", has_text="ghost@x.com"); check("No X-Redro account" in r5.inner_text() and r5.locator("[data-pick]").is_disabled(), f"{tag}: unknown account")
        check(pg.locator("[data-pick]:checked").count() == 2 and "Process 2 selected" in pg.inner_text("#batchRunBtn"), f"{tag}: ready rows preselected")
        # fix the plan on the unknown-plan row and the email on the missing-email row
        r4.locator("select").select_option("monthly"); pg.wait_for_timeout(150)
        check(r4.locator("[data-pick]").is_checked() and "Activate 30 days" in pg.locator(".batch-row", has_text="dee@x.com").inner_text(), f"{tag}: choosing a plan makes the row ready")
        pg.locator("[data-email]").fill("cy@x.com"); pg.locator("[data-email]").dispatch_event("change"); pg.wait_for_timeout(700)
        r3 = pg.locator(".batch-row", has_text="cy@x.com"); check("Activate 7 days" in r3.inner_text(), f"{tag}: typed email looked up: {r3.inner_text()!r}")
        check(pg.locator("#batchAll").is_checked(), f"{tag}: select-all state")
        m = pg.evaluate("({d:document.documentElement.scrollWidth,v:document.documentElement.clientWidth})"); check(m["d"] <= m["v"], f"{tag}: sideways scroll")
        pg.screenshot(path=f"{OUT}/batch-{w}.png", full_page=True)
        # run, but break marking one order Delivered
        pg.evaluate("window.__realUpdate = Appwrite.Databases.prototype.updateDocument; Appwrite.Databases.prototype.updateDocument = function(db,col,id,data){ return id==='o2' ? Promise.reject(new Error('network')) : window.__realUpdate.call(this,db,col,id,data); }; true")
        pg.once("dialog", lambda d: d.accept()); pg.click("#batchRunBtn"); pg.wait_for_timeout(2500)
        subs = pg.evaluate("window.__DB.subscriptions"); orders = {o["$id"]: o["status"] for o in pg.evaluate("window.__DB.orders")}
        ann = [s for s in subs if s["userId"] == "ua" and s["status"] == "active"]; bob = [s for s in subs if s["userId"] == "ub" and s["status"] == "active"]
        check(len(ann) == 1 and ann[0]["plan"] == "weekly" and ann[0]["durationDay"] == 7, f"{tag}: Ann activated {ann}")
        check(len(bob) == 1 and bob[0]["plan"] == "monthly" and bob[0]["durationDay"] == 30, f"{tag}: Bob plan as requested {bob}")
        left = (datetime.datetime.fromisoformat(bob[0]["expiresAt"].replace("Z", "")) - NOW).total_seconds() / 86400
        check(33.0 < left < 33.2, f"{tag}: Bob keeps his 3 days + adds 30 (got {left:.2f} days)")
        check(orders["o1"] == "delivered" and orders["o4"] == "delivered" and orders["o3"] == "delivered", f"{tag}: finished orders not marked delivered {orders}")
        check(orders["o2"] == "paid" and "Could not mark" in pg.locator(".batch-row", has_text="bob@x.com").inner_text(), f"{tag}: failed marking should be reported")
        check(orders["o5"] == "paid" and orders["o6"] == "delivered" and orders["o7"] == "pending", f"{tag}: other orders touched {orders}")
        summ = pg.inner_text("#batchSummary"); check("4 done" in summ and "Extended: kept 3 days" in summ, f"{tag}: summary {summ!r}")
        # run again: nothing already done comes back, even the one that could not be marked
        pg.click("#batchLoadBtn"); pg.wait_for_timeout(1200)
        again = pg.inner_text("#batchList"); check("bob@x.com" not in again and "ann@x.com" not in again and pg.locator(".batch-row").count() == 1, f"{tag}: processed orders came back: {again!r}")
        check(not pg._errs, f"{tag}: errors {pg._errs}"); ctx.close()
        # function down: nothing is written
        pg, ctx = page(br, w, "window.__FN_DOWN=true;"); pg.click("#batchLoadBtn"); pg.wait_for_timeout(1500)
        check(pg.locator("[data-pick]:checked").count() == 0 and pg.evaluate("window.__DB.subscriptions.length") == 1, f"{tag}: function down: rows selectable or writes happened"); ctx.close()
    br.close()
print("\n" + (f"{len(fails)} FAILED" if fails else "ALL ADMIN BATCH CHECKS PASSED")); sys.exit(1 if fails else 0)
