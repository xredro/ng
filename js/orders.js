/* =========================
FILE OVERVIEW
========================= */
// Order management and reporting application with Appwrite

/* =========================
GLOBAL CONSTANTS / CONFIG
========================= */
const DB_ID = "695c4fce0039f513dc83";
const USERS = "695c501b001d24549b03";
const FORMS = "form";
const SUBS = "subscriptions";
const ORDERS = "orders";
const PAYMENTS = "payments";
const PRODUCT_IMAGES_BUCKET = "696825350032fe17c1eb";

/* =========================
EXTERNAL SERVICE SETUP
========================= */
const client = new Appwrite.Client()
  .setEndpoint('https://nyc.cloud.appwrite.io/v1')
  .setProject('695981480033c7a4eb0d');

const account = new Appwrite.Account(client);
const databases = new Appwrite.Databases(client);
const Query = Appwrite.Query;

/* =========================
GLOBAL STATE VARIABLES
========================= */
let profileDocId = null;
let user;
let res;
let businessTitle = "Your Business";

let allOrders = [];
let activeFilter = "all";
// long lists are drawn 30 at a time so a phone stays quick with hundreds of orders
const RENDER_STEP = 30;
let renderLimit = RENDER_STEP;

const EXPAND_DOWN = `
<path d="m480-340 180-180-57-56-123 123-123-123-57 56 180 180Zm0 260q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z"/>`;

const CLOSE_EXPAND = `
<path d="m357-384 123-123 123 123 57-56-180-180-180 180 57 56ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z"/>`;

/* =========================
UTILITY / HELPER FUNCTIONS
========================= */
// Keep all text inserted into HTML safe and available on this page.
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

const STATUS_LABEL = { pending: "Unpaid", paid: "Paid", delivered: "Delivered", cancelled: "Cancelled" };
const STATUS_BADGE = { pending: "unpaid", paid: "paid", delivered: "delivered", cancelled: "cancelled" };

// an unpaid order the customer has already uploaded proof for: it needs the seller to check it
function needsReview(order) {
  return normalizedStatus(order) === "pending" && !!order.paymentProof;
}
function isNewOrder(order) {
  return normalizedStatus(order) === "pending" && Date.now() - new Date(order.$createdAt).getTime() < 24 * 3600e3;
}

function normalizedStatus(order) {
  const value = String(order?.status ?? "").trim().toLowerCase();
  // Older records may store the display label rather than the internal value.
  if (value === "unpaid") return "pending";
  return value;
}
/* =========================================================
   PAYMENT SYSTEM DISABLED — kept for reference, not deleted.
   The Selar-based buySubscription() flow below is commented
   out. Selling/trial-renewal now goes through
   goToPaymentUpload() instead, which sends the seller to an
   external page to upload proof of payment manually.
   To re-enable Selar checkout, uncomment the block below and
   swap the button handlers back to buySubscription(days).
========================================================= */
/*
ORIGINAL_BUY_SUBSCRIPTION_START
async function buySubscription(days) {
  const btn = document.activeElement;
  if (btn) {
    btn.disabled = true;
    btn.innerText = "Redirecting…";
  }
  try {
    const plan = days === 7 ? "7 days" : "30 days";
    const amount = days === 7 ? 1000 : 3000;

    // Check for existing pending payments
    const existing = await databases.listDocuments(DB_ID, PAYMENTS, [
      Query.equal("userId", user.$id),
      Query.equal("status", "pending"),
      Query.equal("used", false),
      Query.limit(1)
    ]);

    if (existing.documents.length) {
      const oldPayment = existing.documents[0];
      const now = new Date();
      const expiresAt = new Date(oldPayment.expiresAt);

      if (expiresAt > now) {
        // Payment is still valid
        showToast("You already have a pending payment. Please complete it.", "warning");

        await databases.updateDocument(DB_ID, PAYMENTS, oldPayment.$id, {
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() });
        
        // Optional: redirect user directly to Selar with old reference
        const selarLink =
          oldPayment.durationDay === 7
            ? `https://selar.com/9g7elg0071`
            : `https://selar.com/07s670b9vg`;

        // Small delay before redirecting so user sees the toast
        setTimeout(() => window.location.href = selarLink, 1500);
        return;
      } else {
        // Old payment expired → allow new payment
        await databases.updateDocument(DB_ID, PAYMENTS, oldPayment.$id, {
          status: "expired"
        });
      }
    }

    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 30); // token valid for 30 mins

    const payment = await databases.createDocument(
      DB_ID,
      PAYMENTS,
      Appwrite.ID.unique(),
      {
        userId: user.$id,
        plan,
        durationDay: days,
        amount,
        expiresAt: expiresAt.toISOString(),
        used: false,
        status: "pending"
      }
    );

    // Redirect to Selar with new payment reference
    const selarLink =
      days === 7
        ? `https://selar.com/9g7elg0071`
        : `https://selar.com/07s670b9vg`;

    window.location.href = selarLink;

  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.innerText = "Subscribe";
    }
    console.error(err);
    showToast("Unable to start payment", "error");
  }
}
ORIGINAL_BUY_SUBSCRIPTION_END
*/

