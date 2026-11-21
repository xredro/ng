/* Share kit: a ready-made share image and three captions built from the seller's REAL store (name, tagline, products,
   prices, pictures, link). Nothing is invented. Pure helpers (readStore, pick, captions, naira) work in Node for tests;
   the image drawing and the modal need a browser. The image is drawn on a canvas in the seller's own browser. */
(function (root) {
  "use strict";
  const hasReq = typeof module !== "undefined" && module.exports;
  const Setup = hasReq ? require("./setup-checklist.js") : root.XrSetup;
  const clip = (s, n) => String(s == null ? "" : s).trim().slice(0, n);
  const naira = p => { const n = Number(String(p || "").replace(/[^\d.]/g, "")); return n > 0 ? "\u20A6" + Math.round(n).toLocaleString("en-US") : ""; };

  function readStore(form) {
    const f = Setup.readForm(form);
    const products = f.products.filter(p => p && clip(p.name, 80)).map(p => ({ name: clip(p.name, 80), price: naira(p.price), imageUrl: /^https?:\/\//.test(String(p.imageUrl || "")) ? String(p.imageUrl) : "", sample: p.sample === true, featured: p.featured === true, soldOut: p.soldOut === true || p.soldOut === "true" }));
    const logo = /^https?:\/\//.test(String(f.cfg.logoUrl || "")) ? String(f.cfg.logoUrl) : "";
    return { name: clip(f.title, 60) || "My store", tagline: clip(f.cfg.tagline, 120), logoUrl: logo, products, hasSamples: products.some(p => p.sample) };
  }
  // up to n products for the picture: available ones, featured first, ones with a picture first
  function pick(store, n) {
    const ok = store.products.filter(p => !p.soldOut);
    const rank = p => (p.featured ? 0 : 2) + (p.imageUrl ? 0 : 1);
    return ok.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).slice(0, n || 3).map(x => x.p);
  }
  const list = names => names.length <= 1 ? names.join("") : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
  function captions(store, link) {
    const names = pick(store, 3).map(p => p.name);
    const taking = names.length ? "Now taking orders: " + list(names) + (store.products.length > names.length ? " and more" : "") + "." : "";
    const tag = store.tagline ? store.tagline + "\n" : "";
    return [
      { id: "status", title: "WhatsApp Status", text: [store.name + " is open for orders \uD83D\uDECD\uFE0F", tag + taking].filter(Boolean).join("\n").trim() + "\n\nSee everything and order here \uD83D\uDC47\n" + link },
      { id: "post", title: "Instagram post", text: [store.name, tag + taking].filter(Boolean).join("\n").trim() + "\n\nOpen the link in my bio, pick what you want, pay by bank transfer and send your payment proof. It takes a minute.\n\n" + link },
      { id: "dm", title: "Reply to a customer", text: "Hi! Thanks for your interest \uD83D\uDE0A You can see everything and order here:\n" + link + "\n\nChoose what you want, send your order with your payment proof, and I'll confirm it once I've checked the payment." }
    ];
  }

  /* ---------------- image (browser only) ---------------- */
  const SIZES = { status: { w: 1080, h: 1920, label: "Status (tall)" }, post: { w: 1080, h: 1080, label: "Post (square)" } };
  const FONT = '"Manrope","Inter",system-ui,-apple-system,"Segoe UI",sans-serif';
  function loadImage(url) {
    return new Promise(resolve => {
      if (!url) return resolve(null);
      const im = new Image(); let done = false; const end = v => { if (!done) { done = true; resolve(v); } };
      im.crossOrigin = "anonymous"; im.onload = () => end(im); im.onerror = () => end(null); setTimeout(() => end(null), 7000); im.src = url;
    });
  }
  function wrap(ctx, text, maxW, maxLines) {
    const words = String(text).split(/\s+/).filter(Boolean), lines = []; let cur = "";
    for (const w of words) { const t = cur ? cur + " " + w : w; if (ctx.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; } }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) { const keep = lines.slice(0, maxLines); let last = keep[maxLines - 1]; while (last.length > 1 && ctx.measureText(last + "\u2026").width > maxW) last = last.slice(0, -1); keep[maxLines - 1] = last + "\u2026"; return keep; }
    return lines;
  }
  function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function cover(ctx, im, x, y, w, h, r) {
    ctx.save(); rr(ctx, x, y, w, h, r); ctx.clip(); const s = Math.max(w / im.width, h / im.height), dw = im.width * s, dh = im.height * s; ctx.drawImage(im, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); ctx.restore();
  }
  function draw(canvas, store, link, format, images) {
    const S = SIZES[format] || SIZES.status; canvas.width = S.w; canvas.height = S.h; const ctx = canvas.getContext("2d");
    const INK = "#16181A", LIME = "#9bdd78", P = 72;
    const g = ctx.createLinearGradient(0, 0, S.w, S.h); g.addColorStop(0, "#1d2420"); g.addColorStop(1, INK); ctx.fillStyle = g; ctx.fillRect(0, 0, S.w, S.h);
    ctx.fillStyle = "rgba(155,221,120,.10)"; ctx.beginPath(); ctx.arc(S.w * 0.95, S.h * 0.88, S.w * 0.55, 0, Math.PI * 2); ctx.fill();
    let y = P;
    // logo or monogram
    const lw = 120; rr(ctx, P, y, lw, lw, 28);
    if (images.logo) { ctx.save(); ctx.fillStyle = "#fff"; ctx.fill(); ctx.restore(); cover(ctx, images.logo, P, y, lw, lw, 28); }
    else { ctx.fillStyle = LIME; ctx.fill(); ctx.fillStyle = INK; ctx.font = "800 64px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(store.name.trim().charAt(0).toUpperCase() || "S", P + lw / 2, y + lw / 2 + 3); }
    y += lw + 44; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#fff"; ctx.font = "800 " + (format === "post" ? 76 : 88) + "px " + FONT; const nameLines = wrap(ctx, store.name, S.w - 2 * P, 2);
    nameLines.forEach(l => { y += format === "post" ? 80 : 94; ctx.fillText(l, P, y); });
    if (store.tagline) { ctx.fillStyle = "rgba(255,255,255,.78)"; ctx.font = "500 38px " + FONT; wrap(ctx, store.tagline, S.w - 2 * P, 2).forEach(l => { y += 54; ctx.fillText(l, P, y); }); }
    y += 56;
    const items = pick(store, 3), footH = 270; const areaBottom = S.h - footH;
    if (items.length) {
      if (format === "status") {
        const rowH = Math.min(300, Math.floor((areaBottom - y) / items.length) - 24), pic = rowH;
        items.forEach((p, i) => {
          const ry = y + i * (rowH + 24); ctx.fillStyle = "rgba(255,255,255,.07)"; rr(ctx, P, ry, S.w - 2 * P, rowH, 32); ctx.fill();
          const im = images.products[i]; if (im) cover(ctx, im, P, ry, pic, rowH, 32); else { ctx.fillStyle = "rgba(255,255,255,.12)"; rr(ctx, P, ry, pic, rowH, 32); ctx.fill(); ctx.fillStyle = LIME; ctx.font = "800 90px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(p.name.charAt(0).toUpperCase(), P + pic / 2, ry + rowH / 2); ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; }
          const tx = P + pic + 36, tw = S.w - 2 * P - pic - 72; ctx.fillStyle = "#fff"; ctx.font = "700 44px " + FONT; const nl = wrap(ctx, p.name, tw, 2);
          const baseY = ry + rowH / 2 - (nl.length - 1) * 26 - (p.price ? 6 : -14); nl.forEach((l, k) => ctx.fillText(l, tx, baseY + k * 54));
          if (p.price) { ctx.fillStyle = LIME; ctx.font = "800 46px " + FONT; ctx.fillText(p.price, tx, baseY + nl.length * 54 + 14); }
        });
      } else {
        const gap = 24, cw = Math.floor((S.w - 2 * P - gap * (items.length - 1)) / items.length), ph = Math.min(cw, areaBottom - y - 120);
        items.forEach((p, i) => {
          const cx = P + i * (cw + gap); const im = images.products[i];
          if (im) cover(ctx, im, cx, y, cw, ph, 28); else { ctx.fillStyle = "rgba(255,255,255,.12)"; rr(ctx, cx, y, cw, ph, 28); ctx.fill(); ctx.fillStyle = LIME; ctx.font = "800 80px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(p.name.charAt(0).toUpperCase(), cx + cw / 2, y + ph / 2); ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; }
          ctx.fillStyle = "#fff"; ctx.font = "700 30px " + FONT; const nl = wrap(ctx, p.name, cw, 1); ctx.fillText(nl[0] || "", cx, y + ph + 44);
          if (p.price) { ctx.fillStyle = LIME; ctx.font = "800 32px " + FONT; ctx.fillText(p.price, cx, y + ph + 86); }
        });
      }
    }
    // call to action and link
    const by = S.h - footH + 40; ctx.fillStyle = LIME; rr(ctx, P, by, S.w - 2 * P, 104, 52); ctx.fill();
    ctx.fillStyle = INK; ctx.font = "800 44px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("Order here", S.w / 2, by + 54); ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#fff"; ctx.font = "600 32px " + FONT; let shown = String(link).replace(/^https?:\/\//, ""); while (shown.length > 8 && ctx.measureText(shown).width > S.w - 2 * P) shown = shown.slice(0, -2);
    ctx.textAlign = "center"; ctx.fillText(shown, S.w / 2, by + 164); ctx.fillStyle = "rgba(255,255,255,.5)"; ctx.font = "500 24px " + FONT; ctx.fillText("powered by X Redro", S.w / 2, by + 208); ctx.textAlign = "left";
  }
  function tainted(canvas) { try { canvas.getContext("2d").getImageData(0, 0, 1, 1); return false; } catch (e) { return true; } }
  async function render(canvas, store, link, format) {
    const items = pick(store, 3);
    const [logo, ...prods] = await Promise.all([loadImage(store.logoUrl)].concat(items.map(p => loadImage(p.imageUrl))));
    draw(canvas, store, link, format, { logo, products: prods });
    if (tainted(canvas)) { draw(canvas, store, link, format, { logo: null, products: [] }); return { withPictures: false }; }  // pictures blocked: still make a useful card
    const wanted = items.filter(p => p.imageUrl).length + (store.logoUrl ? 1 : 0), got = prods.filter(Boolean).length + (logo ? 1 : 0);
    return { withPictures: true, missing: wanted - got };
  }
  const toBlob = canvas => new Promise(res => canvas.toBlob(b => res(b), "image/png"));

  /* ---------------- the sheet on the dashboard ---------------- */
  function open(opts) {
    const $ = id => document.getElementById(id), modal = $("shareModal"); if (!modal) return;
    const store = readStore(opts.form), caps = captions(store, opts.link), opener = document.activeElement;
    let fmt = "status", capId = "status", blob = null, busy = 0;
    const warn = $("shareWarn"), note = $("shareNote"), canvas = $("shareCanvas"), area = $("shareCapture");
    const ready = !!opts.form && store.products.length > 0;
    warn.hidden = true; note.textContent = "";
    if (!ready) { warn.textContent = "Your store isn't ready yet. Open the Store builder to add your products, then come back for your share image."; warn.hidden = false; }
    else if (store.hasSamples) { warn.innerHTML = 'Your store still has sample products. Replace them with your own before you share, or customers could order a sample. <a href="indexF.html">Open the Store builder</a>.'; warn.hidden = false; }
    area.hidden = !ready; $("shareImgBtn").hidden = !ready; $("shareDl").hidden = !ready; $("shareFmt").hidden = !ready;
    const done = () => { if (opts.onShared) opts.onShared(); };
    const toast = (m, t) => { if (window.showToast) window.showToast(m, t || "success"); };
    async function repaint() {
      if (!ready) return; const mine = ++busy; $("shareDl").disabled = $("shareImgBtn").disabled = true; note.textContent = "Making your image\u2026";
      const r = await render(canvas, store, opts.link, fmt); if (mine !== busy) return; blob = await toBlob(canvas); $("shareDl").disabled = $("shareImgBtn").disabled = !blob;
      note.textContent = !r.withPictures ? "Your pictures couldn't be added to the image, but it still has your name, products and link." : r.missing > 0 ? "Some pictures couldn't be loaded, so those products show a letter instead." : "";
    }
    function showCap() { $("shareCaption").value = (caps.find(c => c.id === capId) || caps[0]).text; modal.querySelectorAll("[data-cap]").forEach(b => b.setAttribute("aria-pressed", String(b.getAttribute("data-cap") === capId))); }
    modal.querySelectorAll("[data-fmt]").forEach(b => { b.setAttribute("aria-pressed", String(b.getAttribute("data-fmt") === fmt)); b.onclick = () => { fmt = b.getAttribute("data-fmt"); modal.querySelectorAll("[data-fmt]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); repaint(); }; });
    modal.querySelectorAll("[data-cap]").forEach(b => { b.onclick = () => { capId = b.getAttribute("data-cap"); showCap(); }; });
    async function copy(text, msg) {
      try { await navigator.clipboard.writeText(text); } catch (e) { const t = document.createElement("textarea"); t.value = text; t.style.position = "fixed"; t.style.opacity = "0"; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); } catch (x) { /* nothing more to try */ } t.remove(); }
      toast(msg); done();
    }
    $("shareCopyCap").onclick = () => copy($("shareCaption").value, "Caption copied");
    $("shareCopyLink").onclick = () => copy(opts.link, "Store link copied");
    $("shareDl").onclick = () => { if (!blob) return; const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "store-" + fmt + ".png"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); toast("Image saved"); done(); };
    $("shareImgBtn").onclick = async () => {
      if (!blob) return; const file = new File([blob], "store-" + fmt + ".png", { type: "image/png" });
      try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text: $("shareCaption").value }); done(); return; } } catch (e) { if (e && e.name === "AbortError") return; }
      $("shareDl").click(); toast("Image saved. Add it to your post and paste your caption.");
    };
    function close() { modal.hidden = true; document.removeEventListener("keydown", onKey); if (opener && opener.focus) try { opener.focus(); } catch (e) { /* element is gone */ } }
    function onKey(e) { if (e.key === "Escape") close(); }
    modal.querySelectorAll("[data-close]").forEach(b => { b.onclick = close; });
    document.addEventListener("keydown", onKey);
    showCap(); modal.hidden = false; const first = modal.querySelector("[data-close].xr-btn"); if (first) first.focus(); repaint();
  }
  const api = { SIZES, readStore, pick, captions, naira, draw, render, open };
  if (hasReq) module.exports = api; else root.XrShare = api;
})(typeof window !== "undefined" ? window : globalThis);
