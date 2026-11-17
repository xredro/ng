/* Seller side of Phases 8, 9 and 10: the Public Order ID, customer updates, the seller's decisions, and recovery.
   Loaded before js/orders.js and uses its globals (databases, DB_ID, ORDERS, allOrders, user, escapeHtml, showToast ...).
   Nothing here rewrites the original order except the Public Order ID itself (when a seller creates or replaces it).
   Every decision is a new document in order_reviews, owned by the seller, so it can be trusted (see js/order-logic.js). */
const UPDATES = "order_updates";
const REVIEWS = "order_reviews";
const xr = { updates: new Map(), reviews: new Map(), ready: false, cache: new Map(), form: null };

async function xrListAll(collection, queries) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 30; page++) {
    const q = queries.concat([Query.limit(100)]);
    if (cursor) q.push(Query.cursorAfter(cursor));
    const r = await databases.listDocuments(DB_ID, collection, q);
    out.push.apply(out, r.documents);
    if (r.documents.length < 100) break;
    cursor = r.documents[r.documents.length - 1].$id;
  }
  return out;
}
function xrGroup(docs) {
  const m = new Map();
  docs.forEach(d => { if (!m.has(d.orderID)) m.set(d.orderID, []); m.get(d.orderID).push(d); });
  return m;
}
/* called once after the orders load; a missing collection just means "no updates yet", never an error for the seller */
async function loadOrderUpdates(form) {
  xr.form = form || null; xr.cache.clear();
  try {
    const [u, r] = await Promise.all([
      xrListAll(UPDATES, [Query.equal("sellerID", user.$id), Query.orderAsc("seq")]),
      xrListAll(REVIEWS, [Query.equal("sellerID", user.$id)])
    ]);
    xr.updates = xrGroup(u); xr.reviews = xrGroup(r); xr.ready = true;
  } catch (err) {
    xr.ready = false;
    console.warn("Order updates are not available (collections missing or no permission):", err);
  }
}
async function xrRefreshOrder(order) {
  try {
    const [u, r] = await Promise.all([
      xrListAll(UPDATES, [Query.equal("orderID", order.$id), Query.orderAsc("seq")]),
      xrListAll(REVIEWS, [Query.equal("orderID", order.$id)])
    ]);
    xr.updates.set(order.$id, u); xr.reviews.set(order.$id, r); xr.cache.delete(order.$id);
    return true;
  } catch (err) { console.error("Could not refresh the order:", err); return false; }
}
function xrFields() { return XrOrder.fieldDefs(xr.form && xr.form.fields); }
function xrEffective(order) {
  if (!window.XrOrder) return null;
  let e = xr.cache.get(order.$id);
  if (!e) {
    const fields = xrFields();
    e = XrOrder.replay(order, xr.updates.get(order.$id) || [], xr.reviews.get(order.$id) || [], XrOrder.catalogOf(fields), fields);
    xr.cache.set(order.$id, e);
  }
  return e;
}
const xrPendingUpdates = order => (xr.ready && window.XrOrder ? xrEffective(order).pending : 0);
const xrHasUpdates = order => xr.ready && (xr.updates.get(order.$id) || []).length > 0;
/* the seller delivers the original plus APPROVED updates; null means "use the order as stored" */
function xrDeliveryItems(order) {
  if (!xrHasUpdates(order)) return null;
  return xrEffective(order).approvedItems;
}
function xrUpdateTag(order) {
  const n = xrPendingUpdates(order);
  return n ? `<span class="xr-badge xr-badge--attention">${n === 1 ? "Updated" : n + " updates"}</span>` : "";
}
function xrDueChip(order) {
  if (!xrHasUpdates(order) || normalizedStatus(order) === "cancelled") return "";
  const e = xrEffective(order);
  return e.due > 0 && normalizedStatus(order) !== "pending" ? `<span class="ord-due">₦${e.due.toLocaleString("en-NG")} to pay</span>` : "";
}
const xrCleanId = v => String(v || "").replace(/[^A-Za-z0-9_.-]/g, "");

