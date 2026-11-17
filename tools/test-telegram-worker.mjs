// Run from project root: node tools/test-telegram-worker.mjs
// Tests the Cloudflare Worker against in-memory fakes of the Appwrite REST API and the Telegram Bot API.
let failed = 0;
const a = (c, m) => { if (!c) failed++; console.log(c ? "ok  " : "FAIL", m); };
const ENDPOINT = "https://aw.test/v1";
const env = {
  TELEGRAM_TOKEN: "BOT-TOKEN-SECRET", TELEGRAM_WEBHOOK_SECRET: "whsecret-1234567890", APPWRITE_API_KEY: "KEY-SECRET", TELEGRAM_BOT_USERNAME: "XRedroBot",
  APPWRITE_ENDPOINT: ENDPOINT, APPWRITE_PROJECT_ID: "proj", APPWRITE_DATABASE_ID: "db", APPWRITE_USERS_COLLECTION_ID: "users", APPWRITE_ORDERS_COLLECTION_ID: "orders",
  APPWRITE_UPDATES_COLLECTION_ID: "order_updates", APPWRITE_REVIEWS_COLLECTION_ID: "order_reviews", APPWRITE_TG_CONNECTIONS_COLLECTION_ID: "telegram_connections",
  APPWRITE_TG_EVENTS_COLLECTION_ID: "telegram_events", ALLOWED_ORIGINS: "https://shop.test", DASHBOARD_URL: "https://shop.test/orders.html"
};
const DB = { users: {}, orders: {}, order_updates: {}, order_reviews: {}, telegram_connections: {}, telegram_events: {} };
const JWTS = { "jwt-seller1-aaaaaaaaaaaaaaaaaaaa": "s1", "jwt-seller2-bbbbbbbbbbbbbbbbbbbb": "s2" };
const sent = []; const tg = { mode: "ok", calls: 0, flakyLeft: 0 }; const awLog = [];
let clock = 0; const stamp = () => new Date(Date.now() + (++clock)).toISOString();
const respond = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith("https://api.telegram.org/")) {
    tg.calls++;
    const body = JSON.parse(init.body);
    if (!url.includes("BOT-TOKEN-SECRET")) return respond(404, { ok: false });
    if (tg.mode === "down") throw new Error("network down");
    if (tg.mode === "blocked") return respond(403, { ok: false, description: "Forbidden: bot was blocked by the user" });
    if (tg.mode === "rate") { tg.mode = "ok"; return respond(429, { ok: false, parameters: { retry_after: 0 } }); }
    if (tg.mode === "flaky" && tg.flakyLeft-- > 0) return respond(502, { ok: false });
    sent.push({ chat: String(body.chat_id), text: body.text }); return respond(200, { ok: true });
  }
  if (!url.startsWith(ENDPOINT)) throw new Error("unexpected url " + url);
  const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const u = new URL(url); const path = u.pathname.replace("/v1", "");
  if (path === "/account") { const id = JWTS[h["x-appwrite-jwt"]]; return id ? respond(200, { $id: id }) : respond(401, { message: "Invalid JWT" }); }
  if (h["x-appwrite-key"] !== "KEY-SECRET") return respond(401, { message: "bad key" });
  const m = /^\/databases\/db\/collections\/([^/]+)\/documents(?:\/([^/]+))?$/.exec(path);
  if (!m) return respond(404, { message: "route" });
  const [, col, id] = m; const coll = DB[col]; if (!coll) return respond(404, { message: "collection" });
  awLog.push(init.method + " " + col);
  if (init.method === "GET" && id) return coll[id] ? respond(200, coll[id]) : respond(404, { message: "Document not found" });
  if (init.method === "GET") {
    let docs = Object.values(coll);
    u.searchParams.getAll("queries[]").map(q => JSON.parse(q)).filter(q => q.method === "equal").forEach(q => { docs = docs.filter(d => q.values.includes(d[q.attribute])); });
    return respond(200, { documents: docs, total: docs.length });
  }
  const body = JSON.parse(init.body);
  if (init.method === "POST") { if (coll[body.documentId]) return respond(409, { message: "exists" }); coll[body.documentId] = Object.assign({ $id: body.documentId, $createdAt: stamp(), $updatedAt: stamp() }, body.data); return respond(201, coll[body.documentId]); }
  if (init.method === "PATCH") { if (!coll[id]) return respond(404, { message: "nf" }); Object.assign(coll[id], body.data, { $updatedAt: stamp() }); return respond(200, coll[id]); }
  return respond(405, {});
};
const worker = (await import("../cloudflare-worker/telegram-notifier/src/index.js")).default;

