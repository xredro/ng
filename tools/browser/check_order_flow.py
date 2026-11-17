#!/usr/bin/env python3
"""Real-browser checks for Phases 8, 9 and 10 plus the order-changes switch (needs playwright). Run from the project root:
    python3 tools/browser/check_order_flow.py [outdir]
Uses tools/browser/appwrite_db_stub.js, an in-memory Appwrite with unique indexes, permissions and missing-field errors."""
import os, sys, json, re, datetime, threading, http.server, socketserver, functools
from playwright.sync_api import sync_playwright
from PIL import Image
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/xredro-shots"; os.makedirs(OUT, exist_ok=True)
STUB = open("tools/browser/appwrite_db_stub.js").read()
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=os.getcwd())); PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}"
fails = []
def check(c, m):
    if not c: fails.append(m); print("FAIL:", m)
PNG = os.path.join(OUT, "proof.png"); Image.new("RGB", (60, 40), (30, 120, 60)).save(PNG)
TODAY = datetime.date.today().isoformat()
ID_RE = r"[2-9A-HJKMNP-TV-Z]{12}"

# ---------- seed data ----------
def raw(name, items, fee=3000, pay="Lola Ade"):
    out = [{"label": "Full name", "type": "text", "value": name}, {"label": "Phone", "type": "text", "value": "08031234567"},
           {"label": "Products", "type": "product", "value": [{"name": n, "description": "", "qty": q, "price": p} for n, p, q in items]}]
    if fee: out.append({"label": "Delivery", "type": "additional_fee", "value": "Lagos"})
    out += [{"label": "Name on payment", "type": "payment_account_name", "value": pay}, {"label": "Date paid", "type": "payment_date", "value": "2026-11-02"}]
    return [json.dumps(x) for x in out]
BAGS = [("Black handbag", 12000, 1), ("Gold necklace", 8000, 1)]
def field_products(extra=None):
    return json.dumps({"id": "p1", "type": "product", "label": "Products", "products": [
        {"name": "Black handbag", "price": "12000", "imageId": "", "imageUrl": "", "category": "Bags", "description": ""},
        {"name": "Gold necklace", "price": "8000", "imageId": "", "imageUrl": "", "category": "Jewellery", "description": ""},
        {"name": "Silver wristwatch", "price": "5000", "imageId": "", "imageUrl": "", "category": "Watches", "description": ""},
        {"name": "Ruby ring", "price": "900", "imageId": "", "imageUrl": "", "category": "Jewellery", "description": "", "soldOut": True}]})
FIELDS = [field_products(), json.dumps({"id": "t1", "type": "text", "label": "Full name", "required": True}), json.dumps({"id": "t2", "type": "text", "label": "Phone"})]
def order(i, pid, status, name, form="f1", uid="seller1", total=23000, items=BAGS):
    return {"$id": i, "$createdAt": "2026-11-02T10:00:00.000Z", "$updatedAt": "2026-11-02T10:00:00.000Z", "userId": uid, "formId": form, "formData": raw(name, items),
            "totalAmount": total, "status": status, "paymentProof": "p0", "publicOrderID": pid}
def update(order_id, seq, changes, prev_t, new_t, uid="seller1", proofs=None, pid="X7KM92PQ4N8Z", uid_="u"):
    return {"$id": f"{uid_}{seq}", "$createdAt": f"2026-11-0{3+seq}T10:00:00.000Z", "$updatedAt": "x", "$permissions": ['read("any")'], "updateID": f"{uid_}{seq}", "orderID": order_id, "publicOrderID": pid,
            "sellerID": uid, "seq": seq, "orderSeq": f"{order_id}:{seq}", "previousItems": "[]", "updatedItems": "[]", "changes": json.dumps(changes), "infoChanges": "[]",
            "previousTotal": prev_t, "newTotal": new_t, "additionalAmount": new_t - prev_t, "changeType": "items", "paymentProof": json.dumps(proofs or []),
            "paymentDetails": json.dumps({"name": "Ada", "date": "2026-11-05"}) if proofs else "{}", "paymentStatus": "submitted" if proofs else "none", "updateStatus": "pending", "note": "", "createdAt": "x"}
def review(order_id, upd, decision, amount=0, note="", uid="seller1", perms=None, n=1):
    return {"$id": f"r{n}{decision[:3]}", "$createdAt": f"2026-11-09T10:0{n}:00.000Z", "$updatedAt": "x", "$permissions": perms if perms is not None else ['read("any")', f'update("user:{uid}")', f'delete("user:{uid}")'],
            "orderID": order_id, "updateID": upd, "sellerID": uid, "decision": decision, "amount": amount, "note": note, "verified": "[]", "createdAt": "x"}
