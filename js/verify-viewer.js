/* PDF viewer for the payment verification workspace.
   - Shows the ORIGINAL statement (PDF.js), page by page, rendered only when near the screen.
   - Column guides and match highlights are drawn in a layer on top of each page and positioned in PERCENT of the page.
     The page's PDF size never changes; only its on-screen size does. So the overlays stay exactly aligned through zoom,
     scrolling, window resizing and phone rotation without being recalculated.
   - Text boxes are read once per statement and cached. */
function createPdfViewer(scrollEl, handlers) {
  "use strict";
  const h = handlers || {};
  const pdfjs = window.pdfjsLib;
  const PAD = 12, MIN_ZOOM = 0.3, MAX_ZOOM = 4, MAX_CANVAS_PIXELS = 14e6;
  const MIN_REGION = (window.XrVerify && XrVerify.MIN_REGION) || 0.03;
  let doc = null, sizes = [], pageObjs = [], zoom = 1, fit = "width";
  let layout = null, regionsOn = false, highlights = [], observer = null, current = 1, textCache = new Map();
  const pageEls = [], renderState = new Map();   // pageNo -> { task, zoom }
  const visible = new Set();
  let pagesEl = null, resizeTimer = null, renderTimer = null;

  const el = (tag, cls, attrs) => { const e = document.createElement(tag); if (cls) e.className = cls; if (attrs) Object.keys(attrs).forEach(k => e.setAttribute(k, attrs[k])); return e; };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const REGION_LABEL = { date: "DATE", desc: "NAME / DESCRIPTION", credit: "CREDIT / AMOUNT", namedate: "NAME + DATE" };

  async function load(data, password) {
    destroy();
    const task = pdfjs.getDocument({ data, password: password || undefined });
    doc = await task.promise;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n); const vp = page.getViewport({ scale: 1 });
      pageObjs.push(page); sizes.push({ w: vp.width, h: vp.height });
    }
    buildPages();
    fitNow(fit);
    return { numPages: doc.numPages };
  }
  function destroy() {
    renderState.forEach(s => { try { s.task && s.task.cancel(); } catch (e) { /* ignore */ } });
    renderState.clear(); visible.clear(); pageEls.length = 0; pageObjs = []; sizes = []; textCache = new Map();
    if (observer) { observer.disconnect(); observer = null; }
    if (doc) { try { doc.destroy(); } catch (e) { /* ignore */ } doc = null; }
    scrollEl.replaceChildren(); pagesEl = null;
  }

  function buildPages() {
    pagesEl = el("div", "vw-pages"); scrollEl.replaceChildren(pagesEl);
    observer = new IntersectionObserver(entries => {
      entries.forEach(en => { const n = Number(en.target.dataset.page); if (en.isIntersecting) { visible.add(n); renderPage(n); } else { visible.delete(n); } });
      trimFarPages();
    }, { root: scrollEl, rootMargin: "120% 0px 120% 0px" });
    sizes.forEach((s, i) => {
      const pg = el("div", "vw-page", { "data-page": String(i + 1), "aria-label": `Statement page ${i + 1} of ${sizes.length}` });
      const canvas = el("canvas", "vw-canvas"); const layer = el("div", "vw-layer");
      const tag = el("span", "vw-pageno"); tag.textContent = `Page ${i + 1}`;
      pg.append(canvas, layer, tag); pagesEl.appendChild(pg); pageEls.push(pg); observer.observe(pg);
    });
    renderOverlays();
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    if (window.ResizeObserver) { const ro = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (fit !== "manual") fitNow(fit); }, 120); }); ro.observe(scrollEl); scrollEl._ro = ro; }
  }
  function sizePages() {
    sizes.forEach((s, i) => { const pg = pageEls[i]; pg.style.width = Math.round(s.w * zoom) + "px"; pg.style.height = Math.round(s.h * zoom) + "px"; });
  }
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => { visible.forEach(n => renderPage(n, true)); }, 140);
  }
  function fitNow(mode) {
    if (!sizes.length) return;
    const availW = Math.max(120, scrollEl.clientWidth - PAD * 2), availH = Math.max(120, scrollEl.clientHeight - PAD * 2);
    const maxW = Math.max.apply(null, sizes.map(s => s.w)), maxH = Math.max.apply(null, sizes.map(s => s.h));
    if (mode === "width") zoom = availW / maxW; else if (mode === "page") zoom = Math.min(availW / maxW, availH / maxH);
    zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM); fit = mode;
    sizePages(); scheduleRender(); h.onZoom && h.onZoom(zoom, fit);
  }
  function setZoom(z) {
    if (!sizes.length) return;
    // keep the point in the middle of the screen where it is
    const mid = scrollEl.scrollTop + scrollEl.clientHeight / 2, before = scrollEl.scrollHeight || 1;
    zoom = clamp(z, MIN_ZOOM, MAX_ZOOM); fit = "manual"; sizePages();
    scrollEl.scrollTop = (mid / before) * scrollEl.scrollHeight - scrollEl.clientHeight / 2;
    scheduleRender(); h.onZoom && h.onZoom(zoom, fit);
  }

  function renderPage(n, force) {
    const idx = n - 1, page = pageObjs[idx], pg = pageEls[idx]; if (!page || !pg) return;
    const st = renderState.get(n);
    if (st && st.zoom === zoom && !force) return;
    if (st && st.task) { try { st.task.cancel(); } catch (e) { /* ignore */ } }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let scale = zoom * dpr; const area = sizes[idx].w * sizes[idx].h * scale * scale;
    if (area > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / area);
    const vp = page.getViewport({ scale }); const canvas = pg.querySelector(".vw-canvas");
    const off = document.createElement("canvas"); off.width = Math.floor(vp.width); off.height = Math.floor(vp.height);
    const ctx = off.getContext("2d");
    pg.classList.add("is-loading");
    const task = page.render({ canvasContext: ctx, canvas: off, viewport: vp });
    renderState.set(n, { task, zoom });
    (task.promise || task).then(() => {
      canvas.width = off.width; canvas.height = off.height; canvas.getContext("2d").drawImage(off, 0, 0);
      canvas.style.width = "100%"; canvas.style.height = "100%";
      pg.classList.remove("is-loading"); pg.classList.add("is-ready"); renderState.set(n, { task: null, zoom });
      h.onPageRendered && h.onPageRendered(n);
    }).catch(err => { if (err && (err.name === "RenderingCancelledException" || /cancel/i.test(String(err.message)))) return; console.error("Page render failed:", err); pg.classList.remove("is-loading"); pg.classList.add("is-error"); });
  }
  function trimFarPages() {
    if (!visible.size) return; const lo = Math.min.apply(null, [...visible]) - 4, hi = Math.max.apply(null, [...visible]) + 4;
    pageEls.forEach((pg, i) => { const n = i + 1; if ((n < lo || n > hi) && renderState.has(n)) { const c = pg.querySelector(".vw-canvas"); c.width = 0; c.height = 0; pg.classList.remove("is-ready"); renderState.delete(n); } });
  }
  function onScroll() {
    if (onScroll.raf) return; onScroll.raf = requestAnimationFrame(() => {
      onScroll.raf = 0; const mid = scrollEl.getBoundingClientRect().top + scrollEl.clientHeight * 0.4; let best = current, bd = Infinity;
      pageEls.forEach((pg, i) => { const r = pg.getBoundingClientRect(); const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid)); if (d < bd) { bd = d; best = i + 1; } });
      if (best !== current) { current = best; h.onPage && h.onPage(current, sizes.length); }
    });
  }
  function goTo(n) {
    n = clamp(n, 1, sizes.length); const pg = pageEls[n - 1]; if (!pg) return;
    scrollEl.scrollTo({ top: pg.offsetTop - PAD, behavior: "smooth" }); current = n; h.onPage && h.onPage(n, sizes.length);
  }

  /* ---------- text boxes, read once and cached ---------- */
  async function getPageItems(n) {
    if (textCache.has(n)) return textCache.get(n);
    const page = pageObjs[n - 1], vp = page.getViewport({ scale: 1 }); const tc = await page.getTextContent(); const H = vp.height; const items = [];
    tc.items.forEach(it => {
      const text = String(it.str || ""); if (!text.trim()) return;
      const tr = pdfjs.Util.transform(vp.transform, it.transform);            // text space -> screen at scale 1 (handles rotated pages)
      const len = Math.hypot(tr[0], tr[1]) || 1, wUnits = it.width || 0;
      const x1 = tr[4], y1 = tr[5], x2 = x1 + (tr[0] / len) * wUnits, y2 = y1 + (tr[1] / len) * wUnits;
      items.push({ text, x: Math.min(x1, x2), y: H - y1, w: Math.abs(x2 - x1) || text.length * Math.hypot(tr[2], tr[3]) * 0.5, h: Math.hypot(tr[2], tr[3]) });
    });
    const out = { pageNo: n, width: vp.width, height: vp.height, items }; textCache.set(n, out); return out;
  }
  async function extractAll(onProgress) {
    const out = [];
    for (let n = 1; n <= sizes.length; n++) {
      out.push(await getPageItems(n)); if (onProgress) onProgress(n, sizes.length);
      await new Promise(r => setTimeout(r, 0));                                // let the screen breathe between pages
    }
    return out;
  }

  /* ---------- overlays (all in percent of the page) ---------- */
  const pct = v => (v * 100).toFixed(3) + "%";
  function applyRegionVars() {
    if (!pagesEl || !layout) return;
    Object.keys(layout.regions).forEach(k => { const r = layout.regions[k]; pagesEl.style.setProperty(`--r-${k}-l`, pct(r.x0)); pagesEl.style.setProperty(`--r-${k}-w`, pct(r.x1 - r.x0)); });
  }
  function renderOverlays() {
    if (!pagesEl) return;
    pageEls.forEach((pg, i) => {
      const layer = pg.querySelector(".vw-layer"); layer.replaceChildren();
      if (regionsOn && layout) Object.keys(layout.regions).forEach(k => layer.appendChild(regionEl(k)));
      highlights.filter(r => r.page === i + 1).forEach(r => layer.appendChild(highlightEl(r)));
    });
    applyRegionVars();
  }
  function regionEl(k) {
    const r = el("div", `vw-region vw-region--${k}`, { "data-key": k });
    const chip = el("button", "vw-chip", { type: "button", "data-key": k, "aria-label": `Move the ${REGION_LABEL[k]} column` }); chip.textContent = REGION_LABEL[k];
    const hl = el("div", "vw-handle vw-handle--l", { role: "slider", tabindex: "0", "data-key": k, "data-edge": "l", "aria-label": `${REGION_LABEL[k]} left edge` });
    const hr = el("div", "vw-handle vw-handle--r", { role: "slider", tabindex: "0", "data-key": k, "data-edge": "r", "aria-label": `${REGION_LABEL[k]} right edge` });
    r.append(chip, hl, hr); return r;
  }
  function highlightEl(r) {
    const pgW = r.pageWidth, pgH = r.pageHeight; const st = r.status || "unmatched";
    const b = el("button", `vw-hl vw-hl--${st}`, { type: "button", "data-row": r.id, "aria-label": `${st === "confident" ? "Confident match" : st === "review" ? "Needs review" : st === "used" ? "Already verified" : "Unmatched"} transaction: ${r.label || ""}` });
    b.style.left = pct(r.x0 / pgW); b.style.width = pct((r.x1 - r.x0) / pgW); b.style.top = pct(1 - r.yTop / pgH); b.style.height = pct((r.yTop - r.yBottom) / pgH);
    return b;
  }
  function setLayout(l, show) { layout = l; regionsOn = !!show; renderOverlays(); }
  function showRegions(show) { regionsOn = !!show; renderOverlays(); }
  function setHighlights(list) { highlights = list || []; renderOverlays(); }
  function markSelected(rowId) { pagesEl && pagesEl.querySelectorAll(".vw-hl.is-selected").forEach(b => b.classList.remove("is-selected")); if (rowId && pagesEl) { const b = pagesEl.querySelector(`.vw-hl[data-row="${rowId}"]`); if (b) b.classList.add("is-selected"); } }
  function scrollToRow(r) {
    const pg = pageEls[r.page - 1]; if (!pg) return;
    const y = pg.offsetTop + (1 - r.yTop / r.pageHeight) * pg.offsetHeight;
    scrollEl.scrollTo({ top: Math.max(0, y - scrollEl.clientHeight * 0.3), behavior: "smooth" });
  }

  /* ---------- dragging the column guides ---------- */
  let drag = null;
  function pageOf(node) { return node.closest(".vw-page"); }
  function limitsFor(key, oldR) {
    let lo = 0, hi = 1;
    Object.keys(layout.regions).forEach(k => { if (k === key) return; const o = layout.regions[k]; if (o.x1 <= oldR.x0 + 1e-6 || (o.x0 + o.x1) / 2 < (oldR.x0 + oldR.x1) / 2) lo = Math.max(lo, o.x1); else hi = Math.min(hi, o.x0); });
    return { lo, hi };
  }
  function applyDrag(dx) {
    const k = drag.key, o = drag.start, lim = drag.limits; let x0 = o.x0, x1 = o.x1;
    if (drag.mode === "l") x0 = clamp(o.x0 + dx, lim.lo, o.x1 - MIN_REGION);
    else if (drag.mode === "r") x1 = clamp(o.x1 + dx, o.x0 + MIN_REGION, lim.hi);
    else { const w = o.x1 - o.x0; x0 = clamp(o.x0 + dx, lim.lo, lim.hi - w); x1 = x0 + w; }
    layout.regions[k] = { x0, x1 }; applyRegionVars(); h.onLayoutChange && h.onLayoutChange(layout, false);
  }
  scrollEl.addEventListener("pointerdown", e => {
    const t = e.target.closest(".vw-handle, .vw-chip"); if (!t || !layout) return;
    const pg = pageOf(t); if (!pg) return; e.preventDefault();
    const key = t.dataset.key; const old = Object.assign({}, layout.regions[key]);
    drag = { key, mode: t.classList.contains("vw-chip") ? "move" : t.dataset.edge, startX: e.clientX, width: pg.getBoundingClientRect().width, start: old, limits: limitsFor(key, old), id: e.pointerId, target: t };
    try { t.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    t.classList.add("is-active"); pagesEl.classList.add("is-dragging"); h.onDragState && h.onDragState(true, key);
  });
  scrollEl.addEventListener("pointermove", e => { if (!drag || e.pointerId !== drag.id) return; applyDrag((e.clientX - drag.startX) / drag.width); });
  const endDrag = e => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    drag.target.classList.remove("is-active"); pagesEl && pagesEl.classList.remove("is-dragging"); drag = null; h.onLayoutChange && h.onLayoutChange(layout, true); h.onDragState && h.onDragState(false);
  };
  scrollEl.addEventListener("pointerup", endDrag); scrollEl.addEventListener("pointercancel", endDrag);
  scrollEl.addEventListener("keydown", e => {
    const t = e.target.closest(".vw-handle"); if (!t || !layout || !/^Arrow(Left|Right)$/.test(e.key)) return; e.preventDefault();
    const key = t.dataset.key, o = layout.regions[key]; const step = (e.shiftKey ? 0.02 : 0.005) * (e.key === "ArrowLeft" ? -1 : 1);
    drag = { key, mode: t.dataset.edge, startX: 0, width: 1, start: Object.assign({}, o), limits: limitsFor(key, o), id: -1, target: t }; applyDrag(step);
    drag = null; h.onLayoutChange && h.onLayoutChange(layout, true);
  });
  scrollEl.addEventListener("click", e => { const b = e.target.closest(".vw-hl"); if (b && h.onRowClick) h.onRowClick(b.dataset.row); });

  return {
    load, destroy, extractAll, getPageItems, setLayout, showRegions, setHighlights, markSelected, scrollToRow, goTo,
    zoomIn: () => setZoom(zoom * 1.25), zoomOut: () => setZoom(zoom / 1.25), fitWidth: () => fitNow("width"), fitPage: () => fitNow("page"),
    get numPages() { return sizes.length; }, get zoom() { return zoom; }, get fit() { return fit; }, get currentPage() { return current; },
    get layout() { return layout; }, refit: () => { if (fit !== "manual") fitNow(fit); }
  };
}
if (typeof window !== "undefined") window.createPdfViewer = createPdfViewer;
