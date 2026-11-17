/* =========================================================
   STOREFRONT CHROME (Phase 3)
   Builds the full online-store experience (header, hero,
   search/sort, featured row, product cards, cart drawer,
   checkout summary, footer) for themes listed in
   STOREFRONT_CHROME. Themes not listed keep the original
   layout from storefront-render.js, unchanged.

   Loaded after storefront-render.js, on form.html AND on the
   builder (indexF.html), so preview and live store are the same
   code. buildStorefrontHTML() dispatches here.

   Preserved contract used by form.js / builderF.js:
   ids  itemCount totalCost additionalFeeBox paymentProof
        paymentProofPreview paymentAccountName datePaid cartBar
        cartBarCount cartBarTotal checkoutToggle
        qty-<field>-<i>  badge-<field>-<i>
   fns  changeQty updateTotal submitOrder (names come from opts)
========================================================= */

const STOREFRONT_CHROME = {
  // header: left | center | market (search always open) | bold (announcement bar from the tagline)
  // hero:   split | banner | center | compact | editorial | organic | promo
  // footer: soft | dark | minimal | badge | editorial | compact | plain | organic | bold
  // cats:   chips | cards (category cards with the first product's photo and a count)
  // grid:   the product layout; each has its own card styling in the theme file
  r1: { header: "left",   hero: "banner",    footer: "dark",      cats: "chips", grid: "dense" },
  r2: { header: "center", hero: "center",    footer: "minimal",   cats: "chips", grid: "airy" },
  r3: { header: "left",   hero: "split",     footer: "soft",      cats: "chips", grid: "rounded" },
  r4: { header: "left",   hero: "split",     footer: "badge",     cats: "cards", grid: "iconbadge" },
  r5: { header: "center", hero: "editorial", footer: "editorial", cats: "chips", grid: "luxury" },
  r6: { header: "market", hero: "compact",   footer: "compact",   cats: "chips", grid: "marketplace", counts: true },
  r7: { header: "left",   hero: "compact",   footer: "plain",     cats: "chips", grid: "listings" },
  r8: { header: "center", hero: "organic",   footer: "organic",   cats: "cards", grid: "organic" },
  r9: { header: "bold",   hero: "promo",     footer: "bold",      cats: "cards", grid: "editorial" }
};

function storefrontChromeFor(themeId) {
  return STOREFRONT_CHROME[themeId] || null;
}

/* ---------------- safe values ---------------- */

/* A value placed inside a quoted JS string inside an HTML attribute must be
   JS-escaped first and HTML-escaped second (the browser decodes entities
   before the JS runs). Escaping only the HTML way breaks on an apostrophe. */
