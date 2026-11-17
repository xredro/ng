// Run from project root: node tools/test-order-logic.js
const L = require("../js/order-logic.js");
const crypto = require("crypto");
let failed = 0;
const a = (c, m) => { if (!c) failed++; console.log(c ? "ok  " : "FAIL", m); };

// ---- Public Order ID ----
const ids = new Set();
for (let i = 0; i < 2000; i++) ids.add(L.generatePublicId(n => crypto.randomInt(n)));
a(ids.size === 2000 && [...ids].every(x => x.length === 12 && L.isValidIdShape(x)), "2000 generated IDs: 12 characters, valid, no repeats");
a([...ids].every(x => !/[01OILU]/.test(x)), "no look-alike characters");
a(!L.isValidIdShape("X7KM92PQ4L8N") && !L.isValidIdShape("X7KM92PQ4U8N") && !L.isValidIdShape("X7KM92PQ4O8N"), "IDs with look-alike letters are rejected");
a(L.isValidIdShape("X7KM92PQ4N8Z") && L.isValidIdShape("x7km-92pq-4n8z") && L.normalizeId(" x7km 92pq 4n8z ") === "X7KM92PQ4N8Z", "typed loosely (case, spaces, dashes) still works");
a(!L.isValidIdShape("X7KM92PQ4N8") && !L.isValidIdShape("") && !L.isValidIdShape(null) && !L.isValidIdShape("X7KM92PQ4N8ZZ"), "wrong length rejected");
a(L.spacedId("X7KM92PQ4N8Z") === "X7KM 92PQ 4N8Z", "readable grouping");

// ---- fixtures ----
const raw = [
  { label: "Full name", type: "text", value: "Ada" }, { label: "Phone", type: "text", value: "0801" },
  { label: "Items", type: "product", value: [{ name: "Bag", description: "", qty: 2, price: 10000 }] },
  { label: "Delivery", type: "additional_fee", value: "Lagos" }, { label: "Name on payment", type: "payment_account_name", value: "Ada O" }
].map(JSON.stringify);
const order = { $id: "ord1", userId: "seller1", formData: raw, totalAmount: 23000, status: "pending", publicOrderID: "X7KM92PQ4N8Z" }; // 20000 + 3000 delivery
const fields = [{ label: "Full name", type: "text" }, { label: "Phone", type: "text" }, { label: "City", type: "dropdown", options: ["Lagos", "Abuja"] },
  { label: "Items", type: "product", products: [{ name: "Bag", price: 10000 }, { name: "Shoe", price: 15000 }, { name: "Cap", price: 2000 }, { name: "Ring", price: 900, soldOut: true }] }];
const catalog = L.catalogOf(fields);
a(catalog.length === 4 && catalog[3].soldOut === true, "catalog read from the store's fields");
const perm = u => ['read("any")', 'update("user:' + u + '")', 'delete("user:' + u + '")'];
let seqN = 0, t = 0;
const mkUpdate = (plan, extra) => Object.assign({ $id: "u" + plan.record.seq, updateID: "u" + plan.record.seq, $createdAt: "2026-11-10T10:0" + (t++) + ":00Z" }, plan.record, extra || {});
const review = (o) => Object.assign({ $id: "r" + (++seqN), $createdAt: "2026-11-10T11:0" + (t++) + ":00Z", orderID: "ord1", sellerID: "seller1", amount: 0, note: "", verified: "[]", $permissions: perm("seller1") }, o);

// ---- effective order, the spec's example sequence ----
let eff = L.replay(order, [], [], catalog, fields);
a(eff.total === 23000 && eff.fees === 3000 && eff.due === 23000 && eff.lastSeq === 0, "no updates: effective order is the original");

