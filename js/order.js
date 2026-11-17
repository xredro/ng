/* Customer order page (Phases 8 and 9): find an order with its Public Order ID, see its latest effective state,
   change it, and send more payment evidence. Runs entirely on the Appwrite client (no server code).
   - The original order is only ever read. Every change is a new document in order_updates.
   - The effective order is rebuilt here by replaying the updates over the original with the store's own prices (js/order-logic.js).
   - The seller's decisions are read from order_reviews. */
(function () {
  "use strict";
  const L = window.XrOrder;
  const DB_ID = "695c4fce0039f513dc83";
  const ORDERS = "orders", FORMS = "form";
  const UPDATES = "order_updates", REVIEWS = "order_reviews";
  const BUCKET = "696825350032fe17c1eb";
  const MAX_FILES = 4;
  const MAX_FILE_BYTES = 10 * 1024 * 1024;

  const client = new Appwrite.Client().setEndpoint("https://nyc.cloud.appwrite.io/v1").setProject("695981480033c7a4eb0d");
  const databases = new Appwrite.Databases(client);
  const storage = new Appwrite.Storage(client);
  const Query = Appwrite.Query;
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const safeUrl = u => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || "")) ? esc(u) : "");
  const params = new URLSearchParams(window.location.search);
  const FID = /^[A-Za-z0-9_.-]{1,36}$/.test(params.get("fid") || "") ? params.get("fid") : "";

  /* ---------- state ---------- */
  let publicId = "";        // normalised, in memory only
  let source = null;        // { order, form, fields, catalog, updates, reviews, effective }
  let order = null;         // the view the rest of this file draws from (built by buildView)
  let qtyEdits = {};        // itemKey -> wanted quantity (existing lines and added lines)
  let infoEdits = {};       // label -> new value
  let files = [];           // { file, url, id }
  let pay = { name: "", date: "" };
  let note = "";
  let catalogQuery = "";
  let busy = false;
  let lastPaySig = "";
  let confirmation = null;  // the update the customer just submitted
  const keyIds = [];
  const kid = key => { let i = keyIds.indexOf(key); if (i === -1) { keyIds.push(key); i = keyIds.length - 1; } return i; };

  const STATUS = {
    pending: ["Waiting for payment confirmation", "attention"], paid: ["Payment confirmed", "paid"],
    delivered: ["Delivered", "delivered"], cancelled: ["Cancelled", "cancelled"]
  };
  const fmtDate = iso => { try { return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); } catch (e) { return ""; } };
  const fmtWhen = iso => { try { return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } };
  const today = () => { const n = new Date(); return n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0") + "-" + String(n.getDate()).padStart(2, "0"); };

  /* ---------- reading from Appwrite ---------- */
  async function listAll(collection, queries) {
    const out = [];
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const q = queries.concat([Query.limit(100)]);
      if (cursor) q.push(Query.cursorAfter(cursor));
      const r = await databases.listDocuments(DB_ID, collection, q);
      out.push.apply(out, r.documents);
      if (r.documents.length < 100) break;
      cursor = r.documents[r.documents.length - 1].$id;
    }
    return out;
  }
  const missingCollection = err => err && (err.code === 404 || /collection/i.test(String(err.type || err.message || "")));

  /* returns { kind: "ok"|"notfound"|"off"|"unavailable", ... } */
  async function loadOrder(id) {
    let found;
    try {
      found = await databases.listDocuments(DB_ID, ORDERS, [Query.equal("publicOrderID", id), Query.limit(2)]);
    } catch (err) {
      console.error("Order lookup failed:", err);
      return { kind: "unavailable", message: "Order lookup isn't available right now. Please try again later or contact the seller." };
    }
    if (found.documents.length !== 1 || FID && found.documents[0].formId !== FID) return { kind: "notfound" };
    const o = found.documents[0];
    let form = null;
    try { form = await databases.getDocument(DB_ID, FORMS, o.formId); } catch (e) { console.warn("Store not readable:", e); }
    let cfg = {};
    try { cfg = typeof form?.storeConfig === "string" ? JSON.parse(form.storeConfig) : (form?.storeConfig || {}); } catch (e) { cfg = {}; }
    const contact = { whatsapp: cfg.whatsapp || form?.whatsappNumber || "", phone: cfg.phone || "" };
    if (form && form.customerOrderUpdatesEnabled === false) return { kind: "off", storeName: form.title || "", contact };
    let updates = [], reviews = [], setup = true;
    try {
      updates = await listAll(UPDATES, [Query.equal("orderID", o.$id), Query.orderAsc("seq")]);
      reviews = await listAll(REVIEWS, [Query.equal("orderID", o.$id)]);
    } catch (err) {
      if (missingCollection(err)) { setup = false; console.warn("Order change collections are not set up:", err); }
      else { console.error("Could not read the order history:", err); return { kind: "unavailable", message: "Your order was found but its history could not be loaded. Please try again." }; }
    }
    const fields = form ? L.fieldDefs(form.fields) : [];
    const catalog = L.catalogOf(fields);
    const effective = L.replay(o, updates, reviews, catalog, fields);
    return { kind: "ok", order: o, form, fields, catalog, updates, reviews, effective, contact, logoUrl: /^https?:\/\/\S+$/i.test(String(cfg.logoUrl || "")) ? cfg.logoUrl : "", setup };
  }

  /* the shape the drawing code below uses */
  function buildView(src) {
    const o = src.order, e = src.effective;
    const st = String(o.status || "pending").toLowerCase();
    let canModify = true, reason = "";
    if (!src.setup) { canModify = false; reason = "Order changes are not set up for this store yet. Please contact the seller."; }
    else if (st === "cancelled") { canModify = false; reason = "This order was cancelled. Please contact the seller."; }
    else if (st === "delivered") { canModify = false; reason = "This order has been delivered, so it can no longer be changed. Please contact the seller."; }
    else if (!src.form) { canModify = false; reason = "This store is no longer available. Please contact the seller."; }
    const items = e.items.map(it => {
      const c = src.catalog.find(x => L.itemKey(x) === L.itemKey(it));
      return { label: it.label, name: it.name, description: it.description, qty: it.qty, price: it.price, imageUrl: c ? c.imageUrl : "", soldOut: !!(c && c.soldOut), inStore: !!c };
    });
    const history = [{ at: o.$createdAt, title: "Order placed", status: "", lines: [] }];
    e.steps.forEach(s => history.push({
      at: s.at, title: "Update " + s.seq + (s.bySeller ? " (made by the seller)" : ""), status: s.status,
      lines: L.summarizeStep(s).concat(s.proofs.length ? [s.proofs.length === 1 ? "1 payment image sent" : s.proofs.length + " payment images sent"] : [], s.note && !s.bySeller ? ["Your note: " + s.note] : [], s.reviewNote ? ["Seller's note: " + s.reviewNote] : [],
        s.verified > 0 ? ["Seller confirmed " + L.fmt(s.verified) + " received"] : [])
    }));
    e.audit.forEach(a => history.push({ at: a.at, title: L.AUDIT_TITLE[a.decision] || "Order record changed", status: "", lines: [] }));
    history.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return {
      ref: o.publicOrderID, status: st, createdAt: o.$createdAt, storeName: src.form ? String(src.form.title || "") : "", logoUrl: src.logoUrl,
      contact: src.contact, items, fees: e.fees, originalTotal: e.originalTotal, total: e.total, paid: e.paid, due: e.due, credit: e.credit,
      info: e.info, canModify, cannotModifyReason: reason, updateWaiting: e.pending > 0, catalog: canModify ? src.catalog : [], history: history.slice(0, 40)
    };
  }

  /* ---------- derived numbers ---------- */
  function currentLines() {
    const lines = order.items.map(it => {
      const key = L.itemKey(it);
      return Object.assign({}, it, { key, want: Object.prototype.hasOwnProperty.call(qtyEdits, key) ? qtyEdits[key] : it.qty, existing: true });
    });
    Object.keys(qtyEdits).forEach(key => {
      if (lines.some(l => l.key === key) || !(qtyEdits[key] > 0)) return;
      const c = order.catalog.find(x => L.itemKey(x) === key);
      if (c) lines.push({ label: c.label, name: c.name, description: c.description, price: c.price, imageUrl: c.imageUrl, soldOut: c.soldOut, qty: 0, want: qtyEdits[key], existing: false, key });
    });
    return lines;
  }
  function computeChange() {
    const lines = currentLines();
    const before = order.items.map(i => ({ label: i.label, name: i.name, qty: i.qty, price: i.price }));
    const after = lines.filter(l => l.want > 0).map(l => ({ label: l.label, name: l.name, qty: l.want, price: l.price }));
    const diff = L.diffItems(before, after);
    const newTotal = L.round2(order.total - L.subtotal(before) + L.subtotal(after));
    const infoChanged = order.info.filter(e => e.editable && Object.prototype.hasOwnProperty.call(infoEdits, e.label) && infoEdits[e.label].trim() !== e.value);
    return {
      lines, diff, infoChanged, newTotal, active: after.length,
      has: !L.diffIsEmpty(diff) || infoChanged.length > 0,
      due: Math.max(0, L.round2(newTotal - order.paid)), credit: Math.max(0, L.round2(order.paid - newTotal))
    };
  }

  /* ---------- rendering ---------- */
  function renderAll() {
    renderHead(); renderConfirmation(); renderSummary(); renderItems(); renderAdd(); renderInfo(); renderPay(true); renderReview(); renderHistory(); renderCardSave(); renderContact();
  }
  function badge(text, tone) { return `<span class="xr-badge xr-badge--${tone} xr-badge--dot">${esc(text)}</span>`; }

  function renderHead() {
    const [label, tone] = STATUS[order.status] || [order.status, "neutral"];
    const logo = safeUrl(order.logoUrl);
    $("opHead").innerHTML = `
      <div class="op-head">
        ${logo ? `<img class="op-store-logo" src="${logo}" alt="">`
               : `<span class="op-store-initial" aria-hidden="true">${esc((order.storeName || "X").trim().charAt(0).toUpperCase() || "X")}</span>`}
        <div class="op-head__main">
          <p class="op-store">${esc(order.storeName || "Your order")}</p>
          <p class="op-meta">Order <strong>${esc(order.ref)}</strong> · ${esc(fmtDate(order.createdAt))}</p>
        </div>
      </div>
      <div class="op-badges">${badge(label, tone)}${order.updateWaiting ? badge("Your update is waiting for the seller", "info") : ""}</div>`;
    const img = $("opHead").querySelector(".op-store-logo");
    if (img) img.addEventListener("error", () => {
      const span = document.createElement("span");
      span.className = "op-store-initial"; span.setAttribute("aria-hidden", "true");
      span.textContent = (order.storeName || "X").trim().charAt(0).toUpperCase() || "X";
      img.replaceWith(span);
    });
  }

  function renderSummary() {
    const c = computeChange();
    const rows = [`<li class="op-row"><span>Original order total</span><strong>${L.fmt(order.originalTotal)}</strong></li>`];
    if (order.fees > 0) rows.push(`<li class="op-row"><span>Includes delivery and fees</span><strong>${L.fmt(order.fees)}</strong></li>`);
    rows.push(`<li class="op-row op-row--total"><span>Current order total</span><strong>${L.fmt(order.total)}</strong></li>`);
    if (order.paid > 0) rows.push(`<li class="op-row op-row--ok"><span>Paid and confirmed</span><strong>${L.fmt(order.paid)}</strong></li>`);
    if (order.due > 0) rows.push(`<li class="op-row op-row--due"><span>Still to pay</span><strong>${L.fmt(order.due)}</strong></li>`);
    if (order.credit > 0) rows.push(`<li class="op-row"><span>Paid more than the total</span><strong>${L.fmt(order.credit)}</strong></li>`);
    let extra = "";
    if (c.has) {
      extra = `<ul class="op-rows" style="margin-top:12px"><li class="op-row op-row--total"><span>New total if you submit</span><strong>${L.fmt(c.newTotal)}</strong></li>
        ${c.due > 0 ? `<li class="op-row op-row--due"><span>You would still owe</span><strong>${L.fmt(c.due)}</strong></li>` : ""}
        ${c.credit > 0 ? `<li class="op-row"><span>Paid more than the new total</span><strong>${L.fmt(c.credit)}</strong></li>` : ""}</ul>`;
    }
    $("opSummary").innerHTML = `<h2 class="op-sec-title">Order summary</h2><ul class="op-rows">${rows.join("")}</ul>${extra}
      ${order.credit > 0 ? `<p class="op-note">You have paid more than this order now costs. The seller will settle the difference with you.</p>` : ""}`;
  }

  function lineHTML(l, c) {
    const img = safeUrl(l.imageUrl);
    const removed = l.want === 0;
    const only = c.active <= 1 && !removed;
    const canInc = order.canModify && l.want < L.MAX_QTY && !(l.soldOut && l.want >= l.qty);
    const idx = kid(l.key);
    let ctl = "";
    if (order.canModify) {
      ctl = removed
        ? `<div class="op-line__ctl"><span class="xr-text-2 xr-small">Will be removed</span><button type="button" class="op-link op-link--neutral" data-act="restore" data-k="${idx}">Undo</button></div>`
        : `<div class="op-line__ctl">
             <div class="op-stepper" role="group" aria-label="Quantity of ${esc(l.name)}">
               <button type="button" data-act="dec" data-k="${idx}" aria-label="Fewer ${esc(l.name)}" ${only && l.want <= 1 ? "disabled" : ""}>−</button>
               <output aria-live="polite">${l.want}</output>
               <button type="button" data-act="inc" data-k="${idx}" aria-label="More ${esc(l.name)}" ${canInc ? "" : "disabled"}>+</button>
             </div>
             ${only ? "" : `<button type="button" class="op-link" data-act="remove" data-k="${idx}">Remove</button>`}
           </div>`;
    }
    const tag = !l.existing ? `<span class="op-tag op-tag--new">New</span>` : (l.want !== l.qty && !removed ? `<span class="op-tag">Was ${l.qty}</span>` : "");
    const out = l.existing && l.soldOut ? `<span class="op-tag op-tag--out">Sold out: can't add more</span>` : "";
    return `<li class="op-line ${removed ? "op-line--removed" : ""}" style="list-style:none">
      ${img ? `<img class="op-line__img" src="${img}" alt="" loading="lazy">` : `<span class="op-line__ph" aria-hidden="true">${esc(l.name.charAt(0).toUpperCase())}</span>`}
      <div><p class="op-line__name">${esc(l.name)}${tag}${out}</p><p class="op-line__price">${L.fmt(l.price)} each${l.want > 0 ? " · " + L.fmt(l.price * l.want) : ""}</p></div>
      ${ctl}</li>`;
  }
  function renderItems() {
    const c = computeChange();
    $("opItems").innerHTML = `<h2 class="op-sec-title">Your items</h2>
      <ul class="op-rows" style="gap:0;padding:0">${c.lines.map(l => lineHTML(l, c)).join("")}</ul>
      ${order.canModify ? "" : `<p class="op-note">${esc(order.cannotModifyReason)}</p>`}`;
  }

  function renderAdd() {
    const sec = $("opAdd");
    if (!order.canModify || !order.catalog.length) { sec.hidden = true; return; }
    sec.hidden = false;
    const q = catalogQuery.trim().toLowerCase();
    const list = order.catalog.filter(p => !q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q));
    const c = computeChange();
    const rows = list.map(p => {
      const key = L.itemKey(p);
      const inOrder = c.lines.some(l => l.key === key && l.want > 0) || c.lines.some(l => l.key === key && l.existing);
      const img = safeUrl(p.imageUrl);
      const btn = inOrder ? `<button type="button" class="op-add-btn" disabled>In your order</button>`
        : p.soldOut ? `<button type="button" class="op-add-btn" disabled>Sold out</button>`
        : `<button type="button" class="op-add-btn" data-act="addprod" data-k="${kid(key)}" aria-label="Add ${esc(p.name)}">Add</button>`;
      return `<li class="op-cat" style="list-style:none">${img ? `<img src="${img}" alt="" loading="lazy" style="border-radius:8px;object-fit:cover">` : `<span class="op-line__ph" aria-hidden="true">${esc(p.name.charAt(0).toUpperCase())}</span>`}
        <div><p class="op-cat__name">${esc(p.name)}</p><p class="op-cat__price">${L.fmt(p.price)}${p.category ? " · " + esc(p.category) : ""}</p></div>${btn}</li>`;
    }).join("");
    sec.innerHTML = `<h2 class="op-sec-title">Add more products</h2>
      <input class="xr-input op-search" id="opSearch" type="search" placeholder="Search this store" value="${esc(catalogQuery)}" aria-label="Search products">
      <ul class="op-catalog">${rows || `<li class="op-empty" style="list-style:none">No products match.</li>`}</ul>`;
  }

  function renderInfo() {
    const sec = $("opInfo");
    if (!order.info.length) { sec.hidden = true; return; }
    sec.hidden = false;
    const fields = order.info.map((e, i) => {
      const val = Object.prototype.hasOwnProperty.call(infoEdits, e.label) ? infoEdits[e.label] : e.value;
      if (!order.canModify || !e.editable) return `<div class="op-readonly"><strong>${esc(e.label)}</strong>${esc(e.value)}</div>`;
      const id = "opInfo" + i;
      const control = e.type === "textarea" ? `<textarea class="xr-textarea" id="${id}" data-info="${i}" maxlength="500">${esc(val)}</textarea>`
        : e.type === "dropdown" && e.options.length ? `<select class="xr-select" id="${id}" data-info="${i}">${e.options.map(o => `<option value="${esc(o)}" ${o === val ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`
        : `<input class="xr-input" id="${id}" data-info="${i}" type="${e.type === "number" ? "number" : "text"}" maxlength="500" value="${esc(val)}">`;
      return `<div class="xr-field"><label class="xr-label" for="${id}">${esc(e.label)}</label>${control}</div>`;
    }).join("");
    sec.innerHTML = `<h2 class="op-sec-title">Your details</h2><div class="op-form">${fields}</div>`;
  }

  function needsPaySection(c) { return order.canModify && (c.due > 0 || order.due > 0); }
  function renderPay(force) {
    const c = computeChange();
    const sec = $("opPay");
    const visible = needsPaySection(c);
    const sig = [visible, files.map(f => f.url).join(","), c.due, order.due].join("|");
    if (!force && sig === lastPaySig) return;
    lastPaySig = sig;
    if (!visible) { sec.hidden = true; sec.innerHTML = ""; return; }
    sec.hidden = false;
    const owed = c.has ? c.due : order.due;
    sec.innerHTML = `<h2 class="op-sec-title">Payment for the extra amount</h2>
      <p class="op-note" style="margin:0 0 12px">${owed > 0 ? `Pay <strong>${L.fmt(owed)}</strong> the same way you paid for your order, then add a picture of the receipt here.` : "Add a picture of your payment receipt."} The seller checks it before your order shows as paid.</p>
      <div class="op-form">
        <div class="op-files">${files.map((f, i) => `<div class="op-file"><img src="${esc(f.url)}" alt="Payment image ${i + 1}"><button type="button" data-act="rmfile" data-i="${i}" aria-label="Remove payment image ${i + 1}">×</button></div>`).join("")}</div>
        ${files.length < MAX_FILES ? `<label class="op-upload"><input type="file" id="opFile" accept="image/*" multiple>${files.length ? "Add another payment image" : "Choose payment image"}</label>` : ""}
        <div class="xr-field"><label class="xr-label" for="opPayName">Name on payment</label><input class="xr-input" id="opPayName" data-pay="name" type="text" autocomplete="name" maxlength="80" value="${esc(pay.name)}" placeholder="Name shown on your bank transfer"></div>
        <div class="xr-field"><label class="xr-label" for="opPayDate">Date paid</label><input class="xr-input" id="opPayDate" data-pay="date" type="date" max="${today()}" value="${esc(pay.date)}"></div>
      </div>`;
  }

  function changeLines(c) {
    const out = [];
    c.diff.added.forEach(i => out.push(`Add ${i.name} × ${i.qty}`));
    c.diff.removed.forEach(i => out.push(`Remove ${i.name}`));
    c.diff.changed.forEach(i => out.push(`${i.name}: ${i.from} → ${i.to}`));
    c.infoChanged.forEach(e => out.push(`Change ${e.label}`));
    return out;
  }
  const changeList = c => changeLines(c).map(esc);
  function renderReview() {
    const sec = $("opReview"), sticky = ensureSticky();
    const c = computeChange();
    const mode = !order.canModify ? "" : c.has ? "update" : (order.due > 0 ? "proof" : "");
    if (!mode) { sec.hidden = true; sticky.hidden = true; return; }
    sec.hidden = false;
    const err = sec.dataset.err ? `<div class="xr-alert xr-alert--error" role="alert" style="margin-bottom:12px"><div>${esc(sec.dataset.err)}</div></div>` : "";
    if (mode === "update") {
      sec.innerHTML = `<h2 class="op-sec-title">Review your changes</h2>${err}
        <ul class="op-changes">${changeList(c).map(t => `<li>${t}</li>`).join("")}</ul>
        <ul class="op-rows"><li class="op-row op-row--total"><span>New total</span><strong>${L.fmt(c.newTotal)}</strong></li>
          ${c.due > 0 ? `<li class="op-row op-row--due"><span>Amount still to pay</span><strong>${L.fmt(c.due)}</strong></li>` : `<li class="op-row op-row--ok"><span>Nothing more to pay</span><strong>${L.fmt(0)}</strong></li>`}</ul>
        ${c.due > 0 ? `<p class="op-note">${files.length ? "Your payment image will be sent with this update." : "You can send your payment image now, above, or later from this page."}</p>` : ""}
        <div class="xr-field" style="margin-top:12px"><label class="xr-label" for="opNote">Message to the seller <span class="xr-optional">(optional)</span></label><textarea class="xr-textarea" id="opNote" data-note maxlength="300" style="min-height:64px">${esc(note)}</textarea></div>
        <div class="op-review-actions"><button type="button" class="xr-btn xr-btn--primary" data-act="submit" ${busy ? "disabled" : ""}>${busy ? "Sending…" : "Submit update"}</button>
        <button type="button" class="xr-btn xr-btn--ghost" data-act="undo" ${busy ? "disabled" : ""}>Undo all changes</button></div>`;
      sticky.hidden = false;
      sticky.querySelector(".op-sticky__txt").innerHTML = `<strong>New total ${L.fmt(c.newTotal)}</strong>${c.due > 0 ? "Still to pay " + L.fmt(c.due) : "Nothing more to pay"}`;
    } else {
      sticky.hidden = true;
      sec.innerHTML = `<h2 class="op-sec-title">Send payment evidence</h2>${err}
        <p class="op-note" style="margin:0 0 12px">Add the receipt above, then send it to the seller.</p>
        <button type="button" class="xr-btn xr-btn--primary" data-act="submit" ${busy ? "disabled" : ""}>${busy ? "Sending…" : "Send payment evidence"}</button>`;
    }
  }
  function ensureSticky() {
    let s = $("opSticky");
    if (!s) {
      s = document.createElement("div");
      s.id = "opSticky"; s.className = "op-sticky"; s.hidden = true;
      s.innerHTML = `<div class="op-sticky__in"><div class="op-sticky__txt"></div><button type="button" class="xr-btn xr-btn--primary" data-act="jump">Review</button></div>`;
      document.body.appendChild(s);
    }
    return s;
  }


  function renderHistory() {
    const sec = $("opHistory");
    if (order.history.length < 2) { sec.hidden = true; return; }
    sec.hidden = false;
    const badgeFor = s => s ? `<span class="xr-badge xr-badge--${s === "approved" ? "paid" : s === "rejected" ? "cancelled" : "attention"}">${esc(L.STATUS_LABEL[s] || s)}</span>` : "";
    sec.innerHTML = `<h2 class="op-sec-title">Order history</h2><ol class="op-time">${order.history.map(h => `<li>
      <p class="op-time__title">${esc(h.title)} ${badgeFor(h.status)}</p><p class="op-time__when">${esc(fmtWhen(h.at))}</p>
      ${h.lines.length ? `<ul class="op-time__lines">${h.lines.map(t => `<li style="border:0;padding:0">${esc(t)}</li>`).join("")}</ul>` : ""}</li>`).join("")}</ol>`;
  }

  function renderConfirmation() {
    const sec = $("opConfirm");
    if (!confirmation) { sec.hidden = true; sec.innerHTML = ""; return; }
    sec.hidden = false;
    const c = confirmation;
    sec.innerHTML = `<h2 class="op-sec-title">Update sent to the seller</h2>
      <ul class="op-changes">${c.lines.map(t => `<li>${esc(t)}</li>`).join("")}</ul>
      <ul class="op-rows"><li class="op-row"><span>Total before</span><strong>${L.fmt(c.previousTotal)}</strong></li>
      <li class="op-row op-row--total"><span>New total</span><strong>${L.fmt(c.newTotal)}</strong></li>
      ${c.due > 0 ? `<li class="op-row op-row--due"><span>Still to pay</span><strong>${L.fmt(c.due)}</strong></li>` : ""}</ul>
      <p class="op-note">The seller will review your update. Until then it shows as waiting. ${c.due > 0 && !c.hadProof ? "Add your payment image below when you have paid the extra amount." : ""}</p>`;
  }

  function cardData() {
    const [label] = STATUS[order.status] || [order.status];
    const owing = order.due > 0 && order.status !== "cancelled";
    return {
      storeName: order.storeName, logoUrl: order.logoUrl, publicId, dateText: fmtDate(order.createdAt),
      items: order.items.map(i => ({ name: i.name, qty: i.qty, price: i.price })), feesAmount: order.fees, total: order.total,
      paymentStatus: owing ? "Still to pay: " + L.fmt(order.due) : label,
      paymentTone: order.status === "cancelled" ? "bad" : owing ? "warn" : order.status === "paid" || order.status === "delivered" ? "good" : "info",
      contact: order.contact, retrievalUrl: new URL("order.html" + (FID ? "?fid=" + encodeURIComponent(FID) : ""), window.location.href).href, updatesEnabled: true
    };
  }

  function renderCardSave() {
    $("opCardSave").innerHTML = `<h2 class="op-sec-title">Your order card</h2>
      <p class="op-note" style="margin:0 0 12px">Save a card with your current items, total and code.</p>
      <button type="button" class="xr-btn xr-btn--secondary xr-btn--block" data-act="download">Download order card</button>
      <p class="xr-hint" id="ocHint" style="margin-top:8px"></p>`;
  }
  function renderContact() {
    const c = order.contact || {};
    const parts = [];
    let wa = String(c.whatsapp || "").replace(/\D/g, "");
    if (wa.startsWith("0") && wa.length === 11) wa = "234" + wa.slice(1);
    if (wa.length >= 10) parts.push(`<a class="xr-btn xr-btn--secondary" href="https://wa.me/${wa}?text=${encodeURIComponent("Hello, about my order " + order.ref)}" target="_blank" rel="noopener">Message the seller on WhatsApp</a>`);
    const ph = String(c.phone || "").replace(/[^\d+]/g, "");
    if (ph.length >= 7) parts.push(`<a class="xr-btn xr-btn--secondary" href="tel:${esc(ph)}">Call the seller</a>`);
    $("opContact").innerHTML = parts.join("");
  }


  /* ---------- actions ---------- */
  function showGateMessage(text) { const m = $("opGateMsg"); m.textContent = text || ""; m.hidden = !text; }
  // A tap-rate brake for honest mistakes only. Anyone can bypass it, so it is not a security control (see docs/ORDER-RETRIEVAL.md).
  const FAIL_KEY = "xr-order-fails";
  function failState() { try { return JSON.parse(localStorage.getItem(FAIL_KEY) || "{}"); } catch (e) { return {}; } }
  function noteFail() { try { const s = failState(); const now = Date.now(); const list = (s.t || []).filter(t => now - t < 15 * 60e3); list.push(now); localStorage.setItem(FAIL_KEY, JSON.stringify({ t: list })); } catch (e) { /* ignore */ } }
  function lockedMinutes() { const now = Date.now(); const list = (failState().t || []).filter(t => now - t < 15 * 60e3); return list.length >= 8 ? Math.ceil((15 * 60e3 - (now - list[0])) / 60e3) : 0; }

  function showOffMessage(res) {
    $("opGate").hidden = true; $("opView").hidden = true; $("opOff").hidden = false;
    const c = res.contact || {};
    let wa = String(c.whatsapp || "").replace(/\D/g, ""); if (wa.startsWith("0") && wa.length === 11) wa = "234" + wa.slice(1);
    const parts = [];
    if (wa.length >= 10) parts.push(`<a class="xr-btn xr-btn--secondary" href="https://wa.me/${wa}" target="_blank" rel="noopener">Message the seller on WhatsApp</a>`);
    const ph = String(c.phone || "").replace(/[^\d+]/g, ""); if (ph.length >= 7) parts.push(`<a class="xr-btn xr-btn--secondary" href="tel:${esc(ph)}">Call the seller</a>`);
    $("opOff").innerHTML = `<h1 class="xr-h2">Order changes are turned off</h1>
      <p class="xr-text-2">${esc(res.storeName || "The seller")} has turned off order changes, so orders can't be retrieved or updated right now. Please contact the seller about your order.</p>
      <div class="op-contact">${parts.join("")}</div>`;
  }

  async function find() {
    if (busy) return;
    const mins = lockedMinutes();
    if (mins) { showGateMessage("Too many tries. Please wait about " + mins + " minute" + (mins === 1 ? "" : "s") + " and try again."); return; }
    const typed = $("opCode").value;
    if (!L.isValidIdShape(typed)) { showGateMessage("That doesn't look like an order ID. It has 12 letters and numbers, like X7KM92PQ4N8Z."); return; }
    busy = true; $("opGateBtn").disabled = true; $("opGateBtn").textContent = "Looking…"; showGateMessage("");
    try {
      const id = L.normalizeId(typed);
      const res = await loadOrder(id);
      if (res.kind === "ok") {
        publicId = id; source = res; order = buildView(res); resetEdits();
        $("opGate").hidden = true; $("opView").hidden = false; $("opCode").value = "";
        renderAll(); window.scrollTo(0, 0);
      } else if (res.kind === "off") showOffMessage(res);
      else if (res.kind === "notfound") { noteFail(); showGateMessage("That order ID didn't match an order. Check it and try again."); }
      else showGateMessage(res.message);
    } catch (e) {
      console.error(e);
      showGateMessage("Could not reach the order service. Check your connection and try again.");
    } finally { busy = false; $("opGateBtn").disabled = false; $("opGateBtn").textContent = "Find my order"; }
  }
  function resetEdits() { qtyEdits = {}; infoEdits = {}; files = []; pay = { name: "", date: "" }; note = ""; catalogQuery = ""; lastPaySig = ""; $("opReview").dataset.err = ""; }
  function leave() { publicId = ""; source = null; order = null; confirmation = null; resetEdits(); $("opView").hidden = true; $("opGate").hidden = false; ensureSticky().hidden = true; showGateMessage(""); $("opCode").focus(); }

  async function reloadOrder() {
    const res = await loadOrder(publicId);
    if (res.kind === "off") { showOffMessage(res); ensureSticky().hidden = true; return false; }
    if (res.kind !== "ok") throw new Error(res.message || "The order could not be reloaded.");
    source = res; order = buildView(res); return true;
  }

  function refreshLive() { renderSummary(); renderItems(); renderAdd(); renderPay(false); renderReview(); }
  function keyOf(el) { return keyIds[Number(el.getAttribute("data-k"))]; }

  function addFiles(list) {
    const room = MAX_FILES - files.length;
    Array.from(list).slice(0, room).forEach(f => {
      if (!/^image\//.test(f.type || "")) { showToast("Please choose a picture of your payment", "warning"); return; }
      if (f.size > MAX_FILE_BYTES) { showToast("That image is too large (10 MB limit)", "warning"); return; }
      files.push({ file: f, url: URL.createObjectURL(f), id: "" });
    });
    renderPay(true); renderReview();
  }

  async function submit() {
    if (busy) return;
    const sec = $("opReview");
    sec.dataset.err = "";
    const c = computeChange();
    if (files.length) {
      if (!pay.name.trim()) { sec.dataset.err = "Please enter the name shown on the payment."; renderReview(); return; }
      if (!pay.date) { sec.dataset.err = "Please choose the date you paid."; renderReview(); return; }
      if (pay.date > today()) { sec.dataset.err = "The date paid can't be in the future."; renderReview(); return; }
    } else if (!c.has) { sec.dataset.err = "Please add a payment image first."; renderReview(); return; }

    busy = true; renderReview();
    try {
      // the rules are checked again against the order as it is right now, not as this page last saw it
      if (!(await reloadOrder())) return;
      for (const f of files) {
        if (f.id) continue;
        const up = await storage.createFile(BUCKET, Appwrite.ID.unique(), f.file, [Appwrite.Permission.read(Appwrite.Role.any())]);
        f.id = up.$id;
      }
      const eff = source.effective;
      const request = { items: [], info: {} };
      c.lines.forEach(l => { if (l.want !== (l.existing ? l.qty : 0)) request.items.push({ label: l.label, name: l.name, qty: l.want }); });
      c.infoChanged.forEach(e => { request.info[e.label] = infoEdits[e.label].trim(); });
      const hasChanges = request.items.length || Object.keys(request.info).length;
      if (!hasChanges) {
        // payment evidence on its own: recorded as an update with no item changes
        if (!files.length) throw new Error("Nothing was changed.");
        const id = Appwrite.ID.unique();
        const record = {
          orderID: source.order.$id, publicOrderID: source.order.publicOrderID, sellerID: source.order.userId, seq: eff.lastSeq + 1, orderSeq: source.order.$id + ":" + (eff.lastSeq + 1),
          previousItems: JSON.stringify(L.compactItems(eff.items)), updatedItems: JSON.stringify(L.compactItems(eff.items)), changes: "[]", infoChanges: "[]",
          previousTotal: eff.total, newTotal: eff.total, additionalAmount: 0, changeType: "payment", paymentProof: JSON.stringify(files.map(f => f.id)),
          paymentDetails: JSON.stringify({ name: pay.name.trim(), date: pay.date }), paymentStatus: "submitted", updateStatus: "pending", note: note.trim()
        };
        await saveUpdate(id, record);
        confirmation = { lines: ["Payment evidence sent"], previousTotal: eff.total, newTotal: eff.total, due: eff.due, hadProof: true };
      } else {
        const plan = L.planUpdate(source.order, eff, source.catalog, source.fields, request, { proofs: files.map(f => f.id), payName: pay.name, payDate: pay.date, note });
        if (!plan.ok) throw new Error(plan.message);
        const id = Appwrite.ID.unique();
        await saveUpdate(id, plan.record);
        confirmation = { lines: changeLines(c), previousTotal: eff.total, newTotal: plan.newTotal, due: plan.due, hadProof: files.length > 0 };
      }
      if (typeof xrTelegramNotify === "function") xrTelegramNotify("order_updated", source.order.$id, lastUpdateId);
      resetEdits();
      await reloadOrder();
      renderAll();
      showToast("Your update was sent to the seller", "success");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      sec.dataset.err = (e && e.message) || "Could not send. Check your connection and try again. Your changes are still here.";
      renderReview();
      showToast(sec.dataset.err, "error");
    } finally { busy = false; if (order) renderReview(); }
  }

  /* One document per update. Customers can create it but never edit or delete it (read-only permission, no update/delete roles). */
  let lastUpdateId = "";
  async function saveUpdate(id, record) {
    const doc = Object.assign({}, record, { updateID: id, createdAt: new Date().toISOString() });
    try {
      await databases.createDocument(DB_ID, UPDATES, id, doc, [Appwrite.Permission.read(Appwrite.Role.any())]);
      lastUpdateId = id;
    } catch (err) {
      if (err && err.code === 409) {
        // someone (another device, or the seller's page) saved a newer version first: unique index on orderSeq
        await reloadOrder(); renderAll();
        throw new Error("Your order changed while you were editing (another update was saved first). It has been reloaded; please review and send again.");
      }
      if (missingCollection(err) || (err && err.code === 400 && /attribute|structure/i.test(String(err.message || "")))) throw new Error("Order changes are not set up for this store yet. Please contact the seller.");
      if (err && (err.code === 401 || err.code === 403)) throw new Error("This store's database does not allow order changes yet. Please contact the seller.");
      throw err;
    }
  }

  /* ---------- events ---------- */
  document.addEventListener("click", e => {
    const el = e.target.closest("[data-act]");
    if (!el || !order) return;
    const act = el.getAttribute("data-act");
    const c = computeChange();
    if (act === "inc" || act === "dec") {
      const key = keyOf(el);
      const l = c.lines.find(x => x.key === key); if (!l) return;
      let want = l.want + (act === "inc" ? 1 : -1);
      if (want < 0) want = 0;
      if (act === "dec" && want === 0 && c.active <= 1) return;
      if (act === "inc" && (want > L.MAX_QTY || (l.soldOut && want > l.qty))) return;
      if (l.existing) qtyEdits[key] = want; else if (want > 0) qtyEdits[key] = want; else delete qtyEdits[key];
      refreshLive();
    } else if (act === "remove") {
      const key = keyOf(el); const l = c.lines.find(x => x.key === key); if (!l || c.active <= 1) return;
      if (l.existing) qtyEdits[key] = 0; else delete qtyEdits[key];
      refreshLive();
    } else if (act === "restore") {
      const key = keyOf(el); delete qtyEdits[key]; refreshLive();
    } else if (act === "addprod") {
      qtyEdits[keyOf(el)] = 1; refreshLive();
    } else if (act === "undo") {
      qtyEdits = {}; infoEdits = {}; $("opReview").dataset.err = ""; renderInfo(); refreshLive();
    } else if (act === "rmfile") {
      const f = files.splice(Number(el.getAttribute("data-i")), 1)[0]; if (f) URL.revokeObjectURL(f.url);
      renderPay(true); renderReview();
    } else if (act === "submit") { submit(); }
    else if (act === "jump") { $("opReview").scrollIntoView({ behavior: "smooth", block: "start" }); }
    else if (act === "download") {
      if (!window.XrOrderCard) return;
      XrOrderCard.setCurrent(cardData()); XrOrderCard.download(el);
    }
  });
  document.addEventListener("input", e => {
    const t = e.target;
    if (t.id === "opSearch") { catalogQuery = t.value; const pos = t.selectionStart; renderAdd(); const s = $("opSearch"); if (s) { s.focus(); try { s.setSelectionRange(pos, pos); } catch (x) { /* ignore */ } } return; }
    if (!order) return;
    if (t.hasAttribute("data-info")) {
      const entry = order.info[Number(t.getAttribute("data-info"))]; if (!entry) return;
      infoEdits[entry.label] = t.value; renderSummary(); renderReview();
    } else if (t.getAttribute("data-pay") === "name" || t.getAttribute("data-pay") === "date") {
      pay[t.getAttribute("data-pay")] = t.value;
      const sec = $("opReview");
      if (sec.dataset.err) { sec.dataset.err = ""; const al = sec.querySelector(".xr-alert"); if (al) al.remove(); } // the message was about this field
    }
    else if (t.hasAttribute("data-note")) note = t.value;
  });
  document.addEventListener("change", e => {
    if (e.target.id === "opFile") { addFiles(e.target.files); e.target.value = ""; }
    else if (e.target.getAttribute && e.target.getAttribute("data-pay") === "date") pay.date = e.target.value;
  });
  $("opGateForm").addEventListener("submit", e => { e.preventDefault(); find(); });
  $("opCode").addEventListener("input", e => {
    e.target.value = L.normalizeId(e.target.value).slice(0, L.ID_LENGTH);
    showGateMessage("");
  });
  $("opLeave").addEventListener("click", leave);


  if (FID) {
    // brand the page and honour the seller's switch before the customer even types an ID
    databases.getDocument(DB_ID, FORMS, FID).then(f => {
      $("opGateStore").textContent = f.title || "";
      if (f.customerOrderUpdatesEnabled === false) {
        let cfg = {}; try { cfg = typeof f.storeConfig === "string" ? JSON.parse(f.storeConfig) : (f.storeConfig || {}); } catch (e) { cfg = {}; }
        showOffMessage({ storeName: f.title || "", contact: { whatsapp: cfg.whatsapp || f.whatsappNumber || "", phone: cfg.phone || "" } });
      }
    }).catch(() => {});
  }
})();
