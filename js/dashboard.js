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

async function loadStats(userId) {
  const res = await databases.listDocuments(DB_ID, ORDERS, [
    Query.equal("userId", userId)
  ]);

  const orders = res.documents;

  const pendingCount = orders.filter(o => o.status === "pending").length;

  totalOrders.innerText = orders.length;
  deliveredOrders.innerText = orders.filter(o => o.status === "delivered").length;
  paidOrders.innerText = orders.filter(o => o.status === "paid").length;
  pendingOrders.innerText = pendingCount;

  return pendingCount;
}

async function loadLatestOrders(userId) {
  const user = await requireAuth();
  const res = await databases.listDocuments(
    DB_ID,
    ORDERS,
    [
      Query.equal("userId", user.$id),
      Query.orderDesc("$createdAt"),
      Query.limit(3)
    ]
  );

  renderOrders(res.documents);
}

/* =========================
UI INTERACTION LOGIC
========================= */
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

function updateAttention(pendingCount) {
  const box = document.getElementById("attentionStatus");
  const text = document.getElementById("attentionText");

  if (pendingCount > 0) {
    box.classList.remove("hidden");
    text.textContent = `${pendingCount} orders awaiting payment`;
  } else {
    box.classList.remove("hidden");
    text.textContent = "✓ No pending actions";
    document.getElementById("attentionIcon").textContent = "✓";
  }
}

function updateFormStatus(isPublished, link) {
  const state = document.getElementById("formState");
  const input = document.getElementById("formLinkInput");

  if (isPublished) {
    state.textContent = "Live";
    input.value = link;
  } else {
    state.textContent = "Not published";
  }
}

function updateSystemStatus(ok = true, message = "") {
  const text = document.getElementById("systemText");
  const dot = document.querySelector(".system-status .dot");

  if (!ok) {
    dot.style.background = "#ff5252";
    text.textContent = message;
  }
}

function copyFormLink() {
  const link = `${window.location.origin}/X-Redro/form.html?fid=${user.$id}`;
  navigator.clipboard.writeText(link);
  showToast("Form link copied", "success");
}

function renderOrders(orders) {
  const wrap = document.getElementById("ordersList");
  wrap.innerHTML = "";

  if (!orders.length) {
    wrap.innerHTML = "<p>No recent orders.</p>";
    return;
  }

  orders.forEach(order => {
    const card = document.createElement("div");
    card.className = "order-card";

    const title = getCardTitle(order);
    const summary = getProductSummary(order.formData, 2);
    const amount = normalizeAmount(order.totalAmount);

    card.innerHTML = `
      <div class="card-header">
        <h3>${title}</h3>
        <div class="status ${order.status}"> ${order.status} </div>
      </div>

      <div class="order-summary-line">
        <span class="summary-item">
          ${summary || "No products"}
        </span>
        <span class="order-date">
          ${new Date(order.$createdAt).toDateString()}
        </span>
      </div>

      <div class="meta">
        <span>₦${amount.toLocaleString() || 0}</span>
      </div>
    `;

    wrap.appendChild(card);
  });
}

/* =========================
INITIALIZATION / BOOTSTRAP LOGIC
========================= */
async function initDashboard() {
  user = await requireAuth();
  if (!user) return;

  res = await databases.listDocuments(DB_ID, USERS, [
    Query.equal("userId", user.$id)
  ]);

  /*const subRes = await databases.listDocuments(DB_ID, SUBS, [
    Query.equal("userId", user.$id)
  ]);*/

  const subRes = await databases.listDocuments(DB_ID, SUBS, [
    Query.equal("userId", user.$id),
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

  planDays.innerText = sub.plan;
  expiresIn.innerText = `${daysLeft} days`;
  
  const pendingCount = await loadStats(user.$id);
  loadLatestOrders(user.$id);
  updateAttention(pendingCount);
}

initDashboard();
