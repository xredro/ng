/* =========================
FILE OVERVIEW
========================= */
// Form builder application with Appwrite

/* =========================
GLOBAL CONSTANTS / CONFIG
========================= */
const DB_ID = "695c4fce0039f513dc83";
const FORMS = "form";
const USERS = "695c501b001d24549b03";
const SUBS = "subscriptions";
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
const storage = new Appwrite.Storage(client);
const Query = Appwrite.Query;

/* =========================
GLOBAL STATE VARIABLES
========================= */
let fields = [];
let imagesMarkedForDeletion = [];
let profileDocId = null;
let user;
let res;

let formId;
let formTitle = "";
let formSubtitle = "";

// Visual theme for the customer-facing store page — one of "r1".."r4",
// matching css/theme-r1.css .. theme-r4.css. Persisted on the form
// document as `storeTheme` (NOTE: add a `storeTheme` string attribute
// to the "form" collection in Appwrite for this to save — it's separate
// from the existing dark/light `theme` field on the user profile).
let selectedStoreTheme = "r1";

function selectStoreTheme(themeId) {
  selectedStoreTheme = themeId;
  highlightSelectedTheme();
  // if the preview overlay is currently open, re-render it immediately
  // so switching themes updates the preview live
  const overlay = document.getElementById("previewOverlay");
  if (overlay && !overlay.classList.contains("hidden")) {
    openPreview();
  }
}

function highlightSelectedTheme() {
  document.querySelectorAll("#themePicker .theme-swatch").forEach(el => {
    el.classList.toggle("active", el.dataset.theme === selectedStoreTheme);
  });
}

/* =========================
UTILITY / HELPER FUNCTIONS
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
const PAYMENT_UPLOAD_URL = "https://your-domain.example.com/upload-payment";

function goToPaymentUpload() {
  window.location.href = PAYMENT_UPLOAD_URL;
}

function formatWithCommas(value) {
  if (!value) return "";
  return Number(value.replace(/,/g, "")).toLocaleString();
}

function stripCommas(value) {
  return value.replace(/,/g, "");
}

function handlePriceInput(input) {
  const raw = input.value.replace(/,/g, "").replace(/\D/g, "");
  input.value = raw ? Number(raw).toLocaleString() : "";
}

function getDefaultLabel(type) {
  return {
    text: "Text Input",
    number: "Number Input",
    textarea: "Text Area",
    dropdown: "Dropdown",
    product: "Product Listing",
    additional_fee: "Additional Fee"
  }[type];
}

/* =========================
CORE BUSINESS LOGIC
========================= */
/* ---------------- AUTH ---------------- */
async function requireAuth() {
  try {
    return await account.get();
  } catch {
    window.location.href = "login.html";
  }
}

/* ---------------- SAVE ---------------- */
async function saveForm() {

  const productFields = fields.filter(f => f.type === "product");

  if (productFields.length === 0) {
    showToast("Add at least one product listing before saving.", "warning");
    return;
  }

  const hasAtLeastOneProduct = productFields.some(
    f => Array.isArray(f.products) && f.products.length > 0
  );

  if (!hasAtLeastOneProduct) {
    showToast("Add at least one product inside your product listing.", "warning");
    return;
  }

  // Optional: block empty product name or price
  let invalidProduct = null;

  for (const field of productFields) {
    invalidProduct = field.products.find(
      p => !p.name || !p.price
    );
    if (invalidProduct) break;
  }

  if (invalidProduct) {
    showToast("Each product must have a name and price.", "warning");
    return;
  }

  for (let imageId of imagesMarkedForDeletion) {
    try {
      await storage.deleteFile(PRODUCT_IMAGES_BUCKET, imageId);
    } catch {}
  }

  imagesMarkedForDeletion = [];

  // Saving if valid
  const safeFields = fields.map(f => JSON.stringify(f));

  await databases.updateDocument(DB_ID, FORMS, formId, {
    title: formTitle,
    subtitle: formSubtitle,
    fields: safeFields,
    storeTheme: selectedStoreTheme,
    $updatedAt: new Date().toISOString()
  });

  showToast("Form saved successfully", "success");
}