def seed(**kw):
    s = {
        "form": [{"$id": "f1", "title": "Amaka Bags", "subtitle": "Quality bags", "userId": "seller1", "storeTheme": "r3", "storeConfig": json.dumps({"whatsapp": "08012345678", "phone": "08099990000"}), "fields": FIELDS},
                 {"$id": "f2", "title": "Closed Store", "userId": "seller2", "storeTheme": "r3", "storeConfig": "{}", "fields": FIELDS, "customerOrderUpdatesEnabled": False, "whatsappNumber": "08011112222"}],
        "orders": [order("a1", "X7KM92PQ4N8Z", "paid", "Ada Obi"), order("a2", "D2KV3RY5Q8MT", "delivered", "Done Dan"), order("a3", None, "pending", "Legacy Lola"),
                   order("b1", "B3NP4RS5T6VW", "paid", "Bee Closed", form="f2", uid="seller2")],
        "order_updates": [], "order_reviews": [],
        "subscriptions": [{"$id": "s", "userId": "seller1", "status": "active", "plan": "30 days", "expiresAt": (datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) + datetime.timedelta(days=20)).isoformat() + "Z"}],
        "695c501b001d24549b03": [{"$id": "prof", "userId": "seller1", "theme": "light", "name": "Seller"}],
    }
    s.update(kw); return s
def routes(pg):
    pg.route("**/cdn.jsdelivr.net/**", lambda r: r.fulfill(body=STUB, content_type="application/javascript"))
    pg.route("**/cdnjs.cloudflare.com/**", lambda r: r.fulfill(body="window.pdfjsLib={GlobalWorkerOptions:{}};window.jspdf={};", content_type="application/javascript"))
    pg.route("**/fonts.g*/**", lambda r: r.abort()); pg.route("**/nyc.cloud.appwrite.io/**", lambda r: r.abort())
def new(br, w, seed_data, flags="", url="", dl=False):
    ctx = br.new_context(viewport={"width": w, "height": 844}, accept_downloads=dl); pg = ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:200])); pg._errs = errs
    pg.add_init_script(f"window.__SEED={json.dumps(seed_data)};window.__USER='seller1';" + flags); routes(pg)
    if url: pg.goto(BASE + url); pg.wait_for_timeout(900)
    return pg, ctx
def noover(pg, tag):
    m = pg.evaluate("({d:document.documentElement.scrollWidth,v:document.documentElement.clientWidth})"); check(m["d"] <= m["v"], f"{tag}: sideways scroll")
def last(pg, col): return pg.evaluate(f"(window.__creates||[]).filter(c=>c.col==='{col}').slice(-1)[0]")
def db(pg, col): return pg.evaluate(f"window.__DB['{col}']")

