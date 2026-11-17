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

// Text that goes inside HTML templates must be escaped, or a quote in a product
// name breaks the field and markup in a name would be inserted into the page.
function escapeHtml(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---- unsaved-changes tracking ---- */
let savedSnapshot = "";
function currentSnapshot() {
  return JSON.stringify([formTitle, formSubtitle, selectedStoreTheme, fields, storeConfigSupported ? storefrontNormalizeConfig(storeConfig) : null]);
}
function markSaved() { savedSnapshot = currentSnapshot(); refreshDirty(); }
function isDirty() { return savedSnapshot !== "" && currentSnapshot() !== savedSnapshot; }
function refreshDirty() {
  const el = document.getElementById("saveState");
  if (!el) return;
  const dirty = isDirty();
  el.textContent = dirty ? "Unsaved changes" : "All changes saved";
  el.classList.toggle("is-dirty", dirty);
}
let dirtyTimer = null;
function refreshDirtySoon() { clearTimeout(dirtyTimer); dirtyTimer = setTimeout(refreshDirty, 150); }
function setSaving(on) {
  const btn = document.getElementById("saveBtn");
  if (!btn) return;
  btn.disabled = on;
  btn.classList.toggle("xr-btn--loading", on);
}
function updateSectionHints() {
  const productFields = fields.filter(f => f.type === "product");
  const count = productFields.reduce((n, f) => n + (Array.isArray(f.products) ? f.products.length : 0), 0);
  const other = fields.filter(f => f.type !== "product").length;
  const set = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
  set("hintProducts", count === 0 ? "None yet" : `${count} ${count === 1 ? "product" : "products"}`);
  set("hintFields", other === 0 ? "None yet" : `${other} ${other === 1 ? "field" : "fields"}`);
}

// Store details (logo, banner, tagline, contact...) are kept as ONE JSON string in
// the form doc attribute `storeConfig`. It is only written when that attribute
// exists on the collection (checked at load), so saving never breaks without it.
let storeConfig = {};
let storeConfigSupported = false;

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
    const on = el.dataset.theme === selectedStoreTheme;
    el.classList.toggle("active", on);
    el.setAttribute("aria-checked", String(on));
  });
}

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
    window.location.replace("login.html");
    return null;
  }
}

/* ---------------- SAVE ---------------- */
function openInvalidProduct(field, index, message) {
  const state = getProductUIState(field.id);
  state.activeCategory = "All";
  state.editingIndex = index;
  const sec = document.getElementById("secProducts");
  if (sec) sec.open = true;
  renderFields();
  showToast(message, "warning");
}

async function saveForm() {
  const btn = document.getElementById("saveBtn");
  if (btn && btn.disabled) return;

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

  // every product needs a name and a price: open the first one that does not
  for (const field of productFields) {
    for (let i = 0; i < field.products.length; i++) {
      const p = field.products[i];
      if (!p.name || !p.price) {
        const who = p.name ? `"${p.name}"` : `Product ${i + 1}`;
        openInvalidProduct(field, i, `${who} needs a ${!p.name ? "name" : "price"}.`);
        return;
      }
    }
  }

  setSaving(true);
  try {
    const safeFields = fields.map(f => JSON.stringify(f));

    await databases.updateDocument(DB_ID, FORMS, formId, {
      title: formTitle,
      subtitle: formSubtitle,
      fields: safeFields,
      storeTheme: selectedStoreTheme,
      ...(storeConfigSupported ? { storeConfig: JSON.stringify(storefrontNormalizeConfig(storeConfig)) } : {}),
      $updatedAt: new Date().toISOString()
    });

    // Replaced or removed images are deleted only AFTER the save worked. Before,
    // they were deleted first, so a failed save left the form pointing at files that were gone.
    const toDelete = imagesMarkedForDeletion;
    imagesMarkedForDeletion = [];
    for (const imageId of toDelete) {
      try { await storage.deleteFile(PRODUCT_IMAGES_BUCKET, imageId); } catch {}
    }

    markSaved();
    showToast("Form saved successfully", "success");
  } catch (err) {
    console.error(err);
    showToast("Could not save. Check your connection and try again.", "error");
  } finally {
    setSaving(false);
  }
}

