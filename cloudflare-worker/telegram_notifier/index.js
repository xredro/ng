/* X-Redro Telegram notifier, a Cloudflare Worker.
   - Telegram is for notifications only. Sellers connect once with a single-use link; nothing is typed by hand.
   - The bot token and the Appwrite API key exist only as Worker secrets.
   - The browser never supplies a chat ID or message text. It only names an order (and an event), and the Worker rebuilds
     the message from the saved order, checks the event really happened recently, and sends it once.
   Routes:
     POST /telegram/webhook          Telegram -> Worker (checked with the webhook secret token)
     POST /api/telegram/connect      seller (Appwrite JWT)  -> one-time Telegram link
     POST /api/telegram/status       seller (Appwrite JWT)  -> { connected }
     POST /api/telegram/test         seller (Appwrite JWT)  -> sends a test message to the seller's own chat
     POST /api/telegram/disconnect   seller (Appwrite JWT)
     POST /api/notify                storefront / dashboard -> { event, orderId, refId } (no login; see "notify" below)  */

const TOKEN_TTL_MS = 10 * 60e3;          // a connection link works for 10 minutes, once
const EVENT_WINDOW_MS = 10 * 60e3;       // an event can only be announced within 10 minutes of happening
const SENDING_LOCK_MS = 60e3;            // a message being sent right now is not sent a second time
const MAX_ATTEMPTS = 3;                  // per event, across retries
const TG_TIMEOUT_MS = 6000, AW_TIMEOUT_MS = 8000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,35}$/;
const EVENTS = ["new_order", "order_updated", "order_cancelled", "additional_payment"];

/* ---------------- small utilities ---------------- */
const enc = new TextEncoder();
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function b64url(bytes) { let s = ""; bytes.forEach(b => { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function randomToken() { return b64url(crypto.getRandomValues(new Uint8Array(32))); }
async function safeEqual(a, b) {  // constant-time comparison of two secrets (compares their hashes)
  const [x, y] = await Promise.all([sha256Hex(String(a || "")), sha256Hex(String(b || ""))]);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0 && typeof a === "string" && a.length > 0;
}
const money = v => { const n = typeof v === "number" ? v : Number(String(v == null ? "" : v).replace(/[₦,\s]/g, "")); return Number.isFinite(n) ? n : 0; };
const naira = n => "₦" + String(Math.round(money(n) * 100) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const log = (level, msg, extra) => console[level === "error" ? "error" : "log"](JSON.stringify(Object.assign({ level, msg }, extra || {}))); // never log tokens, keys or chat IDs

function allowedOrigin(env, request) {
  const origin = request.headers.get("Origin");
  const list = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!origin) return { ok: true, origin: null };
  return list.indexOf(origin) !== -1 ? { ok: true, origin } : { ok: false, origin };
}
function json(env, request, body, status, extraHeaders) {
  const h = { "content-type": "application/json", "cache-control": "no-store" };
  const o = allowedOrigin(env, request);
  if (o.ok && o.origin) { h["access-control-allow-origin"] = o.origin; h["vary"] = "Origin"; }
  return new Response(JSON.stringify(body), { status: status || 200, headers: Object.assign(h, extraHeaders || {}) });
}

/* best-effort brake per address and route, per Worker instance. Add a Cloudflare rate-limiting rule for a hard limit (see SETUP.md). */
const hits = new Map();
function limited(request, route, max, windowMs) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const key = route + "|" + ip, now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < windowMs);
  list.push(now); hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

/* ---------------- Appwrite (REST, API key held by the Worker) ---------------- */
async function timed(url, init, ms) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, Object.assign({}, init, { signal: ctl.signal })); } finally { clearTimeout(t); }
}
async function aw(env, method, path, body) {
  const res = await timed(env.APPWRITE_ENDPOINT + path, {
    method, headers: { "content-type": "application/json", "x-appwrite-project": env.APPWRITE_PROJECT_ID, "x-appwrite-key": env.APPWRITE_API_KEY },
    body: body ? JSON.stringify(body) : undefined
  }, AW_TIMEOUT_MS);
  let data = null; try { data = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) { const err = new Error((data && data.message) || ("Appwrite " + res.status)); err.status = res.status; throw err; }
  return data;
}
const docPath = (env, col, id) => `/databases/${env.APPWRITE_DATABASE_ID}/collections/${col}/documents${id ? "/" + encodeURIComponent(id) : ""}`;
const getDoc = (env, col, id) => aw(env, "GET", docPath(env, col, id));
const patchDoc = (env, col, id, data) => aw(env, "PATCH", docPath(env, col, id), { data });
const createDoc = (env, col, id, data) => aw(env, "POST", docPath(env, col), { documentId: id, data, permissions: [] });
async function listDocs(env, col, queries) {
  const qs = queries.map(q => "queries[]=" + encodeURIComponent(JSON.stringify(q))).join("&");
  return (await aw(env, "GET", docPath(env, col) + "?" + qs)).documents || [];
}
const Q = { equal: (attribute, v) => ({ method: "equal", attribute, values: [v] }), limit: n => ({ method: "limit", values: [n] }) };
async function maybeDoc(env, col, id) { try { return await getDoc(env, col, id); } catch (e) { if (e.status === 404) return null; throw e; } }

