/* =========================
FILE OVERVIEW
========================= */
// Form submission and rendering application with Appwrite

/* =========================
GLOBAL CONSTANTS / CONFIG
========================= */
const DB_ID = "695c4fce0039f513dc83";
const FORMS = "form";
const ORDERS = "orders";
const PRODUCT_IMAGES_BUCKET = "696825350032fe17c1eb";

/* =========================
EXTERNAL SERVICE SETUP
========================= */
const client = new Appwrite.Client()
  .setEndpoint('https://nyc.cloud.appwrite.io/v1')
  .setProject('695981480033c7a4eb0d');

const databases = new Appwrite.Databases(client);

/* =========================
GLOBAL STATE VARIABLES
========================= */
let fields = [];
let formTitle = "";
let formSubtitle = "";
let CURRENT_THEME_CLASS = "theme-r1";
let storeConfig = null; // optional JSON from the form doc (logo, banner, contact...), see docs/STOREFRONT-ARCHITECTURE.md

let CURRENT_FORM_ID = "";
let FORM_OWNER_ID = "";
let whatsappNumber = "";
let whatsappOrderRedirectEnabled = false;
let customerOrderUpdatesEnabled = true; // seller can switch customer order changes off in Settings (form attribute customerOrderUpdatesEnabled; missing = on)
let lastOrderCard = null;               // data for the downloadable order card shown after a successful order (js/order-card.js)
let pendingWhatsAppUrl = "";

const cart = {};

/* =========================
UTILITY / HELPER FUNCTIONS
========================= */
function formatNaira(amount) {
  return amount.toLocaleString("en-NG");
}

function buildRawFormData() {
  const data = [];

  fields.forEach(field => {
    if (field.type === "product") {
      const selected = [];

      field.products.forEach((p, i) => {
        const qty = cart[`${field.id}_${i}`] || 0;
        if (qty > 0) {
          selected.push({
            name: p.name,
            description: p.description || "",
            qty,
            price: Number(p.price || 0)
          });
        }
      });

      if (selected.length) {
        data.push({
          label: field.label,
          type: "product",
          value: selected
        });
      }
     
    } else if (field.type === "additional_fee") {
      const el = document.querySelector(`[data-id="${field.id}"]`);
      if (el && el.value) {
        data.push({
          label: field.label,
          type: "additional_fee",
          value: el.value // save ONLY name
        });
      }
      
    } else {
      const el = document.querySelector(`[data-id="${field.id}"]`);
      if (el && el.value.trim()) {
        data.push({
          label: field.label,
          type: field.type,
          value: el.value.trim()
        });
      }
    }
  });

  const paymentAccountName = document.getElementById("paymentAccountName");
  const datePaid = document.getElementById("datePaid");
  if (paymentAccountName && paymentAccountName.value.trim()) {
    data.push({ label: "Name on payment", type: "payment_account_name", value: paymentAccountName.value.trim() });
  }
  if (datePaid && datePaid.value) {
    data.push({ label: "Date paid", type: "payment_date", value: datePaid.value });
  }

  return data;
}

function validateFormInputs() {
  const paymentAccountName = document.getElementById("paymentAccountName");
  if (paymentAccountName && !paymentAccountName.value.trim()) {
    showToast("Please enter the name shown on the payment", "warning");
    paymentAccountName.focus();
    return false;
  }
  const datePaid = document.getElementById("datePaid");
  if (datePaid && !datePaid.value) {
    showToast("Please select the date you paid", "warning");
    datePaid.focus();
    return false;
  }
  const today = new Date();
  const todayLocal = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
  if (datePaid && datePaid.value > todayLocal) {
    showToast("Date paid cannot be in the future", "warning");
    datePaid.focus();
    return false;
  }

  for (const field of fields) {
    if (field.type === "product") continue;

    const el = document.querySelector(`[data-id="${field.id}"]`);

    if (!el || !el.value || !el.value.trim()) {
      showToast(`Please fill "${field.label || "this field"}"`, "warning");
      el?.focus();
      return false;
    }
  }

  return true;
}

/* =========================
WHATSAPP ORDER HANDOFF
========================= */
function normalizeWhatsAppNumber(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) digits = "234" + digits.slice(1);
  if (digits.startsWith("2340") && digits.length === 14) digits = "234" + digits.slice(4);
  return digits;
}

function isValidWhatsAppNumber(value) {
  const digits = normalizeWhatsAppNumber(value);
  // Nigerian mobile numbers: +234 7xx/8xx/9xx followed by 8 digits.
  return /^234\d{10}$/.test(digits);
}

