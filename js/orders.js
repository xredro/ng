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

const EXPAND_DOWN = `
<path d="m480-340 180-180-57-56-123 123-123-123-57 56 180 180Zm0 260q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z"/>`;

const CLOSE_EXPAND = `
<path d="m357-384 123-123 123 123 57-56-180-180-180 180 57 56ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z"/>`;

/* =========================
UTILITY / HELPER FUNCTIONS
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
    window.location.href = "login.html";
  }
}

async function fetchOrders() {
  user = await requireAuth();
  
  res = await databases.listDocuments(DB_ID, USERS, [
    Query.equal("userId", user.$id)
  ]);
  
  //Theme Application
  profileDocId = res.documents[0].$id;

  const savedTheme = res.documents[0].theme || "light";
  applyTheme(savedTheme);
  
  //Subscription Check
  const subRes = await databases.listDocuments(DB_ID, SUBS, [
    Query.equal("userId", user.$id),
    Query.orderDesc("expiresAt"),
    Query.limit(1)
  ]);

  const sub = subRes.documents[0];
  const daysLeft = Math.ceil(
    (new Date(sub.expiresAt) - new Date()) / 86400000
  );

  if (daysLeft <= 0) {
    document.getElementById("subscriptionModal").classList.remove("hidden");
    return;
  }

  const odsRes = await databases.listDocuments(
    DB_ID,
    ORDERS,
    [
      Query.equal("userId", user.$id),
      Query.orderDesc("$createdAt")
    ]
  );

  const formRes = await databases.listDocuments(DB_ID, FORMS, [
    Query.equal("userId", user.$id)
  ]); 

  businessTitle = formRes.documents?.[0]?.title || "Your Business";

  allOrders = odsRes.documents;  
  applyFilter();
}

function applyFilter() {
  let result = [];

  // Filter by status first
  if (activeFilter === "all") {
    result = allOrders;
  } else {
    result = allOrders.filter(o => o.status === activeFilter);
  }

  // Filter by search input (partial, case-insensitive)
  const query = searchInput.value.trim().toLowerCase();
  if (query) {
    result = result.filter(order => {
      const formData = parseFormData(order.formData);

      return formData.some(f => {
        if (f.type === "product" && Array.isArray(f.value)) {
          return f.value.some(p => p.name.toLowerCase().includes(query));
        } else if (typeof f.value === "string") {
          return f.value.toLowerCase().includes(query);
        }
        return false;
      });
    });
  }

  renderOrders(result);

  // Update active button highlight
  document.querySelectorAll(".filters button").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.filter === activeFilter);
  });
}

async function updateStatus(id, status) {
  await databases.updateDocument(
    DB_ID,
    ORDERS,
    id,
    { status }
  );
  fetchOrders();
}

async function deleteOrder(id) {
  const order = allOrders.find(o => o.$id === id);
  if (!order) return;

  if (!confirm("Are you sure you want to delete this order?")) return;

  // Delete payment proof if it exists
  if (order.paymentProof) {
    try {
      await client.storage.deleteFile(PRODUCT_IMAGES_BUCKET, order.paymentProof);
    } catch (e) {
      console.warn("Failed to delete image:", e);
    }
  }

  // Delete the order document
  await databases.deleteDocument(DB_ID, ORDERS, id);

  fetchOrders();
}

async function deleteAllOrders() {
  if (!allOrders.length) {
    showToast("No orders to delete.", "info");
    return;
  }

  for (const order of allOrders) {
    // Delete payment proof image
    if (order.paymentProof) {
      try {
        await client.storage.deleteFile(
          "696825350032fe17c1eb",
          order.paymentProof
        );
      } catch (e) {
        console.warn(`Failed to delete image for order ${order.$id}`, e);
      }
    }

    await databases.deleteDocument(DB_ID, ORDERS, order.$id);
  }

  closeOrderDeleteModal();
  fetchOrders();
  showToast("All orders deleted successfully", "success");
}

function exportOrdersCSV() {
  try {
    if (!allOrders.length) {
      showToast("No orders to export.", "info");
      return;
    }

    const normalized = normalizeOrdersForExport(allOrders);

    // Beautify values
    const formatted = normalized.map(row => ({
      ...row,
      "Total Amount (₦)": row["Total Amount (₦)"],
      "Order Details": row["Order Details"].replace(/\n/g, "\n\n")
    }));

    let csvContent = "";

    if (window.Papa) {
      csvContent = Papa.unparse(formatted, {
        quotes: true,
        newline: "\r\n"
      });
    } else {
      const headers = Object.keys(formatted[0]);
      const rows = formatted.map(r =>
        headers.map(h => `"${String(r[h]).replace(/"/g, '""')}"`).join(",")
      );
      csvContent = [headers.join(","), ...rows].join("\n");
    }

    const blob = new Blob([csvContent], {
      type: "text/csv;charset=utf-8;"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `x_redro_orders_${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("CSV export failed:", err);
    showToast("CSV export failed, try another browser", "error");
  }
}

function exportOrdersPDF() {
  if (!allOrders.length) return showToast("No orders to export.", "info");
  
  if (allOrders.length > 500) {
  showToast("Large dataset detected. CSV export recommended for analysis.", "warning");
}

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

/* =========================
UI INTERACTION LOGIC
========================= */
function renderOrders(orders) {
  ordersList.innerHTML = "";

  if (!orders.length) {
    ordersList.innerHTML = "<p>No orders found.</p>";
    return;
  }

  orders.forEach(order => {
    const card = document.createElement("div");
    card.className = "order-card";

    const summary = getProductSummary(order.formData);

    // Collect values shown in collapsed area
    const collapsedValues = new Set();
    parseFormData(order.formData).forEach(f => {
      if (f.type === "product" && Array.isArray(f.value)) {
        f.value.forEach(p => collapsedValues.add(`${p.name} x${p.qty}`));
      }
    });

    //normalize amount
    const amounts = normalizeAmount(order.totalAmount);

    card.innerHTML = `
      <div class="card-header">
        <h3>${getCardTitle(order)}</h3>

        <div class="status-select" data-id="${order.$id}" onclick="toggleStatusMenu(this)">
          <span class="status-value">${order.status}</span>
          <svg class="chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>

          <div class="status-menu hidden">
            <div onclick="setStatus(this, 'pending')">pending</div>
            <div onclick="setStatus(this, 'paid')">paid</div>
            <div onclick="setStatus(this, 'delivered')">delivered</div>
          </div>
        </div>
      </div>
      
      <div class="order-summary-line">
        <span class="summary-item">${summary || "No products"}</span>
        <span class="order-date">${new Date(order.$createdAt).toDateString()}</span>
      </div>

      <div class="meta">
        <span>₦${amounts.toLocaleString()}</span>
        <div>
          ${order.paymentProof ? `
            <button onclick="viewImage('${order.paymentProof}')"><svg xmlns="http://www.w3.org/2000/svg" height="24px" class="theme-icon" viewBox="0 -960 960 960" width="24px" ><path fill="currentColor" d="M260-361v-40H160v-80h200v-80H200q-17 0-28.5-11.5T160-601v-160q0-17 11.5-28.5T200-801h60v-40h80v40h100v80H240v80h160q17 0 28.5 11.5T440-601v160q0 17-11.5 28.5T400-401h-60v40h-80Zm298 240L388-291l56-56 114 114 226-226 56 56-282 282Z"/></svg></button>
          ` : ""}
          
          <button class="expand-btn" onclick="toggleExpand(this)"> <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#999999"> ${EXPAND_DOWN} </svg></button>
          <button onclick="deleteOrder('${order.$id}')"><svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#999999"><path d="m376-300 104-104 104 104 56-56-104-104 104-104-56-56-104 104-104-104-56 56 104 104-104 104 56 56Zm-96 180q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520Zm-400 0v520-520Z"/></svg></button>
        </div>
      </div>

      <div class="expanded hidden">
        ${parseFormData(order.formData)
          .map(f => {
            let val;
            if (f.type === "product" && Array.isArray(f.value)) {
              val = f.value.map(p => `${p.name} x${p.qty}`)
                          .filter(v => !collapsedValues.has(v))
                          .join(", ");
            } else {
              val = f.value;
            }
            if (!val) return "";
            return `
              <div class="order-field">
                <strong>${f.label}:</strong> ${val}
              </div>
            `;
          })
          .filter(Boolean)
          .join("")}
      </div>
    `;

    ordersList.appendChild(card);
  });
}

function toggleExpand(btn) {
  const card = btn.closest(".order-card");
  const expanded = card.querySelector(".expanded");
  const svg = btn.querySelector("svg");

  const isOpen = !expanded.classList.contains("hidden");

  expanded.classList.toggle("hidden");

  svg.innerHTML = isOpen ? EXPAND_DOWN : CLOSE_EXPAND;
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
  applyFilter();
});

const ordersList = document.getElementById("ordersList");
const modal = document.getElementById("modal");

document.querySelectorAll(".filters button").forEach(btn => {
  btn.onclick = () => {
    activeFilter = btn.dataset.filter;
    applyFilter();
  };
});

modal.onclick = () => {
  modal.classList.add("hidden");
};

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