/* ---------------- FORM LINK ---------------- */
function setupFormLink() {
  const input = document.getElementById("formLinkInput");
  const link = `${window.location.origin}/ng/form.html?fid=${formId}`;
  input.value = link;
}

function copyFormLink() {
  const input = document.getElementById("formLinkInput");
  input.select();
  document.execCommand("copy");
  showToast("Form link copied", "success");
}

/* ---------------- ADD MENU ---------------- */
function toggleAddMenu(btn) {
  const menu = document.getElementById('addMenu');
  const rect = btn.getBoundingClientRect();

  menu.style.top = rect.bottom + 6 + "px";
  menu.style.left = rect.left + "px";

  menu.classList.toggle('hidden');
}

function addField(type) {
  const field = {
    id: crypto.randomUUID(),
    type,
    label: getDefaultLabel(type),
    options: [],
    products: []
  };

  fields.push(field);
  document.getElementById('addMenu').classList.add('hidden');
  renderFields();
}

/* ---------------- RENDER ---------------- */
let expandedFieldIds = new Set(); // transient UI-only state — which Input Field cards are expanded

function renderFields() {
  const container = document.getElementById('fields');
  const productContainer = document.getElementById('productFields');
  container.innerHTML = "";
  if (productContainer) productContainer.innerHTML = "";

  fields.forEach(field => {
    // Product-type fields render in their own "Products" section
    // (category chips + grid + tap-to-edit overlay), always open —
    // not part of the collapsible Input Fields accordion below.
    if (field.type === "product" && productContainer) {
      const card = document.createElement('div');
      card.className = "field-card product-field-card";
      card.innerHTML = `
        <div class="field-header">
          <input
            class="field-label"
            value="${field.label || ""}"
            onchange="updateLabel('${field.id}', this.value)"
          />
          <span class="remove remove-field" data-id="${field.id}">×</span>
        </div>
      `;
      card.appendChild(renderProducts(field));
      productContainer.appendChild(card);
      return;
    }

    const isExpanded = expandedFieldIds.has(field.id);
    const hasBody = field.type === "dropdown" || field.type === "additional_fee";

    const card = document.createElement('div');
    card.className = "field-card" + (isExpanded ? " expanded" : "");

    card.innerHTML = `
      <div class="field-header" onclick="toggleFieldExpanded(event, '${field.id}')">
        <input
          class="field-label"
          value="${field.label || ""}"
          onchange="updateLabel('${field.id}', this.value)"
          onclick="event.stopPropagation()"
        />
        ${hasBody ? `<span class="field-chevron">${isExpanded ? "&#9650;" : "&#9660;"}</span>` : ""}
        <span class="remove remove-field" data-id="${field.id}" onclick="event.stopPropagation()">×</span>
      </div>
    `;

    if (hasBody) {
      const body = document.createElement('div');
      body.className = "field-body";
      if (field.type === "dropdown") body.appendChild(renderDropdown(field));
      if (field.type === "additional_fee") body.appendChild(renderAdditionalFees(field));
      card.appendChild(body);
    }

    container.appendChild(card);
  });
}

function toggleFieldExpanded(e, id) {
  if (e) e.stopPropagation();
  if (expandedFieldIds.has(id)) {
    expandedFieldIds.delete(id);
  } else {
    expandedFieldIds.add(id);
  }
  renderFields();
}

document.addEventListener("click", (e) => {
  if (e.target.classList.contains("remove-field")) {
    const id = e.target.dataset.id;
    removeField(id);
  }
});

function updateLabel(id, value) {
  const f = fields.find(f => f.id === id);
  if (f) f.label = value;
}

/* ---------------- Remove Field---------------- */
async function removeField(id) {
  const field = fields.find(f => f.id === id);

  fields = fields.filter(f => f.id !== id);
  renderFields();

  if (field?.type === "product") {
    for (let p of field.products) {
      if (p.imageId) {
        imagesMarkedForDeletion.push(p.imageId);
      }
    }
  }
}