function buildWhatsAppOrderUrl(rawFormData, totalAmount, paymentFileId, orderId = "") {
  const phone = normalizeWhatsAppNumber(whatsappNumber);
  if (!whatsappOrderRedirectEnabled || !isValidWhatsAppNumber(phone)) return null;

  const productLines = [];
  rawFormData.forEach(item => {
    if (item.type !== "product") return;

    (item.value || []).forEach(product => {
      const qty = Number(product.qty || 0);
      const name = String(product.name || "Product").trim();
      if (!name || qty <= 0) return;
      productLines.push(`• ${name} × ${qty.toLocaleString("en-NG")}`);
    });
  });

  // Deliberately do NOT put the payment-image URL in the WhatsApp message.
  // The customer already selected/uploaded the payment screenshot. WhatsApp
  // should receive a short, human-readable handoff message and the customer
  // attaches that same recent screenshot manually before pressing Send.
  const message = [
    "Hello, I just placed an order via X-Redro.",
    orderId ? `Order ID: ${orderId}` : "",
    "",
    "Selected products:",
    ...productLines,
    "",
    "Payment image will be uploaded below."
  ].filter(Boolean).join("\n");

  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

function paymentImageUrl(fileId) {
  return `https://nyc.cloud.appwrite.io/v1/storage/buckets/${PRODUCT_IMAGES_BUCKET}/files/${encodeURIComponent(fileId)}/view?project=695981480033c7a4eb0d`;
}

/* The seller can mark a product sold out while a customer already has it in their cart.
   Right before sending, check the latest saved store. Sold-out items are taken out of the cart,
   the store is redrawn showing them as sold out, and the customer is told. Products are matched by
   name (not position), so a store edited in the meantime cannot swap quantities between products.
   Returns true when the order can go ahead. If the check itself fails (no network) the order goes ahead. */
async function removeSoldOutFromCart() {
  let latest;
  try {
    const doc = await databases.getDocument(DB_ID, FORMS, CURRENT_FORM_ID);
    latest = (doc.fields || []).map(f => (typeof f === "string" ? JSON.parse(f) : f));
  } catch (err) {
    console.warn("Could not re-check availability:", err);
    return true;
  }

  const removed = [];
  fields.forEach(field => {
    if (field.type !== "product") return;
    const fresh = latest.find(f => f.id === field.id && f.type === "product");
    if (!fresh) return;
    (field.products || []).forEach((p, i) => {
      const key = `${field.id}_${i}`;
      const match = (fresh.products || []).find(q => q.name === p.name);
      if (match && (match.soldOut === true || match.soldOut === "true")) {
        p.soldOut = true;
        if ((cart[key] || 0) > 0) { removed.push(p.name || "A product"); delete cart[key]; }
      }
    });
  });

  if (!removed.length) return true;

  renderForm();
  updateTotal();
  showToast(`${removed.join(", ")} just sold out and was removed from your order.`, "warning");
  return false;
}

/* Public Order ID: random, 12 characters, kept on the original order as its own field.
   It is checked against existing orders first, and the database's unique index on publicOrderID is the final guard. */
async function publicIdTaken(id) {
  try {
    const r = await databases.listDocuments(DB_ID, ORDERS, [Appwrite.Query.equal("publicOrderID", id), Appwrite.Query.limit(1)]);
    return r.documents.length > 0;
  } catch (e) {
    return false; // cannot check from here (permissions or the field does not exist yet); the unique index still protects
  }
}

/* Creates the order. With the Public Order ID first; if the Orders collection has no publicOrderID field yet
   (Appwrite refuses an unknown attribute) the order is sent exactly the old way, so selling never stops. */
async function createOrderDocument(payload) {
  const permissions = [
    Appwrite.Permission.write(Appwrite.Role.any()),
    Appwrite.Permission.read(Appwrite.Role.any())
  ];
  if (window.XrOrder && window.XrOrderCard) {
    for (let attempt = 0; attempt < 6; attempt++) {
      let publicOrderID = "";
      try { publicOrderID = XrOrderCard.generatePublicId(); } catch (e) { console.warn("No secure random source:", e); break; }
      if (await publicIdTaken(publicOrderID)) continue;
      try {
        const res = await databases.createDocument(DB_ID, ORDERS, Appwrite.ID.unique(), Object.assign({}, payload, { publicOrderID }), permissions);
        return { res, publicOrderID };
      } catch (err) {
        const msg = String((err && (err.message || (err.response && err.response.message))) || "");
        if (err && err.code === 409) continue; // another order already has this ID: pick a different one
        if (err && err.code === 400 && /attribute|structure/i.test(msg)) {
          console.warn("The Orders collection has no publicOrderID field yet; sending the order without one.", msg);
          break;
        }
        throw err;
      }
    }
  }
  const res = await databases.createDocument(DB_ID, ORDERS, Appwrite.ID.unique(), payload, permissions);
  return { res, publicOrderID: "" };
}

function buildOrderCardData({ createdAt, publicId, rawFormData, totalAmount, hasProof }) {
  const items = [];
  rawFormData.forEach(f => {
    if (f.type === "product") (f.value || []).forEach(p => items.push({ name: p.name, qty: Number(p.qty || 0), price: Number(p.price || 0) }));
  });
  const productTotal = items.reduce((t, i) => t + i.qty * i.price, 0);
  const cfg = typeof storefrontNormalizeConfig === "function" ? storefrontNormalizeConfig(storeConfig) : {};
  let dateText = "";
  try { dateText = new Date(createdAt || Date.now()).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); } catch (e) { dateText = new Date().toDateString(); }
  let retrievalUrl = "";
  try { retrievalUrl = new URL("order.html?fid=" + encodeURIComponent(CURRENT_FORM_ID), window.location.href).href; } catch (e) { retrievalUrl = "order.html"; }
  return {
    storeName: formTitle, logoUrl: cfg.logoUrl || "", publicId, dateText, items,
    feesAmount: Math.max(0, totalAmount - productTotal), total: totalAmount,
    paymentStatus: hasProof ? "Payment image received" : "Awaiting payment",
    paymentTone: hasProof ? "info" : "warn",
    contact: { whatsapp: cfg.whatsapp || whatsappNumber || "", phone: cfg.phone || "" },
    retrievalUrl, updatesEnabled: customerOrderUpdatesEnabled
  };
}