function storefrontJsArg(v) {
  return storefrontEscape(String(v == null ? "" : v).replace(/\\/g, "\\\\").replace(/'/g, "\\'"));
}

function storefrontSafeUrl(u) {
  const s = String(u || "").trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? storefrontEscape(s) : "";
}

function storefrontHandle(v) {
  return String(v || "")
    .replace(/^https?:\/\/[^/]+\//i, "")
    .replace(/[@\s/]/g, "")
    .replace(/[^A-Za-z0-9._]/g, "")
    .slice(0, 40);
}

/* storeConfig lives in one JSON string on the form document.
   Anything missing or malformed simply falls back to empty. */
function storefrontNormalizeConfig(raw) {
  let c = raw;
  if (typeof c === "string") { try { c = JSON.parse(c); } catch (e) { c = null; } }
  if (!c || typeof c !== "object") c = {};
  const t = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  return {
    tagline: t(c.tagline, 120), about: t(c.about, 600), policy: t(c.policy, 600), heroCta: t(c.heroCta, 24),
    logoUrl: t(c.logoUrl, 500), logoId: t(c.logoId, 64), bannerUrl: t(c.bannerUrl, 500), bannerId: t(c.bannerId, 64),
    phone: t(c.phone, 24), email: t(c.email, 80), whatsapp: t(c.whatsapp, 20),
    instagram: t(c.instagram, 60), tiktok: t(c.tiktok, 60), facebook: t(c.facebook, 60)
  };
}

function storefrontContactLinks(cfg) {
  const out = [];
  const phone = String(cfg.phone || "").replace(/[^\d+]/g, "");
  if (/^\+?\d{7,15}$/.test(phone)) out.push({ kind: "phone", label: cfg.phone, href: "tel:" + phone });
  if (/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(cfg.email || "")) out.push({ kind: "email", label: cfg.email, href: "mailto:" + cfg.email });
  let wa = String(cfg.whatsapp || "").replace(/\D/g, "");
  if (/^0\d{10}$/.test(wa)) wa = "234" + wa.slice(1);
  if (/^\d{10,15}$/.test(wa)) out.push({ kind: "whatsapp", label: "WhatsApp", href: "https://wa.me/" + wa });
  const ig = storefrontHandle(cfg.instagram);
  if (ig) out.push({ kind: "instagram", label: "Instagram", href: "https://instagram.com/" + ig });
  const tt = storefrontHandle(cfg.tiktok);
  if (tt) out.push({ kind: "tiktok", label: "TikTok", href: "https://www.tiktok.com/@" + tt });
  const fb = storefrontHandle(cfg.facebook);
  if (fb) out.push({ kind: "facebook", label: "Facebook", href: "https://facebook.com/" + fb });
  return out;
}

/* ---------------- pure helpers (unit tested) ---------------- */

function storefrontCartLines(fields, cart) {
  const lines = [];
  (fields || []).forEach(f => {
    if (f.type !== "product") return;
    (Array.isArray(f.products) ? f.products : []).forEach((p, i) => {
      const qty = Number((cart || {})[`${f.id}_${i}`]) || 0;
      if (qty <= 0) return;
      const price = Number(p.price || 0) || 0;
      lines.push({ fieldId: f.id, index: i, name: p.name || "", price, qty, imageUrl: p.imageUrl || "", subtotal: qty * price });
    });
  });
  return lines;
}

function storefrontMatchesQuery(name, query) {
  const q = String(query || "").trim().toLowerCase();
  return !q || String(name || "").toLowerCase().includes(q);
}

function storefrontSortCards(cards, mode) {
  const list = cards.slice();
  if (mode === "price-asc") list.sort((a, b) => a.price - b.price || a.idx - b.idx);
  else if (mode === "price-desc") list.sort((a, b) => b.price - a.price || a.idx - b.idx);
  else if (mode === "name") list.sort((a, b) => a.name.localeCompare(b.name) || a.idx - b.idx);
  else list.sort((a, b) => a.idx - b.idx);
  return list;
}

/* ---------------- icons ---------------- */
const SF_ICON = {
  menu: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  cart: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h2l2.4 11h10.2L20 8H6"/><circle cx="9" cy="19.5" r="1.4"/><circle cx="17" cy="19.5" r="1.4"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
};

/* ---------------- product card + popup ---------------- */

function storefrontStockInfo(p) {
  // The seller decides: a product is either available or marked "sold out" in the builder.
  return { out: p.soldOut === true || p.soldOut === "true" };
}

function storefrontChromeCard(field, p, i, opts) {
  const cbId = `pop-${field.id}-${i}`;
  const url = storefrontSafeUrl(p.imageUrl);
  const name = storefrontEscape(p.name);
  const initial = storefrontEscape((p.name || "?").trim().charAt(0).toUpperCase());
  const img = url ? `<img src="${url}" alt="${name}" loading="lazy">` : `<span class="sf-noimg" aria-hidden="true">${initial}</span>`;
  const price = Number(p.price || 0) || 0;
  const priceText = `₦${storefrontFormatNaira(price)}`;
  const qtyId = `qty-${field.id}-${i}`;
  const startQty = opts.live ? (opts.cart[`${field.id}_${i}`] || 0) : 0;
  const rawCategory = p.category || "General";
  const category = storefrontEscape(rawCategory);
  const description = String(p.description || "").trim();
  const safeDescription = storefrontEscape(description);
  const stock = storefrontStockInfo(p);
  const fid = storefrontJsArg(field.id);

  const stockBadge = stock.out ? `<span class="sf-stock sf-stock-out">Sold out</span>` : "";

  const qtyButtons = opts.live && !stock.out
    ? `<button type="button" aria-label="Decrease quantity" onclick="${opts.qtyFn}('${fid}', ${i}, -1)">-</button>
       <span id="${qtyId}">${startQty}</span>
       <button type="button" aria-label="Increase quantity" onclick="${opts.qtyFn}('${fid}', ${i}, 1)">+</button>`
    : `<button type="button" disabled>-</button><span id="${qtyId}">0</span><button type="button" disabled>+</button>`;

  const addBtn = opts.live && !stock.out
    ? `<button type="button" class="sf-add" onclick="${opts.qtyFn}('${fid}', ${i}, 1)">Add</button>`
    : `<button type="button" class="sf-add" disabled>${stock.out ? "Sold out" : "Add"}</button>`;

  return `
    <div class="product-card sf-card${stock.out ? " is-soldout" : ""}" data-category="${category}" data-name="${storefrontEscape(String(p.name || "").toLowerCase())}" data-price="${price}" data-idx="${i}">
      <input type="checkbox" id="${cbId}" class="pop-toggle">
      <span class="product-qty-badge${startQty ? "" : " is-zero"}" id="badge-${fid}-${i}" aria-label="Quantity added">${startQty}</span>
      <label for="${cbId}" class="product-image sf-card-media">${img}${stockBadge}${rawCategory !== "General" ? `<span class="sf-card-cat">${category}</span>` : ""}</label>
      <div class="sf-card-body">
        <label for="${cbId}" class="product-name sf-card-name">${name}</label>
        ${safeDescription ? `<div class="product-description sf-card-desc">${safeDescription}</div>` : ""}
        <div class="sf-card-foot">
          <div class="product-price">${priceText}</div>
          ${addBtn}
        </div>
      </div>
      <div class="product-popup">
        <label for="${cbId}" class="popup-backdrop"></label>
        <div class="popup-card">
          <label for="${cbId}" class="popup-close">&times;</label>
          <div class="popup-image">${img}</div>
          <h3>${name}</h3>
          ${safeDescription ? `<p class="popup-desc">${safeDescription}</p>` : ""}
          <div class="popup-price">${priceText}</div>
          <div class="product-qty">${qtyButtons}</div>
        </div>
      </div>
    </div>`;
}

function storefrontChromeChips(field, chrome) {
  const products = field.products;
  const categories = ["All", ...new Set(products.map(p => p.category || "General"))];
  if (categories.length <= 2) return "";
  const esc = storefrontJsArg;
  const countOf = c => c === "All" ? products.length : products.filter(p => (p.category || "General") === c).length;
  const thumbOf = c => {
    const hit = products.find(p => (c === "All" || (p.category || "General") === c) && storefrontSafeUrl(p.imageUrl));
    const u = hit ? storefrontSafeUrl(hit.imageUrl) : "";
    return u ? `<img src="${u}" alt="" loading="lazy">` : `<span aria-hidden="true">${storefrontEscape(c.trim().charAt(0).toUpperCase())}</span>`;
  };
  const asCards = chrome.cats === "cards";
  return `
    <div class="category-scroll sf-cats sf-cats-${asCards ? "cards" : "chips"}">
      ${categories.map((c, idx) => asCards
        ? `<span class="cat-chip sf-cat-card ${idx === 0 ? "cat-active" : ""}" role="button" tabindex="0" onclick="filterStorefrontCategory(this, '${esc(c)}')"><span class="sf-cat-thumb">${thumbOf(c)}</span><span class="sf-cat-name">${storefrontEscape(c)}</span><span class="sf-cat-count">${countOf(c)}</span></span>`
        : `<span class="cat-chip ${idx === 0 ? "cat-active" : ""}" role="button" tabindex="0" onclick="filterStorefrontCategory(this, '${esc(c)}')">${storefrontEscape(c)}${chrome.counts ? ` <small class="sf-chip-count">${countOf(c)}</small>` : ""}</span>`
      ).join("")}
    </div>`;
}

function storefrontChromeProducts(field, opts, chrome) {
  const f = Object.assign({}, field, { products: Array.isArray(field.products) ? field.products : [] });
  const chips = storefrontChromeChips(f, chrome);
  const cards = f.products.map((p, i) => storefrontChromeCard(f, p, i, opts)).join("");
  return `
    ${chips ? '<span id="sfCats"></span>' : ""}${chips}
    <div class="product-grid sf-grid sf-g-${chrome.grid}">${cards}</div>`;
}

/* ---------------- cart drawer + checkout summary (DOM) ---------------- */

function storefrontCartLinesHTML(lines, qtyFn) {
  return lines.map(l => {
    const url = storefrontSafeUrl(l.imageUrl);
    const name = storefrontEscape(l.name);
    const fid = storefrontJsArg(l.fieldId);
    const thumb = url ? `<img src="${url}" alt="" loading="lazy">` : `<span class="sf-noimg" aria-hidden="true">${storefrontEscape((l.name || "?").trim().charAt(0).toUpperCase())}</span>`;
    return `
      <div class="sf-line">
        <div class="sf-line-img">${thumb}</div>
        <div class="sf-line-body">
          <div class="sf-line-name">${name}</div>
          <div class="sf-line-meta">₦${storefrontFormatNaira(l.price)} each</div>
          <div class="sf-line-ctl">
            <button type="button" aria-label="Decrease quantity of ${name}" onclick="${qtyFn}('${fid}', ${l.index}, -1)">-</button>
            <span>${l.qty}</span>
            <button type="button" aria-label="Increase quantity of ${name}" onclick="${qtyFn}('${fid}', ${l.index}, 1)">+</button>
            <button type="button" class="sf-remove" onclick="${qtyFn}('${fid}', ${l.index}, ${-l.qty})">Remove</button>
          </div>
        </div>
        <div class="sf-line-total">₦${storefrontFormatNaira(l.subtotal)}</div>
      </div>`;
  }).join("");
}

function storefrontRefreshCart(fields, cart, qtyFn) {
  if (typeof document === "undefined") return;
  const lines = storefrontCartLines(fields, cart);
  const items = lines.reduce((s, l) => s + l.qty, 0);
  const sub = lines.reduce((s, l) => s + l.subtotal, 0);
  const set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };

  set("sfCartLines", el => {
    el.innerHTML = lines.length
      ? storefrontCartLinesHTML(lines, qtyFn || "changeQty")
      : '<p class="sf-cart-empty">Your cart is empty. Add something you like.</p>';
  });
  set("sfCartSubtotal", el => { el.textContent = `₦${storefrontFormatNaira(sub)}`; });
  set("sfHeaderCount", el => { el.textContent = items; el.classList.toggle("is-zero", items === 0); });
  set("sfCheckoutSummary", el => {
    el.innerHTML = lines.map(l => `<div class="sf-sum-line"><span>${l.qty} &times; ${storefrontEscape(l.name)}</span><span>₦${storefrontFormatNaira(l.subtotal)}</span></div>`).join("");
    el.style.display = lines.length ? "block" : "none";
  });
  set("sfCheckoutBtn", el => { el.classList.toggle("is-disabled", !lines.length); el.setAttribute("aria-disabled", String(!lines.length)); });
  document.querySelectorAll(".sf-chrome .product-qty-badge").forEach(b => b.classList.toggle("is-zero", b.textContent.trim() === "0"));
}

/* ---------------- search + sort (DOM) ---------------- */

function storefrontSearch() {
  const input = document.getElementById("sfSearchInput");
  const q = input ? input.value : "";
  let visible = 0;
  document.querySelectorAll(".sf-chrome .product-card").forEach(card => {
    const match = storefrontMatchesQuery(card.dataset.name, q);
    card.classList.toggle("sf-filtered", !match);
    if (match && !card.classList.contains("hidden")) visible++;
  });
  const none = document.getElementById("sfNoResults");
  if (none) none.style.display = visible === 0 ? "block" : "none";
}

function storefrontSort(selectEl) {
  const mode = selectEl ? selectEl.value : "default";
  document.querySelectorAll(".sf-chrome .sf-grid").forEach(grid => {
    const cards = Array.from(grid.children).filter(c => c.classList && c.classList.contains("product-card"));
    const rows = cards.map(el => ({ el, price: Number(el.dataset.price) || 0, idx: Number(el.dataset.idx) || 0, name: el.dataset.name || "" }));
    storefrontSortCards(rows, mode).forEach(r => grid.appendChild(r.el));
  });
}

/* ---------------- one layer at a time ----------------
   The menu, search bar, cart drawer, checkout and every product pop-up are
   separate hidden checkboxes. Left alone, several could be open at once and
   stack on top of each other. This listener keeps exactly one open: switching
   one on switches the others off. */
if (typeof document !== "undefined" && !(typeof window !== "undefined" && window.__sfLayerGuard)) {
  if (typeof window !== "undefined") window.__sfLayerGuard = true;
  document.addEventListener("change", e => {
    const t = e.target;
    if (!t || !t.matches || !t.matches(".sf-chrome .sf-toggle, .sf-chrome .pop-toggle") || !t.checked) return;
    const root = t.closest(".sf-chrome");
    if (!root) return;
    root.querySelectorAll(".sf-toggle:checked, .pop-toggle:checked").forEach(other => { if (other !== t) other.checked = false; });
  });
}

/* ---------------- the page ---------------- */

function buildStorefrontChromeHTML({ fields, formTitle, formSubtitle, themeClass, themeId, storeConfig, opts }) {
  const cfg = storefrontNormalizeConfig(storeConfig);
  const chrome = storefrontChromeFor(themeId);
  const productFields = fields.filter(f => f.type === "product");
  const otherFields = fields.filter(f => f.type !== "product");
  const title = storefrontEscape(formTitle);
  const subtitle = storefrontEscape(formSubtitle);
  const initial = storefrontEscape((formTitle || "X").trim().charAt(0).toUpperCase());
  const logoUrl = storefrontSafeUrl(cfg.logoUrl);
  const bannerUrl = storefrontSafeUrl(cfg.bannerUrl);
  const contacts = storefrontContactLinks(cfg);
  const totalProducts = productFields.reduce((n, f) => n + (Array.isArray(f.products) ? f.products.length : 0), 0);
  const categorySet = new Set();
  productFields.forEach(f => (Array.isArray(f.products) ? f.products : []).forEach(p => categorySet.add(p.category || "General")));
  const hasCategories = categorySet.size > 1;
  const hasFees = otherFields.some(f => f.type === "additional_fee");
  const featured = [];
  productFields.forEach(f => (Array.isArray(f.products) ? f.products : []).forEach((p, i) => { if (p.featured && featured.length < 6) featured.push({ f, p, i }); }));

  const announce = chrome.header === "bold" && cfg.tagline ? storefrontEscape(cfg.tagline) : "";
  const closeNav = `onclick="document.getElementById('navToggle').checked=false"`;
  const navLinks = [
    `<a href="#sfHome" ${closeNav}>Home</a>`,
    `<a href="#shop" ${closeNav}>Shop</a>`,
    hasCategories ? `<a href="#sfCats" ${closeNav}>Categories</a>` : "",
    cfg.about ? `<a href="#sfAbout" ${closeNav}>About</a>` : "",
    (contacts.length || cfg.policy) ? `<a href="#sfContact" ${closeNav}>Contact</a>` : ""
  ].join("");

  const sendBtn = opts.live
    ? `<button class="send-btn" onclick="${opts.submitFn}()">Send Order</button>`
    : `<button class="send-btn" disabled>Send Order</button>`;

  const logo = logoUrl
    ? `<img class="sf-logo" src="${logoUrl}" alt="">`
    : `<span class="sf-logo sf-logo-initial" aria-hidden="true">${initial}</span>`;

  const featuredHTML = featured.length ? `
    <section class="sf-featured" aria-label="Featured products">
      <h2 class="sf-h2">Featured</h2>
      <div class="sf-featured-row">
        ${featured.map(({ f, p, i }) => {
          const u = storefrontSafeUrl(p.imageUrl);
          return `<label for="pop-${f.id}-${i}" class="sf-feat-card">
            <span class="sf-feat-img">${u ? `<img src="${u}" alt="" loading="lazy">` : `<span class="sf-noimg" aria-hidden="true">${storefrontEscape((p.name || "?").trim().charAt(0).toUpperCase())}</span>`}</span>
            <span class="sf-feat-name">${storefrontEscape(p.name)}</span>
            <span class="sf-feat-price">₦${storefrontFormatNaira(p.price)}</span>
          </label>`;
        }).join("")}
      </div>
    </section>` : "";

  const shopHTML = totalProducts === 0
    ? `<div class="sf-empty"><h2 class="sf-h2">Products coming soon</h2><p>This store has not added any products yet. Please check back shortly.</p></div>`
    : `${featuredHTML}
       <div class="sf-toolbar">
         <h2 class="sf-h2">${productFields.length > 1 ? "Shop" : (storefrontEscape(productFields[0].label) || "Shop")}</h2>
       </div>
       <section class="showcase">${productFields.map(f => storefrontChromeProducts(f, opts, chrome)).join("")}</section>
       <p class="sf-no-results" id="sfNoResults" style="display:none">No products match your search.</p>`;

  const aboutHTML = cfg.about ? `
    <section class="sf-about" id="sfAbout"><h2 class="sf-h2">About us</h2><p>${storefrontEscape(cfg.about)}</p></section>` : "";

  const contactCol = contacts.length ? `
      <div class="sf-ft-col"><h3>Contact</h3>
        <ul>${contacts.map(c => `<li><a href="${storefrontEscape(c.href)}"${/^https/.test(c.href) ? ' target="_blank" rel="noopener noreferrer"' : ""}>${storefrontEscape(c.label)}</a></li>`).join("")}</ul>
      </div>` : "";
  const policyCol = cfg.policy ? `
      <div class="sf-ft-col"><h3>Delivery and returns</h3><p>${storefrontEscape(cfg.policy)}</p></div>` : "";

  return `
    <div class="preview-theme ${themeClass} sf-chrome sf-hdr-${chrome.header}" id="sfTop">
      <input type="checkbox" id="navToggle" class="sf-toggle" aria-hidden="true" tabindex="-1">
      <input type="checkbox" id="searchToggle" class="sf-toggle" aria-hidden="true" tabindex="-1">
      <input type="checkbox" id="cartToggle" class="sf-toggle" aria-hidden="true" tabindex="-1">

      <header class="sf-header">
        ${announce ? `<div class="sf-announce">${announce}</div>` : ""}
        <div class="sf-header-inner">
          <label for="navToggle" class="sf-icon-btn sf-burger" role="button" aria-label="Menu">${SF_ICON.menu}</label>
          <a class="sf-brand" href="#sfHome" ${closeNav}>${logo}<span class="sf-brand-name">${title}</span></a>
          <nav class="sf-nav" aria-label="Store">${navLinks}</nav>
          <div class="sf-actions">
            ${totalProducts ? `<label for="searchToggle" class="sf-icon-btn" role="button" aria-label="Search products">${SF_ICON.search}</label>` : ""}
            <label for="cartToggle" class="sf-icon-btn sf-cart-btn" role="button" aria-label="Open cart">${SF_ICON.cart}<span class="sf-count is-zero" id="sfHeaderCount">0</span></label>
          </div>
        </div>
        ${totalProducts ? `<div class="sf-search">
          <input type="search" id="sfSearchInput" placeholder="Search products" autocomplete="off" oninput="storefrontSearch()" aria-label="Search products">
          <select id="sfSort" onchange="storefrontSort(this)" aria-label="Sort products">
            <option value="default">Sort: Default</option>
            <option value="price-asc">Price: Low to high</option>
            <option value="price-desc">Price: High to low</option>
            <option value="name">Name: A to Z</option>
          </select>
        </div>` : ""}
      </header>

      <section class="sf-hero sf-hero-${chrome.hero} ${bannerUrl ? "sf-has-banner" : "sf-no-banner"}" id="sfHome">
        <div class="sf-hero-text">
          <div class="store-simple-header">
            <h1>${title}</h1>
            ${subtitle ? `<p>${subtitle}</p>` : ""}
          </div>
          ${cfg.tagline && !announce ? `<p class="sf-tagline">${storefrontEscape(cfg.tagline)}</p>` : ""}
          ${totalProducts ? `<a class="sf-btn" href="#shop">${storefrontEscape(cfg.heroCta || "Shop now")}</a>` : ""}
        </div>
        <div class="sf-hero-media">
          ${bannerUrl ? `<img class="sf-hero-img" src="${bannerUrl}" alt="">` : `<div class="sf-hero-fallback" aria-hidden="true"><span>${initial}</span></div>`}
        </div>
      </section>

      <div class="store-shell sf-shell" id="shop">
        ${shopHTML}
      </div>

      ${aboutHTML}

      <footer class="sf-footer sf-ft-${chrome.footer}" id="sfContact">
        <div class="sf-ft-grid">
          <div class="sf-ft-col sf-ft-brand">
            <div class="sf-ft-name">${logo}<span>${title}</span></div>
            ${cfg.tagline ? `<p>${storefrontEscape(cfg.tagline)}</p>` : ""}
          </div>
          ${contactCol}
          ${policyCol}
        </div>
        <p class="powered">powered by X Redro</p>
      </footer>

      <input type="checkbox" id="checkoutToggle" class="pop-toggle">

      <div class="cart-bar" id="cartBar">
        <div class="cb-info">
          <span id="cartBarCount">0 items</span>
          <small id="cartBarTotal">₦0</small>
        </div>
        <label for="cartToggle" class="cart-bar-checkout-label">View cart &rarr;</label>
      </div>

      <div class="sf-drawer">
        <label for="cartToggle" class="sf-drawer-backdrop"></label>
        <aside class="sf-drawer-panel" role="dialog" aria-label="Your cart">
          <div class="sf-drawer-head">
            <h2>Your cart</h2>
            <label for="cartToggle" class="sf-icon-btn" role="button" aria-label="Close cart">${SF_ICON.close}</label>
          </div>
          <div class="sf-cart-lines" id="sfCartLines"><p class="sf-cart-empty">Your cart is empty. Add something you like.</p></div>
          <div class="sf-drawer-foot">
            <div class="sf-subtotal"><span>Subtotal</span><strong id="sfCartSubtotal">₦0</strong></div>
            ${hasFees ? `<small class="sf-fee-note">Delivery and other fees are added at checkout.</small>` : ""}
            <label for="checkoutToggle" id="sfCheckoutBtn" class="sf-btn sf-btn-block is-disabled" aria-disabled="true" onclick="if(this.classList.contains('is-disabled')){event.preventDefault();return false;}document.getElementById('cartToggle').checked=false">Checkout</label>
            <label for="cartToggle" class="sf-btn sf-btn-ghost sf-btn-block">Continue shopping</label>
          </div>
        </aside>
      </div>

      <div class="checkout-overlay">
        <label for="checkoutToggle" class="checkout-overlay-backdrop"></label>
        <div class="checkout-overlay-card">
          <label for="checkoutToggle" class="checkout-close">&times;</label>
          <div class="checkout-badge">${initial}</div>
          <div class="checkout-head">
            <h2>Checkout</h2>
            <p>Confirm your details and we'll get your order moving.</p>
          </div>

          <div class="sf-summary" id="sfCheckoutSummary" style="display:none"></div>

          ${otherFields.map(f => storefrontField(f, opts)).join("")}

          <div class="total-box">
            <div>Items <span id="itemCount">0</span></div>
            <div id="additionalFeeBox" style="display:none;"></div>
            <div>Total Cost <span id="totalCost">₦0</span></div>
          </div>

          ${storefrontPaymentDetails(opts)}
          <div class="payment-proof">
            <label>Payment Proof Image</label>
            <label class="upload-proof">
              <input type="file" id="paymentProof" accept="image/*" hidden ${opts.live ? "" : "disabled"}>
              <div class="upload-ui">
                <span class="upload-icon">&#8593;</span>
                <span class="upload-text">Upload payment proof</span>
              </div>
            </label>
            <div class="payment-proof-preview" id="paymentProofPreview" aria-live="polite"></div>
          </div>

          ${sendBtn}
          <p class="powered">powered by X Redro</p>
        </div>
      </div>
    </div>
  `;
}
