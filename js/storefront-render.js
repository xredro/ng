/* =========================================================
   SHARED STOREFRONT RENDERER
   =========================================================
   Used by BOTH js/form.js (the real customer page) and
   js/builderF.js (the Form Builder's preview overlay), so the
   preview is guaranteed to match the real page — same markup,
   same classes, same theme CSS. There is only ever one place
   that decides what the storefront looks like.

   Each theme maps to a genuinely different card/grid layout
   mode (not just a palette) — see STOREFRONT_THEME_LAYOUTS.
========================================================= */

const STOREFRONT_THEME_LAYOUTS = {
  r1: "dense",        // borderless dark video-grid
  r2: "airy",          // white cards, generous whitespace
  r3: "rounded",       // rounded grocery-style cards
  r4: "iconbadge",     // dark dashboard, icon badge + progress feel
  r5: "luxury",        // single column, large image, serif, sparse
  r6: "marketplace",   // dense compact grid, utilitarian
  r7: "listings",      // horizontal row cards (image left, details right)
  r8: "organic",       // circular photos, single column, no card box
  r9: "editorial"      // asymmetric grid, first product featured/larger
};

function storefrontFormatNaira(amount) {
  return Number(amount || 0).toLocaleString("en-NG");
}

function storefrontEscape(s) {
  return (s || "").toString().replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* ---------------- ONE product card, shape depends on layout mode ---------------- */

function storefrontProductCard(mode, field, p, i, opts) {
  const cbId = `pop-${field.id}-${i}`;
  const img = p.imageUrl ? `<img src="${p.imageUrl}">` : "";
  const price = `₦${storefrontFormatNaira(p.price)}`;
  const qtyId = `qty-${field.id}-${i}`;
  const startQty = opts.live ? (opts.cart[`${field.id}_${i}`] || 0) : 0;
  const category = storefrontEscape(p.category || "General");
  const name = storefrontEscape(p.name);

  const qtyButtons = opts.live
    ? `<button onclick="${opts.qtyFn}('${field.id}', ${i}, -1)">-</button>
       <span id="${qtyId}">${startQty}</span>
       <button onclick="${opts.qtyFn}('${field.id}', ${i}, 1)">+</button>`
    : `<button disabled>-</button><span id="${qtyId}">0</span><button disabled>+</button>`;

  const popup = `
    <div class="product-popup">
      <label for="${cbId}" class="popup-backdrop"></label>
      <div class="popup-card">
        <label for="${cbId}" class="popup-close">&times;</label>
        <div class="popup-image">${img}</div>
        <h3>${name}</h3>
        <div class="popup-price">${price}</div>
        <div class="product-qty">${qtyButtons}</div>
      </div>
    </div>
  `;

  const moreLabel = mode === "listings" ? "View" : mode === "luxury" ? "Enquire" : "+";

  if (mode === "iconbadge") {
    return `
      <div class="product-card" data-category="${category}">
        <input type="checkbox" id="${cbId}" class="pop-toggle">
        <div class="card-icon-badge">${img}</div>
        <div class="product-name">${name}</div>
        <div class="product-price">${price}</div>
        <label for="${cbId}" class="more-btn">${moreLabel}</label>
        ${popup}
      </div>`;
  }

  if (mode === "listings") {
    return `
      <div class="product-card list-row" data-category="${category}">
        <input type="checkbox" id="${cbId}" class="pop-toggle">
        <div class="product-image">${img}</div>
        <div class="list-row-body">
          <div class="product-name">${name}</div>
          <div class="product-price">${price}</div>
          <label for="${cbId}" class="more-btn">${moreLabel}</label>
        </div>
        ${popup}
      </div>`;
  }

  if (mode === "organic") {
    return `
      <div class="product-card organic-row" data-category="${category}">
        <input type="checkbox" id="${cbId}" class="pop-toggle">
        <div class="product-image circle-photo">${img}</div>
        <div class="product-name">${name}</div>
        <div class="product-price">${price}</div>
        <label for="${cbId}" class="more-btn">${moreLabel}</label>
        ${popup}
      </div>`;
  }

  if (mode === "luxury") {
    return `
      <div class="product-card luxury-row" data-category="${category}">
        <input type="checkbox" id="${cbId}" class="pop-toggle">
        <div class="product-image">${img}</div>
        <div class="luxury-details">
          <div class="product-name">${name}</div>
          <div class="product-price">${price}</div>
          <label for="${cbId}" class="more-btn">${moreLabel}</label>
        </div>
        ${popup}
      </div>`;
  }

  if (mode === "editorial") {
    return `
      <div class="product-card ${i === 0 ? "featured" : ""}" data-category="${category}">
        <input type="checkbox" id="${cbId}" class="pop-toggle">
        <div class="product-image">${img}</div>
        <div class="product-name">${name}</div>
        <div class="product-price">${price}</div>
        <label for="${cbId}" class="more-btn">${moreLabel}</label>
        ${popup}
      </div>`;
  }

  // dense / airy / rounded / marketplace share this base shape — their
  // theme CSS (column count, image aspect ratio, spacing, shape) is what
  // makes them read as completely different designs on screen.
  return `
    <div class="product-card" data-category="${category}">
      <input type="checkbox" id="${cbId}" class="pop-toggle">
      <div class="product-image">${img}</div>
      <div class="product-name">${name}</div>
      <div class="product-price">${price}</div>
      <label for="${cbId}" class="more-btn">${moreLabel}</label>
      ${popup}
    </div>`;
}

/* ---------------- category scroll (only shown when >1 category) ---------------- */

function storefrontCategoryChips(field) {
  const categories = ["All", ...new Set(field.products.map(p => p.category || "General"))];
  if (categories.length <= 2) return "";

  return `
    <div class="category-scroll">
      ${categories.map((c, idx) => `
        <span class="cat-chip ${idx === 0 ? "cat-active" : ""}"
          onclick="filterStorefrontCategory(this, '${storefrontEscape(c).replace(/'/g, "\\'")}')">
          ${storefrontEscape(c)}
        </span>
      `).join("")}
    </div>
  `;
}

