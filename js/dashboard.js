/* =========================
FILE OVERVIEW
========================= */
// Dashboard application with Appwrite

/* =========================
GLOBAL CONSTANTS / CONFIG
========================= */
const DB_ID = "695c4fce0039f513dc83";
const USERS = "695c501b001d24549b03";
const FORMS = "form";
const SUBS = "subscriptions";
const PAYMENTS = "payments";
const ORDERS = "orders";

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

// Public customer-form URLs. GitHub Pages serves this project from /ng,
// while the Cloudflare Pages deployment serves it from the site root.
const XREDRO_FORM_HOSTS = {
  github: "https://xredro.github.io/ng/form.html",
  cloudflare: "https://xredro.pages.dev/form.html"
};
function getPublicFormLink(formOwnerId, platform = "current") {
  const id = encodeURIComponent(String(formOwnerId || ""));
  let base;
  if (platform === "github") base = XREDRO_FORM_HOSTS.github;
  else if (platform === "cloudflare") base = XREDRO_FORM_HOSTS.cloudflare;
  else {
    const host = String(window.location.hostname || "").toLowerCase();
    if (host === "xredro.github.io" || host.endsWith(".github.io")) {
      base = `${window.location.origin}/ng/form.html`;
    } else {
      base = `${window.location.origin}/form.html`;
    }
  }
  return `${base}?fid=${id}`;
}
function copyTextCompat(value) {
  // Clipboard API is unavailable in some older/mobile browsers such as Opera Mini.
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(value).catch(() => legacyCopyText(value));
  }
  return Promise.resolve(legacyCopyText(value));
}
function legacyCopyText(value) {
  const temp = document.createElement("textarea");
  temp.value = value;
  temp.setAttribute("readonly", "");
  temp.style.position = "fixed";
  temp.style.left = "-9999px";
  document.body.appendChild(temp);
  temp.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (_) {}
  temp.remove();
  if (!ok) throw new Error("This browser did not allow copying. Please copy the link from the field manually.");
  return true;
}

/* =========================
UTILITY / HELPER FUNCTIONS
========================= */
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