/* who is calling? The seller's Appwrite JWT is checked with Appwrite itself. The Worker never trusts a user id sent in a body. */
async function authSeller(env, request) {
  const m = /^Bearer\s+([\w.-]{20,4096})$/.exec(request.headers.get("authorization") || "");
  if (!m) return null;
  try {
    const res = await timed(env.APPWRITE_ENDPOINT + "/account", { headers: { "x-appwrite-project": env.APPWRITE_PROJECT_ID, "x-appwrite-jwt": m[1] } }, AW_TIMEOUT_MS);
    if (!res.ok) return null;
    const u = await res.json();
    return u && ID_RE.test(String(u.$id || "")) ? u.$id : null;
  } catch (e) { return null; }
}

/* ---------------- Telegram ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* returns { ok } | { ok:false, blocked:true } (chat gone or bot blocked) | { ok:false, error } . Retries only temporary failures. */
async function sendTelegram(env, chatId, text) {
  let last = "unknown";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await timed(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
      }, TG_TIMEOUT_MS);
      let data = {}; try { data = await res.json(); } catch (e) { /* ignore */ }
      if (res.ok && data.ok) return { ok: true };
      last = "telegram " + res.status;
      if (res.status === 403 || (res.status === 400 && /chat not found|user is deactivated|bot was blocked/i.test(String(data.description || "")))) return { ok: false, blocked: true, error: last };
      if (res.status === 429) { await sleep(Math.min(((data.parameters && data.parameters.retry_after) || 1) * 1000, 3000)); continue; }
      if (res.status >= 500) { await sleep(400 * attempt); continue; }
      return { ok: false, error: last };   // other 4xx: retrying will not help
    } catch (e) { last = e && e.name === "AbortError" ? "timeout" : "network"; await sleep(400 * attempt); }
  }
  return { ok: false, error: last };
}

/* ---------------- seller profile (Users collection) ---------------- */
async function profileOf(env, sellerId) { return maybeDoc(env, env.APPWRITE_USERS_COLLECTION_ID, sellerId); }
async function markDisconnected(env, sellerId) {
  try { await patchDoc(env, env.APPWRITE_USERS_COLLECTION_ID, sellerId, { telegramConnected: false, telegramChatID: "" }); } catch (e) { log("error", "disconnect write failed", { status: e.status }); }
}

