/* X-Redro order logic (Phases 8 and 9). Pure functions: no network, no DOM.
   Used by the store (js/form.js), the customer order page (js/order.js) and the seller Orders page (js/orders.js).

   Model (no server code, everything on the existing Appwrite client architecture):
   - orders           the original order, never rewritten by customers. Gets one extra field: publicOrderID.
   - order_updates    one document per customer change. Created by the customer, never edited.
   - order_reviews    one document per seller decision (approve, reject, payment received, card reissued).
                      Created by the seller, so Appwrite records the seller as its owner (see reviewIsTrusted).
   The "effective order" is never stored. It is rebuilt by replaying the updates over the original order, always against
   the store's own product prices, so a forged total or price in an update document changes nothing. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.XrOrder = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------------- Public Order ID ---------------- */
  // 30 symbols (digits 2-9 and letters without I, L, O, U): nothing that can be mistaken for something else. 12 characters = about 59 random bits.
  const ID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
  const ID_LENGTH = 12;
  const MAX_QTY = 999;
  const NON_INFO_TYPES = ["product", "additional_fee", "payment_account_name", "payment_date"];
  const EDITABLE_INFO_TYPES = ["text", "number", "textarea", "dropdown"];

  /* randomIndex(n) must return a secure random integer in [0, n). The browser passes a crypto-based one. */
  function generatePublicId(randomIndex) {
    let s = "";
    for (let i = 0; i < ID_LENGTH; i++) s += ID_ALPHABET[randomIndex(ID_ALPHABET.length)];
    return s;
  }
  function normalizeId(v) {
    return String(v == null ? "" : v).toUpperCase().replace(/[\s-]/g, "");
  }
  function isValidIdShape(v) {
    const s = normalizeId(v);
    return s.length === ID_LENGTH && s.split("").every(ch => ID_ALPHABET.indexOf(ch) !== -1);
  }
  /* shown as typed on the card: XXXX XXXX XXXX is easier to read aloud, but the ID itself has no spaces */
  const spacedId = v => String(v || "").replace(/(.{4})(?=.)/g, "$1 ");

  /* ---------------- helpers ---------------- */
  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
  function money(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const n = Number(String(value == null ? "" : value).replace(/[₦,\s]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  const fmt = n => "₦" + round2(n).toLocaleString("en-NG");
  const clip = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  function jsonOr(v, fallback) {
    if (v == null || v === "") return fallback;
    if (typeof v !== "string") return v;
    try { return JSON.parse(v); } catch (e) { return fallback; }
  }
  function parseFormData(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(v => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch (e) { return null; } })
      .filter(e => e && typeof e === "object");
  }
  const itemKey = it => String(it.label || "") + "\u0001" + String(it.name || "");

  function itemsOf(raw) {
    const out = [];
    parseFormData(raw).forEach(entry => {
      if (entry.type !== "product" || !Array.isArray(entry.value)) return;
      entry.value.forEach(p => {
        if (!p || typeof p !== "object") return;
        const qty = Math.floor(Number(p.qty) || 0);
        const name = clip(p.name, 200);
        if (!name || qty <= 0) return;
        out.push({ label: String(entry.label || ""), name, description: clip(p.description, 500), qty, price: money(p.price) });
      });
    });
    return out;
  }
  const subtotal = items => round2(items.reduce((t, it) => t + it.qty * it.price, 0));
  const compactItems = items => items.map(i => ({ label: i.label, name: i.name, qty: i.qty, price: i.price }));

  /* the store's products, from its form document's fields */
  function catalogOf(formFields) {
    const out = [];
    (Array.isArray(formFields) ? formFields : []).forEach(f => {
      let field = f;
      if (typeof f === "string") { try { field = JSON.parse(f); } catch (e) { return; } }
      if (!field || field.type !== "product" || !Array.isArray(field.products)) return;
      field.products.forEach(p => {
        if (!p || !p.name) return;
        out.push({
          label: String(field.label || ""), name: String(p.name), price: money(p.price), description: clip(p.description, 500),
          category: String(p.category || ""), imageUrl: /^https?:\/\//i.test(String(p.imageUrl || "")) ? String(p.imageUrl) : "", soldOut: p.soldOut === true || p.soldOut === "true"
        });
      });
    });
    return out;
  }
  function fieldDefs(formFields) {
    return (Array.isArray(formFields) ? formFields : []).map(f => { try { return typeof f === "string" ? JSON.parse(f) : f; } catch (e) { return null; } }).filter(Boolean);
  }

  /* customer-information entries of the original order, with later changes laid over them */
  function infoEntries(raw, formFields, overrides) {
    const defs = new Map(fieldDefs(formFields).map(f => [String(f.label), f]));
    const out = [];
    parseFormData(raw).forEach(e => {
      if (NON_INFO_TYPES.indexOf(e.type) !== -1) return;
      const def = defs.get(String(e.label));
      const type = String((def && def.type) || e.type || "text");
      const label = String(e.label || "");
      const has = overrides && Object.prototype.hasOwnProperty.call(overrides, label);
      out.push({
        label, type, value: has ? String(overrides[label]) : String(e.value == null ? "" : e.value),
        original: String(e.value == null ? "" : e.value),
        options: def && Array.isArray(def.options) ? def.options.map(String) : [],
        editable: !!def && EDITABLE_INFO_TYPES.indexOf(type) !== -1
      });
    });
    return out;
  }

  function diffItems(before, after) {
    const b = new Map(before.map(i => [itemKey(i), i]));
    const a = new Map(after.map(i => [itemKey(i), i]));
    const added = [], removed = [], changed = [];
    a.forEach((it, k) => {
      if (!b.has(k)) added.push({ label: it.label, name: it.name, qty: it.qty, price: it.price });
      else if (b.get(k).qty !== it.qty) changed.push({ label: it.label, name: it.name, from: b.get(k).qty, to: it.qty, price: it.price });
    });
    b.forEach((it, k) => { if (!a.has(k)) removed.push({ label: it.label, name: it.name, qty: it.qty, price: it.price }); });
    return { added, removed, changed };
  }
  const diffIsEmpty = d => !d.added.length && !d.removed.length && !d.changed.length;

  /* ---------------- applying one set of changes ----------------
     state: { items:[…], fees, info:{…overrides} }   changes: [{label,name,qty}] (set semantics; qty 0 removes; unlisted lines stay)
     strict=true  (customer submitting): returns { ok:false, message } at the first rule broken
     strict=false (replaying stored updates): rule breakers are skipped and reported in flags, never thrown */
  function applyChanges(items, changes, catalog, strict) {
    const cat = new Map((catalog || []).map(c => [itemKey(c), c]));
    const flags = [];
    const list = items.map(i => Object.assign({}, i));
    const find = k => list.findIndex(i => itemKey(i) === k);
    for (const raw of changes) {
      const typed = raw && (typeof raw.qty === "number" || (typeof raw.qty === "string" && raw.qty.trim() !== ""));
      const qty = typed ? Number(raw.qty) : NaN;
      const name = clip(raw && raw.name, 200), label = String((raw && raw.label) || "");
      if (!name || !Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) {
        if (strict) return { ok: false, message: "Quantities must be whole numbers from 0 to " + MAX_QTY + "." };
        flags.push("A line with an invalid quantity was ignored."); continue;
      }
      const k = itemKey({ label, name });
      const i = find(k);
      const c = cat.get(k);
      if (i !== -1) {
        if (qty > list[i].qty) {
          if (!c) { if (strict) return { ok: false, message: name + " is no longer sold in this store, so its quantity can't be increased." }; flags.push(name + " is no longer in the store; the increase was ignored."); continue; }
          if (c.soldOut) { if (strict) return { ok: false, message: name + " is sold out, so its quantity can't be increased." }; flags.push(name + " is sold out; the increase was ignored."); continue; }
        }
        if (qty === 0) list.splice(i, 1); else list[i].qty = qty; // price stays as originally ordered
      } else if (qty > 0) {
        if (!c) { if (strict) return { ok: false, message: "\"" + clip(name, 60) + "\" is not available in this store." }; flags.push(name + " is not in the store; it was ignored."); continue; }
        if (c.soldOut) { if (strict) return { ok: false, message: name + " is sold out." }; flags.push(name + " is sold out; it was ignored."); continue; }
        list.push({ label: c.label, name: c.name, description: c.description, qty, price: c.price }); // today's trusted price
      }
    }
    if (!list.length) {
      if (strict) return { ok: false, message: "An order needs at least one product. To cancel the whole order, please contact the seller." };
      return { ok: true, items: items, flags: flags.concat("This update would have emptied the order; it was ignored."), emptied: true };
    }
    return { ok: true, items: list, flags };
  }

  function applyInfo(entries, infoChanges, strict) {
    const overrides = {};
    const diff = [];
    const flags = [];
    for (const ch of Array.isArray(infoChanges) ? infoChanges : []) {
      const label = String(ch && ch.label || "");
      const e = entries.find(x => x.label === label);
      const value = clip(ch && ch.to, 500);
      let problem = "";
      if (!e || !e.editable) problem = "\"" + clip(label, 40) + "\" can't be changed here.";
      else if (!value) problem = "\"" + label + "\" can't be empty.";
      else if (e.type === "dropdown" && e.options.length && e.options.indexOf(value) === -1) problem = "Choose one of the listed options for \"" + label + "\".";
      else if (e.type === "number" && !Number.isFinite(Number(value))) problem = "\"" + label + "\" must be a number.";
      if (problem) { if (strict) return { ok: false, message: problem }; flags.push(problem); continue; }
      if (value !== e.value) { overrides[label] = value; diff.push({ label, from: e.value, to: value }); }
    }
    return { ok: true, overrides, diff, flags };
  }

  /* ---------------- reviews ---------------- */
  // The seller's decisions are stored as documents the seller created. A seller-created document always carries
  // update/delete permission for the seller's own user id; nobody else can grant that role, so we check for it.
  function reviewIsTrusted(review, order) {
    if (!review || !order || review.orderID !== order.$id || review.sellerID !== order.userId) return false;
    const perms = Array.isArray(review.$permissions) ? review.$permissions : [];
    return perms.some(p => /^update\(/.test(p) && p.indexOf("user:" + order.userId) !== -1);
  }
  // An update the seller made for the customer is created by the seller's own session, so it carries update/delete for the seller.
  // A customer's update is created by a guest and can only carry read("any"). Nobody else can grant the seller's role.
  function updateIsBySeller(u, order) {
    if (!u || !order || u.orderID !== order.$id || u.sellerID !== order.userId) return false;
    const perms = Array.isArray(u.$permissions) ? u.$permissions : [];
    return perms.some(p => /^update\(/.test(p) && p.indexOf("user:" + order.userId) !== -1);
  }
  const DECISIONS = ["approved", "rejected", "payment_verified", "card_reissued", "id_replaced", "id_created"];

  /* ---------------- replay ---------------- */
  /* order: the stored order. updates / reviews: documents as Appwrite returns them.
     catalog: the store's current products (trusted). formFields: the store's field definitions. */
  function replay(order, updates, reviews, catalog, formFields) {
    const orig = itemsOf(order.formData);
    const origTotal = round2(money(order.totalAmount));
    const fees = Math.max(0, round2(origTotal - subtotal(orig)));
    const entries0 = infoEntries(order.formData, formFields, null);
    const trustedReviews = (reviews || []).filter(r => reviewIsTrusted(r, order) && DECISIONS.indexOf(r.decision) !== -1)
      .sort((a, b) => String(a.$createdAt).localeCompare(String(b.$createdAt)));
    const mine = (updates || []).filter(u => u && u.orderID === order.$id && u.sellerID === order.userId)
      .sort((a, b) => (Number(a.seq) - Number(b.seq)) || String(a.$createdAt).localeCompare(String(b.$createdAt)));

    let items = orig, total = origTotal, overrides = {};
    const steps = [];
    let verifiedExtra = 0;
    mine.forEach(u => {
      const uid = u.updateID || u.$id;
      const decisions = trustedReviews.filter(r => r.updateID === uid);
      const verdict = decisions.filter(r => r.decision === "approved" || r.decision === "rejected").pop();
      const status = verdict ? verdict.decision : "pending";
      const proofs = jsonOr(u.paymentProof, []).filter(x => typeof x === "string");
      const pay = jsonOr(u.paymentDetails, {}) || {};
      const step = {
        id: uid, seq: Number(u.seq), at: u.$createdAt, status, note: clip(u.note, 300), proofs, payName: clip(pay.name, 80), payDate: clip(pay.date, 10),
        reviewNote: verdict ? clip(verdict.note, 300) : "", flags: [], verified: 0, bySeller: updateIsBySeller(u, order),
        checks: verdict ? jsonOr(verdict.verified, []) : []
      };
      step.verified = round2(decisions.filter(r => r.decision === "payment_verified").reduce((t, r) => t + money(r.amount), 0));
      if (status === "rejected") {
        const prev = jsonOr(u.previousItems, []), next = jsonOr(u.updatedItems, []);
        step.previousTotal = round2(money(u.previousTotal)); step.newTotal = round2(money(u.newTotal));
        step.diff = diffItems(Array.isArray(prev) ? prev : [], Array.isArray(next) ? next : []);
        step.infoDiff = jsonOr(u.infoChanges, []) || [];
        step.counted = false;
        steps.push(step); return;
      }
      const r = applyChanges(items, jsonOr(u.changes, []) || [], catalog, false);
      const ir = applyInfo(infoEntries(order.formData, formFields, overrides), jsonOr(u.infoChanges, []) || [], false);
      const nextItems = r.items;
      const nextTotal = round2(fees + subtotal(nextItems));
      step.flags = r.flags.concat(ir.flags);
      if (Math.abs(nextTotal - round2(money(u.newTotal))) > 0.5 && !r.emptied) step.flags.push("The total the customer's browser reported (" + fmt(money(u.newTotal)) + ") is not what the store's prices give (" + fmt(nextTotal) + "). The store's prices are used.");
      if (Math.abs(round2(money(u.previousTotal)) - total) > 0.5) step.flags.push("This update was made against a different version of the order.");
      step.previousTotal = total; step.newTotal = nextTotal; step.additional = round2(nextTotal - total);
      step.diff = diffItems(items, nextItems); step.infoDiff = ir.diff;
      step.counted = true;
      verifiedExtra += step.verified;
      items = nextItems; total = nextTotal; overrides = Object.assign({}, overrides, ir.overrides);
      steps.push(step);
    });

    const st = String(order.status || "pending").toLowerCase();
    const paidOriginal = (st === "paid" || st === "delivered") ? origTotal : 0;
    const paid = round2(paidOriginal + verifiedExtra);
    const audit = trustedReviews.filter(r => ["card_reissued", "id_replaced", "id_created"].indexOf(r.decision) !== -1)
      .map(r => ({ at: r.$createdAt, decision: r.decision, note: clip(r.note, 300), verified: jsonOr(r.verified, []) }));
    const approvedOnly = steps.filter(s => s.status === "approved");
    return {
      items, total, fees, overrides, info: infoEntries(order.formData, formFields, overrides),
      steps, audit, originalItems: orig, originalTotal: origTotal,
      paid, due: Math.max(0, round2(total - paid)), credit: Math.max(0, round2(paid - total)),
      pending: steps.filter(s => s.status === "pending").length,
      lastSeq: mine.length ? Math.max.apply(null, mine.map(u => Number(u.seq) || 0)) : 0,
      // what the seller should deliver: the original plus approved updates only (pending ones are not promised yet)
      approvedItems: (function () {
        let it = orig;
        approvedOnly.forEach(s => {
          const u = mine.find(x => (x.updateID || x.$id) === s.id);
          if (u) { const r = applyChanges(it, jsonOr(u.changes, []) || [], catalog, false); it = r.items; }
        });
        return it;
      })()
    };
  }

  /* ---------------- planning a customer update ----------------
     effective: result of replay(). request: { items:[{label,name,qty}], info:{label:value} }
     Returns { ok:true, record:{…fields for the OrderUpdates document…}, newTotal, due } or { ok:false, message } */
  function planUpdate(order, effective, catalog, formFields, request, extras) {
    const reqItems = Array.isArray(request && request.items) ? request.items : [];
    if (reqItems.length > 60) return { ok: false, message: "Too many changes in one update." };
    const r = applyChanges(effective.items, reqItems, catalog, true);
    if (!r.ok) return r;
    const infoList = Object.keys((request && request.info) || {}).map(label => ({ label, to: request.info[label] }));
    const ir = applyInfo(effective.info, infoList, true);
    if (!ir.ok) return ir;
    const diff = diffItems(effective.items, r.items);
    if (diffIsEmpty(diff) && !ir.diff.length) return { ok: false, message: "Nothing was changed." };
    const newTotal = round2(effective.fees + subtotal(r.items));
    const changes = [];
    diff.added.forEach(i => changes.push({ label: i.label, name: i.name, qty: i.qty }));
    diff.changed.forEach(i => changes.push({ label: i.label, name: i.name, qty: i.to }));
    diff.removed.forEach(i => changes.push({ label: i.label, name: i.name, qty: 0 }));
    const x = extras || {};
    return {
      ok: true, newTotal, due: Math.max(0, round2(newTotal - effective.paid)),
      record: {
        orderID: order.$id, publicOrderID: order.publicOrderID || "", sellerID: order.userId,
        seq: effective.lastSeq + 1, orderSeq: order.$id + ":" + (effective.lastSeq + 1),
        previousItems: JSON.stringify(compactItems(effective.items)), updatedItems: JSON.stringify(compactItems(r.items)),
        changes: JSON.stringify(changes), infoChanges: JSON.stringify(ir.diff),
        previousTotal: effective.total, newTotal, additionalAmount: round2(newTotal - effective.total),
        changeType: diffIsEmpty(diff) ? "info" : (ir.diff.length ? "items+info" : "items"),
        paymentProof: JSON.stringify(Array.isArray(x.proofs) ? x.proofs.slice(0, 4) : []),
        paymentDetails: JSON.stringify({ name: clip(x.payName, 80), date: clip(x.payDate, 10) }),
        paymentStatus: Array.isArray(x.proofs) && x.proofs.length ? "submitted" : "none",
        updateStatus: "pending", note: clip(x.note, 300)
      }
    };
  }

  /* ---------------- a change the seller makes for the customer (Phase 10) ----------------
     Same rules as a customer update (store prices, no sold-out increases, at least one product), plus the recovery rule:
     the seller must have checked MIN_VERIFY things with the customer first. Waiting customer updates must be decided first,
     so the seller never builds on a change they have not looked at. */
  function planSellerUpdate(order, effective, catalog, formFields, request, extras) {
    const methods = Array.from(new Set(((extras && extras.verified) || []).map(String)));
    if (methods.some(id => !VERIFY_METHODS.some(m => m.id === id))) return { ok: false, message: "Unknown check." };
    if (methods.length < MIN_VERIFY) return { ok: false, message: "Check at least " + MIN_VERIFY + " things with the customer first." };
    if (effective.pending > 0) return { ok: false, message: "The customer has an update waiting. Approve or reject it first." };
    const st = String(order.status || "pending").toLowerCase();
    if (st === "cancelled" || st === "delivered") return { ok: false, message: "A " + st + " order can't be changed." };
    const plan = planUpdate(order, effective, catalog, formFields, request, { note: extras && extras.note });
    if (!plan.ok) return plan;
    plan.verified = methods;
    return plan;
  }

  /* ---------------- reviews the seller creates ---------------- */
  const VERIFY_METHODS = [
    { id: "pay_name", label: "Name on the payment" }, { id: "pay_date", label: "Date paid" },
    { id: "items_total", label: "Items and total" }, { id: "phone", label: "Phone number on the order" },
    { id: "delivery", label: "Delivery details" }
  ];
  const MIN_VERIFY = 2;
  function planReview(order, input) {
    if (DECISIONS.indexOf(input.decision) === -1) return { ok: false, message: "Unknown decision." };
    if ((input.decision === "card_reissued" || input.decision === "id_replaced" || input.decision === "id_created")) {
      const methods = Array.from(new Set((input.verified || []).map(String)));
      if (methods.some(id => !VERIFY_METHODS.some(m => m.id === id))) return { ok: false, message: "Unknown check." };
      if (methods.length < MIN_VERIFY) return { ok: false, message: "Check at least " + MIN_VERIFY + " things with the customer first." };
      input = Object.assign({}, input, { verified: methods });
    }
    if (input.decision === "payment_verified" && !(money(input.amount) > 0)) return { ok: false, message: "Enter the amount received." };
    return {
      ok: true,
      record: {
        orderID: order.$id, updateID: String(input.updateID || ""), sellerID: order.userId, decision: input.decision,
        amount: round2(money(input.amount)), note: clip(input.note, 300), verified: JSON.stringify(input.verified || [])
      }
    };
  }

  /* ---------------- words ---------------- */
  function summarizeStep(s) {
    const lines = [];
    const q = n => Number(n).toLocaleString("en-NG");
    (s.diff.added || []).forEach(i => lines.push("Added " + i.name + " × " + q(i.qty)));
    (s.diff.removed || []).forEach(i => lines.push("Removed " + i.name));
    (s.diff.changed || []).forEach(i => lines.push(i.name + ": " + q(i.from) + " → " + q(i.to)));
    (s.infoDiff || []).forEach(i => lines.push(i.label + ": " + (i.from || "—") + " → " + i.to));
    return lines;
  }
  const AUDIT_TITLE = { card_reissued: "Seller reissued the order card", id_replaced: "Seller replaced the Public Order ID", id_created: "Seller created a Public Order ID" };
  const STATUS_LABEL = { pending: "Waiting for the seller", approved: "Approved", rejected: "Rejected" };

  return {
    ID_ALPHABET, ID_LENGTH, MAX_QTY, VERIFY_METHODS, MIN_VERIFY, DECISIONS, AUDIT_TITLE, STATUS_LABEL,
    generatePublicId, normalizeId, isValidIdShape, spacedId, round2, money, fmt, clip, jsonOr, parseFormData, itemKey, itemsOf, subtotal, compactItems,
    catalogOf, fieldDefs, infoEntries, diffItems, diffIsEmpty, applyChanges, applyInfo, reviewIsTrusted, updateIsBySeller, replay, planUpdate, planSellerUpdate, planReview, summarizeStep
  };
});