function escapeHtml(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatNaira(n) {
  return "₦" + (Number(n) || 0).toLocaleString();
}

// customer-facing words for the stored status values
function statusLabel(status) {
  return { pending: "Unpaid", paid: "Paid", delivered: "Delivered", cancelled: "Cancelled" }[status] || String(status || "Unknown");
}
function statusBadgeClass(status) {
  return { pending: "unpaid", paid: "paid", delivered: "delivered", cancelled: "cancelled" }[status] || "neutral";
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
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

function getProductSummary(rawFormData, maxItems = null) {
  const formData = parseFormData(rawFormData);
  const products = [];

  formData.forEach(f => {
    if (f.type === "product" && Array.isArray(f.value)) {
      f.value.forEach(p => {
        products.push(`${p.name} x${p.qty}`);
      });
    }
  });

  return maxItems !== null
    ? products.slice(0, maxItems).join(", ")
    : products.join(", ");
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

// Appwrite returns at most 100 documents per request (25 by default), so
// every order is fetched page by page. Counts and values then cover all orders.
let dashboardOrders = [];
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

async function loadStats(userId) {
  const orders = await fetchAllOrders(userId);
  dashboardOrders = orders;

  const by = status => orders.filter(o => o.status === status);
  const sum = list => list.reduce((t, o) => t + normalizeAmount(o.totalAmount), 0);
  const pending = by("pending");

  setText("totalOrders", orders.length);
  setText("deliveredOrders", by("delivered").length);
  setText("paidOrders", by("paid").length);
  setText("pendingOrders", pending.length);

  // "Submitted" is what customers ordered. "Marked paid" is only what you have
  // marked paid or delivered. Neither is a bank balance.
  setText("valueAll", formatNaira(sum(orders.filter(o => o.status !== "cancelled"))));
  setText("valuePaid", formatNaira(sum(by("paid")) + sum(by("delivered"))));
  setText("valueUnpaid", formatNaira(sum(pending)));

  return pending.length;
}

async function loadLatestOrders(userId) {
  renderOrders(dashboardOrders.slice(0, 3));
}

/* =========================
UI INTERACTION LOGIC
========================= */
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

function updateAttention(pendingCount) {
  const box = document.getElementById("attentionStatus");
  const text = document.getElementById("attentionText");
  const icon = document.getElementById("attentionIcon");
  if (!box || !text) return;

  if (pendingCount > 0) {
    box.classList.remove("hidden");
    box.classList.remove("xr-alert--success");
    box.classList.add("xr-alert--warning");
    if (icon) icon.textContent = "⚠";
    text.textContent = `${pendingCount} ${pendingCount === 1 ? "order is" : "orders are"} awaiting payment`;
  } else {
    box.classList.remove("hidden");
    box.classList.remove("xr-alert--warning");
    box.classList.add("xr-alert--success");
    if (icon) icon.textContent = "✓";
    text.textContent = "No pending actions";
  }
}

// kept for compatibility with older markup; both are no-ops when the elements are absent
function updateFormStatus(isPublished, link) {
  const state = document.getElementById("formState");
  const input = document.getElementById("formLinkInput");
  if (state) state.textContent = isPublished ? "Live" : "Not published";
  if (input && isPublished) input.value = link;
}

function updateSystemStatus(ok = true, message = "") {
  const text = document.getElementById("systemText");
  if (!ok && text) text.textContent = message;
}

function showLoadError(message) {
  const box = document.getElementById("loadError");
  if (!box) return;
  setText("loadErrorText", message || "Check your connection and reload the page.");
  box.classList.remove("hidden");
}

function showExpiryNotice(daysLeft, msLeft) {
  const box = document.getElementById("expiryNotice");
  if (!box) return;
  const left = typeof xrTimeLeft === "function" && msLeft != null ? xrTimeLeft(msLeft) : null;
  setText("expiryTitle", left && left.underDay ? `Your plan ends in ${left.text}` : daysLeft <= 1 ? "Your plan ends within a day" : `Your plan ends in ${daysLeft} days`);
  setText("expiryText", "Renew to keep your store live and taking orders.");
  box.classList.remove("hidden");
}

async function copyFormLink(platform = "current") {
  if (!user?.$id) return showToast("Your account is still loading. Try again in a moment.", "error");
  const link = getPublicFormLink(user.$id, platform);
  try {
    await copyTextCompat(link);
    if (window.XrSetup) { XrSetup.markShared(user.$id); const c = document.getElementById("setupCard"); if (c && !c.hidden && typeof loadSetupCard === "function") loadSetupCard(user.$id); }
    showToast(`${platform === "cloudflare" ? "Cloudflare" : platform === "github" ? "GitHub" : "Customer form"} link copied`, "success");
  } catch (e) {
    showToast(e?.message || "Could not copy the link. Please copy it manually.", "error");
  }
}

function renderOrders(orders) {
  const wrap = document.getElementById("ordersList");
  wrap.removeAttribute("aria-busy");
  wrap.innerHTML = "";

  if (!orders.length) {
    wrap.innerHTML = `
      <div class="xr-empty">
        <h3 class="xr-empty__title">No orders yet</h3>
        <p class="xr-empty__text">Share your store link and new orders will show up here.</p>
        <button type="button" class="xr-btn xr-btn--primary" onclick="copyFormLink()">Copy store link</button>
      </div>`;
    return;
  }

  orders.forEach(order => {
    const row = document.createElement("div");
    row.className = "dash-order";

    const title = escapeHtml(getCardTitle(order));
    const summary = escapeHtml(getProductSummary(order.formData) || "No products");
    const amount = formatNaira(normalizeAmount(order.totalAmount));
    const date = escapeHtml(new Date(order.$createdAt).toDateString());
    const status = order.status;
    const proofId = escapeHtml(String(order.paymentProof || "").replace(/[^A-Za-z0-9_.-]/g, ""));

    const payment = status === "pending"
      ? (order.paymentProof
          ? `<button type="button" class="xr-btn xr-btn--secondary xr-btn--sm" onclick="viewPaymentImage('${proofId}')">View payment image</button>`
          : `<span class="xr-text-2">No payment proof uploaded</span>`)
      : status === "cancelled"
        ? `<span class="xr-text-2">Order cancelled</span>`
        : `<span class="xr-badge xr-badge--paid">Marked paid</span>`;

    row.innerHTML = `
      <div class="dash-order__head" role="button" tabindex="0" aria-expanded="false"
           onclick="toggleDashboardOrderExpand(this)"
           onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleDashboardOrderExpand(this)}">
        <span class="dash-order__title">${title}</span>
        <span class="xr-badge xr-badge--${statusBadgeClass(status)} xr-badge--dot">${escapeHtml(statusLabel(status))}</span>
        <span class="dash-order__sub">${summary}</span>
        <span class="dash-order__amount">${amount}</span>
        <span class="dash-order__date">${date}</span>
      </div>
      <div class="dash-order__more hidden">
        <strong>Payment:</strong> ${payment}
      </div>`;

    wrap.appendChild(row);
  });
}

function toggleDashboardOrderExpand(headerEl) {
  const card = headerEl.closest(".dash-order");
  const more = card.querySelector(".dash-order__more");
  const open = more.classList.toggle("hidden") === false;
  card.classList.toggle("is-open", open);
  headerEl.setAttribute("aria-expanded", String(open));
}

function viewPaymentImage(fileId) {
  fileId = String(fileId || "").replace(/[^A-Za-z0-9_.-]/g, "");
  if (!fileId) return;
  const modal = document.getElementById("paymentImageModal");
  modal.innerHTML = `<img src="https://nyc.cloud.appwrite.io/v1/storage/buckets/696825350032fe17c1eb/files/${fileId}/view?project=695981480033c7a4eb0d" />`;
  modal.classList.remove("hidden");
}

/* =========================
SETUP CHECKLIST (new sellers)
Shows one "next step" card from what is already saved. Failure here must never affect the dashboard, so everything is caught.
========================= */
async function loadSetupCard(userId) {
  const el = document.getElementById("setupCard");
  if (!el || !window.XrSetup) return;
  let form = null, orderCount = 0;
  try { form = await databases.getDocument(DB_ID, FORMS, userId); } catch (e) { form = null; /* no store saved yet */ }
  try { orderCount = (await databases.listDocuments(DB_ID, ORDERS, [Query.equal("userId", userId), Query.limit(1)])).total || 0; } catch (e) { orderCount = 0; }
  const draw = () => XrSetup.render(el, XrSetup.compute({ form, orderCount, shared: XrSetup.isShared(userId), storeUrl: getPublicFormLink(userId) }), {
    share: async () => { await copyFormLink(); XrSetup.markShared(userId); draw(); }
  });
  draw();
}

/* =========================
INITIALIZATION / BOOTSTRAP LOGIC
========================= */
async function initDashboard() {
  user = await requireAuth();
  if (!user) return;

  const viewLink = document.getElementById("viewStoreLink");
  if (viewLink) viewLink.href = getPublicFormLink(user.$id);

  try {
    res = await databases.listDocuments(DB_ID, USERS, [
      Query.equal("userId", user.$id)
    ]);

    const subRes = await databases.listDocuments(DB_ID, SUBS, [
      Query.equal("userId", user.$id),
      Query.equal("status", "active"),
      Query.orderDesc("expiresAt"),
      Query.limit(1)
    ]);

    //Theme Application
    if (!res.documents.length) return;

    const profile = res.documents[0];
    profileDocId = profile.$id;

    const savedTheme = res.documents[0].theme || "light";
    applyTheme(savedTheme);

    //Quick Subscription Check
    const now = new Date();

    if (!subRes.documents.length) {
      document.getElementById("subscriptionModal").classList.remove("hidden");
      return;
    }

    const sub = subRes.documents[0];
    const expiresAt = new Date(sub.expiresAt);

    if (expiresAt <= now || sub.status !== "active") {
      document.getElementById("subscriptionModal").classList.remove("hidden");
      return;
    }

    const daysLeft = Math.ceil((expiresAt - now) / 86400000);

    setText("planDays", sub.plan);
    setText("expiresIn", typeof xrTimeLeft === "function" ? xrTimeLeft(expiresAt - now).text : `${daysLeft} ${daysLeft === 1 ? "day" : "days"}`);
    if (daysLeft <= 3) showExpiryNotice(daysLeft, expiresAt - now);

    const pendingCount = await loadStats(user.$id);
    await loadLatestOrders(user.$id);
    updateAttention(pendingCount);
    loadSetupCard(user.$id);
  } catch (err) {
    console.error(err);
    showLoadError("We could not reach the server. Check your connection and reload the page.");
    const list = document.getElementById("ordersList");
    if (list) list.removeAttribute("aria-busy");
  }
}

initDashboard();