/* ---------------- DROPDOWN ---------------- */
function renderDropdown(field) {
  const wrap = document.createElement('div');

  const inputRow = document.createElement('div');
  inputRow.className = "dropdown-input-row";

  const input = document.createElement('input');
  input.placeholder = "Add option";
  input.type = "text";
  input.enterKeyHint = "done"; // important for mobile keyboards

  const addBtn = document.createElement('button');
  addBtn.type = "button";
  addBtn.innerText = " + Add option";
  addBtn.className = "add-product";

  const chips = document.createElement('div');
  chips.className = "chips";

  function addOption() {
    const value = input.value.trim();
    if (!value) return;

    field.options.push(value);
    input.value = "";

    renderFields();

    // restore focus after re-render
    setTimeout(() => {
      const inputs = document.querySelectorAll(".dropdown-input-row input");
      if (inputs.length) {
        inputs[inputs.length - 1].focus();
      }
    }, 0);
  }

  // Desktop Enter
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addOption();
    }
  });

  // Mobile fallback
  input.addEventListener("blur", () => {
    if (input.value.trim()) {
      addOption();
    }
  });

  addBtn.onclick = addOption;

  field.options.forEach((opt, i) => {
    const chip = document.createElement('div');
    chip.className = "chip";
    chip.innerHTML = `${opt} <span onclick="removeOption('${field.id}', ${i})">×</span>`;
    chips.appendChild(chip);
  });

  inputRow.appendChild(input);
  inputRow.appendChild(addBtn);

  wrap.appendChild(inputRow);
  wrap.appendChild(chips);

  return wrap;
}
function removeOption(fieldId, index) {
  const field = fields.find(f => f.id === fieldId);
  field.options.splice(index, 1);
  renderFields();
}

/* ---------------- PRODUCTS ---------------- */
function savePrice(fieldId, index, value) {
  const field = fields.find(f => f.id === fieldId);
  if (!field) return;

  // store clean number only
  field.products[index].price = stripCommas(value);
}

let productUIState = {}; // { [fieldId]: { activeCategory: "All", editingIndex: null } } — transient UI-only state, not saved

function getProductUIState(fieldId) {
  if (!productUIState[fieldId]) {
    productUIState[fieldId] = { activeCategory: "All", editingIndex: null };
  }
  return productUIState[fieldId];
}

function setActiveCategory(fieldId, cat) {
  getProductUIState(fieldId).activeCategory = cat;
  renderFields();
}

function openProductEditor(fieldId, index) {
  getProductUIState(fieldId).editingIndex = index;
  renderFields();
}

function closeProductEditor(fieldId) {
  getProductUIState(fieldId).editingIndex = null;
  renderFields();
}