/* ---------------- FORM LINK ---------------- */
function setupFormLink() {
  const input = document.getElementById("formLinkInput");
  if (input) input.value = getPublicFormLink(formId, "current");
}

async function copyFormLink(platform = "current") {
  const id = formId || new URLSearchParams(window.location.search).get("fid");
  if (!id) return showToast("Save or open a form before copying its link.", "error");
  const link = getPublicFormLink(id, platform);
  try {
    await copyTextCompat(link);
    showToast(`${platform === "cloudflare" ? "Cloudflare" : platform === "github" ? "GitHub" : "Customer form"} link copied`, "success");
  } catch (e) {
    const input = document.getElementById("formLinkInput");
    if (input) { input.value = link; input.focus(); input.select(); }
    showToast(e?.message || "Could not copy the link. Copy it from the link field instead.", "error");
  }
}

/* ---------------- ADD MENU ---------------- */
function toggleAddMenu(btn) {
  const menu = document.getElementById('addMenu');
  if (!menu) return;
  const opening = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !opening);
  menu.setAttribute('aria-hidden', String(!opening));
  if (btn) btn.setAttribute('aria-expanded', String(opening));
  if (opening) {
    const firstOption = menu.querySelector('.add-menu-option');
    if (firstOption) setTimeout(() => firstOption.focus(), 0);
  }
}

