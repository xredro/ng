#!/usr/bin/env python3
"""Browser check of the Telegram Notifications settings card and of the notification hooks (order placed, customer update,
cancellation, additional payment). The Worker itself is tested in tools/test-telegram-worker.mjs; here it is a fake.
Run from the project root:  python3 tools/browser/check_telegram.py [outdir]"""
import sys, json, re
OUTARG = sys.argv[1] if len(sys.argv) > 1 else "/tmp/xredro-tg"
sys.argv = ["x", OUTARG]
src = open("tools/browser/check_order_flow.py").read()
exec(src[:src.index("with sync_playwright() as p:")])      # reuse the seed data and page helpers of the order flow check
CONFIG = 'window.XR_TELEGRAM={workerUrl:"https://worker.test",botUsername:"XRedroBot"};'
class FakeWorker:
    def __init__(self): self.connected = False; self.status_fail = False; self.down = False; self.delay = 0; self.reqs = []
    def handle(self, route, request):
        path = request.url.replace("https://worker.test", ""); body = request.post_data or ""
        self.reqs.append({"path": path, "auth": request.headers.get("authorization", ""), "body": body})
        if self.down: return route.abort()
        def ok(o, s=200): route.fulfill(status=s, content_type="application/json", headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*"}, body=json.dumps(o))
        if request.method == "OPTIONS": return route.fulfill(status=204, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST"})
        if path == "/api/telegram/status": return ok({"ok": False}, 500) if self.status_fail else ok({"ok": True, "connected": self.connected})
        if path == "/api/telegram/connect": return ok({"ok": True, "deepLink": "https://t.me/XRedroBot?start=" + "A" * 43, "expiresInSec": 600})
        if path == "/api/telegram/test": return ok({"ok": True})
        if path == "/api/telegram/disconnect": self.connected = False; return ok({"ok": True, "connected": False})
        if path == "/api/notify": return ok({"ok": True, "sent": True}, 202)
        return ok({"ok": False}, 404)
    def notifies(self): return [json.loads(r["body"]) for r in self.reqs if r["path"] == "/api/notify"]
def wire(pg, fw, configured=True):
    pg.context.route("https://t.me/**", lambda r: r.fulfill(body="telegram", content_type="text/html"))
    pg.route("https://worker.test/**", fw.handle)
    if configured: pg.route("**/js/telegram-config.js", lambda r: r.fulfill(body=CONFIG, content_type="application/javascript"))
with sync_playwright() as p:
    br = p.chromium.launch()
    for w in (390, 1280):
        tag = f"{w}px telegram"
        # ---------- not set up ----------
        fw = FakeWorker(); pg, ctx = new(br, w, seed(), "", "/settings.html"); pg.wait_for_timeout(600)
        check("Not set up yet" in pg.inner_text("#tgBody") and pg.locator("#tgBody button").count() == 0, f"{tag}: unconfigured state"); ctx.close()
        # ---------- states ----------
        fw = FakeWorker(); ctx = br.new_context(viewport={"width": w, "height": 844}); pg = ctx.new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)[:200])); pg.add_init_script(f"window.__SEED={json.dumps(seed())};window.__USER='seller1';"); routes(pg); wire(pg, fw)
        pg.goto(BASE + "/settings.html"); pg.wait_for_timeout(900)
        t = pg.inner_text("#tgBody"); check("Not connected" in t and pg.locator("#tgBody >> text=Connect Telegram").count() == 1, f"{tag}: disconnected state: {t!r}")
        check("Receive instant notifications on Telegram" in pg.inner_text("body"), f"{tag}: description text")
        st = [r for r in fw.reqs if r["path"] == "/api/telegram/status"][0]
        check(st["auth"].startswith("Bearer jwt-") and st["body"] == "{}", f"{tag}: status call must send a JWT and no ids: {st}")
        with ctx.expect_page() as newp: pg.click("#tgBody >> text=Connect Telegram")
        popup = newp.value; check(popup.url.startswith("https://t.me/XRedroBot?start=") and len(popup.url.split("start=")[1]) == 43, f"{tag}: Telegram link opened {popup.url}"); popup.close()
        pg.wait_for_timeout(300)
        t = pg.inner_text("#tgBody"); link = pg.locator("#tgBody a", has_text="Open Telegram")
        check("Waiting for you in Telegram" in t and "press Start" in t and link.get_attribute("href").startswith("https://t.me/XRedroBot?start=") and link.get_attribute("target") == "_blank", f"{tag}: connecting state: {t!r}")
        con = [r for r in fw.reqs if r["path"] == "/api/telegram/connect"][0]; check(con["auth"].startswith("Bearer ") and con["body"] == "{}", f"{tag}: connect call carries no ids")
        pg.screenshot(path=f"{OUT}/tg-connecting-{w}.png", full_page=True)
        m = pg.evaluate("({d:document.documentElement.scrollWidth,v:document.documentElement.clientWidth})"); check(m["d"] <= m["v"], f"{tag}: sideways scroll")
        fw.connected = True; pg.wait_for_timeout(3800)       # the seller pressed Start in Telegram; the page notices by itself
        t = pg.inner_text("#tgBody"); check("Connected" in t and "Send Test Notification" in t and "Disconnect Telegram" in t and "Not connected" not in t, f"{tag}: auto-updates to connected without reload: {t!r}")
        check(pg.locator(".tg-dot--on").count() == 1 and "Telegram connected" in pg.inner_text("#toast-container"), f"{tag}: green indicator / toast")
        pg.screenshot(path=f"{OUT}/tg-connected-{w}.png", full_page=True)
        h = pg.locator("#tgBody .xr-btn").first.bounding_box()["height"]; check(h >= 44, f"{tag}: tap target {h}px")
        pg.click("text=Send Test Notification"); pg.wait_for_timeout(500)
        check(any(r["path"] == "/api/telegram/test" for r in fw.reqs) and "Test notification sent" in pg.inner_text("#toast-container"), f"{tag}: test notification")
        pg.once("dialog", lambda d: d.accept()); pg.click("text=Disconnect Telegram"); pg.wait_for_timeout(500)
        check("Not connected" in pg.inner_text("#tgBody") and not fw.connected, f"{tag}: disconnect")
        # expired link
        pg.click("#tgBody >> text=Connect Telegram"); pg.wait_for_timeout(300)
        pg.evaluate("tg.expires = Date.now() - 1")
        pg.wait_for_timeout(3500); t = pg.inner_text("#tgBody"); check("expired" in t and "Try again" in t, f"{tag}: expired link state: {t!r}")
        check(not errs, f"{tag}: errors {errs}"); ctx.close()
        fw = FakeWorker(); fw.status_fail = True; ctx = br.new_context(viewport={"width": w, "height": 844}); pg = ctx.new_page()
        pg.add_init_script(f"window.__SEED={json.dumps(seed())};window.__USER='seller1';"); routes(pg); wire(pg, fw); pg.goto(BASE + "/settings.html"); pg.wait_for_timeout(900)
        check("Something went wrong" in pg.inner_text("#tgBody") and "Try again" in pg.inner_text("#tgBody") and pg.locator(".tg-dot--err").count() == 1, f"{tag}: error state")
        fw.status_fail = False; pg.get_by_role("button", name="Try again").click(); pg.wait_for_timeout(900); check("Not connected" in pg.inner_text("#tgBody"), f"{tag}: retry recovers"); ctx.close()

        # ---------- hooks ----------
        # new order: one notification carrying only the event and the order id; the order is saved first
        fw = FakeWorker(); ctx = br.new_context(viewport={"width": w, "height": 844}); pg = ctx.new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)[:200])); pg.add_init_script(f"window.__SEED={json.dumps(seed())};window.__USER='seller1';"); routes(pg); wire(pg, fw)
        pg.goto(BASE + "/form.html?fid=f1"); pg.wait_for_timeout(800)
        def place():
            pg.click(".sf-add >> nth=0"); pg.click(".sf-cart-btn"); pg.click("#sfCheckoutBtn"); pg.wait_for_timeout(200)
            pg.fill("[data-id=t1]", "Ada Obi"); pg.fill("[data-id=t2]", "08031234567"); pg.fill("#paymentAccountName", "Ada Obi"); pg.fill("#datePaid", TODAY); pg.click(".send-btn")
        place(); pg.wait_for_timeout(1200)
        n = fw.notifies(); newest = [o for o in db(pg, "orders")][-1]
        check(len(n) == 1 and set(n[0].keys()) == {"event", "orderId"} and n[0]["event"] == "new_order" and n[0]["orderId"] == newest["$id"], f"{tag}: new order notification body {n}")
        check("Your order has been sent" in pg.inner_text("#formRoot"), f"{tag}: success screen"); check(not errs, f"{tag}: errors {errs}"); ctx.close()
        # worker down or very slow: order still succeeds, quickly, without errors
        for mode in ("down", "slow"):
            fw = FakeWorker(); ctx = br.new_context(viewport={"width": w, "height": 844}); pg = ctx.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)[:200])); pg.add_init_script(f"window.__SEED={json.dumps(seed())};window.__USER='seller1';"); routes(pg)
            if mode == "down": fw.down = True; wire(pg, fw)
            else:
                pg.route("**/js/telegram-config.js", lambda r: r.fulfill(body=CONFIG, content_type="application/javascript"))
                pg.route("https://worker.test/**", lambda route, request: None)        # never answers
            pg.goto(BASE + "/form.html?fid=f1"); pg.wait_for_timeout(800); place(); pg.wait_for_timeout(1500)
            check(len(db(pg, "orders")) == 5 and "Your order has been sent" in pg.inner_text("#formRoot") and "failed" not in pg.inner_text("#toast-container").lower(), f"{tag}: Telegram {mode}: the order must still succeed")
            check(not errs, f"{tag}: Telegram {mode}: page errors {errs}"); ctx.close()
        # telegram not configured: no requests at all
        fw = FakeWorker(); ctx = br.new_context(viewport={"width": w, "height": 844}); pg = ctx.new_page()
        pg.add_init_script(f"window.__SEED={json.dumps(seed())};window.__USER='seller1';"); routes(pg); wire(pg, fw, configured=False); pg.goto(BASE + "/form.html?fid=f1"); pg.wait_for_timeout(800); place(); pg.wait_for_timeout(1000)
        check(fw.reqs == [] and len(db(pg, "orders")) == 5, f"{tag}: unconfigured Telegram must not send anything"); ctx.close()
        # customer update
        fw = FakeWorker(); ctx = br.new_context(viewport={"width": w, "height": 844}); pg = ctx.new_page()
        pg.add_init_script(f"window.__SEED={json.dumps(seed())};window.__USER='seller1';"); routes(pg); wire(pg, fw); pg.goto(BASE + "/order.html?fid=f1"); pg.wait_for_timeout(500)
        pg.fill("#opCode", "X7KM92PQ4N8Z"); pg.click("#opGateBtn"); pg.wait_for_timeout(600)
        pg.locator(".op-cat", has_text="Silver wristwatch").get_by_role("button", name="Add").click(); pg.click("[data-act=submit]"); pg.wait_for_timeout(1200)
        n = fw.notifies(); upd = db(pg, "order_updates")
        check(len(upd) == 1 and len(n) == 1 and n[0] == {"event": "order_updated", "orderId": "a1", "refId": upd[0]["$id"]}, f"{tag}: update notification {n}"); ctx.close()
        # a failed customer update sends nothing
        fw = FakeWorker(); ctx = br.new_context(viewport={"width": w, "height": 844}); pg = ctx.new_page()
        pg.add_init_script(f"window.__SEED={json.dumps(seed())};window.__USER='seller1';window.__MISSING_COLLECTIONS=['order_updates'];"); routes(pg); wire(pg, fw); pg.goto(BASE + "/order.html?fid=f1"); pg.wait_for_timeout(500)
        pg.fill("#opCode", "X7KM92PQ4N8Z"); pg.click("#opGateBtn"); pg.wait_for_timeout(600)
        check(fw.notifies() == [] and pg.locator(".op-stepper").count() == 0, f"{tag}: nothing to notify when updates can't be saved"); ctx.close()
        # seller: cancel, and a failed cancel
        for fail in (False, True):
            fw = FakeWorker(); ctx = br.new_context(viewport={"width": w, "height": 844}); pg = ctx.new_page()
            pg.add_init_script(f"window.__SEED={json.dumps(seed())};window.__USER='seller1';" + ("window.__FAIL_SAVE=true;" if fail else "")); routes(pg); wire(pg, fw)
            pg.goto(BASE + "/orders.html"); pg.wait_for_timeout(900); pg.fill("#orderSearch", "Legacy"); pg.wait_for_timeout(200); pg.locator(".ord-head").first.click()
            pg.once("dialog", lambda d: d.accept()); pg.locator(".ord-card.is-open").get_by_role("button", name="Cancel order").click(); pg.wait_for_timeout(900)
            n = fw.notifies()
            if fail: check(n == [], f"{tag}: failed cancel must not notify {n}")
            else: check(n == [{"event": "order_cancelled", "orderId": "a3"}], f"{tag}: cancel notification {n}")
            ctx.close()
        # seller: additional payment recorded
        sd = seed(); sd["order_updates"] = [update("a1", 1, [{"label": "Products", "name": "Silver wristwatch", "qty": 1}], 23000, 28000, proofs=["pfSeed"])]
        fw = FakeWorker(); ctx = br.new_context(viewport={"width": w, "height": 844}); pg = ctx.new_page()
        pg.add_init_script(f"window.__SEED={json.dumps(sd)};window.__USER='seller1';"); routes(pg); wire(pg, fw)
        pg.goto(BASE + "/orders.html"); pg.wait_for_timeout(900); pg.fill("#orderSearch", "Ada"); pg.wait_for_timeout(200); pg.locator(".ord-head").first.click()
        pg.locator(".ord-card.is-open").get_by_role("button", name="Approve").click(); pg.wait_for_timeout(700)
        check([x for x in fw.notifies()] == [], f"{tag}: approving is not a payment")
        pg.locator(".ord-head").first.click(); pg.once("dialog", lambda d: d.accept("5000")); pg.locator(".ord-card.is-open").get_by_role("button", name="Mark payment received").click(); pg.wait_for_timeout(800)
        rev = [r for r in db(pg, "order_reviews") if r["decision"] == "payment_verified"]
        n = fw.notifies(); check(len(rev) == 1 and n == [{"event": "additional_payment", "orderId": "a1", "refId": rev[0]["$id"]}], f"{tag}: payment notification {n}"); ctx.close()
    br.close()
print("\n" + (f"{len(fails)} FAILED" if fails else "ALL TELEGRAM CHECKS PASSED")); sys.exit(1 if fails else 0)