function renderProducts(field) {
  const wrap = document.createElement('div');
  wrap.style.marginTop = "12px";

  field.products.forEach(p => { if (!p.category) p.category = "General"; });

  const state = getProductUIState(field.id);
  const categories = ["All", ...new Set(field.products.map(p => p.category || "General"))];

  const chipRow = document.createElement('div');
  chipRow.className = "category-chip-row";
  categories.forEach(cat => {
    const chip = document.createElement('span');
    chip.className = "category-chip" + (state.activeCategory === cat ? " active" : "");
    chip.innerText = cat;
    chip.onclick = () => setActiveCategory(field.id, cat);
    chipRow.appendChild(chip);
  });
  wrap.appendChild(chipRow);

  const grid = document.createElement('div');
  grid.className = "product-edit-grid";

  field.products.forEach((p, i) => {
    if (state.activeCategory !== "All" && (p.category || "General") !== state.activeCategory) return;

    const tile = document.createElement('div');
    tile.className = "product-tile";
    tile.innerHTML = `
      <div class="product-tile-image">
        ${p.imageUrl ? `<img src="${p.imageUrl}" class="product-img"/>` : `<span class="product-tile-placeholder">+ Photo</span>`}
      </div>
      <div class="product-tile-name">${p.name || "Untitled"}</div>
      <div class="product-tile-price">₦${p.price ? formatWithCommas(p.price) : "0"}</div>
    `;
    tile.onclick = () => openProductEditor(field.id, i);
    grid.appendChild(tile);
  });

  const addTile = document.createElement('div');
  addTile.className = "product-tile add-tile";
  addTile.innerHTML = `<span class="pe-plus">+</span><span>Add product</span>`;
  addTile.onclick = () => {
    field.products.push({
      name: "", price: "", imageId: "", imageUrl: "",
      category: state.activeCategory === "All" ? "General" : state.activeCategory
    });
    state.editingIndex = field.products.length - 1;
    renderFields();
  };
  grid.appendChild(addTile);

  wrap.appendChild(grid);

  if (state.editingIndex !== null && field.products[state.editingIndex]) {
    const i = state.editingIndex;
    const p = field.products[i];
    const editor = document.createElement('div');
    editor.className = "product-editor-overlay";
    editor.innerHTML = `
      <div class="product-editor-card">
        <div class="product-editor-head">
          <strong>Edit product</strong>
          <span class="product-editor-close" onclick="closeProductEditor('${field.id}')">&times;</span>
        </div>

        <div class="product-editor-image">
          ${p.imageUrl ? `<img src="${p.imageUrl}" class="product-img"/>` : ""}
          <label class="upload-btn">
            ${p.imageUrl ? "Change image" : "Upload image"}
            <input type="file" hidden onchange="uploadProductImage('${field.id}', ${i}, this)">
          </label>
        </div>

        <label>Name</label>
        <input placeholder="Product name" value="${p.name || ""}"
          onchange="updateProduct('${field.id}', ${i}, 'name', this.value)">

        <label>Price</label>
        <input placeholder="₦ Price" value="${p.price ? formatWithCommas(p.price) : ""}"
          oninput="handlePriceInput(this)" onblur="savePrice('${field.id}', ${i}, this.value)">

        <label>Category</label>
        <input placeholder="e.g. Audio" value="${p.category || "General"}"
          onchange="updateProduct('${field.id}', ${i}, 'category', this.value); renderFields();">

        <button type="button" class="product-editor-delete"
          onclick="removeProduct('${field.id}', ${i}); closeProductEditor('${field.id}');">
          Delete product
        </button>
      </div>
    `;
    wrap.appendChild(editor);
  }

  return wrap;
}

async function uploadProductImage(fieldId, index, input) {
  const file = input.files[0];
  if (!file) return;

  const field = fields.find(f => f.id === fieldId);
  const product = field.products[index];

  // delete old image if exists
  if (product.imageId) {
    await storage.deleteFile(PRODUCT_IMAGES_BUCKET, product.imageId);
  }

  const uploaded = await storage.createFile(
    PRODUCT_IMAGES_BUCKET,
    Appwrite.ID.unique(),
    file
  );

  const previewUrl = storage.getFileView(
    PRODUCT_IMAGES_BUCKET,
    uploaded.$id
  ).href;

  product.imageId = uploaded.$id;
  product.imageUrl = previewUrl;

  renderFields();
}

/*---------------ADDITIONAL PRICING------------*/
function renderAdditionalFees(field) {
  const wrap = document.createElement('div');
  wrap.style.marginTop = "12px";

  if (!Array.isArray(field.fees)) {
    field.fees = [];
  }

  field.fees.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = "fee-row";

    row.innerHTML = `
      <input placeholder="Fee name" value="${f.name || ""}"
        onchange="updateAdditionalFee('${field.id}', ${i}, 'name', this.value)">

      <input placeholder="₦ Amount" value="${f.price ? formatWithCommas(f.price) : ""}"
        oninput="handlePriceInput(this)" 
        onblur="saveAdditionalFeePrice('${field.id}', ${i}, this.value)">

      <span class="remove" onclick="removeAdditionalFee('${field.id}', ${i})">×</span>
    `;

    wrap.appendChild(row);
  });

  const btn = document.createElement('button');
  btn.className = "add-product";
  btn.innerText = "+ Add fee";
  btn.onclick = () => {
    field.fees.push({ name: "", price: "" });
    renderFields();
  };

  wrap.appendChild(btn);
  return wrap;
}