function closeAddMenu(event) {
  if (event && event.target !== event.currentTarget) return;
  const menu = document.getElementById('addMenu');
  const btn = document.getElementById('addFieldBtn');
  if (!menu) return;
  menu.classList.add('hidden');
  menu.setAttribute('aria-hidden', 'true');
  if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.focus(); }
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
  document.getElementById('addMenu').setAttribute('aria-hidden', 'true');
  document.getElementById('addFieldBtn')?.setAttribute('aria-expanded', 'false');
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
            value="${escapeHtml(field.label || "")}"
            onchange="updateLabel('${field.id}', this.value)"
          />
          <span class="remove remove-field" data-id="${field.id}" onclick="event.stopPropagation(); removeField('${field.id}')">×</span>
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
          value="${escapeHtml(field.label || "")}"
          onchange="updateLabel('${field.id}', this.value)"
          onclick="event.stopPropagation()"
        />
        ${hasBody ? `<span class="field-chevron">${isExpanded ? "&#9650;" : "&#9660;"}</span>` : ""}
        <span class="remove remove-field" data-id="${field.id}" onclick="event.stopPropagation(); removeField('${field.id}')">×</span>
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

  updateSectionHints();
  refreshDirtySoon();
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
        ${p.imageUrl ? `<img src="${escapeHtml(p.imageUrl)}" alt="" class="product-img"/>` : `<span class="product-tile-placeholder">+ Photo</span>`}
      </div>
      <div class="product-tile-name">${escapeHtml(p.name || "Untitled")}</div>
      <div class="product-tile-price">₦${p.price ? formatWithCommas(p.price) : "0"}</div>
      <button type="button" class="product-tile-toggle${p.soldOut ? " is-soldout" : ""}" aria-pressed="${p.soldOut ? "true" : "false"}"
        onclick="event.stopPropagation(); toggleSoldOut('${field.id}', ${i})">${p.soldOut ? "Back in stock" : "Mark sold out"}</button>
    `;
    if (p.soldOut) tile.classList.add("is-soldout");
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
    editor.setAttribute("role", "dialog");
    editor.setAttribute("aria-modal", "true");
    editor.innerHTML = `
      <div class="product-editor-card">
        <div class="product-editor-head">
          <strong>Edit product</strong>
          <button type="button" class="product-editor-close" aria-label="Close" onclick="closeProductEditor('${field.id}')">&times;</button>
        </div>

        <div class="product-editor-image">
          ${p.imageUrl ? `<img src="${escapeHtml(p.imageUrl)}" alt="" class="product-img"/>` : ""}
          <label class="upload-btn">
            ${p.imageUrl ? "Change image" : "Upload image"}
            <input type="file" accept="image/*" hidden onchange="uploadProductImage('${field.id}', ${i}, this)">
          </label>
        </div>

        <div class="xr-field">
          <label class="xr-label">Name</label>
          <input class="xr-input" placeholder="Product name" value="${escapeHtml(p.name || "")}"
            onchange="updateProduct('${field.id}', ${i}, 'name', this.value)">
        </div>

        <div class="xr-field">
          <label class="xr-label">Price</label>
          <div class="xr-input-group"><span class="xr-prefix">₦</span>
            <input class="xr-input" inputmode="numeric" placeholder="Price" value="${p.price ? formatWithCommas(p.price) : ""}"
              oninput="handlePriceInput(this)" onblur="savePrice('${field.id}', ${i}, this.value)"></div>
        </div>

        <div class="xr-field">
          <label class="xr-label">Category</label>
          <input class="xr-input" placeholder="e.g. Audio" value="${escapeHtml(p.category || "General")}"
            onchange="updateProduct('${field.id}', ${i}, 'category', this.value); renderFields();">
        </div>

        <div class="xr-field">
          <label class="xr-label">Description <span class="xr-optional">(optional)</span></label>
          <textarea class="xr-textarea product-description-input" rows="3"
            placeholder="Short description of this product"
            onchange="updateProduct('${field.id}', ${i}, 'description', this.value)">${escapeHtml(p.description || "")}</textarea>
        </div>

        <label class="xr-switch product-featured-row">
          <input type="checkbox" ${p.featured ? "checked" : ""}
            onchange="updateProduct('${field.id}', ${i}, 'featured', this.checked)">
          <span class="xr-switch-track"></span>
          Show in "Featured" on the store
        </label>

        <label class="xr-switch product-soldout-row">
          <input type="checkbox" ${p.soldOut ? "checked" : ""}
            onchange="updateProduct('${field.id}', ${i}, 'soldOut', this.checked)">
          <span class="xr-switch-track"></span>
          Sold out
        </label>
        <p class="xr-hint" style="margin:-8px 0 0">Customers still see it, but cannot order it. Save your changes to apply.</p>

        <div class="product-editor-actions">
          <button type="button" class="xr-btn xr-btn--primary" onclick="closeProductEditor('${field.id}')">Done</button>
          <button type="button" class="xr-btn xr-btn--danger"
            onclick="removeProduct('${field.id}', ${i}); closeProductEditor('${field.id}');">Delete product</button>
        </div>
      </div>
    `;
    wrap.appendChild(editor);
  }

  return wrap;
}

// Quick "sold out" switch on the product tile. The change is applied to the store when you save.
function toggleSoldOut(fieldId, index) {
  const field = fields.find(f => f.id === fieldId);
  const p = field && field.products ? field.products[index] : null;
  if (!p) return;
  p.soldOut = !p.soldOut;
  renderFields();
}

async function uploadProductImage(fieldId, index, input) {
  const file = input.files[0];
  if (!file) return;

  const field = fields.find(f => f.id === fieldId);
  const product = field.products[index];

  // Upload the new file first. The old one is only queued for deletion and is removed
  // after a successful save, so a failed upload or save never leaves the form pointing at a missing image.
  let uploaded;
  try {
    uploaded = await storage.createFile(
      PRODUCT_IMAGES_BUCKET,
      Appwrite.ID.unique(),
      file,
      [Appwrite.Permission.read(Appwrite.Role.any())]
    );
  } catch (err) {
    console.error(err);
    showToast("Could not upload the image. Try again.", "error");
    return;
  }
  if (product.imageId) imagesMarkedForDeletion.push(product.imageId);

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
      <input placeholder="Fee name" value="${escapeHtml(f.name || "")}"
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

  // `...p` keeps any extra properties (featured, and future stock fields) so they
  // survive edit, save and reload instead of being silently dropped.
  field.products = field.products.map(p => ({
    ...(p && typeof p === "object" ? p : {}),
    name: p?.name ?? "",
    price: p?.price ?? "",
    imageId: p?.imageId ?? "",
    imageUrl: p?.imageUrl ?? "",
    category: p?.category ?? "General",
    description: p?.description ?? ""
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

/* ---------------- STORE DETAILS (logo, banner, tagline, contact) ---------------- */
const STORE_TEXT_KEYS = ["tagline", "heroCta", "about", "policy", "phone", "email", "whatsapp", "instagram", "tiktok", "facebook"];

function fillStoreDetails() {
  STORE_TEXT_KEYS.forEach(k => {
    const el = document.getElementById("sd_" + k);
    if (el) { el.value = storeConfig[k] || ""; el.disabled = !storeConfigSupported; }
  });
  ["logo", "banner"].forEach(kind => {
    const img = document.getElementById("sd_" + kind + "Preview");
    const input = document.getElementById("sd_" + kind + "File");
    if (input) input.disabled = !storeConfigSupported;
    if (img) {
      const url = storeConfig[kind + "Url"];
      img.src = url || "";
      img.style.display = url ? "block" : "none";
    }
  });
  const note = document.getElementById("storeDetailsNote");
  if (note) note.style.display = storeConfigSupported ? "none" : "block";
}

function updateStoreConfig(key, value) {
  if (!storeConfigSupported) return;
  storeConfig[key] = value;
}

async function uploadStoreImage(kind, input) {
  const file = input.files[0];
  if (!file || !storeConfigSupported) return;
  try {
    const uploaded = await storage.createFile(
      PRODUCT_IMAGES_BUCKET,
      Appwrite.ID.unique(),
      file,
      [Appwrite.Permission.read(Appwrite.Role.any())]
    );
    // the old file is removed on Save, same as replaced product images
    if (storeConfig[kind + "Id"]) imagesMarkedForDeletion.push(storeConfig[kind + "Id"]);
    storeConfig[kind + "Id"] = uploaded.$id;
    storeConfig[kind + "Url"] = storage.getFileView(PRODUCT_IMAGES_BUCKET, uploaded.$id).href;
    fillStoreDetails();
  } catch (err) {
    showToast("Could not upload image", "error");
  }
}

function removeStoreImage(kind) {
  if (!storeConfigSupported) return;
  if (storeConfig[kind + "Id"]) imagesMarkedForDeletion.push(storeConfig[kind + "Id"]);
  storeConfig[kind + "Id"] = "";
  storeConfig[kind + "Url"] = "";
  fillStoreDetails();
}

/* ---------------- PREVIEW OVERLAY ----------------
   The preview is an <iframe> that loads only the store's own CSS and JS,
   the same files as form.html. That keeps the builder page's global styles
   (fonts, inputs, buttons) out of the preview, and gives the store a real
   viewport, so what you see here matches the live page. */

function absUrl(path) { return new URL(path, document.baseURI).href; }

function buildPreviewDoc(data) {
  // "<" is escaped so store text can never close the script tag
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const themeId = String(data.themeClass || "").replace(/^theme-/, "").replace(/[^a-z0-9]/gi, "") || "r1";
  const fontLink = document.querySelector('link[href*="family=Orbitron"]');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${fontLink ? `<link rel="stylesheet" href="${fontLink.href}">` : ""}
<link rel="stylesheet" href="${absUrl("css/form.shared.css")}">
<link rel="stylesheet" href="${absUrl("css/storefront-base.css")}">
<link rel="stylesheet" href="${absUrl("css/alert.css")}">
<link rel="stylesheet" href="${absUrl("css/theme-" + themeId + ".css")}">
</head><body>
<div id="root"></div><div id="toast-container"></div>
<script>window.__PREVIEW__ = ${json};<\/script>
<script src="${absUrl("js/storefront-render.js")}"><\/script>
<script src="${absUrl("js/storefront-chrome.js")}"><\/script>
<script src="${absUrl("js/alert.js")}"><\/script>
<script src="${absUrl("js/preview-runtime.js")}"><\/script>
</body></html>`;
}

