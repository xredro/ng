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

let CURRENT_FORM_ID = "";
let FORM_OWNER_ID = "";

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

  return data;
}

function validateFormInputs() {
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
CORE BUSINESS LOGIC
========================= */
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
        file
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
    const res = await databases.createDocument(
      DB_ID,
      ORDERS,
      Appwrite.ID.unique(),
      orderPayload,
      [
        Appwrite.Permission.write(Appwrite.Role.any()),
        Appwrite.Permission.read(Appwrite.Role.any())
      ]
    );

    console.log("ORDER CREATED:", res);
    renderSuccessState();

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
  cart[key] = Math.max(0, (cart[key] || 0) + delta);

  document.getElementById(`qty-${fieldId}-${index}`).innerText = cart[key];
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
    opts: { live: true, cart, qtyFn: "changeQty", totalFn: "updateTotal", submitFn: "submitOrder" }
  });
}

function renderSuccessState() {
  const container = document.getElementById("formRoot");

  container.innerHTML = `
    <div class="preview-theme ${CURRENT_THEME_CLASS}">
      <div class="preview-card success-state">
        <h2 class="business-name">${formTitle}</h2>

        <div class="success-icon">✓</div>

        <h3 class="success-title">Your order has been sent</h3>
        <p class="success-subtitle">
          The seller will contact you shortly.
        </p>

        <p class="powered">powered by X Redro</p>
      </div>
    </div>
  `;
}

/* =========================
EVENT LISTENERS / TRIGGERS
========================= */
document.addEventListener("change", e => {
  if (e.target.id === "paymentProof") {
    const text = document.querySelector(".upload-text");
    if (e.target.files.length) {
      text.innerText = e.target.files[0].name;
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

    fields = doc.fields.map(f =>
      typeof f === "string" ? JSON.parse(f) : f
    );

    CURRENT_FORM_ID = fid;
    FORM_OWNER_ID = doc.userId || "";

    renderForm();
  } catch (err) {
    console.error("INIT ERROR:", err);
    showToast(err.message || "Form not found", "error");
  }
}

initForm();