/* A slim bar above the store so customers who already ordered can find their order. It is added once to the
   live store only (never the builder preview), above every theme, and hidden when the seller turned order changes off. */
function renderRetrieveStrip() {
  const root = document.getElementById("formRoot");
  if (!root || !customerOrderUpdatesEnabled || !CURRENT_FORM_ID || document.getElementById("ocRetrieveStrip")) return;
  const strip = document.createElement("div");
  strip.id = "ocRetrieveStrip";
  strip.className = "oc-retrieve-strip";
  strip.innerHTML = `<span>Already ordered?</span> <a href="order.html?fid=${encodeURIComponent(CURRENT_FORM_ID)}">Retrieve My Order</a>`;
  root.parentNode.insertBefore(strip, root);
}

async function submitOrder() {
  // validate normal inputs first
  if (!validateFormInputs()) return;

  const rawFormData = buildRawFormData();

  // validate products
  const hasProducts = rawFormData.some(f => f.type === "product");
  if (!hasProducts) {
    showToast("Please select at least one product", "warning");
    return;
  }

  if (!(await removeSoldOutFromCart())) return;

  /* payment proof image */
  const paymentInput = document.getElementById("paymentProof");
  let paymentFileId = null;

  if (paymentInput && paymentInput.files.length > 0) {
    const file = paymentInput.files[0];
    const storage = new Appwrite.Storage(client);

    try {
      const uploadedFile = await storage.createFile(
        PRODUCT_IMAGES_BUCKET,
        Appwrite.ID.unique(),
        file,
        [Appwrite.Permission.read(Appwrite.Role.any())]
      );

      paymentFileId = uploadedFile.$id;
    } catch (err) {
      console.error("Failed to upload payment proof:", err);
      showToast("Failed to upload payment proof. Please try again.", "error");
      showToast(
        err.message ||
        err.response?.message ||
        JSON.stringify(err),
        "error"
      );
      return;
    }
  }

  // compute totals from raw objects
  let totalAmount = 0;
  rawFormData.forEach(f => {
    if (f.type === "product") {
      f.value.forEach(p => {
        totalAmount += p.qty * p.price;
      });
    }
  });
  
  // add additional fee to total
  fields.forEach(field => {
    if (field.type === "additional_fee") {
      const selected = rawFormData.find(f => f.type === "additional_fee" && f.label === field.label);
      if (selected) {
        const feeObj = field.fees.find(f => f.name === selected.value);
        if (feeObj) {
          totalAmount += Number(feeObj.price || 0);
        }
      }
    }
  });

  // stringify ONLY for storage
  const formData = rawFormData.map(item =>
    JSON.stringify(item)
  );

  const orderPayload = {
    userId: FORM_OWNER_ID,
    formId: CURRENT_FORM_ID,
    formData,
    totalAmount,
    status: "pending",
    paymentProof: paymentFileId
  };

  try {
    const { res, publicOrderID } = await createOrderDocument(orderPayload);

    console.log("ORDER CREATED:", res);
    if (typeof xrTelegramNotify === "function") xrTelegramNotify("new_order", res.$id); // fire and forget: never delays or fails the order

    // the order exists now: nothing about the card may turn this into a "failed" order
    try {
      lastOrderCard = publicOrderID ? buildOrderCardData({ createdAt: res.$createdAt, publicId: publicOrderID, rawFormData, totalAmount, hasProof: !!paymentFileId }) : null;
      if (window.XrOrderCard) XrOrderCard.setCurrent(lastOrderCard);
    } catch (cardErr) {
      console.warn("Could not prepare the order card:", cardErr);
      lastOrderCard = null;
    }

    const waUrl = (whatsappOrderRedirectEnabled && paymentFileId)
      ? buildWhatsAppOrderUrl(rawFormData, totalAmount, paymentFileId, publicOrderID)
      : null;

    if (waUrl) {
      pendingWhatsAppUrl = waUrl;
      renderSuccessState(true);
    } else {
      pendingWhatsAppUrl = "";
      renderSuccessState(false);
    }

  } catch (err) {
    console.error("FAILED TO SEND ORDER:", err);
    showToast(
      err.message ||
      err.response?.message ||
      JSON.stringify(err),
      "error"
    );
  }
}