const step = (e, req, extras) => { const p = L.planUpdate(order, e, catalog, fields, req, extras); return p; };
let p1 = step(eff, { items: [{ label: "Items", name: "Bag", qty: 3 }] });
a(p1.ok && p1.newTotal === 33000 && p1.record.additionalAmount === 10000 && p1.record.seq === 1 && p1.record.orderSeq === "ord1:1", "update 1: add a bag -> 33,000, +10,000, sequence 1");
const u1 = mkUpdate(p1);
eff = L.replay(order, [u1], [], catalog, fields);
a(eff.total === 33000 && eff.items[0].qty === 3 && eff.pending === 1 && eff.due === 33000, "effective order after update 1 (pending counts for the customer)");
let p2 = step(eff, { items: [{ label: "Items", name: "Shoe", qty: 1 }] });
a(p2.ok && p2.newTotal === 48000 && p2.record.seq === 2, "update 2: add a shoe -> 48,000");
const u2 = mkUpdate(p2);
eff = L.replay(order, [u1, u2], [], catalog, fields);
let p3 = step(eff, { items: [{ label: "Items", name: "Bag", qty: 2 }] });
a(p3.ok && p3.newTotal === 38000 && p3.record.additionalAmount === -10000, "update 3: back to 2 bags -> 38,000, -10,000");
const u3 = mkUpdate(p3);
eff = L.replay(order, [u3, u1, u2], [], catalog, fields); // given out of order on purpose
a(eff.total === 38000 && eff.steps.map(s => s.seq).join() === "1,2,3" && eff.lastSeq === 3, "three updates replayed in sequence order");