function updateAdditionalFee(fieldId, index, key, value) {
  const field = fields.find(f => f.id === fieldId);
  if (!field) return;
  field.fees[index][key] = value;
}

function saveAdditionalFeePrice(fieldId, index, value) {
  const field = fields.find(f => f.id === fieldId);
  if (!field) return;
  field.fees[index].price = stripCommas(value);
}

function removeAdditionalFee(fieldId, index) {
  const field = fields.find(f => f.id === fieldId);
  if (!field) return;

  field.fees.splice(index, 1);
  renderFields();
}

/*------------ NORMALIZE PRODUCTS & ADDITIONAL FEE-------------*/
function normalizeProducts(field) {
  if (!Array.isArray(field.products)) {
    field.products = [];
    return;
  }

  field.products = field.products.map(p => ({
    name: p?.name ?? "",
    price: p?.price ?? "",
    imageId: p?.imageId ?? "",
    imageUrl: p?.imageUrl ?? "",
    category: p?.category ?? "General"
  }));
}

function normalizeFee(field){
  if (!Array.isArray(field.fees)) {
    field.fees = [];
    return;
  }

  field.fees = field.fees.map(f => ({
    name: f?.name ?? "",
    price: f?.price ?? ""
  }));
}

function updateProduct(fieldId, index, key, value) {
  const field = fields.find(f => f.id === fieldId);
  field.products[index][key] = value;
}

function removeProduct(fieldId, index) {
  const field = fields.find(f => f.id === fieldId);
  if (!field || !field.products[index]) return;

  const product = field.products[index];

  if (product.imageId) {
    imagesMarkedForDeletion.push(product.imageId);
  }

  field.products.splice(index, 1);
  renderFields();
}

/* ---------------- PREVIEW OVERLAY ---------------- */
let previewCart = {};

function openPreview(e) {
  if (e) e.preventDefault();
  const overlay = document.getElementById("previewOverlay");
  const container = document.getElementById("previewForm");

  previewCart = {};
  container.innerHTML = buildStorefrontHTML({
    fields,
    formTitle,
    formSubtitle,
    themeClass: `theme-${selectedStoreTheme}`,
    // live:true so the preview is genuinely interactive (real qty
    // buttons, real running total) — same renderer as the real page,
    // just pointed at a throwaway preview cart instead of a real order.
    opts: { live: true, cart: previewCart, qtyFn: "previewChangeQty", totalFn: "previewUpdateTotal", submitFn: "previewNoSubmit" }
  });
  overlay.classList.remove("hidden");
}

function closePreview() {
  document.getElementById("previewOverlay").classList.add("hidden");
}

function previewNoSubmit() {
  showToast("This is a preview — orders can't be sent from here.", "info");
}

function previewChangeQty(fieldId, index, delta) {
  const key = `${fieldId}_${index}`;
  previewCart[key] = Math.max(0, (previewCart[key] || 0) + delta);
  const el = document.getElementById(`qty-${fieldId}-${index}`);
  if (el) el.innerText = previewCart[key];
  previewUpdateTotal();
}