function changeQty(fieldId, index, delta) {
  const key = `${fieldId}_${index}`;

  // a product the seller marked sold out cannot be added (its buttons are disabled too)
  const pf = fields.find(f => f.id === fieldId);
  const prod = pf && Array.isArray(pf.products) ? pf.products[index] : null;
  if (delta > 0 && prod && (prod.soldOut === true || prod.soldOut === "true")) {
    showToast(`${prod.name || "This product"} is sold out`, "info");
    return;
  }

  cart[key] = Math.max(0, (cart[key] || 0) + delta);

  const qty = cart[key];
  const qtyEl = document.getElementById(`qty-${fieldId}-${index}`);
  const badgeEl = document.getElementById(`badge-${fieldId}-${index}`);
  if (qtyEl) qtyEl.innerText = qty;
  if (badgeEl) badgeEl.innerText = qty;
  updateTotal();
}

function updateTotal() {
  let items = 0;
  let total = 0;

  fields.forEach(field => {
    if (field.type === "product") {
      field.products.forEach((p, i) => {
        const key = `${field.id}_${i}`;
        const qty = cart[key] || 0;
        items += qty;
        total += qty * Number(p.price || 0);
      });
    }
  });
  
  // additional fees
  let additionalFees = [];
  let additionalFeeAmount = 0;

  fields.forEach(field => {
    if (field.type === "additional_fee") {
      const select = document.querySelector(`[data-id="${field.id}"]`);
      if (select && select.value) {
        const selected = field.fees.find(f => f.name === select.value);
        if (selected) {
          additionalFees.push({
            label: field.label,        // use FIELD label
            name: selected.name,       // selected option name
            price: Number(selected.price || 0)
          });

          additionalFeeAmount += Number(selected.price || 0);
        }
      }
    }
  });

  total += additionalFeeAmount;
  const feeBox = document.getElementById("additionalFeeBox");

  if (feeBox) {
    if (additionalFees.length > 0) {

      feeBox.innerHTML = additionalFees.map(fee => `
        <div>
          ${fee.label}: ${fee.name}
          <span>₦${formatNaira(fee.price)}</span>
        </div>
      `).join("");

      feeBox.style.display = "block";

    } else {
      feeBox.innerHTML = "";
      feeBox.style.display = "none";
    }
  }

  document.getElementById("itemCount").innerText = items;
  document.getElementById("totalCost").innerText = `₦${formatNaira(total)}`;

  // keep the sticky cart bar in sync (new visual system — additive)
  const cartBarCount = document.getElementById("cartBarCount");
  const cartBarTotal = document.getElementById("cartBarTotal");
  const cartBar = document.getElementById("cartBar");
  if (cartBarCount) cartBarCount.innerText = `${items} item${items === 1 ? "" : "s"}`;
  if (cartBarTotal) cartBarTotal.innerText = `₦${formatNaira(total)}`;
  if (cartBar) cartBar.classList.toggle("visible", items > 0);

  // full-store themes: cart drawer, header count, checkout summary
  if (typeof storefrontRefreshCart === "function") storefrontRefreshCart(fields, cart, "changeQty");
}

/* =========================
UI INTERACTION LOGIC
========================= */
/* ---------------- RENDER (delegates to the shared storefront renderer
   in js/storefront-render.js — the builder's preview uses the exact
   same function, so what a seller previews is what customers see) ---------------- */