// Replaces the old buySubscription(days) flow: sends the seller to
// an external page where they upload their payment proof manually.
// TODO: replace this placeholder URL with your real payment/upload page.
const PAYMENT_UPLOAD_URL = "https://xredro.pages.dev/form?fid=697c34ab17039e5fc78f";

function goToPaymentUpload() {
  window.location.href = PAYMENT_UPLOAD_URL;
}

function parseFormData(raw) {
  if (!Array.isArray(raw)) return [];

  return raw
    .map(item => {
      try {
        return typeof item === "string" ? JSON.parse(item) : item;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function getProductSummary(rawFormData, maxItems = 3) {
  const formData = parseFormData(rawFormData);
  const products = [];

  formData.forEach(f => {
    if (f && f.type === "product" && Array.isArray(f.value)) {
      f.value.forEach(p => {
        if (!p || typeof p !== "object") return;
        const name = String(p.name || "Product").trim();
        if (name) products.push(name);
      });
    }
  });

  const visible = maxItems === null ? products : products.slice(0, maxItems);
  const result = visible.join(", ");
  return products.length > visible.length ? `${result}, …` : result;
}

function getCardTitle(order) {
  const formData = parseFormData(order.formData);

  // Filter out product types first
  const nonProducts = formData.filter(f => f.type !== "product" && f.value);

  // Use first non-product label's value
  if (nonProducts.length) {
    return nonProducts[0].value;
  }

  // If no non-product values exist, fallback to second field (if exists)
  if (formData.length > 1 && formData[1].value) {
    return formData[1].value;
  }

  // Fallback default
  return "Order";
}

function normalizeAmount(value) {
  if (value === null || value === undefined) return 0;

  if (typeof value === "number") return value;

  if (typeof value === "string") {
    const clean = value.replace(/[₦,\s]/g, "");
    const num = Number(clean);
    return isNaN(num) ? 0 : num;
  }

  return 0;
}

function normalizeOrdersForExport(orders) {
  return orders.map(order => {
    const formData = parseFormData(order.formData);

    const products = [];
    const details = [];

    formData.forEach(f => {
      if (f.type === "product" && Array.isArray(f.value)) {
        f.value.forEach(p => {
          products.push(`${p.name} × ${p.qty}`);
        });
      } else if (f.value) {
        details.push(`${f.label}: ${f.value}`);
      }
    });

    const amount = normalizeAmount(order.totalAmount);

    return {
      "Order Summary": products.slice(0, 3).join(", "),
      "Order Details": details.concat(products).join("\n"),
      "Payment Status": order.status.toUpperCase(),
      "Total Amount (₦)": `₦${amount.toLocaleString()}`,
      "Last Updated": new Date(order.$updatedAt).toLocaleString()
    };
  });
}

/* =========================
CORE BUSINESS LOGIC
========================= */
async function requireAuth() {
  try {
    return await account.get();
  } catch {
    window.location.replace("login.html");
    return null;
  }
}

// Appwrite returns at most 100 documents per request (25 by default). Fetch every
// page so the list, the counts, "Products to deliver" and "Export PDF" see all orders.
async function fetchAllOrders(userId) {
  const all = [];
  let cursor = null;
  for (;;) {
    const queries = [Query.equal("userId", userId), Query.orderDesc("$createdAt"), Query.limit(100)];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const page = await databases.listDocuments(DB_ID, ORDERS, queries);
    all.push(...page.documents);
    if (page.documents.length < 100 || all.length >= 5000) break;
    cursor = page.documents[page.documents.length - 1].$id;
  }
  return all;
}

function showOrdersError(message) {
  ordersList.removeAttribute("aria-busy");
  ordersList.innerHTML = `
    <div class="xr-alert xr-alert--error" role="alert">
      <div><span class="xr-alert__title">Could not load your orders</span>${escapeHtml(message)}
      <div style="margin-top:8px"><button type="button" class="xr-btn xr-btn--secondary xr-btn--sm" onclick="fetchOrders()">Try again</button></div></div>
    </div>`;
}

async function fetchOrders() {
  user = await requireAuth();
  if (!user) return;

  try {
    res = await databases.listDocuments(DB_ID, USERS, [
      Query.equal("userId", user.$id)
    ]);

    if (!res.documents.length) {
      showOrdersError("We could not find your account profile.");
      return;
    }

    //Theme Application
    profileDocId = res.documents[0].$id;

    const savedTheme = res.documents[0].theme || "light";
    applyTheme(savedTheme);

    //Subscription Check
    const subRes = await databases.listDocuments(DB_ID, SUBS, [
      Query.equal("userId", user.$id),
      Query.equal("status", "active"),
      Query.orderDesc("expiresAt"),
      Query.limit(1)
    ]);

    if (!subRes.documents.length) {
      document.getElementById("subscriptionModal").classList.remove("hidden");
      ordersList.removeAttribute("aria-busy");
      ordersList.innerHTML = "";
      return;
    }
    const sub = subRes.documents[0];
    const daysLeft = Math.ceil(
      (new Date(sub.expiresAt) - new Date()) / 86400000
    );

    if (daysLeft <= 0) {
      document.getElementById("subscriptionModal").classList.remove("hidden");
      ordersList.removeAttribute("aria-busy");
      ordersList.innerHTML = "";
      return;
    }

    const [orders, formRes] = await Promise.all([
      fetchAllOrders(user.$id),
      databases.listDocuments(DB_ID, FORMS, [Query.equal("userId", user.$id)])
    ]);

    businessTitle = formRes.documents?.[0]?.title || "Your Business";

    allOrders = orders;
    if (typeof loadOrderUpdates === "function") await loadOrderUpdates(formRes.documents?.[0] || null); // customer updates and seller decisions (never blocks the orders list)
    ordersList.removeAttribute("aria-busy");
    applyFilter();
  } catch (err) {
    console.error("Could not load orders:", err);
    showOrdersError("Check your connection and try again.");
  }
}

const FILTERS = {
  all: { label: "All", test: () => true },
  pending: { label: "Unpaid", test: o => normalizedStatus(o) === "pending" },
  review: { label: "Needs review", test: o => needsReview(o) },
  updated: { label: "Updated", test: o => typeof xrPendingUpdates === "function" && xrPendingUpdates(o) > 0 },
  paid: { label: "Paid", test: o => normalizedStatus(o) === "paid" },
  delivered: { label: "Delivered", test: o => normalizedStatus(o) === "delivered" },
  cancelled: { label: "Cancelled", test: o => normalizedStatus(o) === "cancelled" }
};

function applyFilter() {
  // Update counts first so a malformed order/card cannot prevent the filters
  // from displaying the real counts.
  document.querySelectorAll(".ord-filters button").forEach(btn => {
    const f = FILTERS[btn.dataset.filter];
    if (!f) return;
    const on = btn.dataset.filter === activeFilter;
    btn.classList.toggle("active", on);
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-pressed", String(on));
    btn.textContent = `${f.label} ${allOrders.filter(f.test).length}`;
  });

  let result = allOrders.filter((FILTERS[activeFilter] || FILTERS.all).test);

  const query = String(searchInput?.value || "").trim().toLowerCase();
  if (query) {
    result = result.filter(order => {
      if (String(order?.publicOrderID || "").toLowerCase().includes(query.replace(/[\s-]/g, ""))) return true;
      const formData = parseFormData(order?.formData);
      return formData.some(f => {
        if (!f) return false;
        if (f.type === "product" && Array.isArray(f.value)) {
          return f.value.some(p => String(p?.name || "").toLowerCase().includes(query));
        }
        return typeof f.value === "string" && f.value.toLowerCase().includes(query);
      });
    });
  }

  renderOrders(result);
}

async function updateStatus(id, status) {
  const order = allOrders.find(o => o.$id === id);
  if (!order || normalizedStatus(order) === status) return;

  if (status === "cancelled" && !confirm("Cancel this order? You can restore it later.")) return;

  const previous = order.status;
  order.status = status;               // show the change straight away
  applyFilter();
  try {
    await databases.updateDocument(DB_ID, ORDERS, id, { status });
    if (status === "cancelled" && typeof xrTelegramNotify === "function") xrTelegramNotify("order_cancelled", id); // only after the cancellation is saved
  } catch (err) {
    console.error("Could not update the order:", err);
    order.status = previous;           // put it back: the server still has the old status
    applyFilter();
    showToast("Could not update the order. Check your connection and try again.", "error");
  }
}

const deletingOrderIds = new Set();

async function deleteOrder(id, clickEvent) {
  // Prevent a mobile tap from bubbling into a card/parent interaction.
  if (clickEvent) {
    clickEvent.preventDefault();
    clickEvent.stopPropagation();
  }
  if (!id || deletingOrderIds.has(id)) return;
  const order = allOrders.find(o => o.$id === id);
  if (!order) {
    showToast("This order is no longer in the list. Refresh and try again.", "info");
    return;
  }
  if (!confirm("Are you sure you want to delete this order?")) return;

  deletingOrderIds.add(id);
  try {
    // Delete the order document first so a storage-file failure cannot block
    // deleting the order itself (common when a proof file was already removed).
    await databases.deleteDocument(DB_ID, ORDERS, id);
    allOrders = allOrders.filter(item => item.$id !== id);
    applyFilter();

    if (order.paymentProof) {
      try {
        await client.storage.deleteFile(PRODUCT_IMAGES_BUCKET, order.paymentProof);
      } catch (e) {
        console.warn("Order deleted, but its payment image could not be removed:", e);
      }
    }
    showToast("Order deleted successfully.", "success");
  } catch (e) {
    console.error("Failed to delete order:", e);
    showToast("Unable to delete order. Please try again.", "error");
  } finally {
    deletingOrderIds.delete(id);
  }
}

async function deleteAllOrders() {
  if (!allOrders.length) {
    showToast("No orders to delete.", "info");
    closeOrderDeleteModal();
    return;
  }

  // Delete the order record first, then its proof image. One failure must not stop the rest.
  let deleted = 0, failed = 0;
  for (const order of [...allOrders]) {
    try {
      await databases.deleteDocument(DB_ID, ORDERS, order.$id);
      deleted++;
    } catch (e) {
      console.warn(`Could not delete order ${order.$id}`, e);
      failed++;
      continue;
    }
    if (order.paymentProof) {
      try {
        await client.storage.deleteFile(PRODUCT_IMAGES_BUCKET, order.paymentProof);
      } catch (e) {
        console.warn(`Failed to delete image for order ${order.$id}`, e);
      }
    }
  }

  closeOrderDeleteModal();
  await fetchOrders();
  showToast(
    failed ? `Deleted ${deleted} orders. ${failed} could not be deleted, try again.` : "All orders deleted successfully",
    failed ? "warning" : "success"
  );
}

function exportOrdersPDF() {
  if (!allOrders.length) return showToast("No orders to export.", "info");
  
  const normalized = normalizeOrdersForExport(allOrders);

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF("landscape");

  const businessName = businessTitle;
  const platformName = "X Redro";

  // HEADER
  doc.setFontSize(18);
  doc.text(businessName, 14, 15);

  doc.setFontSize(10);
  doc.text(`Orders Report • Generated via ${platformName}`, 14, 22);
  doc.text(`Total Orders: ${allOrders.length}`, 14, 28);

  // TABLE
  const columns = Object.keys(normalized[0]).map(key => ({
    header: key,
    dataKey: key
  }));

  doc.autoTable({
    columns,
    body: normalized,
    startY: 35,
    styles: {
      fontSize: 9,
      cellPadding: 4,
      valign: "top"
    },
    headStyles: {
      fillColor: [15, 15, 15],
      textColor: 255,
      fontStyle: "bold"
    },
    alternateRowStyles: {
      fillColor: [245, 245, 245]
    },
    margin: { left: 14, right: 14 },
    didDrawPage: data => {
      const page = doc.internal.getCurrentPageInfo().pageNumber;
      const total = doc.internal.getNumberOfPages();

      doc.setFontSize(8);
      doc.text(
        `Page ${page} of ${total}`,
        data.settings.margin.left,
        doc.internal.pageSize.height - 10
      );
    }
  });

  doc.save(`x_redro_orders_${Date.now()}.pdf`);
}

function getPaidProductTotals() {
  const totals = new Map();

  allOrders
    .filter(order => order.status === "paid")
    .forEach(order => {
      // with customer updates: the original plus APPROVED updates (pending ones are not promised yet)
      const override = typeof xrDeliveryItems === "function" ? xrDeliveryItems(order) : null;
      if (override) {
        override.forEach(it => { totals.set(it.name, (totals.get(it.name) || 0) + it.qty); });
        return;
      }
      parseFormData(order.formData).forEach(field => {
        if (field.type !== "product" || !Array.isArray(field.value)) return;
        field.value.forEach(product => {
          if (!product || typeof product !== "object") return;
          const name = String(product.name || "Product").trim();
          const qty = Number(product.qty || 0);
          if (!name || !Number.isFinite(qty) || qty <= 0) return;
          totals.set(name, (totals.get(name) || 0) + qty);
        });
      });
    });

  return [...totals.entries()].sort((a,b) => a[0].localeCompare(b[0]));
}

function openDeliverySummary() {
  const modal = document.getElementById("deliverySummaryModal");
  const list = document.getElementById("deliverySummaryList");
  if (!modal || !list) return;

  const totals = getPaidProductTotals();
  if (!totals.length) {
    list.innerHTML = `<div class="delivery-summary-empty">No paid-order products to deliver yet.</div>`;
  } else {
    list.innerHTML = totals.map(([name, qty]) => `
      <div class="order-product-detail delivery-summary-item">
        <div><strong>${escapeHtml(name)}</strong> × ${qty.toLocaleString("en-NG")}</div>
      </div>
    `).join("");
  }

  modal.classList.remove("hidden");
}

function closeDeliverySummary(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById("deliverySummaryModal")?.classList.add("hidden");
}

function scrollOrdersToTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* =========================
UI INTERACTION LOGIC
========================= */
function renderOrders(orders) {
  ordersList.innerHTML = "";

  if (!orders.length) {
    const none = !allOrders.length;
    ordersList.innerHTML = none
      ? `<div class="xr-empty xr-card">
           <h2 class="xr-empty__title">No orders yet</h2>
           <p class="xr-empty__text">Share your store link and new orders will appear here.</p>
           <a class="xr-btn xr-btn--primary" href="indexF.html">Open store builder</a>
         </div>`
      : `<div class="xr-empty xr-card">
           <h2 class="xr-empty__title">No orders match</h2>
           <p class="xr-empty__text">Try a different filter or clear the search.</p>
         </div>`;
    return;
  }

  orders.slice(0, renderLimit).forEach(order => {
    try {
    if (!order || typeof order !== "object") return;
    const card = document.createElement("article");
    card.className = "ord-card";
    const status = normalizedStatus(order) || "pending";
    const id = escapeHtml(String(order.$id).replace(/[^A-Za-z0-9_.-]/g, ""));
    const proofId = escapeHtml(String(order.paymentProof || "").replace(/[^A-Za-z0-9_.-]/g, ""));

    const summary = getProductSummary(order.formData);
    const parsedOrderFields = parseFormData(order.formData);
    const amounts = normalizeAmount(order.totalAmount);
    const label = STATUS_LABEL[status] || status;
    const badge = STATUS_BADGE[status] || "neutral";

    const tags = [
      isNewOrder(order) ? `<span class="xr-badge xr-badge--info">New</span>` : "",
      needsReview(order) ? `<span class="xr-badge xr-badge--attention">Proof uploaded</span>` : "",
      typeof xrUpdateTag === "function" ? xrUpdateTag(order) : ""
    ].join("");

    const detailRows = parsedOrderFields.map(f => {
      if (f.type === "product" && Array.isArray(f.value)) {
        return `
          <div class="ord-field ord-field--wide">
            <strong>${escapeHtml(f.label || "Products")}</strong>
            <div class="order-products-detail">
              ${f.value.filter(p => p && typeof p === "object").map(p => {
                const desc = String(p.description || "").trim();
                const price = Number(p.price || 0);
                return `<div class="order-product-detail">
                  <div><strong>${escapeHtml(p.name || "Product")}</strong> × ${Number(p.qty || 0).toLocaleString()}</div>
                  ${desc ? `<div class="order-product-description">${escapeHtml(desc)}</div>` : ""}
                  ${price ? `<div class="order-product-price">₦${price.toLocaleString("en-NG")} each</div>` : ""}
                </div>`;
              }).join("")}
            </div>
          </div>`;
      }
      const val = String(f.value ?? "").trim();
      if (!val) return "";
      return `<div class="ord-field"><strong>${escapeHtml(f.label || "Field")}</strong><span>${escapeHtml(val)}</span></div>`;
    }).filter(Boolean).join("");

    let payment;
    if (status === "pending") {
      payment = order.paymentProof
        ? `<button type="button" class="ord-proof" onclick="viewImage('${proofId}')" aria-label="View payment proof full size">
             <img loading="lazy" alt="Payment proof" src="https://nyc.cloud.appwrite.io/v1/storage/buckets/${PRODUCT_IMAGES_BUCKET}/files/${proofId}/view?project=695981480033c7a4eb0d">
             <span>View full size</span></button>`
        : `<span class="xr-text-2">No payment proof uploaded</span>`;
    } else if (status === "cancelled") {
      payment = `<span class="xr-text-2">Order cancelled</span>`;
    } else {
      payment = `<span class="xr-badge xr-badge--paid">&#10003; Marked paid</span>`;
    }

    const steps = status === "cancelled"
      ? `<div class="xr-alert"><div><span class="xr-alert__title">This order is cancelled</span>It is not counted in your paid or delivery totals.</div></div>
         <button type="button" class="xr-btn xr-btn--secondary xr-btn--sm" onclick="updateStatus('${id}', 'pending')">Restore as unpaid</button>`
      : `<p class="ord-steps-label">Status</p>
         <div class="ord-steps" role="group" aria-label="Order status">
           ${["pending", "paid", "delivered"].map(k => `<button type="button" class="ord-step${status === k ? " is-current" : ""}" aria-pressed="${status === k}" onclick="updateStatus('${id}', '${k}')">${STATUS_LABEL[k]}</button>`).join("")}
         </div>
         <button type="button" class="xr-btn xr-btn--ghost xr-btn--sm" onclick="updateStatus('${id}', 'cancelled')">Cancel order</button>`;

    card.innerHTML = `
      <div class="ord-head" role="button" tabindex="0" aria-expanded="false"
           onclick="toggleExpand(this)"
           onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleExpand(this)}">
        <div class="ord-main">
          <div class="ord-title"><span class="ord-name">${escapeHtml(getCardTitle(order))}</span>${tags}</div>
          <div class="ord-sub">${escapeHtml(summary || "No products")}</div>
        </div>
        <div class="ord-side">
          <span class="xr-badge xr-badge--${badge} xr-badge--dot">${escapeHtml(label)}</span>
          <strong class="ord-amount">₦${amounts.toLocaleString()}</strong>
          ${typeof xrDueChip === "function" ? xrDueChip(order) : ""}
        </div>
        <div class="ord-date">${escapeHtml(new Date(order.$createdAt).toDateString())}</div>
      </div>

      <div class="ord-details hidden">
        ${typeof xrIdRowHTML === "function" ? xrIdRowHTML(order, id) : ""}
        ${detailRows}
        ${typeof xrUpdatesHTML === "function" ? xrUpdatesHTML(order, id) : ""}
        <div class="ord-field ord-field--wide"><strong>Payment</strong><div>${payment}</div></div>
        <div class="ord-actions">
          ${steps}
          <button type="button" class="xr-btn xr-btn--danger xr-btn--sm" aria-label="Delete this order" onclick="deleteOrder('${id}', event)">Delete order</button>
        </div>
      </div>
    `;

    ordersList.appendChild(card);
    } catch (error) {
      console.error("Could not render an order card:", order?.$id, error);
    }
  });

  if (orders.length > renderLimit) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "xr-btn xr-btn--secondary xr-btn--block ord-more";
    more.textContent = `Show ${Math.min(RENDER_STEP, orders.length - renderLimit)} more (${orders.length - renderLimit} left)`;
    more.onclick = () => { renderLimit += RENDER_STEP; applyFilter(); };
    ordersList.appendChild(more);
  }
}

function toggleExpand(head) {
  const card = head.closest(".ord-card");
  const details = card.querySelector(".ord-details");
  const open = details.classList.toggle("hidden") === false;
  card.classList.toggle("is-open", open);
  head.setAttribute("aria-expanded", String(open));
}

/* "View full order" from the payment verification workspace: show this order in the list, opened */
function xrOpenOrderCard(id) {
  const o = allOrders.find(x => x.$id === id);
  if (!o) return;
  activeFilter = "all";
  if (searchInput) searchInput.value = o.publicOrderID || (window.XrVerify ? XrVerify.customerName(o) : "");
  applyFilter();
  const head = document.querySelector(".ord-head");
  if (head) { head.click(); head.scrollIntoView({ block: "start", behavior: "smooth" }); }
}

function viewImage(fileId) {
  if (!fileId) {
    showToast("No payment proof uploaded.", "info");
    return;
  }

  modal.innerHTML = `
    <img src="https://nyc.cloud.appwrite.io/v1/storage/buckets/696825350032fe17c1eb/files/${fileId}/view?project=695981480033c7a4eb0d" />
  `;
  modal.classList.remove("hidden");
}

function toggleStatusMenu(el) {
  event.stopPropagation();
  el.classList.toggle("open");
  el.querySelector(".status-menu").classList.toggle("hidden");
}

function setStatus(item, value) {
  event.stopPropagation();

  const select = item.closest(".status-select");
  const id = select.dataset.id;

  select.querySelector(".status-value").textContent = value;
  select.classList.remove("open");
  select.querySelector(".status-menu").classList.add("hidden");

  // keep the status-based colour coding (status-pending/paid/delivered) in sync
  select.classList.remove("status-pending", "status-paid", "status-delivered");
  select.classList.add(`status-${value}`);

  updateStatus(id, value);
}

function openOrderDeleteModal() {
  document.getElementById("confirmModal").classList.remove("hidden");
}

function closeOrderDeleteModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById("confirmModal").classList.add("hidden");
}

/* =========================
EVENT LISTENERS / TRIGGERS
========================= */
const searchInput = document.getElementById("orderSearch");
searchInput.addEventListener("input", () => {
  renderLimit = RENDER_STEP;
  applyFilter();
});

const ordersList = document.getElementById("ordersList");
const modal = document.getElementById("modal");

document.querySelectorAll(".ord-filters button").forEach(btn => {
  btn.onclick = () => {
    activeFilter = btn.dataset.filter;
    renderLimit = RENDER_STEP;
    applyFilter();
  };
});

modal.onclick = () => {
  modal.classList.add("hidden");
};

window.addEventListener("scroll", () => {
  const btn = document.getElementById("ordersTopButton");
  if (btn) btn.classList.toggle("visible", window.scrollY > 260);
}, { passive: true });

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    if (typeof closeIdDialog === "function") closeIdDialog();
    closeDeliverySummary();
  }
});

document.addEventListener("click", e => {
  document.querySelectorAll(".status-select").forEach(sel => {
    if (!sel.contains(e.target)) {
      sel.classList.remove("open");
      sel.querySelector(".status-menu").classList.add("hidden");
    }
  });
});

/* =========================
INITIALIZATION / BOOTSTRAP LOGIC
========================= */
fetchOrders();