function filterStorefrontCategory(chipEl, category) {
  const chipRow = chipEl.closest(".category-scroll");
  const grid = chipRow.nextElementSibling;

  chipRow.querySelectorAll(".cat-chip").forEach(c => c.classList.remove("cat-active"));
  chipEl.classList.add("cat-active");

  grid.querySelectorAll(".product-card").forEach(card => {
    const match = category === "All" || card.dataset.category === category;
    card.classList.toggle("hidden", !match);
  });
}

function storefrontProducts(field, themeId, opts) {
  const mode = STOREFRONT_THEME_LAYOUTS[themeId] || "dense";
  const chips = storefrontCategoryChips(field);
  const cards = field.products.map((p, i) => storefrontProductCard(mode, field, p, i, opts)).join("");

  return `
    ${chips}
    <div class="product-grid layout-${mode}">
      ${cards}
    </div>
  `;
}

/* ---------------- non-product fields (checkout fields) ---------------- */

function storefrontField(field, opts) {
  let html = `<div class="form-group">`;
  if (field.label) html += `<label>${storefrontEscape(field.label)}</label>`;

  const disabledAttr = opts.live ? "" : "disabled";
  const dataId = opts.live ? `data-id="${field.id}"` : "";

  if (field.type === "text") html += `<input type="text" ${dataId} ${disabledAttr}>`;
  if (field.type === "number") html += `<input type="number" ${dataId} ${disabledAttr}>`;
  if (field.type === "textarea") html += `<textarea ${dataId} ${disabledAttr}></textarea>`;
  if (field.type === "dropdown") {
    html += `<select ${dataId} ${disabledAttr}>
      ${(field.options || []).map(o => `<option value="${storefrontEscape(o)}">${storefrontEscape(o)}</option>`).join("")}
    </select>`;
  }
  if (field.type === "additional_fee") {
    const onchange = opts.live ? `onchange="${opts.totalFn}()"` : "";
    html += `<select ${dataId} ${onchange} ${disabledAttr}>
      <option value="">Select option</option>
      ${(field.fees || []).map(f => `<option value="${storefrontEscape(f.name)}">${storefrontEscape(f.name)}</option>`).join("")}
    </select>`;
  }

  html += `</div>`;
  return html;
}

/* ---------------- full page/preview builder ---------------- */

