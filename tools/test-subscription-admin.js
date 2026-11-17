// Run from project root: node tools/test-subscription-admin.js
// Tests the subscription-admin Function (existing Function, extended to keep remaining time) against an in-memory fake of Appwrite.
const Module = require("module");
let failed = 0;
const a = (c, m) => { if (!c) failed++; console.log(c ? "ok  " : "FAIL", m); };
const store = { users: {}, subscriptions: {} };
let n = 0;
const fake = {
  Client: class { setEndpoint() { return this; } setProject() { return this; } setKey() { return this; } },
  ID: { unique: () => "s" + (++n) },
  Query: { equal: (attr, val) => ({ attr, val }), orderDesc: attr => ({ ord: attr }), limit: x => ({ limit: x }) },
  Databases: class {
    async getDocument(db, col, id) { const d = store[col === "u" ? "users" : "subscriptions"][id]; if (!d) throw new Error("nf"); return d; }
    async listDocuments(db, col, q) {
      const key = col === "u" ? "users" : "subscriptions";
      let docs = Object.values(store[key]).filter(d => q.filter(x => x.attr).every(c => d[c.attr] === c.val));
      const ord = q.find(x => x.ord); if (ord) docs.sort((x, y) => String(y[ord.ord]).localeCompare(String(x[ord.ord])));
      const lim = q.find(x => x.limit); return { documents: docs.slice(0, lim ? lim.limit : 25) };
    }
    async createDocument(db, col, id, data) { store.subscriptions[id] = Object.assign({ $id: id }, data); return store.subscriptions[id]; }
    async updateDocument(db, col, id, data) { Object.assign(store.subscriptions[id], data); return store.subscriptions[id]; }
  }
};
const orig = Module._load; Module._load = function (r, ...x) { return r === "node-appwrite" ? fake : orig.call(this, r, ...x); };
Object.assign(process.env, { APPWRITE_FUNCTION_API_ENDPOINT: "http://x", APPWRITE_FUNCTION_PROJECT_ID: "p", XREDRO_ADMIN_API_KEY: "k", XREDRO_USERS_COLLECTION_ID: "u", XREDRO_SUBSCRIPTIONS_COLLECTION_ID: "subs" });
const main = require("../appwrite-functions/subscription-admin/src/main.js");
const call = async body => { let out; await main({ req: { bodyJson: body }, res: { json: (o, s) => { out = { body: o, status: s || 200 }; } }, log() {}, error() {} }); return out; };
const DAY = 86400000;
store.users.p1 = { $id: "p1", userId: "u1", email: "a@x.com", username: "Ada" };
const days = ms => Math.round(ms / DAY * 100) / 100;

(async () => {
  let r = await call({ action: "findUser", email: "a@x.com" });
  a(r.status === 200 && r.body.user.userId === "u1" && r.body.subscription === null, "findUser: no plan running -> subscription null");
  r = await call({ action: "activate", userId: "u1", plan: "weekly", days: 7 });
  a(r.status === 200 && !r.body.extended && r.body.remainingMs === 0 && days(Date.parse(r.body.subscription.expiresAt) - Date.now()) === 7, "no plan running: 7 days from now");
  const first = Object.values(store.subscriptions)[0];
  a(first.plan === "weekly" && first.durationDay === 7 && first.status === "active", "plan stored as requested");

  // 3 days left, then buy weekly: ends in 10 days, plan text stays "weekly"/7
  Object.values(store.subscriptions).forEach(s => { s.expiresAt = new Date(Date.now() + 3 * DAY).toISOString(); });
  r = await call({ action: "findUser", email: "a@x.com" });
  a(r.body.subscription && r.body.subscription.plan === "weekly" && days(Date.parse(r.body.subscription.expiresAt) - Date.now()) === 3, "findUser reports the running plan");
  r = await call({ action: "activate", userId: "u1", plan: "weekly", days: 7 });
  a(r.body.extended === true && days(r.body.remainingMs) === 3 && days(Date.parse(r.body.subscription.expiresAt) - Date.now()) === 10, "3 days left + weekly: ends in 10 days");
  const subs = Object.values(store.subscriptions);
  const fresh = subs.find(s => s.$id === r.body.subscription.id);
  a(fresh.plan === "weekly" && fresh.durationDay === 7 && fresh.status === "active" && subs.filter(s => s.status === "active").length === 1, "plan description as requested; older record retired");

  // hours left, then monthly
  subs.forEach(s => { s.expiresAt = new Date(Date.now() + 5 * 3600e3).toISOString(); s.status = "active"; });
  r = await call({ action: "activate", userId: "u1", plan: "monthly", days: 30 });
  a(r.body.extended && Math.abs(Date.parse(r.body.subscription.expiresAt) - Date.now() - (30 * DAY + 5 * 3600e3)) < 5000 && r.body.subscription.plan === "monthly", "5 hours left + monthly: 30 days and 5 hours");

  // expired plan: starts from now
  Object.values(store.subscriptions).forEach(s => { s.expiresAt = new Date(Date.now() - 2 * DAY).toISOString(); s.status = "active"; });
  r = await call({ action: "activate", userId: "u1", plan: "weekly", days: 7 });
  a(!r.body.extended && days(Date.parse(r.body.subscription.expiresAt) - Date.now()) === 7, "expired plan: counts from now, nothing added");
  r = await call({ action: "findUser", email: "a@x.com" });
  const live = Object.values(store.subscriptions).filter(s => s.status === "active" && Date.parse(s.expiresAt) > Date.now());
  a(live.length === 1, "exactly one running plan after all that");

  // validation unchanged
  a((await call({ action: "activate", userId: "u1", plan: "weekly", days: 8 })).status === 400, "weekly must be 7 days");
  a((await call({ action: "activate", userId: "u1", plan: "custom-45-days", days: 45 })).status === 200, "custom days still work");
  a((await call({ action: "activate", userId: "nobody", plan: "weekly", days: 7 })).status === 404, "unknown account refused");
  a((await call({ action: "findUser", email: "bad" })).status === 400, "bad email refused");
  console.log(failed ? `\n${failed} FAILED` : "\nall passed"); process.exit(failed ? 1 : 0);
})();