/* ---------- panels inside an order card ---------- */
function xrIdRowHTML(order, id) {
  if (!window.XrOrder) return "";
  const pid = order.publicOrderID;
  const hasField = "publicOrderID" in order;
  if (!hasField) return `<div class="ord-field ord-field--wide"><strong>Public Order ID</strong><span class="xr-text-2 xr-small">Add the publicOrderID field to the orders collection to switch on order cards (docs/DATABASE-CHANGES.md).</span></div>`;
  return `<div class="ord-field ord-field--wide ord-access"><strong>Public Order ID</strong>
    <span class="ord-pid">${pid ? escapeHtml(XrOrder.spacedId(pid)) : "None yet. This order was placed before order IDs existed."}</span>
    <div class="ord-access__actions"><button type="button" class="xr-btn xr-btn--secondary xr-btn--sm" onclick="openIdDialog('${id}')">${pid ? "Order card and ID" : "Create an order ID"}</button>${xrCanChangeForCustomer(order) ? `<button type="button" class="xr-btn xr-btn--secondary xr-btn--sm" onclick="openSellerEdit('${id}')">Change order for customer</button>` : ""}</div></div>`;
}

function xrThumbs(list, when) {
  if (!list.length) return "";
  return `<div class="ord-proofs">${list.map(pid => {
    const f = xrCleanId(pid);
    return `<button type="button" class="ord-proof ord-proof--small" onclick="viewImage('${escapeHtml(f)}')" aria-label="View payment image full size">
      <img loading="lazy" alt="Payment image" src="https://nyc.cloud.appwrite.io/v1/storage/buckets/${PRODUCT_IMAGES_BUCKET}/files/${escapeHtml(f)}/view?project=695981480033c7a4eb0d"><span>${escapeHtml(when)}</span></button>`;
  }).join("")}</div>`;
}

