// Stand-in for the Appwrite web SDK with a REAL in-memory database, for the order flow checks.
// Seeded from window.__SEED = { collectionId: [docs...] }. Emulates what matters for Phases 8 to 10:
//   Query.equal / orderAsc / orderDesc / limit / cursorAfter, unique indexes (409), unknown attributes (400),
//   missing collections (404), and "a guest can only grant any/guests permissions" (401).
(function () {
  const later = v => new Promise(r => setTimeout(() => r(v), 15));
  const clone = v => JSON.parse(JSON.stringify(v));
  const Query = {
    equal: (a, v) => ({ m: "equal", a, v: Array.isArray(v) ? v : [v] }), orderAsc: a => ({ m: "orderAsc", a }), orderDesc: a => ({ m: "orderDesc", a }),
    limit: n => ({ m: "limit", n }), cursorAfter: id => ({ m: "cursorAfter", id })
  };
  const SEED = window.__SEED || {};
  const DB = {};
  Object.keys(SEED).forEach(c => { DB[c] = clone(SEED[c]); });
  window.__DB = DB;
  const UNIQUE = { orders: ["publicOrderID"], order_updates: ["orderSeq"] };
  const ALLOWED = {
    orders: ["userId", "formId", "formData", "totalAmount", "status", "paymentProof", "publicOrderID"],
    order_updates: ["updateID", "orderID", "publicOrderID", "sellerID", "seq", "orderSeq", "previousItems", "updatedItems", "changes", "infoChanges", "previousTotal", "newTotal", "additionalAmount", "changeType", "paymentProof", "paymentDetails", "paymentStatus", "updateStatus", "note", "createdAt"],
    statement_layouts: ["userId", "name", "mode", "regions", "updatedAt"],
    order_reviews: ["orderID", "updateID", "sellerID", "decision", "amount", "note", "verified", "createdAt"]
  };
  const err = (code, message, type) => Object.assign(new Error(message), { code, type });
  const missing = c => (window.__MISSING_COLLECTIONS || []).includes(c);
  const hidden = (c, k) => (window.__MISSING_ATTRS || []).includes(c + "." + k);
  let t = 0; const stamp = () => new Date(Date.now() + (++t)).toISOString();
  class Client { setEndpoint() { return this; } setProject() { return this; } }
  class Account { createJWT() { return later({ jwt: "jwt-seller1-aaaaaaaaaaaaaaaaaaaaaaaa" }); } get() { return window.__AS_GUEST ? Promise.reject(err(401, "guest")) : later({ $id: window.__USER || "seller1", email: "s@x.y", name: "Seller" }); } }
  class Databases {
    listDocuments(db, col, queries) {
      if (missing(col)) return Promise.reject(err(404, "Collection not found", "collection_not_found"));
      let docs = (DB[col] || []).slice();
      const qs = queries || [];
      qs.filter(q => q.m === "equal").forEach(q => { docs = docs.filter(d => q.v.includes(d[q.a])); });
      const ord = qs.find(q => q.m === "orderAsc" || q.m === "orderDesc");
      if (ord) docs.sort((a, b) => (a[ord.a] > b[ord.a] ? 1 : a[ord.a] < b[ord.a] ? -1 : 0) * (ord.m === "orderAsc" ? 1 : -1));
      const cur = qs.find(q => q.m === "cursorAfter");
      if (cur) { const i = docs.findIndex(d => d.$id === cur.id); docs = docs.slice(i + 1); }
      const lim = qs.find(q => q.m === "limit");
      if (col === "orders" && window.__GUEST_CANNOT_LIST && window.__AS_GUEST) return Promise.reject(err(401, "not authorized"));
      return later({ documents: clone(docs.slice(0, lim ? lim.n : 25)), total: docs.length });
    }
    getDocument(db, col, id) {
      if (missing(col)) return Promise.reject(err(404, "Collection not found", "collection_not_found"));
      const d = (DB[col] || []).find(x => x.$id === id);
      return d ? later(clone(d)) : Promise.reject(err(404, "Document not found"));
    }
    createDocument(db, col, id, data, perms) {
      if (missing(col)) return Promise.reject(err(404, "Collection not found", "collection_not_found"));
      (window.__creates = window.__creates || []).push({ col, id, data: clone(data), perms });
      if (window.__FORCE_409_ORDER_ONCE && col === "orders") { window.__FORCE_409_ORDER_ONCE = false; return Promise.reject(err(409, "Document with the requested unique attributes already exists")); }
      if (window.__FORCE_409_ONCE && col === "order_updates") { window.__FORCE_409_ONCE = false; return Promise.reject(err(409, "Document with the requested unique attributes already exists")); }
      const allowed = ALLOWED[col];
      if (allowed) for (const k of Object.keys(data)) if (!allowed.includes(k) || hidden(col, k)) return Promise.reject(err(400, `Invalid document structure: Unknown attribute: "${k}"`, "document_invalid_structure"));
      if (window.__AS_GUEST) for (const p of perms || []) if (!/\("(any|guests)"\)$/.test(p)) return Promise.reject(err(401, "Permissions must be one of: (any, guests)"));
      for (const k of UNIQUE[col] || []) if (data[k] != null && (DB[col] || []).some(d => d[k] === data[k])) return Promise.reject(err(409, "Document with the requested unique attributes already exists"));
      const doc = Object.assign({ $id: id, $createdAt: stamp(), $updatedAt: stamp(), $permissions: perms || [] }, clone(data));
      (DB[col] = DB[col] || []).push(doc);
      return later(clone(doc));
    }
    deleteDocument(db, col, id) {
      if (missing(col)) return Promise.reject(err(404, "Collection not found", "collection_not_found"));
      const i = (DB[col] || []).findIndex(x => x.$id === id); if (i < 0) return Promise.reject(err(404, "Document not found"));
      DB[col].splice(i, 1); return later({});
    }
    updateDocument(db, col, id, data) {
      (window.__updates = window.__updates || []).push({ col, id, data: clone(data) });
      const d = (DB[col] || []).find(x => x.$id === id);
      if (!d) return Promise.reject(err(404, "Document not found"));
      if (window.__FAIL_SAVE) return Promise.reject(err(500, "network"));
      for (const k of Object.keys(data)) if (hidden(col, k)) return Promise.reject(err(400, `Invalid document structure: Unknown attribute: "${k}"`));
      for (const k of UNIQUE[col] || []) if (data[k] != null && DB[col].some(x => x.$id !== id && x[k] === data[k])) return Promise.reject(err(409, "Document with the requested unique attributes already exists"));
      Object.assign(d, clone(data), { $updatedAt: stamp() });
      return later(clone(d));
    }
  }
  // Emulation of the subscription-admin Function (the real one is tested in tools/test-subscription-admin.js)
  class Functions {
    createExecution(fid, body) {
      const b = JSON.parse(body || "{}"); const USERS = "695c501b001d24549b03";
      const out = (o, status) => later({ responseBody: JSON.stringify(o), responseStatusCode: status || 200, status: "completed", $id: "ex" });
      const DAY = 86400000;
      const running = uid => (DB.subscriptions || []).filter(x => x.userId === uid && x.status === "active" && Date.parse(x.expiresAt) > Date.now()).sort((a, c) => Date.parse(c.expiresAt) - Date.parse(a.expiresAt))[0];
      if (window.__FN_DOWN) return Promise.reject(err(500, "Function unavailable"));
      if (b.action === "findUser") {
        const u = (DB[USERS] || []).find(x => x.email === b.email);
        if (!u) return out({ ok: false, message: "No X-Redro account was found with that email." }, 404);
        const r = running(u.userId);
        return out({ ok: true, user: { userId: u.userId, email: u.email, username: u.username || "" }, subscription: r ? { plan: r.plan, expiresAt: r.expiresAt } : null });
      }
      if (b.action === "activate") {
        const r = running(b.userId); const base = r ? Date.parse(r.expiresAt) : Date.now();
        const exp = new Date(base + b.days * DAY).toISOString();
        (DB.subscriptions || []).forEach(x => { if (x.userId === b.userId && x.status === "active") x.status = "expired"; });
        const doc = { $id: "sub" + Math.random().toString(36).slice(2, 8), userId: b.userId, plan: b.plan, durationDay: b.days, startsAt: new Date().toISOString(), expiresAt: exp, status: "active" };
        DB.subscriptions.push(doc);
        const u = (DB[USERS] || []).find(x => x.userId === b.userId);
        return out({ ok: true, user: { email: u && u.email }, subscription: { id: doc.$id, plan: b.plan, days: b.days, expiresAt: exp }, extended: !!r, previousExpiresAt: r ? r.expiresAt : null, remainingMs: r ? Math.max(0, base - Date.now()) : 0 });
      }
      return out({ ok: false, message: "Unknown admin action." }, 400);
    }
  }
  let nf = 0;
  class Storage { createFile(b, id, f) { (window.__uploads = window.__uploads || []).push(f && f.name); return later({ $id: "pf" + (++nf) }); } getFileView(b, id) { return { href: "https://img.test/" + id }; } }
  const role = n => ({ r: n });
  window.Appwrite = {
    Client, Account, Databases, Storage, Functions, Query, ID: { unique: () => "id" + Math.random().toString(36).slice(2, 12) },
    Permission: { read: r => `read("${r.r}")`, update: r => `update("${r.r}")`, delete: r => `delete("${r.r}")`, write: r => `write("${r.r}")`, create: r => `create("${r.r}")` },
    Role: { any: () => role("any"), user: id => role("user:" + id), users: () => role("users"), guests: () => role("guests") }
  };
})();
