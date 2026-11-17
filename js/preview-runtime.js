/* =========================================================
   PREVIEW RUNTIME
   Runs INSIDE the builder's preview iframe (see openPreview in
   builderF.js). The iframe is an isolated document that loads only
   the store's own CSS, exactly like form.html, so the preview is not
   affected by the builder page's global styles. The builder passes the
   store data in window.__PREVIEW__.
========================================================= */

var fields = [];
var previewCart = {};

function previewNoSubmit() {
  showToast("This is a preview. Orders can't be sent from here.", "info");
}

function previewChangeQty(fieldId, index, delta) {
  const key = `${fieldId}_${index}`;
  previewCart[key] = Math.max(0, (previewCart[key] || 0) + delta);
  const qty = previewCart[key];
  const el = document.getElementById(`qty-${fieldId}-${index}`);
  const badgeEl = document.getElementById(`badge-${fieldId}-${index}`);
  if (el) el.innerText = qty;
  if (badgeEl) badgeEl.innerText = qty;
  previewUpdateTotal();
}

function previewUpdateTotal() {
  let items = 0, total = 0;

  fields.forEach(field => {
    if (field.type === "product") {
      (Array.isArray(field.products) ? field.products : []).forEach((p, i) => {
        const qty = previewCart[`${field.id}_${i}`] || 0;
        items += qty;
        total += qty * (Number(p.price || 0) || 0);
      });
    }
  });

  let additionalFeeAmount = 0;
  const additionalFeesHtml = [];
  fields.forEach(field => {
    if (field.type === "additional_fee") {
      const select = document.querySelector(`[data-id="${field.id}"]`);
      if (select && select.value) {
        const selected = (field.fees || []).find(f => f.name === select.value);
        if (selected) {
          additionalFeeAmount += Number(selected.price || 0);
          additionalFeesHtml.push(`<div>${storefrontEscape(field.label)}: ${storefrontEscape(selected.name)} <span>₦${Number(selected.price || 0).toLocaleString()}</span></div>`);
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

  const set = (id, text) => { const el = document.getElementById(id); if (el) el.innerText = text; };
  set("itemCount", items);
  set("totalCost", `₦${total.toLocaleString()}`);
  set("cartBarCount", `${items} item${items === 1 ? "" : "s"}`);
  set("cartBarTotal", `₦${total.toLocaleString()}`);
  const cartBar = document.getElementById("cartBar");
  if (cartBar) cartBar.classList.toggle("visible", items > 0);

  if (typeof storefrontRefreshCart === "function") storefrontRefreshCart(fields, previewCart, "previewChangeQty");
}

(function boot() {
  const data = window.__PREVIEW__ || {};
  fields = Array.isArray(data.fields) ? data.fields : [];
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = buildStorefrontHTML({
    fields,
    formTitle: data.formTitle || "",
    formSubtitle: data.formSubtitle || "",
    themeClass: data.themeClass || "theme-r1",
    storeConfig: data.storeConfig || null,
    opts: { live: true, cart: previewCart, qtyFn: "previewChangeQty", totalFn: "previewUpdateTotal", submitFn: "previewNoSubmit" }
  });
  // In-page links (#shop, #sfAbout, ...) must scroll inside the preview. In an srcdoc frame the browser would
  // resolve "#shop" against the BUILDER page's address and load the builder inside the frame, losing the store.
  document.addEventListener("click", e => {
    const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (href.charAt(0) === "#") {
      e.preventDefault();
      const id = decodeURIComponent(href.slice(1));
      const target = id ? document.getElementById(id) : null;
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      else window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (/^(tel|mailto):/i.test(href)) {
      e.preventDefault();
      showToast("Preview only. Customers can tap this to call or email you.", "info");
    }
  });
  // Escape closes the preview (key events inside the frame do not reach the builder page)
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && window.parent !== window) window.parent.postMessage({ xredro: "closePreview" }, "*");
  });
})();