with sync_playwright() as p:
    br = p.chromium.launch()
    for w in (390, 1280):
        tag = f"{w}px"
        # ================= A. the store: Public Order ID and card =================
        for mode in ("new", "old database", "collision", "updates off"):
            flags = {"old database": "window.__MISSING_ATTRS=['orders.publicOrderID'];", "collision": "window.__FORCE_409_ORDER_ONCE=true;"}.get(mode, "")
            sd = seed()
            if mode == "updates off": sd["form"][0]["customerOrderUpdatesEnabled"] = False
            pg, ctx = new(br, w, sd, flags, "/form.html?fid=f1", dl=True); lt = f"{tag} store/{mode}"
            if mode != "updates off": check(pg.locator("#ocRetrieveStrip a").count() == 1 and "Retrieve My Order" in pg.inner_text("#ocRetrieveStrip"), f"{lt}: Retrieve My Order link missing")
            else: check(pg.locator("#ocRetrieveStrip").count() == 0, f"{lt}: retrieve link shown although updates are off")
            pg.click(".sf-add >> nth=0"); pg.click(".sf-cart-btn"); pg.click("#sfCheckoutBtn"); pg.wait_for_timeout(200)
            pg.fill("[data-id=t1]", "Ada Obi"); pg.fill("[data-id=t2]", "08031234567"); pg.fill("#paymentAccountName", "Ada Obi"); pg.fill("#datePaid", TODAY)
            pg.click(".send-btn"); pg.wait_for_timeout(1500)
            made = [c for c in (pg.evaluate("window.__creates||[]")) if c["col"] == "orders"]
            check(len(made) == (2 if mode == "collision" else 2 if mode == "old database" else 1), f"{lt}: order create attempts {len(made)}")
            if mode == "old database":
                check("publicOrderID" in made[0]["data"] and "publicOrderID" not in made[1]["data"] and len(db(pg, "orders")) == 5, f"{lt}: fallback did not create the order")
                check(pg.locator(".oc-panel").count() == 0 and "Your order has been sent" in pg.inner_text("#formRoot"), f"{lt}: success screen")
            else:
                d = made[-1]["data"]; pid = d.get("publicOrderID", "")
                check(re.fullmatch(ID_RE, pid) is not None, f"{lt}: public ID '{pid}'")
                if mode == "collision": check(made[0]["data"]["publicOrderID"] != pid, f"{lt}: retry reused the same ID")
                check(len(db(pg, "orders")) == 5 and sum(1 for o in db(pg, "orders") if o.get("publicOrderID") == pid) == 1, f"{lt}: order not saved once with that ID")
                check(pid not in (o.get("$id") for o in db(pg, "orders")) and pid != "", f"{lt}: public ID equals an internal id")
                check(pg.inner_text("#ocCode").strip() == pid, f"{lt}: card shows '{pg.inner_text('#ocCode')}'")
                pg.wait_for_timeout(400)
                dim = pg.evaluate("(()=>{const i=document.getElementById('ocPreview');return i&&!i.hidden?[i.naturalWidth,i.naturalHeight]:null})()")
                check(dim and dim[0] == 1080 and 1000 < dim[1] < 2400, f"{lt}: card size {dim}")
                txt = pg.inner_text(".oc-panel")
                if mode == "updates off": check("Retrieve My Order" not in txt and "retrieve and update" not in txt, f"{lt}: card promises updates although they're off")
                else: check("retrieve and update your order later" in txt and pg.locator(".oc-panel a", has_text="Retrieve My Order").count() == 1, f"{lt}: keep-safe text / link missing")
                with pg.expect_download() as dd: pg.click("text=Download order card")
                check(dd.value.suggested_filename == f"order-{pid}.png", f"{lt}: file name {dd.value.suggested_filename}")
                path = os.path.join(OUT, f"card-{mode.replace(' ','-')}-{w}.png"); dd.value.save_as(path); check(Image.open(path).size[0] == 1080, f"{lt}: saved card size")
                if mode == "new": pg.screenshot(path=f"{OUT}/success-{w}.png", full_page=True)
                noover(pg, lt)
            check(not pg._errs, f"{lt}: errors {pg._errs}"); ctx.close()

        # ================= B. customer: Retrieve My Order and Update Order =================
        up1_proof = "pfSeed"
        pg, ctx = new(br, w, seed(), "", "/order.html?fid=f1"); tag_b = f"{tag} customer"
        check("Amaka Bags" in pg.inner_text("#opGateStore"), f"{tag_b}: store name on gate")
        pg.fill("#opCode", "x7km-92pq 4n8z"); check(pg.input_value("#opCode") == "X7KM-92PQ4N8Z"[:0] + "X7KM92PQ4N8Z", f"{tag_b}: input '{pg.input_value('#opCode')}'")
        pg.fill("#opCode", "nope"); pg.click("#opGateBtn"); check("12 letters" in pg.inner_text("#opGateMsg"), f"{tag_b}: bad shape message")
        pg.fill("#opCode", "ZZZZZZZZZZZZ"); pg.click("#opGateBtn"); pg.wait_for_timeout(300); check("didn't match" in pg.inner_text("#opGateMsg"), f"{tag_b}: unknown ID message")
        pg.fill("#opCode", "D2KV3RY5Q8MT"); pg.click("#opGateBtn"); pg.wait_for_timeout(500)
        check(pg.locator(".op-stepper").count() == 0 and "delivered" in pg.inner_text("#opItems").lower() and pg.locator("#opAdd").is_hidden(), f"{tag_b}: delivered order is editable")
        pg.click("#opLeave")
        pg.fill("#opCode", "X7KM92PQ4N8Z"); pg.click("#opGateBtn"); pg.wait_for_timeout(600)
        txt = pg.inner_text("#opView")
        check("X7KM92PQ4N8Z" in txt and "Amaka Bags" in txt and "₦23,000" in txt and "Payment confirmed" in txt, f"{tag_b}: order view")
        check(pg.locator("#opReview").is_hidden(), f"{tag_b}: review visible before any change")
        check(pg.locator(".op-cat", has_text="Ruby ring").locator("button").is_disabled(), f"{tag_b}: sold-out product addable")
        pg.locator(".op-cat", has_text="Silver wristwatch").get_by_role("button", name="Add").click(); pg.wait_for_timeout(150)
        txt = pg.inner_text("#opView"); check("₦28,000" in txt and "₦5,000" in txt and pg.locator("#opPay").is_visible(), f"{tag_b}: preview totals/payment section")
        pg.set_input_files("#opFile", PNG); pg.wait_for_timeout(150)
        pg.click("[data-act=submit]"); check("name shown" in pg.inner_text("#opReview"), f"{tag_b}: missing payment name not caught")
        pg.fill("#opPayName", "Ada Obi"); pg.fill("#opPayDate", TODAY); check("name shown" not in pg.inner_text("#opReview"), f"{tag_b}: stale error remains")
        pg.fill("#opNote", "Please pack together"); pg.screenshot(path=f"{OUT}/order-review-{w}.png", full_page=True)
        pg.click("[data-act=submit]"); pg.wait_for_timeout(1300)
        c1 = last(pg, "order_updates"); d = c1["data"]
        check(c1["perms"] == ['read("any")'], f"{tag_b}: update permissions {c1['perms']} (customers must not get update/delete)")
        check(d["seq"] == 1 and d["orderSeq"] == "a1:1" and d["orderID"] == "a1" and d["sellerID"] == "seller1" and d["publicOrderID"] == "X7KM92PQ4N8Z" and d["updateID"] == c1["id"], f"{tag_b}: update document {d}")
        check(d["previousTotal"] == 23000 and d["newTotal"] == 28000 and d["additionalAmount"] == 5000 and d["updateStatus"] == "pending" and d["paymentStatus"] == "submitted" and len(json.loads(d["paymentProof"])) == 1, f"{tag_b}: update numbers/payment")
        check(json.loads(d["changes"]) == [{"label": "Products", "name": "Silver wristwatch", "qty": 1}], f"{tag_b}: changes {d['changes']}")
        o = [x for x in db(pg, "orders") if x["$id"] == "a1"][0]
        check(o["totalAmount"] == 23000 and o["status"] == "paid" and len(json.loads(o["formData"][2])["value"]) == 2, f"{tag_b}: ORIGINAL order was modified")
        check(pg.evaluate("(window.__updates||[]).filter(u=>u.col==='orders').length") == 0, f"{tag_b}: customer wrote to the orders collection")
        txt = pg.inner_text("#opView"); check("Update sent to the seller" in pg.inner_text("#opConfirm") and "Add Silver wristwatch" in txt and "Waiting for the seller" in txt and "₦28,000" in txt, f"{tag_b}: confirmation / history")
        check("Still to pay" in txt and "₦5,000" in txt, f"{tag_b}: effective order after update 1")
        # second update: more handbags
        pg.locator(".op-line", has_text="Black handbag").locator("[data-act=inc]").click(); pg.wait_for_timeout(100)
        check("₦40,000" in pg.inner_text("#opSummary"), f"{tag_b}: second preview {pg.inner_text('#opSummary')[:200]}")
        pg.click("[data-act=submit]"); pg.wait_for_timeout(1200)
        c2 = last(pg, "order_updates"); check(c2["data"]["seq"] == 2 and c2["data"]["previousTotal"] == 28000 and c2["data"]["newTotal"] == 40000 and c2["data"]["paymentStatus"] == "none", f"{tag_b}: update 2 {c2['data']['seq']} {c2['data']['newTotal']}")
        txt = pg.inner_text("#opView"); check("Update 1" in txt and "Update 2" in txt and "₦40,000" in txt and "₦23,000" in txt, f"{tag_b}: history shows every update")
        # a stale-state conflict (another device saved first)
        pg.locator(".op-line", has_text="Black handbag").locator("[data-act=dec]").click(); pg.wait_for_timeout(100)
        pg.evaluate("window.__FORCE_409_ONCE=true"); n_before = len(db(pg, "order_updates"))
        pg.click("[data-act=submit]"); pg.wait_for_timeout(1200)
        check(len(db(pg, "order_updates")) == n_before and "another update was saved first" in pg.inner_text("#opReview"), f"{tag_b}: conflict message '{pg.inner_text('#opReview')[:120]}'")
        check(pg.locator(".op-line", has_text="Black handbag").locator("output").inner_text() == "1", f"{tag_b}: edits lost after conflict")
        noover(pg, tag_b); pg.screenshot(path=f"{OUT}/order-after-{w}.png", full_page=True)
        with pg.expect_download() as dd: pg.click("[data-act=download]")
        check(dd.value.suggested_filename == "order-X7KM92PQ4N8Z.png", f"{tag_b}: card download {dd.value.suggested_filename}")
        check(not pg._errs, f"{tag_b}: errors {pg._errs}"); ctx.close()

        # seller already rejected update 2 and a stranger forged an approval of update 1
        sd = seed(); sd["order_updates"] = [update("a1", 1, [{"label": "Products", "name": "Silver wristwatch", "qty": 1}], 23000, 28000), update("a1", 2, [{"label": "Products", "name": "Black handbag", "qty": 2}], 28000, 40000)]
        sd["order_reviews"] = [review("a1", "u2", "rejected", note="Out of that bag", n=1), review("a1", "u1", "approved", perms=['read("any")', 'update("user:attacker")'], n=2)]
        pg, ctx = new(br, w, sd, "", "/order.html?fid=f1"); pg.fill("#opCode", "X7KM92PQ4N8Z"); pg.click("#opGateBtn"); pg.wait_for_timeout(600)
        txt = pg.inner_text("#opView")
        check("₦28,000" in pg.inner_text("#opSummary") and "Rejected" in txt and "Out of that bag" in txt and "Waiting for the seller" in txt, f"{tag_b}: rejected update excluded / forged approval ignored")
        # a forged total inside an update document does not change the price
        sd = seed(); u = update("a1", 1, [{"label": "Products", "name": "Silver wristwatch", "qty": 1}], 1, 1); sd["order_updates"] = [u]
        ctx.close(); pg, ctx = new(br, w, sd, "", "/order.html?fid=f1"); pg.fill("#opCode", "X7KM92PQ4N8Z"); pg.click("#opGateBtn"); pg.wait_for_timeout(600)
        check("₦28,000" in pg.inner_text("#opSummary") and "₦1" not in pg.inner_text("#opSummary").replace("₦1,", ""), f"{tag_b}: forged total changed the effective total: {pg.inner_text('#opSummary')[:160]}"); ctx.close()

        # the seller switched order changes off
        for entry in ("/order.html?fid=f2", "/order.html"):
            pg, ctx = new(br, w, seed(), "", entry)
            if "fid" not in entry: pg.fill("#opCode", "B3NP4RS5T6VW"); pg.click("#opGateBtn"); pg.wait_for_timeout(600)
            check(pg.locator("#opOff").is_visible() and "turned off" in pg.inner_text("#opOff") and pg.locator("#opView").is_hidden(), f"{tag_b}: switched-off message ({entry})")
            check("Bee Closed" not in pg.inner_text("body") and "WhatsApp" in pg.inner_text("#opOff"), f"{tag_b}: off page leaks the order or lacks contact ({entry})")
            noover(pg, f"{tag_b} off"); ctx.close()
        # tables not set up
        pg, ctx = new(br, w, seed(), "window.__MISSING_COLLECTIONS=['order_updates'];", "/order.html?fid=f1"); pg.fill("#opCode", "X7KM92PQ4N8Z"); pg.click("#opGateBtn"); pg.wait_for_timeout(600)
        check(pg.locator("#opView").is_visible() and pg.locator(".op-stepper").count() == 0 and "not set up" in pg.inner_text("#opItems"), f"{tag_b}: unset collections should give a read-only view"); ctx.close()
        # guests cannot list orders
        pg, ctx = new(br, w, seed(), "window.__AS_GUEST=true;window.__GUEST_CANNOT_LIST=true;", "/order.html?fid=f1"); pg.fill("#opCode", "X7KM92PQ4N8Z"); pg.click("#opGateBtn"); pg.wait_for_timeout(500)
        check("isn't available" in pg.inner_text("#opGateMsg"), f"{tag_b}: locked-down database message '{pg.inner_text('#opGateMsg')}'"); ctx.close()
        # 8 wrong tries brake
        pg, ctx = new(br, w, seed(), "", "/order.html")
        for i in range(8): pg.fill("#opCode", "ZZZZZZZZZZZ" + "ZWXYZ"[i % 5]); pg.click("#opGateBtn"); pg.wait_for_timeout(200)
        pg.fill("#opCode", "X7KM92PQ4N8Z"); pg.click("#opGateBtn"); pg.wait_for_timeout(300); check("Too many tries" in pg.inner_text("#opGateMsg") and pg.locator("#opView").is_hidden(), f"{tag_b}: no brake"); ctx.close()

        # ================= C. seller: updates, decisions, recovery =================
        tag_s = f"{tag} seller"
        sd = seed(); sd["order_updates"] = [update("a1", 1, [{"label": "Products", "name": "Silver wristwatch", "qty": 1}], 23000, 28000, proofs=["pfSeed"])]
        def seller(sd2=None, flags=""):
            return new(br, w, sd2 or sd, flags, "/orders.html", dl=True)
        pg, ctx = seller()
        chips = pg.evaluate("[...document.querySelectorAll('.ord-filters button')].map(b=>b.textContent)")
        check("Updated 1" in chips, f"{tag_s}: chips {chips}")
        pg.fill("#orderSearch", "x7km 92pq"); pg.wait_for_timeout(200); check(pg.locator(".ord-card").count() == 1, f"{tag_s}: search by public order ID ({pg.locator('.ord-card').count()})")
        pg.fill("#orderSearch", "Ada"); pg.wait_for_timeout(200); pg.locator(".ord-head").first.click(); pg.wait_for_timeout(150)
        card = pg.locator(".ord-card.is-open"); t = card.inner_text()
        check("X7KM 92PQ 4N8Z" in t and "latest order" in t.lower() and "Update 1" in t and "₦28,000" in t and "Added Silver wristwatch" in t, f"{tag_s}: panel text: {t[:900]!r}")
        check("Black handbag" in t and "₦23,000" in card.inner_text(), f"{tag_s}: original details missing")
        check(card.locator(".ord-upd img").count() == 1 and "pfSeed" in card.locator(".ord-upd img").get_attribute("src"), f"{tag_s}: payment image")
        check(pg.evaluate("getPaidProductTotals().map(x=>x.join(':')).join()") == "Black handbag:1,Gold necklace:1", f"{tag_s}: pending update counted for delivery: {pg.evaluate('getPaidProductTotals()')}")
        noover(pg, tag_s); pg.screenshot(path=f"{OUT}/seller-update-{w}.png", full_page=True)
        card.get_by_role("button", name="Approve").click(); pg.wait_for_timeout(700)
        rv = last(pg, "order_reviews"); check(rv["data"]["decision"] == "approved" and rv["data"]["updateID"] == "u1" and rv["data"]["sellerID"] == "seller1", f"{tag_s}: approval {rv and rv['data']}")
        check(rv["perms"] == ['read("any")', 'update("user:seller1")', 'delete("user:seller1")'], f"{tag_s}: review owner permissions {rv['perms']}")
        check(pg.evaluate("getPaidProductTotals().map(x=>x.join(':')).join()") == "Black handbag:1,Gold necklace:1,Silver wristwatch:1", f"{tag_s}: approved update not counted: {pg.evaluate('getPaidProductTotals()')}")
        check("Updated 0" in pg.evaluate("[...document.querySelectorAll('.ord-filters button')].map(b=>b.textContent)"), f"{tag_s}: Updated chip after approval")
        pg.locator(".ord-head").first.click(); card = pg.locator(".ord-card.is-open")
        check("Approved" in card.inner_text() and card.get_by_role("button", name="Approve").count() == 0, f"{tag_s}: state after approval")
        pg.once("dialog", lambda dlg: dlg.accept("5000")); card.get_by_role("button", name="Mark payment received").click(); pg.wait_for_timeout(700)
        rv = last(pg, "order_reviews"); check(rv["data"]["decision"] == "payment_verified" and rv["data"]["amount"] == 5000, f"{tag_s}: payment review {rv['data']}")
        pg.locator(".ord-head").first.click(); card = pg.locator(".ord-card.is-open"); check("Still to pay ₦0" in card.inner_text() and "Extra payment received" in card.inner_text(), f"{tag_s}: due after payment")
        check(not pg._errs, f"{tag_s}: errors {pg._errs}"); ctx.close()
        # reject
        pg, ctx = seller(); pg.fill("#orderSearch", "Ada"); pg.wait_for_timeout(200); pg.locator(".ord-head").first.click()
        pg.on("dialog", lambda dlg: dlg.accept("Sold out today") if dlg.type == "prompt" else dlg.accept())
        pg.locator(".ord-card.is-open").get_by_role("button", name="Reject").click(); pg.wait_for_timeout(700)
        rv = last(pg, "order_reviews"); check(rv["data"]["decision"] == "rejected" and rv["data"]["note"] == "Sold out today", f"{tag_s}: rejection {rv and rv['data']}")
        check(pg.evaluate("getPaidProductTotals().map(x=>x.join(':')).join()") == "Black handbag:1,Gold necklace:1", f"{tag_s}: rejected update counted"); ctx.close()
        # a customer update arrives while the page is open: seller can't approve a handled update
        pg, ctx = seller(); pg.fill("#orderSearch", "Ada"); pg.wait_for_timeout(200); pg.locator(".ord-head").first.click()
        pg.evaluate("window.__DB.order_reviews.push({$id:'rx',$createdAt:'2026-11-10T00:00:00.000Z',$permissions:['read(\"any\")','update(\"user:seller1\")'],orderID:'a1',updateID:'u1',sellerID:'seller1',decision:'rejected',amount:0,note:'',verified:'[]'})")
        pg.once("dialog", lambda dlg: dlg.accept()); pg.locator(".ord-card.is-open").get_by_role("button", name="Approve").click(); pg.wait_for_timeout(600)
        check(len([c for c in pg.evaluate("window.__creates||[]") if c["col"] == "order_reviews"]) == 0 and "already handled" in pg.inner_text("#toast-container"), f"{tag_s}: double decision"); ctx.close()

        # recovery: legacy order has no ID -> create
        pg, ctx = seller(seed()); pg.fill("#orderSearch", "Legacy"); pg.wait_for_timeout(200); pg.locator(".ord-head").first.click(); card = pg.locator(".ord-card.is-open")
        check("None yet" in card.inner_text(), f"{tag_s}: legacy order ID text")
        card.get_by_role("button", name="Create an order ID").click(); pg.wait_for_timeout(200)
        go = pg.locator("#idGo"); boxes = pg.locator("[data-vm]")
        check(boxes.count() == 5 and go.is_disabled(), f"{tag_s}: verification list / gate")
        boxes.nth(0).check(); check(go.is_disabled(), f"{tag_s}: one check enough")
        boxes.nth(3).check(); check(go.is_enabled() and "Lola Ade" in pg.inner_text("#idBody") and "08031234567" in pg.inner_text("#idBody"), f"{tag_s}: two checks / seller can compare")
        pg.fill("#idNote", "Called from the number on the order"); go.click(); pg.wait_for_timeout(1000)
        newid = pg.inner_text("#ocCode").strip(); o3 = [x for x in db(pg, "orders") if x["$id"] == "a3"][0]
        check(re.fullmatch(ID_RE, newid) is not None and o3["publicOrderID"] == newid, f"{tag_s}: created ID '{newid}' / saved '{o3['publicOrderID']}'")
        rv = last(pg, "order_reviews"); check(rv["data"]["decision"] == "id_created" and json.loads(rv["data"]["verified"]) == ["pay_name", "phone"] and newid not in json.dumps(rv["data"]), f"{tag_s}: id_created record {rv['data']}")
        pg.wait_for_timeout(300); check(pg.evaluate("!document.getElementById('ocPreview').hidden"), f"{tag_s}: preview")
        with pg.expect_download() as dd: pg.click("#idBody >> text=Download order card")
        check(dd.value.suggested_filename == f"order-{newid}.png", f"{tag_s}: card file")
        pg.screenshot(path=f"{OUT}/seller-id-{w}.png"); pg.locator("#idBody").get_by_role("button", name="Done").click(); pg.wait_for_timeout(100)
        check(pg.evaluate("document.getElementById('idBody').innerHTML") == "", f"{tag_s}: dialog content left in page")
        # replace an ID, and send the card again
        pg.fill("#orderSearch", "Ada"); pg.wait_for_timeout(200); pg.locator(".ord-head").first.click(); card = pg.locator(".ord-card.is-open")
        card.get_by_role("button", name="Order card and ID").click(); boxes = pg.locator("[data-vm]"); boxes.nth(1).check(); boxes.nth(2).check()
        pg.locator("#idBody [value=card_reissued]").check(); pg.click("#idGo"); pg.wait_for_timeout(900)
        check(pg.inner_text("#ocCode").strip() == "X7KM92PQ4N8Z" and last(pg, "order_reviews")["data"]["decision"] == "card_reissued", f"{tag_s}: card reissue keeps the ID")
        pg.locator("#idBody").get_by_role("button", name="Done").click()
        pg.locator(".ord-head").first.click(); card = pg.locator(".ord-card.is-open"); card.get_by_role("button", name="Order card and ID").click()
        boxes = pg.locator("[data-vm]"); boxes.nth(1).check(); boxes.nth(4).check(); pg.locator("#idBody [value=id_replaced]").check(); pg.click("#idGo"); pg.wait_for_timeout(900)
        rid = pg.inner_text("#ocCode").strip(); o1 = [x for x in db(pg, "orders") if x["$id"] == "a1"][0]
        check(rid != "X7KM92PQ4N8Z" and o1["publicOrderID"] == rid and last(pg, "order_reviews")["data"]["decision"] == "id_replaced", f"{tag_s}: replaced ID {rid}")
        check(not any(x.get("publicOrderID") == "X7KM92PQ4N8Z" for x in db(pg, "orders")), f"{tag_s}: old ID still resolves")
        pg.locator("#idBody").get_by_role("button", name="Done").click()
        check(not pg._errs, f"{tag_s}: errors {pg._errs}"); ctx.close()
        # Phase 10: the seller changes an order for the customer
        pg, ctx = seller(seed()); pg.fill("#orderSearch", "Ada"); pg.wait_for_timeout(200); pg.locator(".ord-head").first.click(); card = pg.locator(".ord-card.is-open")
        card.get_by_role("button", name="Change order for customer").click(); pg.wait_for_timeout(200)
        go = pg.locator("#seGo"); boxes = pg.locator("#idBody [data-vm]")
        check(go.is_disabled() and boxes.count() == 5, f"{tag_s}: seller change gate")
        boxes.nth(0).check(); check(go.is_disabled(), f"{tag_s}: one check is not enough for a change")
        boxes.nth(3).check(); check(go.is_enabled(), f"{tag_s}: two checks enable the change")
        go.click(); pg.wait_for_timeout(300); check("Nothing was changed" in pg.inner_text("#seErr"), f"{tag_s}: empty change: {pg.inner_text('#seErr')!r}")
        pg.select_option("#seAdd", label="Silver wristwatch · ₦5,000"); pg.fill("#seNote", "Customer phoned to add a watch")
        check(pg.locator("#seAdd option").all_inner_texts().count("Ruby ring · ₦900") == 0, f"{tag_s}: sold-out product offered to the seller")
        pg.screenshot(path=f"{OUT}/seller-change-{w}.png", full_page=True)
        go.click(); pg.wait_for_timeout(1000)
        up = last(pg, "order_updates"); rv = last(pg, "order_reviews")
        check(up and up["perms"] == ['read("any")', 'update("user:seller1")', 'delete("user:seller1")'] and up["data"]["sellerID"] == "seller1" and up["data"]["orderSeq"] == "a1:1" and up["data"]["newTotal"] == 28000, f"{tag_s}: seller update doc {up}")
        check(json.loads(up["data"]["changes"]) == [{"label": "Products", "name": "Silver wristwatch", "qty": 1}], f"{tag_s}: seller update changes")
        check(rv["data"]["decision"] == "approved" and rv["data"]["updateID"] == up["data"]["updateID"] and json.loads(rv["data"]["verified"]) == ["pay_name", "phone"] and "watch" in rv["data"]["note"], f"{tag_s}: auto-approval record {rv['data']}")
        check(pg.locator("#idModal").evaluate("e=>e.classList.contains('hidden')") and "Order changed" in pg.inner_text("#toast-container"), f"{tag_s}: dialog closed with confirmation")
        check(pg.evaluate("getPaidProductTotals().map(x=>x.join(':')).join()") == "Black handbag:1,Gold necklace:1,Silver wristwatch:1", f"{tag_s}: approved seller change is delivered")
        pg.locator(".ord-head").first.click(); card = pg.locator(".ord-card.is-open"); t = card.inner_text()
        check("made by you" in t and "Checked with the customer" in t and "Name on the payment" in t and "Added Silver wristwatch" in t and "₦5,000 to pay" in pg.inner_text("body"), f"{tag_s}: history shows seller change: {t[:600]!r}")
        check(not pg._errs, f"{tag_s}: errors {pg._errs}"); ctx.close()
        # waiting customer update blocks a seller change; cancelled orders offer no change button
        pg, ctx = seller(sd); pg.fill("#orderSearch", "Ada"); pg.wait_for_timeout(200); pg.locator(".ord-head").first.click()
        pg.locator(".ord-card.is-open").get_by_role("button", name="Change order for customer").click(); pg.wait_for_timeout(200)
        check("waiting" in pg.inner_text("#idBody"), f"{tag_s}: waiting update warning"); pg.locator("#idBody [data-vm]").nth(0).check(); pg.locator("#idBody [data-vm]").nth(3).check()
        pg.fill("#seq0", "2"); pg.click("#seGo"); pg.wait_for_timeout(500)
        check("waiting" in pg.inner_text("#seErr") and not [c for c in pg.evaluate("window.__creates||[]") if c["col"] == "order_updates"], f"{tag_s}: change allowed over a waiting update"); ctx.close()
        pg, ctx = seller(seed()); pg.fill("#orderSearch", "Done"); pg.wait_for_timeout(200); pg.locator(".ord-head").first.click()
        check(pg.locator(".ord-card.is-open").get_by_role("button", name="Change order for customer").count() == 0, f"{tag_s}: delivered order offers a change"); ctx.close()
        # failed save never shows an ID; unset field is explained
        pg, ctx = seller(seed(), "window.__FAIL_SAVE=true;"); pg.fill("#orderSearch", "Legacy"); pg.wait_for_timeout(200); pg.locator(".ord-head").first.click()
        pg.locator(".ord-card.is-open").get_by_role("button", name="Create an order ID").click(); boxes = pg.locator("[data-vm]"); boxes.nth(0).check(); boxes.nth(1).check(); pg.click("#idGo"); pg.wait_for_timeout(800)
        check(pg.locator("#ocCode").count() == 0 and pg.locator("#idErr").is_visible(), f"{tag_s}: an ID was shown although saving failed"); ctx.close()
        # no collections yet: orders page still works
        pg, ctx = seller(seed(), "window.__MISSING_COLLECTIONS=['order_updates','order_reviews'];")
        check(pg.locator(".ord-card").count() >= 3 and not pg._errs, f"{tag_s}: orders page without the new collections {pg.locator('.ord-card').count()} {pg._errs}"); ctx.close()

        # ================= D. Settings switch =================
        pg, ctx = new(br, w, seed(), "", "/settings.html"); pg.wait_for_timeout(500)
        sw = pg.locator("#customerOrderUpdatesEnabled")
        check(sw.is_checked(), f"{tag} settings: default must be on")
        pg.locator("label[for=customerOrderUpdatesEnabled]").click(); pg.wait_for_timeout(500)
        check(pg.evaluate("(window.__updates||[]).slice(-1)[0].data.customerOrderUpdatesEnabled") is False and [f for f in db(pg, "form") if f["$id"] == "f1"][0].get("customerOrderUpdatesEnabled") is False, f"{tag} settings: switch off not saved")
        check(not sw.is_checked(), f"{tag} settings: switch state"); noover(pg, f"{tag} settings"); ctx.close()
        pg, ctx = new(br, w, seed(), "window.__MISSING_ATTRS=['form.customerOrderUpdatesEnabled'];", "/settings.html"); pg.wait_for_timeout(500)
        pg.locator("label[for=customerOrderUpdatesEnabled]").click(); pg.wait_for_timeout(500)
        check(pg.locator("#customerOrderUpdatesEnabled").is_checked() and "attribute" in pg.inner_text("#toast-container"), f"{tag} settings: failed save should put the switch back"); ctx.close()
    br.close()
print("\n" + (f"{len(fails)} FAILED" if fails else "ALL ORDER FLOW CHECKS PASSED")); sys.exit(1 if fails else 0)
