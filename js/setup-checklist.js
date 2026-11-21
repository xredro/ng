/* Setup checklist for new sellers: works out what is left to do from the saved store and the orders, and shows ONE
   "next step" card on the dashboard. Pure logic (compute) is separate from the DOM part (render) so it can be tested.
   It only reads what the seller has already saved. Nothing here writes to the database. */
(function (root) {
  "use strict";
  const S = (typeof module !== "undefined" && module.exports) ? require("./starter-kits.js") : root.XrStarter;
  const TITLE_PLACEHOLDER = S.TITLE_PLACEHOLDER;
  const has = v => String(v == null ? "" : v).trim().length > 0;
  const parseJson = v => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch (e) { return null; } };

  function readForm(form) {
    const f = form || {};
    const fields = (Array.isArray(f.fields) ? f.fields : []).map(parseJson).filter(x => x && typeof x === "object");
    const products = [];
    fields.filter(x => x.type === "product").forEach(x => (Array.isArray(x.products) ? x.products : []).forEach(p => products.push(p || {})));
    const cfg = parseJson(f.storeConfig) || {};
    return { fields, products, cfg, title: String(f.title || ""), subtitle: String(f.subtitle || ""), whatsappNumber: f.whatsappNumber };
  }

  // input: { form, orderCount, shared, storeUrl }  ->  { steps, done, total, next, complete }
  function compute(input) {
    const i = input || {};
    const f = readForm(i.form);
    const samples = f.products.filter(p => p.sample === true).length;
    const named = has(f.title) && f.title.trim() !== TITLE_PLACEHOLDER;
    const bankDone = has(f.subtitle) && !/\[[^\]]+\]/.test(f.subtitle);
    const contactDone = has(f.whatsappNumber) || has(f.cfg.whatsapp) || has(f.cfg.phone);
    const steps = [
      { id: "starter", title: "Pick your starter store", why: "Choose what you sell and get a ready-made store with sample products in one tap.",
        done: f.fields.length > 0, action: { label: "Choose a starter", href: "indexF.html?quickstart=1" } },
      { id: "name", title: "Name your store", why: "Customers see this name at the top of your store.",
        done: named, action: { label: "Add your store name", href: "indexF.html" } },
      { id: "products", title: samples > 0 ? "Replace the sample products" : "Add your products",
        why: samples > 0 ? "Swap each sample for your own photo, name and price. Customers can order a sample if you leave it." : "Add at least one product with a name and a price.",
        done: f.products.length > 0 && samples === 0, action: { label: "Edit products", href: "indexF.html" } },
      { id: "bank", title: "Add your bank details", why: "Tell customers exactly where to pay. Replace the [brackets] in your store's sub heading.",
        done: bankDone, action: { label: "Add bank details", href: "indexF.html" } },
      { id: "contact", title: "Add your WhatsApp number", why: "So customers can reach you, and so they can send you their order on WhatsApp.",
        done: contactDone, action: { label: "Add WhatsApp number", href: "settings.html#waH" } },
      { id: "test", title: "Place a test order", why: "Order from your own store as a customer to see exactly what your customers see. You can delete it afterwards.",
        done: Number(i.orderCount) > 0, action: { label: "Open my store", href: i.storeUrl || "#", external: true } },
      { id: "share", title: "Share your store link", why: "Get a ready share image and captions for WhatsApp Status, Instagram and your DMs.",
        done: i.shared === true, action: { label: "Open share kit", run: "share" } }
    ];
    const done = steps.filter(s => s.done).length;
    return { steps, done, total: steps.length, next: steps.find(s => !s.done) || null, complete: done === steps.length };
  }

  const sharedKey = uid => "xr_shared_" + uid;
  function isShared(uid) { try { return localStorage.getItem(sharedKey(uid)) === "1"; } catch (e) { return false; } }
  function markShared(uid) { try { localStorage.setItem(sharedKey(uid), "1"); } catch (e) { /* storage blocked: the step simply stays open */ } }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // help videos are optional: a step only shows "Watch" when js/help-config.js has an https:// link or a path under assets/videos/
  function videoFor(id) { const h = root.XR_HELP; const v = h && h.videos ? String(h.videos[id] || "") : ""; return /^https:\/\//.test(v) || /^assets\/videos\/[\w.-]+$/.test(v) ? v : ""; }

  function render(el, state, handlers) {
    if (!el) return;
    if (state.complete) { el.hidden = true; return; }
    const n = state.next;
    const pct = Math.round(state.done / state.total * 100);
    const btn = (s, primary) => {
      const a = s.action, cls = "xr-btn " + (primary ? "xr-btn--primary" : "xr-btn--secondary") + " xr-btn--sm";
      return a.run ? `<button type="button" class="${cls}" data-run="${esc(a.run)}">${esc(a.label)}</button>`
        : `<a class="${cls}" href="${esc(a.href)}"${a.external ? ' target="_blank" rel="noopener"' : ""}>${esc(a.label)}</a>`;
    };
    const vid = videoFor(n.id);
    const list = state.steps.map(s => `<li class="${s.done ? "is-done" : s === n ? "is-next" : ""}"><span class="setup__tick" aria-hidden="true">${s.done ? "✓" : ""}</span><span>${esc(s.title)}${s.done ? '<span class="xr-sr-only"> (done)</span>' : ""}</span></li>`).join("");
    el.hidden = false;
    el.innerHTML = `<div class="setup__top"><h2 class="xr-h3" id="setupH">Get your store ready</h2><span class="xr-small xr-text-2">${state.done} of ${state.total} done</span></div>
      <div class="setup__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-labelledby="setupH"><span style="width:${pct}%"></span></div>
      <div class="setup__next"><p class="setup__label">Next step</p><h3 class="setup__title">${esc(n.title)}</h3><p class="xr-text-2">${esc(n.why)}</p>
        <div class="xr-row">${btn(n, true)}${vid ? `<a class="xr-btn xr-btn--ghost xr-btn--sm" href="${esc(vid)}" target="_blank" rel="noopener">Watch the video</a>` : ""}</div></div>
      <details class="setup__all"><summary>See all steps</summary><ol class="setup__list">${list}</ol></details>
      <p class="setup__help xr-small"><a href="help.html">Help and videos</a></p>`;
    el.querySelectorAll("[data-run]").forEach(b => b.addEventListener("click", () => handlers && handlers[b.getAttribute("data-run")] && handlers[b.getAttribute("data-run")]()));
  }

  const api = { compute, render, isShared, markShared, readForm };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.XrSetup = api;
})(typeof window !== "undefined" ? window : globalThis);