function renderForm() {
  const container = document.getElementById("formRoot");
  container.innerHTML = buildStorefrontHTML({
    fields,
    formTitle,
    formSubtitle,
    themeClass: CURRENT_THEME_CLASS,
    storeConfig,
    opts: { live: true, cart, qtyFn: "changeQty", totalFn: "updateTotal", submitFn: "submitOrder" }
  });
}

function renderSuccessState(whatsappReady = false) {
  const container = document.getElementById("formRoot");

  container.innerHTML = `
    <div class="preview-theme ${CURRENT_THEME_CLASS}">
      <div class="preview-card success-state">
        <h2 class="business-name">${storefrontEscape(formTitle)}</h2>

        <div class="success-icon">✓</div>

        <h3 class="success-title">Your order has been sent</h3>
        <p class="success-subtitle">
          The seller will contact you shortly.
        </p>

        ${lastOrderCard && window.XrOrderCard ? XrOrderCard.panelHTML(lastOrderCard) : ""}

        ${whatsappReady ? `
          <div class="whatsapp-handoff-box">
            <p><strong>Send your payment proof to the seller</strong></p>
            <p class="whatsapp-handoff-help">Your order details are already prepared. When WhatsApp opens, attach the same payment screenshot you just uploaded, then tap Send.</p>
            <a class="whatsapp-handoff-btn" href="${pendingWhatsAppUrl}" target="_blank" rel="noopener">Continue to WhatsApp</a>
          </div>
        ` : ""}

        <p class="powered">powered by X Redro</p>
      </div>
    </div>
  `;

  const strip = document.getElementById("ocRetrieveStrip");
  if (strip) strip.remove();
  if (lastOrderCard && window.XrOrderCard) XrOrderCard.fillPreview();
}

/* =========================
EVENT LISTENERS / TRIGGERS
========================= */
document.addEventListener("change", e => {
  if (e.target.id === "paymentProof") {
    const text = document.querySelector(".upload-text");
    const preview = document.getElementById("paymentProofPreview");
    if (preview) {
      preview.innerHTML = "";
      if (e.target.files && e.target.files.length) {
        const file = e.target.files[0];
        if (file.type && !file.type.startsWith("image/")) {
          showToast("Please choose an image file for payment proof", "warning");
          e.target.value = "";
          if (text) text.innerText = "Upload payment proof";
          return;
        }
        const image = document.createElement("img");
        image.className = "payment-proof-preview-image";
        image.alt = "Selected payment proof preview";
        image.src = URL.createObjectURL(file);
        image.onload = () => URL.revokeObjectURL(image.src);
        preview.appendChild(image);
        const status = document.createElement("span");
        status.className = "payment-proof-selected-label";
        status.textContent = "Payment image selected";
        preview.appendChild(status);
        if (text) text.innerText = "Change payment image";
      } else if (text) {
        text.innerText = "Upload payment proof";
      }
    } else if (text && e.target.files.length) {
      text.innerText = "Payment image selected";
    }
  }
});

/* =========================
INITIALIZATION / BOOTSTRAP LOGIC
========================= */
async function initForm() {
  const params = new URLSearchParams(window.location.search);
  const fid = params.get("fid");

  if (!fid) {
    showToast("Invalid form link", "error");
    return;
  }

  try {
    const doc = await databases.getDocument(DB_ID, FORMS, fid);

    formTitle = doc.title || "";
    formSubtitle = doc.subtitle || "";

    // Which of the 4 finalized visual themes this seller picked in the
    // Form Builder (falls back to theme-r1 if the form predates this,
    // or if the `storeTheme` attribute hasn't been added to the form
    // collection in Appwrite yet — see NOTE in js/builderF.js).
    CURRENT_THEME_CLASS = doc.storeTheme ? `theme-${doc.storeTheme}` : "theme-r1";
    storeConfig = doc.storeConfig || null;

    fields = doc.fields.map(f =>
      typeof f === "string" ? JSON.parse(f) : f
    );

    CURRENT_FORM_ID = fid;
    FORM_OWNER_ID = doc.userId || "";
    whatsappNumber = String(doc.whatsappNumber || "").trim();
    whatsappOrderRedirectEnabled = doc.whatsappOrderRedirectEnabled === true;
    customerOrderUpdatesEnabled = doc.customerOrderUpdatesEnabled !== false;

    renderForm();
    renderRetrieveStrip();
  } catch (err) {
    console.error("INIT ERROR:", err);
    showToast(err.message || "Form not found", "error");
  }
}

initForm();