function setPreviewDevice(mode) {
  const stage = document.getElementById("previewStage");
  const phone = mode !== "full";
  stage.classList.toggle("is-phone", phone);
  document.getElementById("pvPhone").setAttribute("aria-pressed", String(phone));
  document.getElementById("pvFull").setAttribute("aria-pressed", String(!phone));
}

function openPreview(e) {
  if (e) e.preventDefault();
  const overlay = document.getElementById("previewOverlay");
  const frame = document.getElementById("previewFrame");
  const wasHidden = overlay.classList.contains("hidden");
  if (wasHidden) setPreviewDevice(window.innerWidth >= 700 ? "phone" : "full");

  frame.srcdoc = buildPreviewDoc({
    fields,
    formTitle,
    formSubtitle,
    themeClass: `theme-${selectedStoreTheme}`,
    storeConfig
  });
  overlay.classList.remove("hidden");
}

function closePreview() {
  document.getElementById("previewOverlay").classList.add("hidden");
  document.getElementById("previewFrame").srcdoc = "";
}

window.addEventListener("message", (e) => {
  const frame = document.getElementById("previewFrame");
  if (frame && e.source === frame.contentWindow && e.data && e.data.xredro === "closePreview") closePreview();
});

/* =========================
UI INTERACTION LOGIC
========================= */
/* ---------------- INIT ---------------- */
async function initBuilder() {
  user = await requireAuth();
  if (!user) return;
  
  res = await databases.listDocuments(DB_ID, USERS, [
    Query.equal("userId", user.$id)
  ]);
  
  // Quick Subscription Check
  const subRes = await databases.listDocuments(DB_ID, SUBS, [
    Query.equal("userId", user.$id),
    Query.equal("status", "active"),
    Query.orderDesc("expiresAt"),
    Query.limit(1)
  ]);
  
  // Existing accounts may not yet have a profile row; avoid crashing on it.
  if (!res.documents.length) {
    showToast("Your account setup is incomplete. Please log out and log in again.", "error");
    return;
  }

  //Theme Application
  profileDocId = res.documents[0].$id;

  const savedTheme = res.documents[0].theme || "light";
  applyTheme(savedTheme);

  //Quick Subscription Check
  if (!subRes.documents.length) {
    document.getElementById("subscriptionModal").classList.remove("hidden");
    return;
  }
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
    storeConfigSupported = Object.prototype.hasOwnProperty.call(formDoc, "storeConfig");
    storeConfig = storefrontNormalizeConfig(formDoc.storeConfig);
    fillStoreDetails();

    document.getElementById("titleInput").value = formTitle;
    document.getElementById("subtitleInput").value = formSubtitle;
    highlightSelectedTheme();
  } catch (err) {
    // Create an empty form only when it really does not exist (404). Any other
    // failure (network, permissions) must not be mistaken for "no form yet".
    if (err && err.code !== 404) {
      console.error(err);
      showToast("Could not load your store. Check your connection and reload the page.", "error");
      return;
    }
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
  markSaved();
}

initBuilder();

/* =========================
EVENT LISTENERS / TRIGGERS
========================= */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeAddMenu();
    closePreview();
  }
});

// keep the "Unsaved changes" label and the leave-page warning in step with edits
["input", "change", "click"].forEach(t => document.addEventListener(t, refreshDirtySoon));
window.addEventListener("beforeunload", (e) => {
  if (isDirty()) { e.preventDefault(); e.returnValue = ""; }
});

// theme choices are radio-style buttons: reachable and usable from the keyboard
document.querySelectorAll("#themePicker .theme-swatch").forEach(el => {
  el.setAttribute("role", "radio");
  el.tabIndex = 0;
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectStoreTheme(el.dataset.theme); }
  });
});

document.getElementById("previewStage").addEventListener("click", (e) => {
  // only the dark area around the phone, not the store itself
  if (e.target === e.currentTarget) closePreview();
});

/* =========================
UNUSED / EXPERIMENTAL / FUTURE CODE
========================= */
