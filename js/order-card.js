/* Public Order ID generation and the downloadable order card (Phase 8).
   Used by the store (js/form.js) after an order is saved, by the customer order page (js/order.js) and by the seller Orders page. */
(function (global) {
  "use strict";
  const L = () => global.XrOrder;

  /* secure random index in [0, n) without modulo bias */
  function randomIndex(n) {
    const c = global.crypto || global.msCrypto;
    if (!c || !c.getRandomValues) throw new Error("No secure random source available");
    const limit = Math.floor(256 / n) * n;
    const buf = new Uint8Array(1);
    for (;;) { c.getRandomValues(buf); if (buf[0] < limit) return buf[0] % n; }
  }
  const generatePublicId = () => L().generatePublicId(randomIndex);

  /* ---------- the card image ---------- */
  const W = 1080, PAD = 64;
  const FONT = '"Manrope", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const MONO = '"SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';
  const naira = n => "₦" + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString("en-NG");
  const KEEP_SAFE = "Keep this order ID safe. You can use it to retrieve and update your order later.";
  const KEEP_SAFE_OFF = "Keep this order ID safe. Quote it to the seller if you need help with your order.";

  function wrap(ctx, text, maxWidth) {
    const out = [];
    String(text == null ? "" : text).split(/\n/).forEach(par => {
      let line = "";
      par.split(/(\s+)/).forEach(tok => {
        if (!tok) return;
        const trial = line + tok;
        if (ctx.measureText(trial).width <= maxWidth || !line.trim()) {
          if (ctx.measureText(tok).width > maxWidth) {
            let chunk = line;
            for (const ch of tok) {
              if (ctx.measureText(chunk + ch).width > maxWidth && chunk) { out.push(chunk.trimEnd()); chunk = ""; }
              chunk += ch;
            }
            line = chunk;
          } else line = trial;
        } else { out.push(line.trimEnd()); line = tok.replace(/^\s+/, ""); }
      });
      out.push(line.trimEnd());
    });
    return out.length ? out : [""];
  }
  const TONES = { good: ["#e4f3e8", "#276b3c"], warn: ["#fdeee1", "#8a5a1d"], bad: ["#fbe6e6", "#b03226"], info: ["#e3eefb", "#2b5ea8"] };
  function roundRect(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }

  /* data: { storeName, publicId, dateText, items:[{name,qty,price}], feesAmount, total, paymentStatus, paymentTone,
             contact:{whatsapp,phone}, retrievalUrl, updatesEnabled } */
  function renderOrderCard(data, logoImg, doc) {
    const d = doc || global.document;
    const measure = d.createElement("canvas").getContext("2d");
    const inner = W - PAD * 2;
    const f = (w, px, fam) => `${w} ${px}px ${fam || FONT}`;
    const keepSafe = data.updatesEnabled === false ? KEEP_SAFE_OFF : KEEP_SAFE;

    measure.font = f(800, 46);
    const nameLines = wrap(measure, data.storeName || "Your order", inner - 150).slice(0, 2);
    const rows = (data.items || []).map(it => {
      measure.font = f(700, 34);
      const lines = wrap(measure, it.name, inner - 300);
      return { it, lines, h: lines.length * 44 + 44 };
    });
    measure.font = f(800, 32);
    const safe = wrap(measure, keepSafe, inner - 56);
    const contactParts = [];
    if (data.contact && data.contact.whatsapp) contactParts.push("WhatsApp " + data.contact.whatsapp);
    if (data.contact && data.contact.phone) contactParts.push("Phone " + data.contact.phone);
    measure.font = f(600, 28);
    const contact = contactParts.length ? wrap(measure, "Seller: " + contactParts.join("  ·  "), inner) : [];
    measure.font = f(500, 28);
    const how = data.updatesEnabled === false ? [] : wrap(measure, "To see or change this order: open " + (data.retrievalUrl || "") + ", tap \"Retrieve My Order\" and type the ID above.", inner);

    let H = 230 + 40 + 150 + 30 + 56;
    rows.forEach(r => { H += r.h + 20; });
    if (data.feesAmount > 0) H += 60;
    H += 40 + 110 + 90 + 44 + 190;      // divider+total, status pill, id label, id box
    H += safe.length * 42 + 56 + 24;     // keep-safe block
    H += contact.length * 38 + (contact.length ? 16 : 0) + how.length * 38 + (how.length ? 16 : 0) + 90;

    const canvas = d.createElement("canvas");
    canvas.width = W; canvas.height = Math.ceil(H);
    const c = canvas.getContext("2d");
    c.fillStyle = "#ffffff"; c.fillRect(0, 0, W, canvas.height);
    c.fillStyle = "#16181a"; c.fillRect(0, 0, W, 230);
    const cx = PAD + 50, cy = 123;
    c.save(); c.beginPath(); c.arc(cx, cy, 50, 0, Math.PI * 2); c.closePath(); c.clip();
    if (logoImg) {
      const s = Math.max(100 / logoImg.width, 100 / logoImg.height);
      c.fillStyle = "#fff"; c.fillRect(cx - 50, cy - 50, 100, 100);
      c.drawImage(logoImg, cx - (logoImg.width * s) / 2, cy - (logoImg.height * s) / 2, logoImg.width * s, logoImg.height * s);
    } else {
      c.fillStyle = "#9bdd78"; c.fillRect(cx - 50, cy - 50, 100, 100);
      c.fillStyle = "#14210f"; c.font = f(800, 52); c.textAlign = "center"; c.textBaseline = "middle";
      c.fillText((String(data.storeName || "X").trim()[0] || "X").toUpperCase(), cx, cy + 2);
    }
    c.restore();
    c.textAlign = "left"; c.textBaseline = "alphabetic";
    c.fillStyle = "#9bdd78"; c.font = f(800, 24); c.fillText("ORDER CARD", PAD + 130, 76);
    c.fillStyle = "#ffffff"; c.font = f(800, 46);
    nameLines.forEach((ln, i) => c.fillText(ln, PAD + 130, 136 + i * 54));

    let y = 270;
    c.fillStyle = "#5f6469"; c.font = f(600, 24); c.fillText("ORDER DATE", PAD, y + 24);
    c.fillStyle = "#16181a"; c.font = f(800, 44); c.fillText(data.dateText || "", PAD, y + 80);
    c.textAlign = "right"; c.fillStyle = "#5f6469"; c.font = f(600, 24); c.fillText("PAYMENT", W - PAD, y + 24);
    const [pbg, pfg] = TONES[data.paymentTone] || ["#eceeea", "#4f555a"];
    c.font = f(700, 28);
    const pw = Math.min(inner / 2 + 60, c.measureText(data.paymentStatus || "").width + 56);
    c.fillStyle = pbg; roundRect(c, W - PAD - pw, y + 38, pw, 56, 28); c.fill();
    c.fillStyle = pfg; c.textAlign = "right"; c.fillText(data.paymentStatus || "", W - PAD - 28, y + 76); c.textAlign = "left";
    y += 150;
    c.fillStyle = "#e4e6e2"; c.fillRect(PAD, y, inner, 3); y += 30;

    c.fillStyle = "#5f6469"; c.font = f(600, 24); c.fillText("ITEMS", PAD, y + 24); y += 56;
    rows.forEach(r => {
      c.fillStyle = "#16181a"; c.font = f(700, 34);
      r.lines.forEach((ln, i) => c.fillText(ln, PAD, y + 34 + i * 44));
      c.fillStyle = "#5f6469"; c.font = f(500, 27);
      c.fillText(naira(r.it.price) + " each", PAD, y + 26 + r.lines.length * 44);
      c.textAlign = "right"; c.fillStyle = "#16181a"; c.font = f(700, 34);
      c.fillText(naira(r.it.qty * r.it.price), W - PAD, y + 34);
      c.fillStyle = "#5f6469"; c.font = f(600, 28); c.fillText("× " + r.it.qty.toLocaleString("en-NG"), W - PAD, y + 76);
      c.textAlign = "left";
      y += r.h + 20;
    });
    if (data.feesAmount > 0) {
      c.fillStyle = "#16181a"; c.font = f(600, 30); c.fillText("Delivery and fees", PAD, y + 34);
      c.textAlign = "right"; c.fillText(naira(data.feesAmount), W - PAD, y + 34); c.textAlign = "left";
      y += 60;
    }
    y += 10; c.fillStyle = "#e4e6e2"; c.fillRect(PAD, y, inner, 3); y += 30;
    c.fillStyle = "#16181a"; c.font = f(800, 40); c.fillText("Total", PAD, y + 56);
    c.textAlign = "right"; c.font = f(800, 56); c.fillText(naira(data.total), W - PAD, y + 60); c.textAlign = "left";
    y += 120;

    c.fillStyle = "#5f6469"; c.font = f(600, 24); c.fillText("PUBLIC ORDER ID", PAD, y + 24); y += 44;
    c.fillStyle = "#f4f5f2"; roundRect(c, PAD, y, inner, 150, 24); c.fill();
    c.setLineDash([14, 10]); c.lineWidth = 3; c.strokeStyle = "#8d948f"; roundRect(c, PAD + 1.5, y + 1.5, inner - 3, 147, 24); c.stroke(); c.setLineDash([]);
    const spaced = String(data.publicId || "").split("").join(" ");
    let size = 62;
    c.fillStyle = "#16181a"; c.textAlign = "center"; c.font = f(800, size, MONO);
    while (c.measureText(spaced).width > inner - 40 && size > 28) { size -= 2; c.font = f(800, size, MONO); }
    c.fillText(spaced, W / 2, y + 96); c.textAlign = "left";
    y += 150 + 40;

    // the instruction the customer must not miss
    const boxH = safe.length * 42 + 40;
    c.fillStyle = "#fff4d6"; roundRect(c, PAD, y, inner, boxH, 20); c.fill();
    c.fillStyle = "#6b4d00"; c.font = f(800, 32);
    safe.forEach((ln, i) => c.fillText(ln, PAD + 28, y + 56 + i * 42));
    y += boxH + 24;

    c.fillStyle = "#16181a"; c.font = f(600, 28);
    contact.forEach((ln, i) => c.fillText(ln, PAD, y + 28 + i * 38)); if (contact.length) y += contact.length * 38 + 16;
    c.fillStyle = "#5f6469"; c.font = f(500, 28);
    how.forEach((ln, i) => c.fillText(ln, PAD, y + 28 + i * 38)); if (how.length) y += how.length * 38 + 16;
    c.fillStyle = "#8d948f"; c.font = f(600, 24); c.textAlign = "center"; c.fillText("powered by X Redro", W / 2, y + 50);
    return canvas;
  }

  function loadLogo(url) {
    return new Promise(resolve => {
      if (!/^https?:\/\//i.test(String(url || ""))) return resolve(null);
      const img = new Image();
      img.crossOrigin = "anonymous";
      const done = v => { clearTimeout(t); resolve(v); };
      const t = setTimeout(() => done(null), 3000);
      img.onload = () => done(img);
      img.onerror = () => done(null);
      img.src = url;
    });
  }

  /* ---------- the panel shown after an order is sent, and its buttons ---------- */
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  let current = null;
  let cardPromise = null;
  const setCurrent = data => { current = data; cardPromise = null; };
  function getCanvas() {
    if (!current) return Promise.reject(new Error("No order card"));
    if (!cardPromise) cardPromise = loadLogo(current.logoUrl).then(img => renderOrderCard(current, img));
    return cardPromise;
  }

  function panelHTML(data) {
    const off = data.updatesEnabled === false;
    return `
    <section class="oc-panel" aria-labelledby="ocTitle">
      <h4 class="oc-title" id="ocTitle">Save your order card</h4>
      <div class="oc-code-box">
        <span class="oc-code-label">Public Order ID</span>
        <strong class="oc-code" id="ocCode">${esc(data.publicId)}</strong>
        <button type="button" class="oc-btn oc-btn--small" onclick="xrCopyOrderId(this)">Copy ID</button>
      </div>
      <p class="oc-warn"><strong>${esc(off ? KEEP_SAFE_OFF : KEEP_SAFE)}</strong></p>
      <img class="oc-preview" id="ocPreview" alt="Your order card" hidden>
      <div class="oc-actions">
        <button type="button" class="oc-btn oc-btn--primary" onclick="xrDownloadOrderCard(this)">Download order card</button>
        ${off ? "" : `<a class="oc-btn" href="${esc(data.retrievalUrl || "#")}">Retrieve My Order</a>`}
      </div>
      <p class="oc-hint" id="ocHint">The card is a picture you can keep in your photos or share. If the download doesn't start, press and hold the card image and choose Save.</p>
    </section>`;
  }
  async function fillPreview() {
    const img = document.getElementById("ocPreview");
    if (!img) return;
    try { const canvas = await getCanvas(); img.src = canvas.toDataURL("image/png"); img.hidden = false; } catch (e) { /* the download button still tries again */ }
  }
  async function download(btn) {
    const hint = document.getElementById("ocHint");
    if (btn) btn.disabled = true;
    try {
      const canvas = await getCanvas();
      const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
      if (!blob) throw new Error("Could not make the image");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "order-" + String(current.publicId || "card").replace(/[^A-Za-z0-9-]/g, "") + ".png";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      if (hint) hint.textContent = "Order card saved. Keep it somewhere you can find it.";
    } catch (e) {
      if (hint) hint.textContent = "The card could not be saved automatically. Take a screenshot of this page or write down your order ID.";
    } finally { if (btn) btn.disabled = false; }
  }
  async function copyId(btn) {
    const id = current && current.publicId;
    if (!id) return;
    let ok = false;
    try { await navigator.clipboard.writeText(id); ok = true; } catch (e) {
      const el = document.getElementById("ocCode");
      if (el && global.getSelection) { const r = document.createRange(); r.selectNodeContents(el); const s = global.getSelection(); s.removeAllRanges(); s.addRange(r); try { ok = document.execCommand("copy"); } catch (e2) { /* ignore */ } }
    }
    if (btn) { const t = btn.textContent; btn.textContent = ok ? "Copied" : "Press and hold the ID to copy"; setTimeout(() => { btn.textContent = t; }, 2200); }
  }

  global.XrOrderCard = { generatePublicId, randomIndex, renderOrderCard, wrap, panelHTML, setCurrent, fillPreview, download, copyId, getCanvas, KEEP_SAFE };
  global.xrDownloadOrderCard = download;
  global.xrCopyOrderId = copyId;
})(typeof window !== "undefined" ? window : globalThis);