function xrUpdatesHTML(order, id) {
  if (!window.XrOrder || !xr.ready || !xrHasUpdates(order)) return "";
  const L = XrOrder;
  const e = xrEffective(order);
  const status = normalizedStatus(order);
  const fmt = L.fmt;
  const when = iso => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const lines = e.items.map(i => `<div class="order-product-detail"><div><strong>${escapeHtml(i.name)}</strong> × ${i.qty.toLocaleString()}</div><div class="order-product-price">${fmt(i.price)} each</div></div>`).join("");
  const infoNow = e.info.filter(x => x.value !== x.original).map(x => `<div class="ord-field"><strong>${escapeHtml(x.label)}</strong><span>${escapeHtml(x.value)} <em class="xr-text-2">(was ${escapeHtml(x.original || "—")})</em></span></div>`).join("");
  const latest = `
    <div class="ord-field ord-field--wide ord-latest"><strong>Latest order (with ${e.steps.filter(s => s.counted).length} update${e.steps.filter(s => s.counted).length === 1 ? "" : "s"})</strong>
      <div class="order-products-detail">${lines}</div>
      <p class="ord-update__nums">Original total <strong>${fmt(e.originalTotal)}</strong> · Latest total <strong>${fmt(e.total)}</strong> · Paid and verified <strong>${fmt(e.paid)}</strong> · Still to pay <strong>${fmt(e.due)}</strong>${e.credit > 0 ? ` · Paid more than the total by <strong>${fmt(e.credit)}</strong>` : ""}</p>
      ${infoNow ? `<div class="ord-latest__info">${infoNow}</div>` : ""}
    </div>`;
  const canReview = status === "pending" || status === "paid";
  const stepsHTML = e.steps.slice().reverse().map(s => {
    const uid = escapeHtml(xrCleanId(s.id));
    const tone = { pending: "attention", approved: "paid", rejected: "cancelled" }[s.status] || "neutral";
    const body = L.summarizeStep(s);
    const nums = s.counted
      ? `Total <strong>${fmt(s.previousTotal)}</strong> → <strong>${fmt(s.newTotal)}</strong> (${s.additional >= 0 ? "+" : "−"}${fmt(Math.abs(s.additional))})`
      : `Customer asked for ${fmt(s.previousTotal)} → ${fmt(s.newTotal)}. Not counted.`;
    const flags = s.flags.map(f => `<p class="ord-upd__flag">⚠ ${escapeHtml(f)}</p>`).join("");
    const pay = s.proofs.length ? xrThumbs(s.proofs, new Date(s.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })) + ((s.payName || s.payDate) ? `<p class="ord-update__pay">${s.payName ? "Name on payment: " + escapeHtml(s.payName) : ""}${s.payName && s.payDate ? " · " : ""}${s.payDate ? "Date paid: " + escapeHtml(s.payDate) : ""}</p>` : "") : "";
    const received = s.verified > 0 ? `<p class="ord-update__pay">Extra payment received: <strong>${fmt(s.verified)}</strong></p>` : "";
    const actions = [];
    if (canReview && s.status === "pending") {
      actions.push(`<button type="button" class="xr-btn xr-btn--primary xr-btn--sm" onclick="xrDecide('${id}','${uid}','approved')">Approve</button>`);
      actions.push(`<button type="button" class="xr-btn xr-btn--danger xr-btn--sm" onclick="xrDecide('${id}','${uid}','rejected')">Reject</button>`);
    }
    if (canReview && s.counted && e.due > 0 && (s.proofs.length || s.additional > 0)) {
      actions.push(`<button type="button" class="xr-btn xr-btn--secondary xr-btn--sm" onclick="xrPaymentReceived('${id}','${uid}')">Mark payment received</button>`);
    }
    return `<div class="ord-upd ord-upd--${s.status}">
      <div class="ord-update__head"><strong>Update ${s.seq}${s.bySeller ? " · made by you" : ""}</strong><span class="xr-badge xr-badge--${tone}">${escapeHtml(L.STATUS_LABEL[s.status] || s.status)}</span></div>
      <p class="ord-update__when">${escapeHtml(when(s.at))}</p>
      ${body.length ? `<ul class="ord-update__lines">${body.map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul>` : ""}
      <p class="ord-update__nums">${nums}</p>
      ${s.note ? `<p class="ord-update__pay">Customer's note: ${escapeHtml(s.note)}</p>` : ""}
      ${s.reviewNote ? `<p class="ord-update__pay">Your note: ${escapeHtml(s.reviewNote)}</p>` : ""}
      ${s.bySeller && s.checks.length ? `<p class="ord-update__pay">Checked with the customer: ${s.checks.map(c => escapeHtml((L.VERIFY_METHODS.find(m => m.id === c) || { label: c }).label)).join(", ")}</p>` : ""}
      ${flags}${pay}${received}
      ${actions.length ? `<div class="ord-update__actions">${actions.join("")}</div>` : ""}
    </div>`;
  }).join("");
  const audit = e.audit.length ? `<p class="ord-hist__when">${e.audit.map(a => escapeHtml(L.AUDIT_TITLE[a.decision] || a.decision) + " · " + escapeHtml(new Date(a.at).toLocaleDateString("en-GB"))).join(" · ")}</p>` : "";
  return `${latest}
    <div class="ord-field ord-field--wide"><strong>Customer updates (${e.steps.length})</strong>${stepsHTML}${audit}</div>`;
}

/* ---------- seller decisions ---------- */
async function xrCreateReview(order, input) {
  const plan = XrOrder.planReview(order, input);
  if (!plan.ok) { showToast(plan.message, "warning"); return false; }
  const me = Appwrite.Role.user(user.$id);
  try {
    const saved = await databases.createDocument(DB_ID, REVIEWS, Appwrite.ID.unique(), Object.assign({}, plan.record, { createdAt: new Date().toISOString() }), [
      Appwrite.Permission.read(Appwrite.Role.any()), Appwrite.Permission.update(me), Appwrite.Permission.delete(me)
    ]);
    return saved.$id || true;     // the new review's id (always truthy)
  } catch (err) {
    console.error("Could not save the decision:", err);
    showToast(err && (err.code === 404 || /collection/i.test(String(err.message))) ? "Order decisions are not set up yet (see docs/DATABASE-CHANGES.md)." : "Could not save. Check your connection and try again.", "error");
    return false;
  }
}
async function xrDecide(orderId, updateId, decision) {
  const order = allOrders.find(o => o.$id === orderId); if (!order) return;
  let note = "";
  if (decision === "rejected") {
    if (!confirm("Reject this update? It stops counting toward the customer's order. Their payment images stay on record.")) return;
    note = prompt("Tell the customer why (optional):", "") || "";
  }
  if (!(await xrRefreshOrder(order))) { showToast("Could not check the latest version. Try again.", "error"); return; }
  const step = xrEffective(order).steps.find(s => s.id === updateId);
  if (!step || step.status !== "pending") { applyFilter(); showToast("That update was already handled.", "warning"); return; }
  if (await xrCreateReview(order, { decision, updateID: updateId, note })) {
    await xrRefreshOrder(order); applyFilter();
    showToast(decision === "approved" ? "Update approved." : "Update rejected.", "success");
  }
}
async function xrPaymentReceived(orderId, updateId) {
  const order = allOrders.find(o => o.$id === orderId); if (!order) return;
  if (!(await xrRefreshOrder(order))) { showToast("Could not check the latest version. Try again.", "error"); return; }
  const e = xrEffective(order);
  if (e.due <= 0) { applyFilter(); showToast("Nothing is owed on this order now.", "warning"); return; }
  const raw = prompt("How much did you receive for this update? (₦)", String(e.due));
  if (raw === null) return;
  const amount = XrOrder.money(raw);
  if (!(amount > 0)) { showToast("Enter an amount greater than zero.", "warning"); return; }
  const reviewId = await xrCreateReview(order, { decision: "payment_verified", updateID: updateId, amount, note: "" });
  if (reviewId) {
    if (typeof xrTelegramNotify === "function") xrTelegramNotify("additional_payment", order.$id, reviewId); // only after the payment is saved
    await xrRefreshOrder(order); applyFilter();
    showToast("Payment recorded.", "success");
  }
}

/* ---------- order card, ID, recovery (Phase 8 section 5) ---------- */
let idDialog = { id: null, card: null };
function xrFacts(order) {
  const parsed = XrOrder.parseFormData(order.formData);
  const pick = fn => parsed.find(fn);
  const val = e => (e && String(e.value || "").trim()) || "";
  const items = XrOrder.itemsOf(order.formData);
  return {
    pay_name: val(pick(e => e.type === "payment_account_name")),
    pay_date: val(pick(e => e.type === "payment_date")),
    items_total: items.length ? items.map(i => `${i.name} × ${i.qty}`).join(", ") + ` · ₦${normalizeAmount(order.totalAmount).toLocaleString("en-NG")}` : "",
    phone: val(pick(e => e.type !== "product" && /phone|whatsapp|mobile|tel/i.test(String(e.label || "")))),
    delivery: val(pick(e => e.type === "additional_fee")) || val(pick(e => e.type !== "product" && /address|location|delivery|city|state/i.test(String(e.label || ""))))
  };
}
const XR_HINT = {
  pay_name: "Ask: what name was on your payment?", pay_date: "Ask: what date did you pay?", items_total: "Ask: what did you order and what was the total?",
  phone: "Ask: which phone number did you use?", delivery: "Ask: where should it be delivered?"
};
function openIdDialog(id) {
  const order = allOrders.find(o => o.$id === id);
  if (!order || !window.XrOrder || !window.XrOrderCard) return;
  idDialog = { id, card: null };
  const facts = xrFacts(order);
  const has = !!order.publicOrderID;
  const rows = XrOrder.VERIFY_METHODS.map(m => `
    <li><label class="ord-verify__row"><input type="checkbox" data-vm="${m.id}" onchange="refreshIdDialog()" ${facts[m.id] ? "" : "disabled"}>
      <span><strong>${escapeHtml(m.label)}</strong><em>${escapeHtml(XR_HINT[m.id])}</em>
      <span class="ord-verify__val">${facts[m.id] ? escapeHtml(facts[m.id]) : "Not on this order"}</span></span></label></li>`).join("");
  document.getElementById("idBody").innerHTML = `
    <h2 class="xr-h3" id="idTitle">${has ? "Order card and ID" : "Create an order ID"}${has ? " · " + escapeHtml(XrOrder.spacedId(order.publicOrderID)) : ""}</h2>
    <p class="xr-text-2" style="margin:var(--xr-s-2) 0 var(--xr-s-3)">Only give the card or ID to the person who placed this order. Ask them the questions below <strong>without reading the answers out</strong> and tick each one they get right. A name or phone number alone is not enough: tick at least ${XrOrder.MIN_VERIFY}.</p>
    <ul class="ord-verify">${rows}</ul>
    ${has ? `<fieldset class="ord-choice"><legend class="xr-label">What do you want to do?</legend>
      <label><input type="radio" name="idAction" value="card_reissued" checked onchange="refreshIdDialog()"> Send the card again (same ID)</label>
      <label><input type="radio" name="idAction" value="id_replaced" onchange="refreshIdDialog()"> Replace the ID (the old ID stops working)</label></fieldset>` : ""}
    <div class="xr-field" style="margin-top:var(--xr-s-3)"><label class="xr-label" for="idNote">Note <span class="xr-optional">(optional, kept on record)</span></label><textarea class="xr-textarea" id="idNote" maxlength="300" style="min-height:56px" placeholder="Example: called from the number on the order"></textarea></div>
    <p id="idErr" class="xr-error" role="alert" hidden></p>
    <div class="xr-row" style="margin-top:var(--xr-s-4)"><button type="button" class="xr-btn xr-btn--secondary" onclick="closeIdDialog()">Cancel</button>
    <button type="button" class="xr-btn xr-btn--primary" id="idGo" onclick="runIdDialog()" disabled>${has ? "Continue" : "Create ID"}</button></div>`;
  document.getElementById("idModal").classList.remove("hidden");
}
const xrChecked = () => Array.from(document.querySelectorAll("#idBody [data-vm]:checked")).map(el => el.getAttribute("data-vm"));
function refreshIdDialog() {
  const go = document.getElementById("idGo");
  if (go) go.disabled = xrChecked().length < XrOrder.MIN_VERIFY;
}
function xrCardData(order) {
  const e = xrEffective(order);
  const status = normalizedStatus(order);
  const due = e.due;
  let cfg = {};
  try { cfg = typeof xr.form?.storeConfig === "string" ? JSON.parse(xr.form.storeConfig) : (xr.form?.storeConfig || {}); } catch (x) { cfg = {}; }
  return {
    storeName: businessTitle, logoUrl: /^https?:\/\//i.test(String(cfg.logoUrl || "")) ? cfg.logoUrl : "", publicId: order.publicOrderID,
    items: e.items.map(i => ({ name: i.name, qty: i.qty, price: i.price })), feesAmount: e.fees, total: e.total,
    dateText: new Date(order.$createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
    paymentStatus: status === "cancelled" ? "Cancelled" : status === "delivered" ? "Delivered" : due > 0 ? "Still to pay: ₦" + due.toLocaleString("en-NG") : status === "paid" ? "Payment confirmed" : "Awaiting payment",
    paymentTone: status === "cancelled" ? "bad" : due > 0 ? "warn" : status === "pending" ? "info" : "good",
    contact: { whatsapp: cfg.whatsapp || xr.form?.whatsappNumber || "", phone: cfg.phone || "" },
    retrievalUrl: new URL("order.html" + (xr.form ? "?fid=" + encodeURIComponent(xr.form.$id) : ""), window.location.href).href,
    updatesEnabled: xr.form ? xr.form.customerOrderUpdatesEnabled !== false : true
  };
}
async function xrAssignNewId(order) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = XrOrderCard.generatePublicId();
    try {
      const taken = await databases.listDocuments(DB_ID, ORDERS, [Query.equal("publicOrderID", candidate), Query.limit(1)]);
      if (taken.documents.length) continue;
    } catch (e) { /* can't check; the unique index decides */ }
    try {
      await databases.updateDocument(DB_ID, ORDERS, order.$id, { publicOrderID: candidate });
      return candidate;
    } catch (err) {
      if (err && err.code === 409) continue;
      throw err;
    }
  }
  throw new Error("Could not find a free order ID. Try again.");
}
async function runIdDialog() {
  const order = allOrders.find(o => o.$id === idDialog.id);
  if (!order) return;
  const go = document.getElementById("idGo"), err = document.getElementById("idErr");
  const methods = xrChecked();
  const note = document.getElementById("idNote").value;
  const action = order.publicOrderID ? (document.querySelector("#idBody [name=idAction]:checked")?.value || "card_reissued") : "id_created";
  go.disabled = true; go.textContent = "Working…"; err.hidden = true;
  try {
    const check = XrOrder.planReview(order, { decision: action, verified: methods, note });
    if (!check.ok) throw new Error(check.message);
    if (!(await xrRefreshOrder(order))) throw new Error("Could not check the latest version of this order. Try again.");
    if (action !== "card_reissued") {
      const fresh = await databases.getDocument(DB_ID, ORDERS, order.$id);
      if (fresh.$updatedAt !== order.$updatedAt) { Object.assign(order, fresh); throw new Error("This order just changed. Close this and open it again."); }
      const newId = await xrAssignNewId(order);
      order.publicOrderID = newId;
    }
    const saved = await xrCreateReview(order, { decision: action, verified: methods, note });
    if (!saved) showToast("The ID was changed but the record of this check could not be saved.", "warning");
    xr.cache.delete(order.$id); await xrRefreshOrder(order);
    idDialog.card = xrCardData(order);
    XrOrderCard.setCurrent(idDialog.card);
    document.getElementById("idBody").innerHTML = `
      <h2 class="xr-h3" id="idTitle">${action === "card_reissued" ? "Order card" : "New order ID ready"}</h2>
      <p class="xr-text-2" style="margin:var(--xr-s-2) 0">${action === "card_reissued" ? "Send the customer this card." : "The old ID no longer works. Send the customer the new card."}</p>
      ${XrOrderCard.panelHTML(idDialog.card)}
      <div class="xr-row" style="margin-top:var(--xr-s-3)"><button type="button" class="xr-btn xr-btn--secondary" onclick="copyIdMessage(this)">Copy message for the customer</button>
      <button type="button" class="xr-btn xr-btn--primary" onclick="closeIdDialog()">Done</button></div>`;
    XrOrderCard.fillPreview();
    applyFilter();
  } catch (e) {
    console.error("Order ID action failed:", e);
    const missing = e && (e.code === 400 && /attribute|structure/i.test(String(e.message)));
    err.textContent = missing ? "The orders collection needs the publicOrderID field first (docs/DATABASE-CHANGES.md)." : (e.message || "Something went wrong. Nothing was changed.");
    err.hidden = false; go.textContent = "Continue"; refreshIdDialog();
  }
}
async function copyIdMessage(btn) {
  const c = idDialog.card; if (!c) return;
  const text = `Hello, here is your order at ${c.storeName}.\nPublic Order ID: ${c.publicId}\n${c.updatesEnabled ? "See or change your order: " + c.retrievalUrl + "\n" : ""}Please keep this ID safe.`;
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (e) { /* fall through */ }
  const t = btn.textContent; btn.textContent = ok ? "Copied" : "Could not copy"; setTimeout(() => { btn.textContent = t; }, 2000);
}
function closeIdDialog(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById("idModal")?.classList.add("hidden");
  document.getElementById("idBody").innerHTML = "";
  idDialog = { id: null, card: null };
  if (window.XrOrderCard) XrOrderCard.setCurrent(null);
}


/* ---------- Phase 10: the seller changes the order for the customer ----------
   Same rules as a customer update (js/order-logic.js planSellerUpdate), after the same "ask the customer" checks as recovery.
   It is saved as an ordinary order_updates document, but created by the seller's own session, so it carries the seller's
   update/delete role. That role is how every page knows the seller made it (a guest can't give it). It is approved straight
   away with a review that records the checks and the note, so the history shows who changed what and why. Extra money is
   still recorded separately with "Mark payment received"; nothing is marked paid here. */
function xrCanChangeForCustomer(order) {
  if (!xr.ready || !window.XrOrder || !xr.form) return false;
  const st = normalizedStatus(order);
  return st === "pending" || st === "paid";
}
let sellerEdit = { id: null };
function openSellerEdit(id) {
  const order = allOrders.find(o => o.$id === id);
  if (!order || !window.XrOrder || !xr.form) return;
  sellerEdit = { id };
  const e = xrEffective(order), facts = xrFacts(order);
  const catalog = XrOrder.catalogOf(xrFields());
  const verifyRows = XrOrder.VERIFY_METHODS.map(m => `
    <li><label class="ord-verify__row"><input type="checkbox" data-vm="${m.id}" onchange="refreshSellerEdit()" ${facts[m.id] ? "" : "disabled"}>
      <span><strong>${escapeHtml(m.label)}</strong><em>${escapeHtml(XR_HINT[m.id])}</em>
      <span class="ord-verify__val">${facts[m.id] ? escapeHtml(facts[m.id]) : "Not on this order"}</span></span></label></li>`).join("");
  const lines = e.items.map((i, n) => `
    <div class="ord-edit-row"><label for="seq${n}"><strong>${escapeHtml(i.name)}</strong> <span class="xr-text-2 xr-small">${XrOrder.fmt(i.price)} each</span></label>
      <input class="xr-input" id="seq${n}" type="number" inputmode="numeric" min="0" max="${XrOrder.MAX_QTY}" step="1" value="${i.qty}"
        data-label="${escapeHtml(i.label)}" data-name="${escapeHtml(i.name)}" data-start="${i.qty}" aria-label="Quantity of ${escapeHtml(i.name)}"></div>`).join("");
  const have = new Set(e.items.map(i => XrOrder.itemKey(i)));
  const addable = catalog.filter(c => !c.soldOut && !have.has(XrOrder.itemKey(c)));
  const addBlock = addable.length ? `
    <div class="ord-edit-row ord-edit-row--add"><label for="seAdd"><strong>Add a product</strong></label>
      <select class="xr-select" id="seAdd"><option value="">Choose…</option>${addable.map((c, n) => `<option value="${n}">${escapeHtml(c.name)} · ${XrOrder.fmt(c.price)}</option>`).join("")}</select>
      <input class="xr-input" id="seAddQty" type="number" inputmode="numeric" min="1" max="${XrOrder.MAX_QTY}" step="1" value="1" aria-label="Quantity to add"></div>` : "";
  const infos = e.info.filter(x => x.editable).map((x, n) => `
    <div class="xr-field"><label class="xr-label" for="seInfo${n}">${escapeHtml(x.label)}</label>
      <input class="xr-input" id="seInfo${n}" type="text" maxlength="500" value="${escapeHtml(x.value)}" data-label="${escapeHtml(x.label)}" data-start="${escapeHtml(x.value)}"></div>`).join("");
  sellerEdit.addable = addable;
  document.getElementById("idBody").innerHTML = `
    <h2 class="xr-h3" id="idTitle">Change order for customer${order.publicOrderID ? " · " + escapeHtml(XrOrder.spacedId(order.publicOrderID)) : ""}</h2>
    <p class="xr-text-2" style="margin:var(--xr-s-2) 0 var(--xr-s-3)">Use this when the customer asks you to change their order and can't do it themselves. Ask them the questions below <strong>without reading the answers out</strong> and tick each one they get right (at least ${XrOrder.MIN_VERIFY}).</p>
    ${e.pending > 0 ? `<p class="xr-error" role="alert">The customer has an update waiting. Approve or reject it first, then come back.</p>` : ""}
    <ul class="ord-verify">${verifyRows}</ul>
    <h3 class="xr-h4" style="margin:var(--xr-s-4) 0 var(--xr-s-2)">Order now (set a quantity to 0 to remove it)</h3>
    ${lines}${addBlock}${infos ? `<h3 class="xr-h4" style="margin:var(--xr-s-4) 0 var(--xr-s-2)">Customer details</h3>${infos}` : ""}
    <div class="xr-field" style="margin-top:var(--xr-s-3)"><label class="xr-label" for="seNote">Note <span class="xr-optional">(optional, kept on record)</span></label><textarea class="xr-textarea" id="seNote" maxlength="300" style="min-height:56px" placeholder="Example: customer called to add a necklace"></textarea></div>
    <p id="seErr" class="xr-error" role="alert" hidden></p>
    <div class="xr-row" style="margin-top:var(--xr-s-4)"><button type="button" class="xr-btn xr-btn--secondary" onclick="closeIdDialog()">Cancel</button>
    <button type="button" class="xr-btn xr-btn--primary" id="seGo" onclick="runSellerEdit()" disabled>Save change</button></div>`;
  document.getElementById("idModal").classList.remove("hidden");
}
function refreshSellerEdit() {
  const go = document.getElementById("seGo");
  if (go) go.disabled = xrChecked().length < XrOrder.MIN_VERIFY;
}
function xrSellerRequest() {
  const items = [];
  document.querySelectorAll("#idBody input[data-name]").forEach(el => {
    if (el.value !== el.getAttribute("data-start")) items.push({ label: el.getAttribute("data-label"), name: el.getAttribute("data-name"), qty: el.value });
  });
  const sel = document.getElementById("seAdd");
  if (sel && sel.value !== "") {
    const c = sellerEdit.addable[Number(sel.value)];
    if (c) items.push({ label: c.label, name: c.name, qty: document.getElementById("seAddQty").value });
  }
  const info = {};
  document.querySelectorAll("#idBody input[data-start][data-label]:not([data-name])").forEach(el => {
    if (el.value.trim() !== el.getAttribute("data-start")) info[el.getAttribute("data-label")] = el.value;
  });
  return { items, info };
}
async function runSellerEdit() {
  const order = allOrders.find(o => o.$id === sellerEdit.id); if (!order) return;
  const go = document.getElementById("seGo"), err = document.getElementById("seErr");
  go.disabled = true; go.textContent = "Saving…"; err.hidden = true;
  const fail = msg => { err.textContent = msg; err.hidden = false; go.textContent = "Save change"; refreshSellerEdit(); };
  try {
    if (!(await xrRefreshOrder(order))) return fail("Could not check the latest version of this order. Try again.");
    const fields = xrFields(), e = xrEffective(order);
    const methods = xrChecked(), note = document.getElementById("seNote").value;
    const plan = XrOrder.planSellerUpdate(order, e, XrOrder.catalogOf(fields), fields, xrSellerRequest(), { verified: methods, note: "Changed by the seller for the customer. " + String(note || "").trim() });
    if (!plan.ok) return fail(plan.message);
    const me = Appwrite.Role.user(user.$id);
    const id = Appwrite.ID.unique();
    try {
      await databases.createDocument(DB_ID, UPDATES, id, Object.assign({}, plan.record, { updateID: id, createdAt: new Date().toISOString() }),
        [Appwrite.Permission.read(Appwrite.Role.any()), Appwrite.Permission.update(me), Appwrite.Permission.delete(me)]);
    } catch (x) {
      if (x && x.code === 409) { await xrRefreshOrder(order); applyFilter(); return fail("The order changed while you were editing (another update was saved first). Close this and open it again."); }
      throw x;
    }
    const approved = await xrCreateReview(order, { decision: "approved", updateID: id, verified: plan.verified, note: String(note || "").trim() });
    await xrRefreshOrder(order); applyFilter();
    closeIdDialog();
    showToast(approved ? "Order changed. The customer will see it with their Public Order ID." : "Change saved but not approved yet. Approve it from the order's updates.", approved ? "success" : "warning");
  } catch (x) {
    console.error("Seller change failed:", x);
    fail(x && (x.code === 404 || /collection/i.test(String(x.message))) ? "Order changes are not set up yet (docs/DATABASE-CHANGES.md)." : "Could not save. Check your connection and try again. Nothing was changed.");
  }
}