/**
 * Builds the full storefront HTML — used verbatim by both the real
 * customer page and the Form Builder's preview, so what a seller
 * sees in preview IS what customers see.
 *
 * config.opts:
 *   live      — true on the real page (real cart, real submit);
 *               false in the builder preview (static controls,
 *               but same markup/classes/theme CSS)
 *   cart      — only read when live is true
 *   qtyFn     — global function name to call on qty +/- (default "changeQty")
 *   totalFn   — global function name to call on fee change (default "updateTotal")
 *   submitFn  — global function name for the Send Order button (default "submitOrder")
 */
function buildStorefrontHTML({ fields, formTitle, formSubtitle, themeClass, opts }) {
  opts = Object.assign({ live: false, cart: {}, qtyFn: "changeQty", totalFn: "updateTotal", submitFn: "submitOrder" }, opts || {});
  const themeId = (themeClass || "theme-r1").replace("theme-", "");
  const productFields = fields.filter(f => f.type === "product");
  const otherFields = fields.filter(f => f.type !== "product");
  const initial = (formTitle || "X").trim().charAt(0).toUpperCase();

  const sendBtn = opts.live
    ? `<button class="send-btn" onclick="${opts.submitFn}()">Send Order</button>`
    : `<button class="send-btn" disabled>Send Order</button>`;

  if (productFields.length === 0) {
    return `
      <div class="preview-theme ${themeClass}">
        <div class="preview-card">
          <h2 class="business-name">${storefrontEscape(formTitle)}</h2>
          <p class="subtitle">${storefrontEscape(formSubtitle)}</p>
          ${otherFields.map(f => storefrontField(f, opts)).join("")}
          <div class="total-box">
            <div>Items <span id="itemCount">0</span></div>
            <div id="additionalFeeBox" style="display:none;"></div>
            <div>Total Cost <span id="totalCost">₦0</span></div>
          </div>
          <div class="payment-proof">
            <label>Payment Proof Image</label>
            <label class="upload-proof">
              <input type="file" id="paymentProof" hidden ${opts.live ? "" : "disabled"}>
              <div class="upload-ui">
                <span class="upload-icon">&#8593;</span>
                <span class="upload-text">Upload payment proof</span>
              </div>
            </label>
          </div>
          ${sendBtn}
          <p class="powered">powered by X Redro</p>
        </div>
      </div>
    `;
  }

  return `
    <div class="preview-theme ${themeClass}">
      <div class="store-simple-header">
        <h1>${storefrontEscape(formTitle)}</h1>
        <p>${storefrontEscape(formSubtitle)}</p>
      </div>

      <div class="store-shell">
        <section class="showcase">
          ${productFields.map(f => storefrontProducts(f, themeId, opts)).join("")}
        </section>
      </div>

      <input type="checkbox" id="checkoutToggle" class="pop-toggle">

      <div class="cart-bar" id="cartBar">
        <div class="cb-info">
          <span id="cartBarCount">0 items</span>
          <small id="cartBarTotal">₦0</small>
        </div>
        <label for="checkoutToggle" class="cart-bar-checkout-label">Checkout &rarr;</label>
      </div>

      <div class="checkout-overlay">
        <label for="checkoutToggle" class="checkout-overlay-backdrop"></label>
        <div class="checkout-overlay-card">
          <label for="checkoutToggle" class="checkout-close">&times;</label>
          <div class="checkout-badge">${storefrontEscape(initial)}</div>
          <div class="checkout-head">
            <h2>Checkout</h2>
            <p>Confirm your details and we'll get your order moving.</p>
          </div>

          ${otherFields.map(f => storefrontField(f, opts)).join("")}

          <div class="total-box">
            <div>Items <span id="itemCount">0</span></div>
            <div id="additionalFeeBox" style="display:none;"></div>
            <div>Total Cost <span id="totalCost">₦0</span></div>
          </div>

          <div class="payment-proof">
            <label>Payment Proof Image</label>
            <label class="upload-proof">
              <input type="file" id="paymentProof" hidden ${opts.live ? "" : "disabled"}>
              <div class="upload-ui">
                <span class="upload-icon">&#8593;</span>
                <span class="upload-text">Upload payment proof</span>
              </div>
            </label>
          </div>

          ${sendBtn}
          <p class="powered">powered by X Redro</p>
        </div>
      </div>
    </div>
  `;
}