/* ---------------- webhook: the seller pressed Start ---------------- */
async function handleWebhook(request, env) {
  if (!(await safeEqual(request.headers.get("x-telegram-bot-api-secret-token"), env.TELEGRAM_WEBHOOK_SECRET))) return new Response("forbidden", { status: 401 });
  let update; try { update = await request.json(); } catch (e) { return new Response("bad request", { status: 400 }); }
  try {
    const cm = update.my_chat_member;
    if (cm && cm.chat && cm.chat.type === "private" && cm.new_chat_member && ["kicked", "left"].indexOf(cm.new_chat_member.status) !== -1) {
      const owners = await listDocs(env, env.APPWRITE_USERS_COLLECTION_ID, [Q.equal("telegramChatID", String(cm.chat.id)), Q.limit(5)]).catch(() => []);
      for (const p of owners) await markDisconnected(env, p.$id);       // the seller blocked the bot: stop sending, keep X-Redro working
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const msg = update.message;
    if (!msg || !msg.chat || msg.chat.type !== "private" || typeof msg.text !== "string") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    const chatId = String(msg.chat.id);
    const parts = msg.text.trim().split(/\s+/);
    const command = (parts[0] || "").split("@")[0].toLowerCase();

    if (command === "/stop") {
      const owners = await listDocs(env, env.APPWRITE_USERS_COLLECTION_ID, [Q.equal("telegramChatID", chatId), Q.limit(5)]).catch(() => []);
      for (const p of owners) await markDisconnected(env, p.$id);
      await sendTelegram(env, chatId, owners.length ? "Telegram notifications are switched off. You can connect again from X-Redro Settings." : "This chat was not connected to an X-Redro account.");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (command !== "/start") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    const token = parts[1] || "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      await sendTelegram(env, chatId, "To connect, open Settings in X-Redro, find Telegram Notifications and press Connect Telegram. That gives you a link made just for you.");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const id = (await sha256Hex(token)).slice(0, 32);          // only a hash of the token is ever stored
    const rec = await maybeDoc(env, env.APPWRITE_TG_CONNECTIONS_COLLECTION_ID, id);
    const bad = !rec || rec.used === true || Date.parse(rec.expiresAt) < Date.now();
    if (bad) {
      await sendTelegram(env, chatId, "That connection link has expired or was already used. Please press Connect Telegram in X-Redro Settings again.");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    await patchDoc(env, env.APPWRITE_TG_CONNECTIONS_COLLECTION_ID, id, { used: true });   // single use: burned before anything else happens
    const profile = await profileOf(env, rec.userId);
    if (!profile) { await sendTelegram(env, chatId, "We could not find your X-Redro account. Please try again from Settings."); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
    await patchDoc(env, env.APPWRITE_USERS_COLLECTION_ID, rec.userId, { telegramChatID: chatId, telegramConnected: true });
    await sendTelegram(env, chatId, "Your X-Redro Telegram notifications are now connected!\n\nYou'll receive notifications whenever important order activities happen on your X-Redro storefront.");
    log("log", "telegram connected", { seller: rec.userId });
  } catch (e) {
    log("error", "webhook failed", { status: e.status, message: String(e.message).slice(0, 120) });
    // answer 200 anyway: Telegram would retry the same update for hours, and every failure above is logged
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

/* ---------------- seller endpoints (Appwrite JWT required) ---------------- */
async function handleSeller(path, request, env) {
  const sellerId = await authSeller(env, request);
  if (!sellerId) return json(env, request, { ok: false, message: "Please sign in again." }, 401);
  if (path === "/api/telegram/connect") {
    if (limited(request, "connect", 10, 10 * 60e3)) return json(env, request, { ok: false, message: "Too many tries. Please wait a few minutes." }, 429);
    const bot = String(env.TELEGRAM_BOT_USERNAME || "");
    if (!/^[A-Za-z0-9_]{3,64}$/.test(bot)) return json(env, request, { ok: false, message: "Telegram is not set up yet (bot username missing)." }, 503);
    const token = randomToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
    await createDoc(env, env.APPWRITE_TG_CONNECTIONS_COLLECTION_ID, (await sha256Hex(token)).slice(0, 32), { userId: sellerId, expiresAt, used: false, createdAt: new Date().toISOString() });
    return json(env, request, { ok: true, deepLink: `https://t.me/${bot}?start=${token}`, expiresAt, expiresInSec: TOKEN_TTL_MS / 1000 });
  }
  const profile = await profileOf(env, sellerId);
  if (!profile) return json(env, request, { ok: false, message: "Account not found." }, 404);
  const connected = profile.telegramConnected === true && !!profile.telegramChatID;
  if (path === "/api/telegram/status") return json(env, request, { ok: true, connected });
  if (path === "/api/telegram/disconnect") {
    if (connected) await sendTelegram(env, profile.telegramChatID, "Telegram notifications for your X-Redro store are switched off. You can connect again any time from Settings.");
    await markDisconnected(env, sellerId);
    return json(env, request, { ok: true, connected: false });
  }
  if (path === "/api/telegram/test") {
    if (!connected) return json(env, request, { ok: false, message: "Telegram is not connected." }, 409);
    if (limited(request, "test", 6, 10 * 60e3)) return json(env, request, { ok: false, message: "Too many tests. Please wait a few minutes." }, 429);
    const r = await sendTelegram(env, profile.telegramChatID, "✅ TEST NOTIFICATION\n\nThis is a test from X-Redro. If you can read this, Telegram notifications are working.");
    if (r.blocked) { await markDisconnected(env, sellerId); return json(env, request, { ok: false, code: "blocked", message: "Telegram says this chat can't receive messages (the bot may have been blocked). Please connect again." }, 409); }
    if (!r.ok) return json(env, request, { ok: false, message: "Telegram could not be reached. Please try again in a moment." }, 502);
    return json(env, request, { ok: true });
  }
  return json(env, request, { ok: false, message: "Not found." }, 404);
}

/* ---------------- order notifications ---------------- */
function formFieldsOf(order) {
  return (Array.isArray(order.formData) ? order.formData : []).map(v => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch (e) { return null; } }).filter(e => e && typeof e === "object");
}
function orderLabel(order) { return order.publicOrderID ? String(order.publicOrderID) : String(order.$id).slice(-8).toUpperCase(); }
function customerName(order) {
  const f = formFieldsOf(order).filter(e => e.type !== "product" && e.type !== "additional_fee" && typeof e.value === "string" && e.value.trim());
  const named = f.find(e => /name/i.test(String(e.label || "")) && e.type !== "payment_account_name") || f.find(e => e.type === "text");
  return named ? named.value.trim().slice(0, 60) : "Customer";
}
function itemCount(order) {
  let n = 0;
  formFieldsOf(order).forEach(e => { if (e.type === "product" && Array.isArray(e.value)) e.value.forEach(p => { n += Math.max(0, Math.floor(Number(p && p.qty) || 0)); }); });
  return n;
}
function paymentStatus(order) {
  const s = String(order.status || "pending").toLowerCase();
  if (s === "paid" || s === "delivered") return "Paid";
  return order.paymentProof ? "Payment proof received" : "Unpaid";
}
const reviewTrusted = (r, order) => r && r.orderID === order.$id && r.sellerID === order.userId &&
  (Array.isArray(r.$permissions) ? r.$permissions : []).some(p => /^update\(/.test(p) && p.indexOf("user:" + order.userId) !== -1);

async function latestTotal(env, order) {   // what the order costs now: the newest update the seller did not reject
  let total = money(order.totalAmount);
  try {
    const ups = (await listDocs(env, env.APPWRITE_UPDATES_COLLECTION_ID, [Q.equal("orderID", order.$id), Q.limit(100)])).filter(u => u.sellerID === order.userId).sort((a, b) => Number(a.seq) - Number(b.seq));
    const revs = (await listDocs(env, env.APPWRITE_REVIEWS_COLLECTION_ID, [Q.equal("orderID", order.$id), Q.limit(100)])).filter(r => reviewTrusted(r, order));
    ups.forEach(u => { const rejected = revs.some(r => r.updateID === (u.updateID || u.$id) && r.decision === "rejected"); if (!rejected) total = money(u.newTotal); });
  } catch (e) { /* fall back to the original total */ }
  return total;
}
const fresh = iso => Date.now() - Date.parse(iso) < EVENT_WINDOW_MS && Date.now() - Date.parse(iso) > -60e3;
const link = env => (/^https?:\/\//.test(env.DASHBOARD_URL || "") ? "\n" + env.DASHBOARD_URL : "");
const tail = env => "\n\nOpen your X-Redro dashboard to view the order." + link(env);

/* Checks the event really happened, recently, for this order, and builds the message from SAVED data. Returns { skip } or { key, text }. */
async function buildEvent(env, event, order, refId) {
  const label = "#" + orderLabel(order), who = customerName(order);
  if (event === "new_order") {
    if (!fresh(order.$createdAt)) return { skip: "too old" };
    return { key: `new_order:${order.$id}`, text: `🔔 NEW ORDER RECEIVED\n\nYou have received a new order on X-Redro!\n\nOrder ID: ${label}\nCustomer: ${who}\nItems: ${itemCount(order)}\nTotal: ${naira(order.totalAmount)}\nPayment Status: ${paymentStatus(order)}` + tail(env) };
  }
  if (event === "order_updated") {
    if (!refId) return { skip: "missing update" };
    const u = await maybeDoc(env, env.APPWRITE_UPDATES_COLLECTION_ID, refId);
    if (!u || u.orderID !== order.$id || u.sellerID !== order.userId || !fresh(u.$createdAt)) return { skip: "no such recent update" };
    const changes = (() => { try { return JSON.parse(u.changes || "[]"); } catch (e) { return []; } })();
    const info = (() => { try { return JSON.parse(u.infoChanges || "[]"); } catch (e) { return []; } })();
    const proofs = (() => { try { return JSON.parse(u.paymentProof || "[]"); } catch (e) { return []; } })();
    const meaningful = changes.length > 0 || info.length > 0 || proofs.length > 0 || money(u.newTotal) !== money(u.previousTotal);
    if (!meaningful) return { skip: "nothing changed" };
    const extra = (proofs.length ? `\nPayment evidence attached: ${proofs.length}` : "");
    return { key: `order_updated:${order.$id}:${u.$id}`, text: `🔄 ORDER UPDATED\n\nAn existing order has been updated.\n\nOrder ID: ${label}\nCustomer: ${who}\nPrevious Total: ${naira(u.previousTotal)}\nNew Total: ${naira(u.newTotal)}${extra}` + "\n\nOpen your X-Redro dashboard to view the changes." + link(env) };
  }
  if (event === "order_cancelled") {
    if (String(order.status).toLowerCase() !== "cancelled" || !fresh(order.$updatedAt)) return { skip: "not cancelled" };
    return { key: `order_cancelled:${order.$id}:${order.$updatedAt}`, text: `❌ ORDER CANCELLED\n\nOrder ID: ${label}\nCustomer: ${who}\n\nThis order has been cancelled.` };
  }
  if (event === "additional_payment") {
    if (!refId) return { skip: "missing payment" };
    const r = await maybeDoc(env, env.APPWRITE_REVIEWS_COLLECTION_ID, refId);
    if (!r || !reviewTrusted(r, order) || r.decision !== "payment_verified" || !(money(r.amount) > 0) || !fresh(r.$createdAt)) return { skip: "no such recent payment" };
    return { key: `additional_payment:${order.$id}:${r.$id}`, text: `💰 ADDITIONAL PAYMENT UPDATE\n\nOrder ID: ${label}\nCustomer: ${who}\nAmount Received: ${naira(r.amount)}\nUpdated Order Total: ${naira(await latestTotal(env, order))}\n\nOpen X-Redro to view the payment details.` + link(env) };
  }
  return { skip: "unknown event" };
}

/* "notify": anyone's browser may call this, so it can never be used to say anything of its own.
   The caller names an event and an order; the Worker re-reads the order from Appwrite, finds the order's own seller,
   checks the event genuinely happened in the last 10 minutes, and sends the message the Worker wrote itself, once. */
async function handleNotify(request, env) {
  if (limited(request, "notify", 30, 60e3)) return json(env, request, { ok: false }, 429);
  let body; try { body = await request.json(); } catch (e) { return json(env, request, { ok: false }, 400); }
  const event = String(body && body.event || ""), orderId = String(body && body.orderId || ""), refId = body && body.refId != null ? String(body.refId) : "";
  if (EVENTS.indexOf(event) === -1 || !ID_RE.test(orderId) || (refId && !ID_RE.test(refId))) return json(env, request, { ok: false }, 400);
  // From here on the answer is always 202: the page that called us must never be able to tell a hit from a miss, and must never fail because of us.
  const done = (sent, reason) => json(env, request, { ok: true, sent: !!sent, reason: reason || "" }, 202);
  try {
    const order = await maybeDoc(env, env.APPWRITE_ORDERS_COLLECTION_ID, orderId);
    if (!order || !ID_RE.test(String(order.userId || ""))) return done(false, "unknown");
    const profile = await profileOf(env, order.userId);                       // the seller's chat comes from Appwrite, never from the request
    if (!profile || profile.telegramConnected !== true || !profile.telegramChatID) return done(false, "not connected");
    const ev = await buildEvent(env, event, order, refId);
    if (ev.skip) return done(false, ev.skip);

    // once per event: the record is created BEFORE sending, so two copies of the same call cannot both send
    const eventId = (await sha256Hex(ev.key)).slice(0, 32);
    let attempts = 1;
    try {
      await createDoc(env, env.APPWRITE_TG_EVENTS_COLLECTION_ID, eventId, { event, orderId, userId: order.userId, status: "sending", attempts: 1, createdAt: new Date().toISOString() });
    } catch (e) {
      if (e.status !== 409) throw e;
      const prev = await getDoc(env, env.APPWRITE_TG_EVENTS_COLLECTION_ID, eventId);
      const age = Date.now() - Date.parse(prev.$updatedAt || prev.createdAt);
      if (prev.status === "sent" || prev.status === "blocked" || (prev.status === "sending" && age < SENDING_LOCK_MS) || Number(prev.attempts) >= MAX_ATTEMPTS) return done(false, "already handled");
      attempts = Number(prev.attempts) + 1;
      await patchDoc(env, env.APPWRITE_TG_EVENTS_COLLECTION_ID, eventId, { status: "sending", attempts });
    }
    const r = await sendTelegram(env, profile.telegramChatID, ev.text);
    const status = r.ok ? "sent" : r.blocked ? "blocked" : "failed";
    await patchDoc(env, env.APPWRITE_TG_EVENTS_COLLECTION_ID, eventId, { status, attempts }).catch(() => {});
    if (r.blocked) await markDisconnected(env, order.userId);                  // blocked the bot: stop sending, nothing else changes
    if (!r.ok) log("error", "telegram not delivered", { event, status, attempts });
    return done(r.ok, r.ok ? "" : status);
  } catch (e) {
    log("error", "notify failed", { event, status: e.status, message: String(e.message).slice(0, 120) });
    return done(false, "error");
  }
}

/* ---------------- router ---------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (request.method === "OPTIONS") {
      const o = allowedOrigin(env, request);
      if (!o.ok) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": o.origin || "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, authorization", "access-control-max-age": "600", "vary": "Origin" } });
    }
    if (path === "/" && request.method === "GET") return new Response(JSON.stringify({ ok: true, service: "xredro-telegram" }), { status: 200, headers: { "content-type": "application/json" } });
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    if (path === "/telegram/webhook") return handleWebhook(request, env);
    if (path.startsWith("/api/")) {
      if (!allowedOrigin(env, request).ok) return new Response(JSON.stringify({ ok: false, message: "Origin not allowed." }), { status: 403, headers: { "content-type": "application/json" } });
      try {
        if (path === "/api/notify") return await handleNotify(request, env);
        if (/^\/api\/telegram\/(connect|status|test|disconnect)$/.test(path)) return await handleSeller(path, request, env);
      } catch (e) {
        log("error", "request failed", { path, status: e.status, message: String(e.message).slice(0, 120) });
        return json(env, request, { ok: false, message: "Something went wrong. Please try again." }, 500);
      }
    }
    return new Response("not found", { status: 404 });
  }
};