function previewUpdateTotal() {
  let items = 0, total = 0;

  fields.forEach(field => {
    if (field.type === "product") {
      field.products.forEach((p, i) => {
        const qty = previewCart[`${field.id}_${i}`] || 0;
        items += qty;
        total += qty * Number(p.price || 0);
      });
    }
  });

  let additionalFeeAmount = 0;
  let additionalFeesHtml = [];
  fields.forEach(field => {
    if (field.type === "additional_fee") {
      const select = document.querySelector(`[data-id="${field.id}"]`);
      if (select && select.value) {
        const selected = (field.fees || []).find(f => f.name === select.value);
        if (selected) {
          additionalFeeAmount += Number(selected.price || 0);
          additionalFeesHtml.push(`<div>${field.label}: ${selected.name} <span>₦${Number(selected.price || 0).toLocaleString()}</span></div>`);
        }
      }
    }
  });
  total += additionalFeeAmount;

  const feeBox = document.getElementById("additionalFeeBox");
  if (feeBox) {
    feeBox.innerHTML = additionalFeesHtml.join("");
    feeBox.style.display = additionalFeesHtml.length ? "block" : "none";
  }

  const itemCountEl = document.getElementById("itemCount");
  const totalCostEl = document.getElementById("totalCost");
  if (itemCountEl) itemCountEl.innerText = items;
  if (totalCostEl) totalCostEl.innerText = `₦${total.toLocaleString()}`;

  const cartBarCount = document.getElementById("cartBarCount");
  const cartBarTotal = document.getElementById("cartBarTotal");
  const cartBar = document.getElementById("cartBar");
  if (cartBarCount) cartBarCount.innerText = `${items} item${items === 1 ? "" : "s"}`;
  if (cartBarTotal) cartBarTotal.innerText = `₦${total.toLocaleString()}`;
  if (cartBar) cartBar.classList.toggle("visible", items > 0);
}

/* =========================
UI INTERACTION LOGIC
========================= */
/* ---------------- INIT ---------------- */
async function initBuilder() {
  user = await requireAuth();
  
  res = await databases.listDocuments(DB_ID, USERS, [
    Query.equal("userId", user.$id)
  ]);
  
  // Quick Subscription Check
  const subRes = await databases.listDocuments(DB_ID, SUBS, [
    Query.equal("userId", user.$id),
    Query.orderDesc("expiresAt"),
    Query.limit(1)
  ]);
  
  //Theme Application
  profileDocId = res.documents[0].$id;

  const savedTheme = res.documents[0].theme || "light";
  applyTheme(savedTheme);

  //Quick Subscription Check
  const sub = subRes.documents[0];
  const daysLeft = Math.ceil(
    (new Date(sub.expiresAt) - new Date()) / 86400000
  );

  if (daysLeft <= 0) {
    document.getElementById("subscriptionModal").classList.remove("hidden");
    return;
  } 

  try {
    const formDoc = await databases.getDocument(DB_ID, FORMS, user.$id);
    fields = [];

    if (formDoc.fields && Array.isArray(formDoc.fields)) {
      fields = formDoc.fields.map(f => {
        try {
          const field = JSON.parse(f);

          if (field.type === "product") {
            normalizeProducts(field);
          }
          
          if (field.type === "additional_fee") {
            normalizeFee(field);
          }

          return field;
        } catch {
          return null;
        }
      }).filter(Boolean);
    }  
    formId = user.$id;
    formTitle = formDoc.title || "";
    formSubtitle = formDoc.subtitle || "";
    selectedStoreTheme = formDoc.storeTheme || "r1";

    document.getElementById("titleInput").value = formTitle;
    document.getElementById("subtitleInput").value = formSubtitle;
    highlightSelectedTheme();
  } catch (err) {
    // create empty form if not exists
    await databases.createDocument(DB_ID, FORMS, user.$id, {
      userId: user.$id,
      fields: [],
      $createdAt: new Date().toISOString()
    });
    fields = [];
    formId = user.$id;
  }
  
  if (!res.documents.length) return;    
  
  renderFields();
  setupFormLink();
}

initBuilder();

/* =========================
EVENT LISTENERS / TRIGGERS
========================= */
document.addEventListener("click", (e) => {
  const menu = document.getElementById("addMenu");
  const addBtn = document.getElementById("addFieldBtn"); // your + button

  if (!menu || menu.classList.contains("hidden")) return;

  // if click is outside menu AND outside button → close
  if (!menu.contains(e.target) && !addBtn.contains(e.target)) {
    menu.classList.add("hidden");
  }
});

document.getElementById("previewOverlay").addEventListener("click", (e) => {
  const content = document.getElementById("previewForm");

  // click outside preview card
  if (!content.contains(e.target)) {
    closePreview();
  }
});

/* =========================
UNUSED / EXPERIMENTAL / FUTURE CODE
========================= */
