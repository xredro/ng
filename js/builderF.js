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
let profileDocId = null;
let user;
let res;

let formId;
let formTitle = "";
let formSubtitle = "";

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
    product: "Product Listing"
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
  const safeFields = fields.map(f => JSON.stringify(f));

  await databases.updateDocument(DB_ID, FORMS, formId, {
    title: formTitle,
    subtitle: formSubtitle,
    fields: safeFields,
    $updatedAt: new Date().toISOString()
  });

  showToast("Form saved successfully", "success");
}

/* ---------------- FORM LINK ---------------- */
function setupFormLink() {
  const input = document.getElementById("formLinkInput");
  const link = `${window.location.origin}/X-Redro/form.html?fid=${formId}`;
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
function renderFields() {
  const container = document.getElementById('fields');
  container.innerHTML = "";

  fields.forEach(field => {
    const card = document.createElement('div');
    card.className = "field-card";

    card.innerHTML = `
      <div class="field-header">
        <input 
          class="field-label"
          value="${field.label || ""}"
          onchange="updateLabel('${field.id}', this.value)"
        />
        <span class="remove" onclick="removeField('${field.id}')">×</span>
      </div>
    `;

    if (field.type === "dropdown") card.appendChild(renderDropdown(field));
    if (field.type === "product") card.appendChild(renderProducts(field));

    container.appendChild(card);
  });
}

function updateLabel(id, value) {
  const f = fields.find(f => f.id === id);
  if (f) f.label = value;
}

async function removeField(id) {
  const field = fields.find(f => f.id === id);
  
  // delete all product images
  if (field.type === "product") {
    for (let p of field.products) {
      if (p.imageId) {
        await storage.deleteFile(PRODUCT_IMAGES_BUCKET, p.imageId);
      }
    }
  }
  
  fields = fields.filter(f => f.id !== id);
  renderFields();
}

/* ---------------- DROPDOWN ---------------- */
function renderDropdown(field) {
  const wrap = document.createElement('div');

  const input = document.createElement('input');
  input.placeholder = "Add option & press Enter";

  const chips = document.createElement('div');
  chips.className = "chips";

  input.onkeydown = e => {
    if (e.key === "Enter" && input.value.trim()) {
      field.options.push(input.value.trim());
      input.value = "";
      renderFields();
    }
  };

  field.options.forEach((opt, i) => {
    const chip = document.createElement('div');
    chip.className = "chip";
    chip.innerHTML = `${opt} <span onclick="removeOption('${field.id}', ${i})">×</span>`;
    chips.appendChild(chip);
  });

  wrap.append(input, chips);
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

function renderProducts(field) {
  const wrap = document.createElement('div');

  field.products.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = "product-row";

    row.innerHTML = `
      <div class="product-image">
        ${p.imageUrl 
          ? `<img src="${p.imageUrl}" class="product-img"/>`
          : `<label class="upload-btn">
              Upload image
              <input type="file" hidden onchange="uploadProductImage('${field.id}', ${i}, this)">
            </label>`
        }
      </div>

      <input placeholder="Product name" value="${p.name || ""}"
        onchange="updateProduct('${field.id}', ${i}, 'name', this.value)">

      <input placeholder="₦ Price" value="${p.price ? formatWithCommas(p.price) : ""}"
        oninput="handlePriceInput(this)" onblur="savePrice('${field.id}', ${i}, this.value)">

      <span class="remove" onclick="removeProduct('${field.id}', ${i})">×</span>
    `;

    wrap.appendChild(row);
  });

  const btn = document.createElement('button');
  btn.className = "add-product";
  btn.innerText = "+ Add product";
  btn.onclick = () => {
    field.products.push({ name: "", price: "", imageId: "", imageUrl: "" });
    renderFields();
  };

  wrap.appendChild(btn);
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

function normalizeProducts(field) {
  if (!Array.isArray(field.products)) {
    field.products = [];
    return;
  }

  field.products = field.products.map(p => ({
    name: p?.name ?? "",
    price: p?.price ?? "",
    imageId: p?.imageId ?? "",
    imageUrl: p?.imageUrl ?? ""
  }));
}

function updateProduct(fieldId, index, key, value) {
  const field = fields.find(f => f.id === fieldId);
  field.products[index][key] = value;
}

async function removeProduct(fieldId, index) {
  const field = fields.find(f => f.id === fieldId);
  if (!field || !field.products[index]) return;

  const product = field.products[index];

  // 🔒 remove synchronously first
  field.products.splice(index, 1);
  renderFields();

  // 🧹 cleanup async later
  if (product.imageId) {
    try {
      await storage.deleteFile(PRODUCT_IMAGES_BUCKET, product.imageId);
    } catch {}
  }
}

/* ---------------- PREVIEW OVERLAY ---------------- */
function openPreview(e) {
  if (e) e.preventDefault();
  const overlay = document.getElementById("previewOverlay");
  const container = document.getElementById("previewForm");

  container.innerHTML = buildPreviewHTML();
  overlay.classList.remove("hidden");
}

function closePreview() {
  document.getElementById("previewOverlay").classList.add("hidden");
}

function buildPreviewHTML() {
  let html = `
    <div class="preview-card">
      <h2 class="business-name">${formTitle || "My Business Name"}</h2>
      <p class="subtitle">${formSubtitle || "Select your order"}</p>
  `;

  fields.forEach(field => {
    html += renderPreviewField(field);
  });

  html += `
      <div class="total-box">
        <div>Items <span>0</span></div>
        <div>Total Cost <span>₦0</span></div>
      </div>

      <div class="payment-proof">
        <label>Payment Proof</label>
        <div class="proof-box">Upload</div>
      </div>

      <button class="send-btn" disabled>Send Order</button>
      <p class="powered">powered by X Redro</p>
    </div>
  `;

  return html;
}

function renderPreviewField(field) {
  let html = `<div class="form-group">`;

  if (field.label) {
    html += `<label>${field.label}</label>`;
  }

  if (field.type === "text") {
    html += `<input type="text" placeholder="User input" disabled>`;
  }

  if (field.type === "number") {
    html += `<input type="number" placeholder="User input" disabled>`;
  }

  if (field.type === "textarea") {
    html += `<textarea placeholder="User input" disabled></textarea>`;
  }

  if (field.type === "dropdown") {
    html += `<select disabled>
      ${field.options.map(opt => `<option>${opt}</option>`).join("")}
    </select>`;
  }

  if (field.type === "product") {
    html += renderPreviewProducts(field);
  }

  html += `</div>`;
  return html;
}

function renderPreviewProducts(field) {
  let html = `<div class="product-grid">`;

  field.products.forEach(p => {
    html += `
      <div class="product-card">
        <div class="product-image">
          ${p.imageUrl ? `<img src="${p.imageUrl}">` : ""}
        </div>
        <div class="product-name">${p.name || "Product Name"}</div>
        <div class="product-price">₦${Number(p.price || 0).toLocaleString()}</div>
        <div class="product-qty">Qty: 1</div>
      </div>
    `;
  });

  html += `</div>`;
  return html;
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

          return field;
        } catch {
          return null;
        }
      }).filter(Boolean);
    }  
    formId = user.$id;
    formTitle = formDoc.title || "";
    formSubtitle = formDoc.subtitle || "";

    document.getElementById("titleInput").value = formTitle;
    document.getElementById("subtitleInput").value = formSubtitle;
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