// ---- price integrity ----
const forged = mkUpdate(p1, { newTotal: 1, previousTotal: 1, updatedItems: JSON.stringify([{ label: "Items", name: "Bag", qty: 3, price: 1 }]) });
eff = L.replay(order, [forged], [], catalog, fields);
a(eff.total === 33000 && eff.steps[0].flags.some(f => /not what the store's prices give/.test(f)), "forged total/price in the update document is ignored and flagged");
const cheap = mkUpdate(p1, { changes: JSON.stringify([{ label: "Items", name: "Shoe", qty: 2 }]) });
eff = L.replay(order, [cheap], [], [{ label: "Items", name: "Shoe", price: 15000 }, catalog[0]], fields);
a(eff.total === 23000 + 30000, "new lines always use the store's price");
eff = L.replay(order, [cheap], [], [catalog[0]], fields);
a(eff.total === 23000 && eff.steps[0].flags.length > 0, "a product the store doesn't sell is ignored");
eff = L.replay(order, [mkUpdate(p1, { changes: JSON.stringify([{ label: "Items", name: "Ring", qty: 1 }]) })], [], catalog, fields);
a(eff.total === 23000 && eff.steps[0].flags.some(f => /sold out/.test(f)), "a sold-out product in a stored update is ignored");
eff = L.replay(order, [mkUpdate(p1, { changes: JSON.stringify([{ label: "Items", name: "Bag", qty: 0 }]) })], [], catalog, fields);
a(eff.total === 23000 && eff.items.length === 1 && eff.steps[0].flags.some(f => /emptied/.test(f)), "an update that would empty the order is ignored");
eff = L.replay(order, [mkUpdate(p1, { changes: JSON.stringify([{ label: "Items", name: "Bag", qty: -5 }, { label: "Items", name: "Bag", qty: 1e9 }, { label: "Items", name: "Bag", qty: "x" }]) })], [], catalog, fields);
a(eff.total === 23000, "junk quantities in a stored update are ignored");
const foreign = [mkUpdate(p1, { orderID: "other" }), mkUpdate(p1, { sellerID: "seller2" })];
a(L.replay(order, foreign, [], catalog, fields).total === 23000, "updates for another order or seller are ignored");

// ---- customer rules when planning ----
eff = L.replay(order, [], [], catalog, fields);
a(!step(eff, { items: [{ label: "Items", name: "Ring", qty: 1 }] }).ok, "customer can't add a sold-out product");
a(!step(eff, { items: [{ label: "Items", name: "Nope", qty: 1 }] }).ok, "customer can't add an unknown product");
a(!step(eff, { items: [{ label: "Items", name: "Bag", qty: 0 }] }).ok, "customer can't remove every product");
a(!step(eff, { items: [] }).ok && /nothing/i.test(step(eff, { items: [] }).message), "no change refused");
for (const bad of [-1, 1.5, 1000, "x", null, [], true]) a(!step(eff, { items: [{ label: "Items", name: "Bag", qty: bad }] }).ok, "bad quantity refused: " + JSON.stringify(bad));
let pi = step(eff, { info: { Phone: "0802", City: "Lagos" } });
a(!pi.ok, "City isn't on the order, so it can't be changed");
pi = step(eff, { info: { Phone: "0802" } });
a(pi.ok && pi.record.changeType === "info" && pi.newTotal === 23000 && JSON.parse(pi.record.infoChanges)[0].from === "0801", "contact details can change; total doesn't");
a(!step(eff, { info: { "Name on payment": "x" } }).ok && !step(eff, { info: { Phone: " " } }).ok, "payment fields and empty values refused");
const ui = mkUpdate(pi); eff = L.replay(order, [ui], [], catalog, fields);
a(eff.info.find(e => e.label === "Phone").value === "0802" && eff.info.find(e => e.label === "Phone").original === "0801", "effective details show the new phone; the original is kept");
a(L.parseFormData(order.formData).find(e => e.label === "Phone").value === "0801", "the original order document is never changed");
const pExtra = L.planUpdate(order, L.replay(order, [], [], catalog, fields), catalog, fields, { items: [{ label: "Items", name: "Cap", qty: 1 }] }, { proofs: ["f1", "f2"], payName: "Ada", payDate: "2026-11-10", note: "hi" });
a(pExtra.record.paymentStatus === "submitted" && JSON.parse(pExtra.record.paymentProof).length === 2 && pExtra.record.updateStatus === "pending", "payment evidence recorded on the update; status starts pending");

// ---- seller reviews ----
eff = L.replay(order, [u1, u2], [review({ decision: "rejected", updateID: "u1", note: "Out of that bag" })], catalog, fields);
a(eff.steps[0].status === "rejected" && eff.steps[0].counted === false && eff.steps[1].status === "pending", "rejected update is shown but not counted");
a(eff.total === 23000 + 15000 && eff.items.length === 2, "rejecting update 1 removes only its own changes");
a(eff.steps[1].flags.some(f => /different version/.test(f)), "later update flagged as made against another version");
eff = L.replay(order, [u1], [review({ decision: "approved", updateID: "u1" })], catalog, fields);
a(eff.steps[0].status === "approved" && eff.pending === 0 && eff.approvedItems[0].qty === 3, "approved update counts toward what to deliver");
eff = L.replay(order, [u1], [], catalog, fields);
a(eff.approvedItems[0].qty === 2, "pending update does not count toward what to deliver");
const fake = review({ decision: "approved", updateID: "u1", $permissions: ['read("any")', 'update("user:attacker")'] });
const fake2 = review({ decision: "approved", updateID: "u1", $permissions: ['read("any")'] });
const fake3 = review({ decision: "approved", updateID: "u1", sellerID: "attacker", $permissions: perm("attacker") });
eff = L.replay(order, [u1], [fake, fake2, fake3], catalog, fields);
a(eff.steps[0].status === "pending", "reviews not created by the seller are ignored");
a(L.reviewIsTrusted(review({ decision: "approved" }), order) && !L.reviewIsTrusted(review({ orderID: "other" }), order), "review trust check");

// ---- payments ----
const paidOrder = Object.assign({}, order, { status: "paid" });
eff = L.replay(paidOrder, [u1], [], catalog, fields);
a(eff.paid === 23000 && eff.due === 10000, "paid order + update: only the extra is due");
eff = L.replay(paidOrder, [u1], [review({ decision: "payment_verified", updateID: "u1", amount: 10000 })], catalog, fields);
a(eff.paid === 33000 && eff.due === 0, "extra payment verified by the seller clears the amount due");
eff = L.replay(paidOrder, [u1], [review({ decision: "payment_verified", updateID: "u1", amount: 4000 })], catalog, fields);
a(eff.due === 6000, "partial extra payment leaves the rest due");
eff = L.replay(paidOrder, [mkUpdate(L.planUpdate(paidOrder, L.replay(paidOrder, [], [], catalog, fields), catalog, fields, { items: [{ label: "Items", name: "Bag", qty: 1 }] }))], [], catalog, fields);
a(eff.total === 13000 && eff.credit === 10000 && eff.due === 0, "total goes down on a paid order: credit shown, nothing automatic");
eff = L.replay(order, [u1], [review({ decision: "payment_verified", updateID: "u1", amount: 10000, $permissions: ['read("any")'] })], catalog, fields);
a(eff.paid === 0, "a payment 'verification' not created by the seller counts for nothing");

// ---- review planning ----
let pr = L.planReview(order, { decision: "card_reissued", verified: ["pay_name"] });
a(!pr.ok && /at least 2/.test(pr.message), "reissuing a card needs two checks");
pr = L.planReview(order, { decision: "id_replaced", verified: ["pay_name", "phone", "phone"], note: "Called the number on the order" });
a(pr.ok && JSON.parse(pr.record.verified).length === 2 && pr.record.sellerID === "seller1" && !JSON.stringify(pr.record).includes("X7KM"), "replacement recorded with its checks, never with an ID");
a(!L.planReview(order, { decision: "payment_verified", updateID: "u1", amount: 0 }).ok && !L.planReview(order, { decision: "banana" }).ok, "bad reviews refused");
a(L.replay(order, [], [review({ decision: "id_replaced", verified: '["pay_name","phone"]' })], catalog, fields).audit[0].decision === "id_replaced", "reissues appear in the audit list");


// ---- Phase 10: a change the seller makes for the customer ----
const base = L.replay(paidOrder, [], [], catalog, fields);
const sreq = { items: [{ label: "Items", name: "Shoe", qty: 1 }] };
let sp = L.planSellerUpdate(paidOrder, base, catalog, fields, sreq, { verified: ["pay_name"], note: "x" });
a(!sp.ok && /at least 2/.test(sp.message), "seller change needs two checks with the customer");
sp = L.planSellerUpdate(paidOrder, base, catalog, fields, sreq, { verified: ["pay_name", "bogus"] });
a(!sp.ok, "unknown check refused");
sp = L.planSellerUpdate(paidOrder, base, catalog, fields, sreq, { verified: ["pay_name", "phone"], note: "Called" });
a(sp.ok && sp.newTotal === 38000 && sp.record.additionalAmount === 15000 && sp.verified.length === 2, "seller adds a shoe: total 38,000, +15,000, checks kept");
a(!L.planSellerUpdate(paidOrder, base, catalog, fields, { items: [{ label: "Items", name: "Ring", qty: 1 }] }, { verified: ["pay_name", "phone"] }).ok, "seller can't add a sold-out product either");
a(!L.planSellerUpdate(paidOrder, base, catalog, fields, { items: [{ label: "Items", name: "Bag", qty: 0 }] }, { verified: ["pay_name", "phone"] }).ok, "seller can't empty the order (cancel instead)");
a(!L.planSellerUpdate(Object.assign({}, order, { status: "cancelled" }), L.replay(order, [], [], catalog, fields), catalog, fields, sreq, { verified: ["pay_name", "phone"] }).ok, "a cancelled order can't be changed");
a(!L.planSellerUpdate(Object.assign({}, order, { status: "delivered" }), L.replay(order, [], [], catalog, fields), catalog, fields, sreq, { verified: ["pay_name", "phone"] }).ok, "a delivered order can't be changed");
const custUpd = mkUpdate(L.planUpdate(paidOrder, base, catalog, fields, { items: [{ label: "Items", name: "Cap", qty: 1 }] }), { $permissions: ['read("any")'] });
const effPend = L.replay(paidOrder, [custUpd], [], catalog, fields);
a(!L.planSellerUpdate(paidOrder, effPend, catalog, fields, sreq, { verified: ["pay_name", "phone"] }).ok, "waiting customer update must be decided first");
const sellerUpd = mkUpdate(sp.record ? sp : sp, { $permissions: perm("seller1") });
const effS = L.replay(paidOrder, [sellerUpd], [review({ decision: "approved", updateID: "u1", verified: '["pay_name","phone"]', note: "Called" })], catalog, fields);
a(effS.steps[0].bySeller === true && effS.steps[0].status === "approved" && effS.steps[0].checks.length === 2, "seller-made update is recognised, approved, checks shown");
a(effS.approvedItems.some(i => i.name === "Shoe") && effS.total === 38000 && effS.due === 15000, "approved seller change is delivered and the extra stays unpaid until the seller records it");
const guestFake = L.replay(paidOrder, [mkUpdate(sp, { $permissions: ['read("any")'] })], [], catalog, fields);
a(guestFake.steps[0].bySeller === false && guestFake.steps[0].status === "pending", "a guest can't pass an update off as the seller's");
a(L.updateIsBySeller(sellerUpd, paidOrder) && !L.updateIsBySeller(sellerUpd, Object.assign({}, paidOrder, { userId: "someone" })), "seller role must belong to this order's own seller");

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