/* ---------- helpers ---------- */
let ipN = 0; // each ordinary call comes from a different address so the per-address brake is only exercised where a test means to
const call = async (method, path, { body, jwt, origin = "https://shop.test", headers = {}, ip = "10.1." + Math.floor(++ipN / 250) + "." + (ipN % 250) } = {}) => {
  const h = Object.assign({ "content-type": "application/json" }, headers);
  if (jwt) h.authorization = "Bearer " + jwt; if (origin) h.origin = origin; if (ip) h["cf-connecting-ip"] = ip;
  const res = await worker.fetch(new Request("https://worker.test" + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  let data = null; try { data = await res.clone().json(); } catch (e) { /* none */ }
  return { status: res.status, data, res };
};
const webhook = (update, secret = env.TELEGRAM_WEBHOOK_SECRET) => call("POST", "/telegram/webhook", { body: update, origin: null, headers: secret == null ? {} : { "x-telegram-bot-api-secret-token": secret } });
const start = (chatId, text) => webhook({ update_id: 1, message: { chat: { id: chatId, type: "private" }, from: { id: chatId }, text } });
const JWT1 = "jwt-seller1-aaaaaaaaaaaaaaaaaaaa", JWT2 = "jwt-seller2-bbbbbbbbbbbbbbbbbbbb";
const fresh = () => new Date().toISOString();
const orderDoc = (id, uid, extra = {}) => Object.assign({ $id: id, $createdAt: fresh(), $updatedAt: fresh(), userId: uid, status: "pending", totalAmount: 45000, paymentProof: "", publicOrderID: "ORD1024XYZ98",
  formData: [JSON.stringify({ label: "Full name", type: "text", value: "Jane" }), JSON.stringify({ label: "Products", type: "product", value: [{ name: "Bag", qty: 2, price: 20000 }, { name: "Shoe", qty: 1, price: 5000 }] })] }, extra);
const lastMsg = () => sent[sent.length - 1];
const wait = ms => new Promise(r => setTimeout(r, ms));
DB.users.s1 = { $id: "s1", userId: "s1", email: "a@x.com", telegramConnected: false, telegramChatID: "" };
DB.users.s2 = { $id: "s2", userId: "s2", email: "b@x.com", telegramConnected: false, telegramChatID: "" };

/* ---------- TEST 1: connect ---------- */
let r = await call("POST", "/api/telegram/connect");
a(r.status === 401, "connect without sign-in is refused");
r = await call("POST", "/api/telegram/connect", { jwt: "jwt-forged-cccccccccccccccccccc" });
a(r.status === 401, "connect with a forged JWT is refused");
r = await call("POST", "/api/telegram/connect", { jwt: JWT1, origin: "https://evil.test" });
a(r.status === 403, "connect from another website is refused");
r = await call("POST", "/api/telegram/connect", { jwt: JWT1 });
a(r.status === 200 && /^https:\/\/t\.me\/XRedroBot\?start=[A-Za-z0-9_-]{43}$/.test(r.data.deepLink) && r.data.expiresInSec === 600, "connect returns a deep link with a 43-character random token and a 10 minute life");
const token1 = r.data.deepLink.split("start=")[1];
const stored = Object.values(DB.telegram_connections)[0];
a(Object.keys(DB.telegram_connections).length === 1 && stored.userId === "s1" && stored.used === false && !JSON.stringify(DB).includes(token1), "token is tied to the signed-in seller; only a hash of it is stored");
r = await call("POST", "/api/telegram/connect", { jwt: JWT1 }); const tokenB = r.data.deepLink.split("start=")[1];
a(tokenB !== token1, "every link is new");

a((await webhook({ message: { chat: { id: 111, type: "private" }, text: "/start " + token1 } }, null)).status === 401, "webhook without the secret token is refused");
a((await webhook({ message: { chat: { id: 111, type: "private" }, text: "/start " + token1 } }, "wrong-secret")).status === 401, "webhook with the wrong secret token is refused");
a(DB.users.s1.telegramConnected === false && sent.length === 0, "nothing happened on refused webhooks");
a((await start(111, "/start s1")).status === 200 && DB.users.s1.telegramConnected === false, "a seller id in the start text does not connect anything");
a((await start(111, "/start " + "A".repeat(43))).status === 200 && DB.users.s1.telegramConnected === false && /expired or was already used/.test(lastMsg().text), "unknown token: nothing connected, chat told");
sent.length = 0;
r = await start(111, "/start " + token1);
a(r.status === 200 && DB.users.s1.telegramConnected === true && DB.users.s1.telegramChatID === "111" && DB.users.s2.telegramConnected === false, "TEST 1: valid link connects chat 111 to seller 1 only");
a(sent.length === 1 && sent[0].chat === "111" && /Your X-Redro Telegram notifications are now connected!/.test(sent[0].text), "confirmation message sent");
a(Object.values(DB.telegram_connections).find(c => c.userId === "s1" && c.used === true), "token burned");
sent.length = 0;
await start(222, "/start " + token1);
a(DB.users.s1.telegramChatID === "111" && sent.length === 1 && /already used/.test(sent[0].text), "the same link cannot be used from another chat");
const expired = "E".repeat(43); DB.telegram_connections["x"] = { $id: "x", userId: "s2", used: false, expiresAt: new Date(Date.now() - 1000).toISOString() };
const { default: _ } = { default: 0 };
const crypto = globalThis.crypto; const hash = async s => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map(b => b.toString(16).padStart(2, "0")).join("");
DB.telegram_connections[(await hash(expired)).slice(0, 32)] = { $id: (await hash(expired)).slice(0, 32), userId: "s2", used: false, expiresAt: new Date(Date.now() - 1000).toISOString() };
sent.length = 0; await start(333, "/start " + expired);
a(DB.users.s2.telegramConnected === false && /expired/.test(lastMsg().text), "expired link refused");
a((await webhook({ message: { chat: { id: -999, type: "group" }, text: "/start " + tokenB } })).status === 200 && DB.users.s1.telegramChatID === "111", "group chats are ignored");
r = await call("POST", "/api/telegram/status", { jwt: JWT1 }); a(r.data.connected === true && !JSON.stringify(r.data).includes("111"), "status says connected and never reveals the chat id");
r = await call("POST", "/api/telegram/status", { jwt: JWT2 }); a(r.data.connected === false, "seller 2 is still disconnected");

/* ---------- TEST 2: test notification ---------- */
sent.length = 0;
r = await call("POST", "/api/telegram/test", { jwt: JWT1 });
a(r.status === 200 && sent.length === 1 && sent[0].chat === "111" && /TEST NOTIFICATION/.test(sent[0].text), "TEST 2: seller 1 receives the test notification in their own chat");
r = await call("POST", "/api/telegram/test", { jwt: JWT2 });
a(r.status === 409 && sent.length === 1, "seller 2 (not connected) cannot trigger a message");
a((await call("POST", "/api/telegram/test", { body: { chatId: "111" } })).status === 401, "TEST 10: test endpoint without sign-in");
r = await call("POST", "/api/telegram/test", { jwt: JWT2, body: { chatId: "111", chat_id: "111", text: "hi" } });
a(sent.length === 1, "a chat id or text in the request body is ignored");

/* ---------- TEST 3: new order ---------- */
DB.orders.o1 = orderDoc("o1", "s1");
sent.length = 0;
r = await call("POST", "/api/notify", { body: { event: "new_order", orderId: "o1" }, origin: "https://shop.test" });
a(r.status === 202 && sent.length === 1 && sent[0].chat === "111", "TEST 3: new order reaches seller 1's chat");
a(/NEW ORDER RECEIVED/.test(sent[0].text) && /Order ID: #ORD1024XYZ98/.test(sent[0].text) && /Customer: Jane/.test(sent[0].text) && /Items: 3/.test(sent[0].text) && /Total: ₦45,000/.test(sent[0].text) && /Payment Status: Unpaid/.test(sent[0].text), "message content from the saved order");
a(!/BOT-TOKEN|KEY-SECRET/.test(sent[0].text), "no secrets in messages");
sent.length = 0;
await call("POST", "/api/notify", { body: { event: "new_order", orderId: "o1" } });
await call("POST", "/api/notify", { body: { event: "new_order", orderId: "o1" } });
a(sent.length === 0, "the same event is never sent twice");

/* ---------- TEST 9: sellers are kept apart ---------- */
DB.users.s2.telegramConnected = true; DB.users.s2.telegramChatID = "222";
DB.orders.o2 = orderDoc("o2", "s2", { publicOrderID: "SELLER2ORDER", formData: [JSON.stringify({ label: "Full name", type: "text", value: "Kemi" }), JSON.stringify({ label: "P", type: "product", value: [{ name: "Cap", qty: 1, price: 3000 }] })], totalAmount: 3000 });
sent.length = 0;
await call("POST", "/api/notify", { body: { event: "new_order", orderId: "o2" } });
a(sent.length === 1 && sent[0].chat === "222" && /Kemi/.test(sent[0].text) && !sent.some(m => m.chat === "111"), "TEST 9: seller 2's order goes to seller 2 only");
r = await call("POST", "/api/notify", { body: { event: "new_order", orderId: "o1", chatId: "222", userId: "s2", text: "hello" } });
a(!sent.some(m => m.text === "hello") && sent.length === 1, "TEST 9: a chat id, seller id or text in the request changes nothing");
a(DB.users.s1.telegramChatID === "111", "seller 1's chat was not touched");
r = await call("POST", "/api/telegram/disconnect", { jwt: JWT2 });
a(DB.users.s2.telegramConnected === false && DB.users.s1.telegramConnected === true, "seller 2 can only disconnect their own Telegram");
DB.users.s2.telegramConnected = true; DB.users.s2.telegramChatID = "222";

/* ---------- TEST 4: updates ---------- */
const upd = (id, extra = {}) => Object.assign({ $id: id, $createdAt: fresh(), orderID: "o1", sellerID: "s1", updateID: id, seq: 1, previousTotal: 45000, newTotal: 55000, changes: JSON.stringify([{ label: "Products", name: "Shoe", qty: 3 }]), infoChanges: "[]", paymentProof: "[]" }, extra);
DB.order_updates.u1 = upd("u1");
sent.length = 0;
r = await call("POST", "/api/notify", { body: { event: "order_updated", orderId: "o1", refId: "u1" } });
a(sent.length === 1 && sent[0].chat === "111" && /ORDER UPDATED/.test(sent[0].text) && /Previous Total: ₦45,000/.test(sent[0].text) && /New Total: ₦55,000/.test(sent[0].text) && /Order ID: #ORD1024XYZ98/.test(sent[0].text), "TEST 4: update notification with previous and new total");
sent.length = 0;
await call("POST", "/api/notify", { body: { event: "order_updated", orderId: "o1", refId: "u1" } });
a(sent.length === 0, "update announced once");
DB.order_updates.u2 = upd("u2", { seq: 2, previousTotal: 55000, newTotal: 55000, changes: "[]", infoChanges: "[]", paymentProof: "[]" });
await call("POST", "/api/notify", { body: { event: "order_updated", orderId: "o1", refId: "u2" } });
a(sent.length === 0, "an update that changes nothing is not announced");
DB.order_updates.u3 = upd("u3", { seq: 3, previousTotal: 55000, newTotal: 55000, changes: "[]", paymentProof: JSON.stringify(["pf1"]) });
await call("POST", "/api/notify", { body: { event: "order_updated", orderId: "o1", refId: "u3" } });
a(sent.length === 1 && /Payment evidence attached: 1/.test(sent[0].text), "payment evidence alone is announced");
DB.order_updates.u4 = upd("u4", { $createdAt: new Date(Date.now() - 3600e3).toISOString(), seq: 4 });
sent.length = 0; await call("POST", "/api/notify", { body: { event: "order_updated", orderId: "o1", refId: "u4" } });
a(sent.length === 0, "an old update cannot be announced later");
DB.order_updates.u5 = upd("u5", { orderID: "o2" });
await call("POST", "/api/notify", { body: { event: "order_updated", orderId: "o1", refId: "u5" } });
a(sent.length === 0, "an update that belongs to another order cannot be announced for this one");
await call("POST", "/api/notify", { body: { event: "order_updated", orderId: "o1", refId: "nope" } });
a(sent.length === 0, "an update that does not exist is not announced");

/* ---------- TEST 5: cancelled ---------- */
sent.length = 0;
await call("POST", "/api/notify", { body: { event: "order_cancelled", orderId: "o1" } });
a(sent.length === 0, "an order that is not cancelled is not announced as cancelled");
DB.orders.o1.status = "cancelled"; DB.orders.o1.$updatedAt = fresh();
await call("POST", "/api/notify", { body: { event: "order_cancelled", orderId: "o1" } });
a(sent.length === 1 && sent[0].chat === "111" && /ORDER CANCELLED/.test(sent[0].text) && /Order ID: #ORD1024XYZ98/.test(sent[0].text) && /Customer: Jane/.test(sent[0].text) && /This order has been cancelled\./.test(sent[0].text), "TEST 5: cancellation notification");
DB.orders.o1.status = "pending";

/* ---------- TEST 6: additional payment ---------- */
const perms = uid => ['read("any")', `update("user:${uid}")`, `delete("user:${uid}")`];
DB.order_reviews.r1 = { $id: "r1", $createdAt: fresh(), orderID: "o1", sellerID: "s1", updateID: "u1", decision: "payment_verified", amount: 10000, $permissions: perms("s1") };
sent.length = 0;
await call("POST", "/api/notify", { body: { event: "additional_payment", orderId: "o1", refId: "r1" } });
a(sent.length === 1 && /ADDITIONAL PAYMENT UPDATE/.test(sent[0].text) && /Amount Received: ₦10,000/.test(sent[0].text) && /Updated Order Total: ₦55,000/.test(sent[0].text) && sent[0].chat === "111", "TEST 6: additional payment notification (amount and updated total)");
DB.order_reviews.r2 = { $id: "r2", $createdAt: fresh(), orderID: "o1", sellerID: "s1", updateID: "u1", decision: "payment_verified", amount: 99999, $permissions: ['read("any")', 'update("user:attacker")'] };
sent.length = 0; await call("POST", "/api/notify", { body: { event: "additional_payment", orderId: "o1", refId: "r2" } });
a(sent.length === 0, "a payment 'review' not created by the seller is not announced");
DB.order_reviews.r3 = { $id: "r3", $createdAt: fresh(), orderID: "o1", sellerID: "s1", updateID: "u1", decision: "approved", amount: 0, $permissions: perms("s1") };
await call("POST", "/api/notify", { body: { event: "additional_payment", orderId: "o1", refId: "r3" } });
a(sent.length === 0, "an approval is not announced as a payment");

/* ---------- TEST 10: nobody can make the Worker say things ---------- */
sent.length = 0;
for (const body of [{ event: "send", orderId: "o1", text: "pay me" }, { event: "new_order" }, { event: "new_order", orderId: "../../x" }, { event: "new_order", orderId: "missing" }, "garbage"]) {
  const x = await call("POST", "/api/notify", { body }); a([202, 400].includes(x.status), "notify rejects or ignores: " + JSON.stringify(body).slice(0, 50));
}
a(sent.length === 0, "TEST 10: no message was produced by any of those");
DB.orders.old = orderDoc("old", "s1", { $createdAt: new Date(Date.now() - 86400e3).toISOString() });
await call("POST", "/api/notify", { body: { event: "new_order", orderId: "old" } });
a(sent.length === 0, "an old order cannot be re-announced");
a((await call("POST", "/api/notify", { body: { event: "new_order", orderId: "o2" }, origin: "https://evil.test" })).status === 403, "browsers on other websites are refused");
a((await call("GET", "/api/notify")).status === 404 && (await call("POST", "/nothing")).status === 404, "unknown routes 404");
const flood = []; for (let i = 0; i < 40; i++) flood.push((await call("POST", "/api/notify", { body: { event: "new_order", orderId: "missing" }, ip: "9.9.9.9" })).status);
a(flood.includes(429), "a flood from one address is braked");
a((await call("POST", "/api/notify", { body: { event: "new_order", orderId: "missing" }, ip: "8.8.8.8" })).status === 202, "other addresses are unaffected");
const probe = await call("POST", "/api/notify", { body: { event: "new_order", orderId: "o2" }, ip: "7.7.7.7" });
const probe2 = await call("POST", "/api/notify", { body: { event: "new_order", orderId: "missing" }, ip: "7.7.7.7" });
a(probe.status === 202 && probe2.status === 202, "hits and misses answer the same way");

/* ---------- TEST 8: Telegram unavailable ---------- */
DB.orders.o3 = orderDoc("o3", "s1"); tg.mode = "down"; sent.length = 0;
const t0 = Date.now(); r = await call("POST", "/api/notify", { body: { event: "new_order", orderId: "o3" } });
a(r.status === 202 && r.data.sent === false && DB.orders.o3 && DB.orders.o3.status === "pending", "TEST 8: Telegram down: the Worker still answers normally and the order is untouched");
const ev3 = Object.values(DB.telegram_events).find(e => e.orderId === "o3"); a(ev3 && ev3.status === "failed" && ev3.attempts === 1, "failure recorded for later retry");
tg.mode = "ok"; r = await call("POST", "/api/notify", { body: { event: "new_order", orderId: "o3" } });
a(sent.length === 1 && DB.telegram_events[Object.keys(DB.telegram_events).find(k => DB.telegram_events[k].orderId === "o3")].status === "sent", "a later call retries a failed notification (once it works, it is sent)");
sent.length = 0; await call("POST", "/api/notify", { body: { event: "new_order", orderId: "o3" } });
a(sent.length === 0, "…and then never again");
DB.orders.o4 = orderDoc("o4", "s1"); tg.mode = "flaky"; tg.flakyLeft = 2; sent.length = 0; tg.calls = 0;
await call("POST", "/api/notify", { body: { event: "new_order", orderId: "o4" } });
a(sent.length === 1 && tg.calls === 3, "temporary Telegram errors are retried inside one call without duplicates (" + tg.calls + " tries, " + sent.length + " message)");
DB.orders.o5 = orderDoc("o5", "s1"); tg.mode = "rate"; sent.length = 0;
await call("POST", "/api/notify", { body: { event: "new_order", orderId: "o5" } });
a(sent.length === 1, "Telegram's 'slow down' answer is waited out and retried");
tg.mode = "ok";

/* ---------- blocked bot ---------- */
DB.orders.o6 = orderDoc("o6", "s1"); tg.mode = "blocked"; sent.length = 0;
r = await call("POST", "/api/notify", { body: { event: "new_order", orderId: "o6" } });
a(r.status === 202 && DB.users.s1.telegramConnected === false && DB.users.s1.telegramChatID === "", "blocked bot: the seller is switched to disconnected, X-Redro unaffected");
tg.mode = "ok"; DB.orders.o7 = orderDoc("o7", "s1"); tg.calls = 0;
await call("POST", "/api/notify", { body: { event: "new_order", orderId: "o7" } });
a(tg.calls === 0, "no more messages are attempted after that");

/* ---------- TEST 7: disconnect ---------- */
await call("POST", "/api/telegram/connect", { jwt: JWT1 }).then(async x => { const t = x.data.deepLink.split("start=")[1]; await start(555, "/start " + t); });
a(DB.users.s1.telegramConnected === true && DB.users.s1.telegramChatID === "555", "seller 1 reconnects (a different chat)");
sent.length = 0; r = await call("POST", "/api/telegram/disconnect", { jwt: JWT1 });
a(r.status === 200 && DB.users.s1.telegramConnected === false && DB.users.s1.telegramChatID === "", "TEST 7: disconnect clears the connection");
sent.length = 0; DB.orders.o8 = orderDoc("o8", "s1"); await call("POST", "/api/notify", { body: { event: "new_order", orderId: "o8" } });
a(sent.length === 0, "TEST 7: no notification after disconnecting");
a((await call("POST", "/api/telegram/test", { jwt: JWT1 })).status === 409, "test notification refused when disconnected");
await call("POST", "/api/telegram/connect", { jwt: JWT1 }).then(async x => { await start(666, "/start " + x.data.deepLink.split("start=")[1]); });
sent.length = 0; await webhook({ my_chat_member: { chat: { id: 666, type: "private" }, new_chat_member: { status: "kicked" } } });
a(DB.users.s1.telegramConnected === false, "blocking the bot in Telegram disconnects the seller");
await call("POST", "/api/telegram/connect", { jwt: JWT1 }).then(async x => { await start(777, "/start " + x.data.deepLink.split("start=")[1]); });
sent.length = 0; await start(777, "/stop");
a(DB.users.s1.telegramConnected === false && /switched off/.test(lastMsg().text), "/stop in Telegram switches notifications off");

/* ---------- secrets ---------- */
const everything = JSON.stringify(DB);
a(!everything.includes("BOT-TOKEN-SECRET") && !everything.includes("KEY-SECRET") && !everything.includes("whsecret"), "no secret is ever written to the database");
const logs = []; const origLog = console.log, origErr = console.error; console.log = console.error = x => logs.push(String(x));
tg.mode = "down"; DB.orders.o9 = orderDoc("o9", "s2"); await call("POST", "/api/notify", { body: { event: "new_order", orderId: "o9" } });
console.log = origLog; console.error = origErr; tg.mode = "ok";
a(logs.length > 0 && !logs.join("\n").match(/BOT-TOKEN|KEY-SECRET|whsecret|222/), "failures are logged without secrets or chat ids");
console.log(failed ? `\n${failed} FAILED` : "\nall passed"); process.exit(failed ? 1 : 0);
