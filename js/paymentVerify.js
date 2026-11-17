/* Payment verification workspace (the "Verify payments" button on the Orders page).
   One screen: the ORIGINAL bank statement on the left, a compact review panel on the right (a bottom sheet on phones).
   Flow: 1 upload  ->  2 select the date / description / credit columns on the PDF  ->  3 review the highlighted matches and verify.

   How it fits the existing system (unchanged on purpose):
   - Unpaid orders come from the Orders page list (status "pending"); the customer's payment name and date and the order total
     are what is compared with the statement. The customer's screenshot is shown as evidence only, it is never read for matching.
   - "Paid" is written with the same seller-session update the old screen used. Nothing is marked paid without the seller
     pressing a Confirm or Verify all button, and only unique, confident matches are included in Verify all.
   - The statement PDF stays in this browser tab's memory. It is never uploaded or stored.
   Matching rules live in js/verify-engine.js (tested), the PDF and column guides in js/verify-viewer.js.
   TEXT-BASED PDFs ONLY: the text is read straight out of the PDF by PDF.js. There is no OCR and no fallback; a PDF without enough
   embedded text is refused with a clear message and never processed. */
(function () {
  "use strict";
  const V = window.XrVerify;
  const LAYOUTS = "statement_layouts";
  const USED_KEY = "xredro-verified-tx-v2";
  const MAX_PDF_BYTES = 60 * 1024 * 1024;
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const naira = n => "₦" + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString("en-NG", { minimumFractionDigits: Number(n) % 1 ? 2 : 0 });
  const tick = () => new Promise(r => setTimeout(r, 0));
  const proofUrl = id => `https://nyc.cloud.appwrite.io/v1/storage/buckets/${PRODUCT_IMAGES_BUCKET}/files/${encodeURIComponent(id)}/view?project=695981480033c7a4eb0d`;
  const cleanId = v => String(v || "").replace(/[^A-Za-z0-9_.-]/g, "");

  let S = null;       // the whole workspace state; null when closed
  let viewer = null, root = null;

  function freshState() {
    return {
      step: 1, view: "columns", file: null, pendingBuffer: null, password: "", pages: [],
      layout: V.sanitizeLayout(V.DEFAULT_LAYOUTS.three), layoutSource: "default", savedLayouts: [], savedRemote: true, savedNote: "", activeLayoutId: "",
      dateOrder: "auto", dateTolerance: 2, orders: [], prepared: [], verifiedKeys: new Set(), used: new Set(), rejected: new Set(), forced: new Set(), manual: [],
      ex: null, rows: [], match: null, filter: "confident", sel: null, pick: null, confirmAll: false, verifying: null, failed: [],
      progress: null, error: "", notice: "", paid: new Set(), panelOpen: false, editRow: null, namingLayout: false, showRows: false
    };
  }

  /* ---------------- opening and closing (the two functions the Orders page calls) ---------------- */
  window.openVerifyOverlay = function () {
    if (!window.pdfjsLib) { showToast("The PDF reader could not be loaded. Check your connection and reload the page.", "error"); return; }
    if (root) return;
    S = freshState();
    const eligible = allOrders.filter(o => normalizedStatus(o) === "pending" && (o.paymentProof || V.paymentFields(o).name));
    S.orders = eligible; S.prepared = V.prepareOrders(eligible);
    allOrders.forEach(o => { if (o.verifiedTx) S.verifiedKeys.add(String(o.verifiedTx)); });
    try { JSON.parse(localStorage.getItem(USED_KEY) || "[]").forEach(k => S.verifiedKeys.add(k)); } catch (e) { /* none yet */ }
    root = document.createElement("div"); root.className = "vw"; root.id = "vw"; root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "true"); root.setAttribute("aria-labelledby", "vwTitle");
    root.innerHTML = shellHTML();
    document.body.appendChild(root); document.body.classList.add("vw-open");
    viewer = createPdfViewer(root.querySelector("#vwScroll"), {
      onPage: (n, t) => { S.pageNow = n; setText("#vwPageNow", n); setText("#vwPageTotal", t); },
      onZoom: z => setText("#vwZoom", Math.round(z * 100) + "%"),
      onLayoutChange: (l, commit) => { S.layout = l; S.layoutSource = commit ? "manual" : S.layoutSource; if (commit) { S.activeLayoutNote = ""; renderPanel(); } },
      onRowClick: id => onRowClick(id)
    });
    root.addEventListener("click", onClick); root.addEventListener("change", onChange); root.addEventListener("input", onInput);
    document.addEventListener("keydown", onKey);
    loadSavedLayouts();
    render();
    root.querySelector(".vw-close").focus();
  };
  window.closeVerifyOverlay = function () {
    if (!root) return;
    if (S && S.verifying && S.verifying.running) { showToast("Please wait until verification finishes.", "warning"); return; }
    document.removeEventListener("keydown", onKey);
    try { viewer.destroy(); } catch (e) { /* ignore */ }
    root.remove(); root = null; viewer = null; S = null; document.body.classList.remove("vw-open");
    if (typeof applyFilter === "function") applyFilter();
  };
  function onKey(e) { if (e.key === "Escape" && root) { const lb = root.querySelector(".vw-lightbox"); if (lb) lb.remove(); else window.closeVerifyOverlay(); } }
  const setText = (sel, v) => { const e = root && root.querySelector(sel); if (e) e.textContent = v; };

  /* ---------------- shell ---------------- */
  function shellHTML() {
    return `
    <header class="vw-top">
      <div class="vw-top__row">
        <div class="vw-top__title"><h2 id="vwTitle">Verify payments</h2><p class="vw-file" id="vwFile"></p></div>
        <button type="button" class="xr-btn xr-btn--secondary xr-btn--sm vw-close" data-act="close">Close</button>
      </div>
      <ol class="vw-steps" id="vwSteps" aria-label="Progress"></ol>
    </header>
    <div class="vw-body">
      <section class="vw-doc" aria-label="Bank statement">
        <div class="vw-toolbar" role="toolbar" aria-label="Statement view">
          <div class="vw-tb-group"><button type="button" class="vw-tb" data-act="prev" aria-label="Previous page">‹</button><span class="vw-pagectl"><span id="vwPageNow">0</span> / <span id="vwPageTotal">0</span></span><button type="button" class="vw-tb" data-act="next" aria-label="Next page">›</button></div>
          <div class="vw-tb-group"><button type="button" class="vw-tb" data-act="zoomout" aria-label="Zoom out">−</button><span class="vw-zoom" id="vwZoom">100%</span><button type="button" class="vw-tb" data-act="zoomin" aria-label="Zoom in">+</button></div>
          <div class="vw-tb-group"><button type="button" class="vw-tb vw-tb--text" data-act="fitwidth">Fit width</button><button type="button" class="vw-tb vw-tb--text" data-act="fitpage">Fit page</button><button type="button" class="vw-tb vw-tb--text" data-act="fullscreen" id="vwFull">Full screen</button></div>
        </div>
        <div class="vw-stage">
          <div class="vw-scroll" id="vwScroll" tabindex="0"></div>
          <div class="vw-cover" id="vwCover"></div>
          <div class="vw-banner" id="vwBanner" role="status" aria-live="polite" hidden></div>
        </div>
      </section>
      <aside class="vw-panel" id="vwPanel" aria-label="Matching and review">
        <button type="button" class="vw-panel__head" data-act="sheet" aria-expanded="true"><span class="vw-grip" aria-hidden="true"></span><span class="vw-panel__title" id="vwPanelTitle"></span><span class="vw-panel__sum" id="vwPanelSum"></span></button>
        <div class="vw-panel__body" id="vwPanelBody"></div>
        <div class="vw-panel__foot" id="vwPanelFoot"></div>
      </aside>
    </div>`;
  }

  /* ---------------- rendering ---------------- */
  function render() { renderSteps(); renderCover(); renderPanel(); renderBanner(); }
  function renderSteps() {
    const loaded = !!S.file && S.pages.length > 0;
    const state = [loaded ? "done" : "current", !loaded ? "todo" : (S.step >= 3 ? "done" : "current"), S.step >= 3 ? "current" : "todo"];
    const labels = ["Statement uploaded", "Select transaction columns", "Review and verify matches"];
    root.querySelector("#vwSteps").innerHTML = labels.map((l, i) => {
      const clickable = (i === 1 && loaded && S.step === 3) ? ' data-act="to-columns" role="button" tabindex="0"' : "";
      return `<li class="vw-step vw-step--${state[i]}"${state[i] === "current" ? ' aria-current="step"' : ""}${clickable}><span class="vw-step__dot">${state[i] === "done" ? "✓" : i + 1}</span><span class="vw-step__txt">${l}${i === 0 && S.file ? `<small>${esc(S.file.name)}</small>` : ""}</span></li>`;
    }).join("");
    root.querySelector("#vwFile").textContent = S.file ? `${S.file.name} · ${S.pages.length || "…"} page${S.pages.length === 1 ? "" : "s"}` : `${S.orders.length} unpaid order${S.orders.length === 1 ? "" : "s"} to check`;
  }
  function renderCover() {
    const cover = root.querySelector("#vwCover"); const scroll = root.querySelector("#vwScroll");
    scroll.classList.toggle("is-empty", !S.pages.length);
    if (S.progress) {
      cover.hidden = false; cover.className = "vw-cover vw-cover--busy";
      cover.innerHTML = `<div class="vw-progress"><div class="vw-spinner" aria-hidden="true"></div><p class="vw-progress__msg">${esc(S.progress.msg)}</p>${S.progress.frac != null ? `<div class="vw-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(S.progress.frac * 100)}"><span style="width:${Math.round(S.progress.frac * 100)}%"></span></div>` : ""}</div>`;
    } else if (!S.pages.length) {
      cover.hidden = false; cover.className = "vw-cover";
      cover.innerHTML = S.needPassword ? passwordHTML() : uploadHTML();
    } else { cover.hidden = true; cover.innerHTML = ""; }
  }
  function uploadHTML() {
    const none = !S.orders.length;
    return `<div class="vw-upload" id="vwDrop">
      <div class="vw-upload__icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 17v-6"/><path d="m9.5 13.5 2.5-2.5 2.5 2.5"/></svg></div>
      <h3>Upload your bank statement</h3>
      <p>Upload your bank statement to automatically match customer payments with their orders.</p>
      <div class="xr-alert xr-alert--info vw-notice" role="note"><div><span class="xr-alert__title">Text-based PDFs only</span>Only text-based PDF bank statements are supported. Your statement must contain selectable, extractable text. Scanned documents, photographs saved as PDFs and image-only PDFs are not supported.</div></div>
      ${S.error ? `<div class="xr-alert xr-alert--error" role="alert"><div>${esc(S.error)}</div></div>` : ""}
      ${none ? `<div class="xr-alert xr-alert--warning"><div>There are no unpaid orders waiting for payment verification right now. You can still look through a statement, but nothing will match.</div></div>` : ""}
      <label class="xr-btn xr-btn--primary vw-pick"><input type="file" id="vwFileInput" accept="application/pdf,.pdf" hidden>Choose PDF statement</label>
      <p class="vw-hint">or drop the PDF here. It stays on your device and is never uploaded.</p>
    </div>`;
  }
  function passwordHTML() {
    return `<div class="vw-upload"><h3>This statement is password protected</h3><p>Type the password your bank gave you. It is used only to open the file on your device.</p>
      ${S.error ? `<div class="xr-alert xr-alert--error" role="alert"><div>${esc(S.error)}</div></div>` : ""}
      <div class="xr-field vw-pw"><label class="xr-label" for="vwPw">PDF password</label><input class="xr-input" id="vwPw" type="password" autocomplete="off"></div>
      <div class="vw-row"><button type="button" class="xr-btn xr-btn--primary" data-act="unlock">Open statement</button><button type="button" class="xr-btn xr-btn--secondary" data-act="cancel-pw">Choose another file</button></div></div>`;
  }
  function renderBanner() {
    const b = root.querySelector("#vwBanner"); let msg = "";
    if (S.pick) { const o = S.prepared.find(x => x.id === S.pick); msg = `Tap the transaction on the statement that paid for ${esc(o ? o.customer : "this order")}. <button type="button" class="vw-link" data-act="cancel-pick">Cancel</button>`; }
    else if (S.notice) msg = esc(S.notice);
    b.hidden = !msg; b.innerHTML = msg;
  }
  function progress(msg, frac) { S.progress = msg ? { msg, frac: frac == null ? null : frac } : null; renderCover(); renderPanelChrome(); }

  /* ---------------- the review panel ---------------- */
  function renderPanel() {
    renderPanelChrome();
    const body = root.querySelector("#vwPanelBody"), foot = root.querySelector("#vwPanelFoot");
    let v;
    if (!S.pages.length) v = viewIdle();
    else if (S.step === 2) v = viewColumns();
    else if (S.view === "txn") v = viewTxn();
    else if (S.view === "order") v = viewOrder();
    else if (S.view === "rows") v = viewRows();
    else v = viewResults();
    body.innerHTML = v.body; foot.innerHTML = v.foot || ""; foot.hidden = !v.foot;
    root.querySelector("#vwPanel").classList.toggle("has-foot", !!v.foot);
  }
  function renderPanelChrome() {
    const panel = root.querySelector("#vwPanel");
    const open = S.panelOpen || S.view === "txn" && S.step === 3;
    panel.classList.toggle("is-open", open); root.querySelector(".vw-panel__head").setAttribute("aria-expanded", String(open));
    const title = !S.pages.length ? "Get started" : S.step === 2 ? "Select columns" : S.view === "txn" ? "Transaction review" : S.view === "order" ? "Order" : S.view === "rows" ? "Extracted transactions" : "Results";
    setText("#vwPanelTitle", title);
    const m = S.match; setText("#vwPanelSum", S.step === 3 && m && S.view !== "txn" ? `${m.summary.confident} confident · ${m.summary.review} to review` : S.step === 2 && S.pages.length ? "Drag the coloured guides over the columns" : "");
  }
  function viewIdle() {
    return { body: `<div class="vw-tip"><h3>How it works</h3><ol class="vw-how"><li>Upload your bank statement PDF.</li><li>Place the three coloured guides over the date, description and credit columns.</li><li>Press <b>Match payments</b>. Matches light up on the statement.</li><li>Check the yellow ones, then verify the green ones together.</li></ol>
      <p class="vw-hint">Only text-based PDF statements can be read. ${S.orders.length} unpaid order${S.orders.length === 1 ? "" : "s"} will be checked. Customer screenshots stay available as evidence.</p></div>` };
  }

  const REGION_META = { date: ["DATE", "vw-dot--date"], desc: ["NAME / DESCRIPTION", "vw-dot--desc"], credit: ["CREDIT / AMOUNT", "vw-dot--credit"], namedate: ["NAME + DATE", "vw-dot--desc"] };
  function viewColumns() {
    const keys = V.REGION_KEYS[S.layout.mode];
    const saved = S.savedLayouts;
    const body = `
      <h3 class="vw-h">Select the transaction columns</h3>
      <p class="vw-lead">Select the date, transaction description and credit amount columns. Drag the guides on the statement so each covers its column.</p>
      ${S.layoutSource === "guess" ? `<p class="vw-note">✓ We placed the guides from the headings in your statement. Please check them.</p>` : S.layoutSource === "saved" ? `<p class="vw-note">✓ Saved layout applied. You can still adjust the guides.</p>` : ""}
      <div class="vw-seg" role="radiogroup" aria-label="Column layout">
        <button type="button" role="radio" aria-checked="${S.layout.mode === "three"}" class="${S.layout.mode === "three" ? "is-on" : ""}" data-act="mode" data-mode="three">Date, description and credit</button>
        <button type="button" role="radio" aria-checked="${S.layout.mode === "two"}" class="${S.layout.mode === "two" ? "is-on" : ""}" data-act="mode" data-mode="two">Name + date together, and credit</button>
      </div>
      <ul class="vw-regions">${keys.map(k => `<li><span class="vw-dot ${REGION_META[k][1]}"></span><span class="vw-regions__name">${REGION_META[k][0]}</span>
        <span class="vw-nudge"><button type="button" class="vw-tb" data-act="nudge" data-key="${k}" data-d="-0.01" aria-label="Move ${REGION_META[k][0]} left">◀</button><button type="button" class="vw-tb" data-act="nudge" data-key="${k}" data-d="0.01" aria-label="Move ${REGION_META[k][0]} right">▶</button></span></li>`).join("")}</ul>
      <details class="vw-opts"><summary>Options</summary>
        <div class="xr-field"><label class="xr-label" for="vwOrder">Date format on this statement</label><select class="xr-select" id="vwOrder"><option value="auto" ${S.dateOrder === "auto" ? "selected" : ""}>Work it out from the statement</option><option value="dmy" ${S.dateOrder === "dmy" ? "selected" : ""}>Day first (10/11/2026 is 10 November)</option><option value="mdy" ${S.dateOrder === "mdy" ? "selected" : ""}>Month first (10/11/2026 is 11 October)</option></select></div>
        <div class="xr-field"><label class="xr-label" for="vwTol">Dates may differ by up to</label><select class="xr-select" id="vwTol">${[0, 1, 2, 3, 5, 7].map(n => `<option value="${n}" ${S.dateTolerance === n ? "selected" : ""}>${n} day${n === 1 ? "" : "s"} (those matches are sent for review)</option>`).join("")}</select></div>
      </details>
      <div class="vw-saved"><h4>Saved layouts</h4>
        ${saved.length ? `<div class="vw-row"><select class="xr-select" id="vwLayoutSel" aria-label="Saved layouts"><option value="">Choose a saved layout…</option>${saved.map(l => `<option value="${esc(l.id)}" ${S.activeLayoutId === l.id ? "selected" : ""}>${esc(l.name)}</option>`).join("")}</select></div>
        <div class="vw-row"><button type="button" class="xr-btn xr-btn--secondary xr-btn--sm" data-act="layout-apply" ${S.activeLayoutId ? "" : "disabled"}>Apply</button><button type="button" class="xr-btn xr-btn--secondary xr-btn--sm" data-act="layout-update" ${S.activeLayoutId ? "" : "disabled"}>Update with current guides</button><button type="button" class="xr-btn xr-btn--ghost xr-btn--sm vw-danger" data-act="layout-delete" ${S.activeLayoutId ? "" : "disabled"}>Delete</button></div>` : `<p class="vw-hint">Same bank every day? Save the guides once and reuse them.</p>`}
        ${S.namingLayout ? `<div class="vw-row"><input class="xr-input" id="vwLayoutName" type="text" maxlength="60" placeholder="Name, for example GTBank current account" aria-label="Layout name"><button type="button" class="xr-btn xr-btn--primary xr-btn--sm" data-act="layout-save">Save</button><button type="button" class="xr-btn xr-btn--ghost xr-btn--sm" data-act="layout-cancel">Cancel</button></div>` : `<button type="button" class="xr-btn xr-btn--secondary xr-btn--sm" data-act="layout-name">Save these guides as a layout</button>`}
        ${S.savedNote ? `<p class="vw-hint">${esc(S.savedNote)}</p>` : ""}
      </div>
      ${S.error ? `<div class="xr-alert xr-alert--error" role="alert"><div>${esc(S.error)}</div></div>` : ""}`;
    return { body, foot: `<button type="button" class="xr-btn xr-btn--primary xr-btn--block" data-act="match" ${S.progress ? "disabled" : ""}>Match payments</button>` };
  }

  /* ---- results ---- */
  function viewResults() {
    const m = S.match; if (!m) return { body: `<p class="vw-lead">Press Match payments to begin.</p>` };
    const sm = m.summary;
    const plan = V.verifyAllPlan(m);
    const cards = [["Unpaid orders checked", sm.ordersChecked, ""], ["Transactions extracted", sm.transactions, ""], ["Confident matches", sm.confident, "ok"], ["Need review", sm.review, "warn"], ["Orders with no match", sm.unmatchedOrders, ""], ["Unused transactions", sm.unusedTransactions, ""]];
    let confirm = "";
    if (S.verifying && (S.verifying.running || S.verifying.done)) {
      const v = S.verifying;
      confirm = `<div class="vw-box" role="status" aria-live="polite">${v.running ? `<p><b>Verifying ${v.index} of ${v.total}…</b></p><div class="vw-bar"><span style="width:${Math.round(v.index / v.total * 100)}%"></span></div>` : `<p><b>${v.ok.length} order${v.ok.length === 1 ? "" : "s"} marked as paid.</b>${v.failed.length ? ` ${v.failed.length} could not be verified and stayed unpaid.` : ""}</p>`}
        ${v.failed.length ? `<ul class="vw-fails">${v.failed.map(f => `<li><b>${esc(f.name)}</b>: ${esc(f.reason)}</li>`).join("")}</ul>${v.running ? "" : `<button type="button" class="xr-btn xr-btn--secondary xr-btn--sm" data-act="retry-failed">Try the failed ones again</button>`}` : ""}</div>`;
    } else if (S.confirmAll) {
      confirm = `<div class="vw-box vw-box--confirm"><p><b>${plan.length} order${plan.length === 1 ? " is" : "s are"} ready for verification.</b></p>
        <p>${sm.review} order${sm.review === 1 ? " requires" : "s require"} manual review.</p><p>${sm.unmatchedOrders} order${sm.unmatchedOrders === 1 ? " has" : "s have"} no matching transaction.</p>
        <p class="vw-hint">Only confident, unique matches are included. Each order is checked again just before it is marked paid.</p>
        <div class="vw-row"><button type="button" class="xr-btn xr-btn--primary" data-act="verify-confirm">Mark ${plan.length} order${plan.length === 1 ? "" : "s"} as paid</button><button type="button" class="xr-btn xr-btn--secondary" data-act="verify-cancel">Cancel</button></div></div>`;
    }
    const dateNote = S.ex && S.ex.dateOrder === "unknown" && S.dateOrder === "auto" && S.rows.some(r => r.date && r.date.ambiguous)
      ? `<div class="xr-alert xr-alert--warning"><div>Some dates, like ${esc((S.rows.find(r => r.date && r.date.ambiguous) || {}).dateText || "")}, can be read two ways. Those matches wait for your review. If this statement writes the day first, <button type="button" class="vw-link" data-act="set-dmy">set day first</button>.</div></div>` : "";
    const tabs = [["confident", "Confident", sm.confident], ["review", "Review", sm.review], ["nomatch", "No match", sm.unmatchedOrders], ["rows", "All transactions", sm.transactions]];
    const body = `
      <p class="vw-lead">${S.progress ? "" : "Your statement has been analysed. Review the highlighted transactions below."}</p>
      <div class="vw-cards">${cards.map(c => `<div class="vw-stat ${c[2] ? "vw-stat--" + c[2] : ""}"><strong>${c[1]}</strong><span>${c[0]}</span></div>`).join("")}</div>
      ${sm.alreadyUsedTransactions ? `<p class="vw-hint">${sm.alreadyUsedTransactions} transaction${sm.alreadyUsedTransactions === 1 ? " was" : "s were"} already used to verify orders and ${sm.alreadyUsedTransactions === 1 ? "is" : "are"} skipped.</p>` : ""}
      ${(S.ex && S.ex.warnings || []).map(w => `<div class="xr-alert xr-alert--warning"><div>${esc(w)}</div></div>`).join("")}
      ${dateNote}${confirm}
      <div class="vw-tabs" role="tablist">${tabs.map(t => `<button type="button" role="tab" aria-selected="${S.filter === t[0]}" class="${S.filter === t[0] ? "is-on" : ""}" data-act="filter" data-f="${t[0]}">${t[1]} <span>${t[2]}</span></button>`).join("")}</div>
      <ul class="vw-list">${listItems(m)}</ul>`;
    const busy = S.verifying && S.verifying.running;
    const foot = `<button type="button" class="xr-btn xr-btn--primary xr-btn--block" data-act="verify-all" ${plan.length && !busy && !S.confirmAll ? "" : "disabled"}>Verify all${plan.length ? ` (${plan.length})` : ""}</button>
      <button type="button" class="xr-btn xr-btn--secondary xr-btn--block" data-act="to-columns">Adjust columns</button>`;
    return { body, foot };
  }
  const rowOf = id => S.rows.find(r => r.id === id);
  const prepOf = id => S.prepared.find(o => o.id === id);
  function chip(status) { const t = { confident: ["Confident match", "ok"], review: ["Needs review", "warn"], unmatched: ["No match", "none"], used: ["Already verified", "none"] }[status] || ["", "none"]; return `<span class="vw-tag vw-tag--${t[1]}">${t[0]}</span>`; }
  function listItems(m) {
    const out = [];
    if (S.filter === "confident" || S.filter === "review") {
      const seen = new Set();
      m.pairs.filter(p => p.status === S.filter).forEach(p => { if (seen.has(p.orderId)) return; if (S.filter === "review") { const best = m.orderStatus.get(p.orderId).best; if (best !== p) return; } seen.add(p.orderId);
        const o = prepOf(p.orderId), r = rowOf(p.rowId);
        out.push(`<li><button type="button" class="vw-item" data-act="open-txn" data-row="${esc(r.id)}" data-order="${esc(o.id)}"><span class="vw-item__main"><b>${esc(o.customer)}</b><small>${esc(r.description || r.descText)} · ${esc(r.date ? r.date.iso : r.dateText || "no date")} · page ${r.page}</small></span><span class="vw-item__side"><b>${naira(r.amount)}</b>${chip(p.status)}</span></button></li>`); });
    } else if (S.filter === "nomatch") {
      S.prepared.filter(o => m.orderStatus.get(o.id).status === "unmatched").forEach(o => out.push(`<li><button type="button" class="vw-item" data-act="open-order" data-order="${esc(o.id)}"><span class="vw-item__main"><b>${esc(o.customer)}</b><small>Paid as “${esc(o.name || "—")}” · ${esc(o.date ? o.date.iso : "no date")}</small></span><span class="vw-item__side"><b>${o.total == null ? "—" : naira(o.total)}</b>${chip("unmatched")}</span></button></li>`));
    } else {
      S.rows.forEach(r => { const st = m.rowStatus.get(r.id).status; out.push(`<li><button type="button" class="vw-item" data-act="open-txn" data-row="${esc(r.id)}"><span class="vw-item__main"><b>${esc(r.description || r.descText || "(no description)")}</b><small>${esc(r.date ? r.date.iso : r.dateText || "no date")} · page ${r.page}${r.edited ? " · corrected" : ""}</small></span><span class="vw-item__side"><b>${naira(r.amount)}</b>${chip(st)}</span></button></li>`); });
    }
    if (!out.length) return `<li class="vw-empty">${{ confident: "No confident matches yet.", review: "Nothing needs review.", nomatch: "Every order has a possible transaction.", rows: "No transactions were read." }[S.filter]}</li>`;
    return out.join("");
  }
  function viewRows() { return { body: `<p>…</p>` }; }

  /* ---- one transaction compared with its order ---- */
  function markName(desc, customerName) {
    const want = V.nameTokens(customerName);
    return String(desc || "").split(/(\s+)/).map(w => { const t = V.normText(w); return t && want.some(x => V.tokenMatches(x, t)) ? `<mark>${esc(w)}</mark>` : esc(w); }).join("");
  }
  function cmpLine(label, ok, left, right, note) {
    const sym = ok === true ? "✓" : ok === "warn" ? "!" : "✕";
    return `<div class="vw-cmp__row vw-cmp__row--${ok === true ? "ok" : ok === "warn" ? "warn" : "no"}"><span class="vw-cmp__sym" aria-hidden="true">${sym}</span><div><b>${label}</b><div class="vw-cmp__vals"><span><small>Bank statement</small>${left}</span><span><small>Customer / order</small>${right}</span></div>${note ? `<p class="vw-cmp__note">${esc(note)}</p>` : ""}</div></div>`;
  }
  function viewTxn() {
    const sel = S.sel || {}; const row = rowOf(sel.rowId); if (!row) { S.view = "results"; return viewResults(); }
    const st = S.match.rowStatus.get(row.id); const pairs = st.pairs || [];
    const pair = pairs.find(p => p.orderId === sel.orderId) || pairs[0] || null; const order = pair ? prepOf(pair.orderId) : null;
    const back = `<button type="button" class="vw-back" data-act="back">‹ Back to results</button>`;
    const bankCard = `<section class="vw-card vw-card--bank"><h4>Bank statement transaction</h4><dl class="vw-dl">
      <dt>Date</dt><dd>${esc(row.dateText || "Not read")}${row.date ? ` <small>(${esc(row.date.iso)}${row.date.ambiguous ? ", or " + esc(row.date.altIso) : ""})</small>` : ""}</dd>
      <dt>Name / description</dt><dd>${order ? markName(row.description || row.descText, order.name) : esc(row.description || row.descText || "Not read")}</dd>
      <dt>Amount credited</dt><dd><b>${naira(row.amount)}</b></dd><dt>Statement page</dt><dd>${row.page}</dd>
      ${row.reference ? `<dt>Reference</dt><dd class="vw-mono">${esc(row.reference)}</dd>` : ""}</dl>
      <p class="vw-hint"><button type="button" class="vw-link" data-act="edit-row" data-row="${esc(row.id)}">Correct what was read</button></p></section>`;
    if (S.editRow === row.id) return { body: back + bankCard + editRowHTML(row), foot: "" };
    if (!order) {
      const same = S.prepared.filter(o => o.cents === row.cents && !S.match.confidentPairs.some(p => p.orderId === o.id));
      const near = S.prepared.filter(o => o.cents !== row.cents && o.cents != null).sort((a, b) => Math.abs(a.cents - row.cents) - Math.abs(b.cents - row.cents)).slice(0, 3);
      const stt = st.status === "used" ? st.reason : "No unpaid order matches this transaction.";
      return { body: `${back}${bankCard}<section class="vw-card"><h4>X-Redro order</h4><p>${esc(stt)}</p>${st.status === "used" ? "" : `<p class="vw-hint">Know which order it is? Choose it below. You will still confirm it yourself.</p>
        <ul class="vw-list">${same.concat(near).map(o => `<li><button type="button" class="vw-item" data-act="assign" data-row="${esc(row.id)}" data-order="${esc(o.id)}"><span class="vw-item__main"><b>${esc(o.customer)}</b><small>Paid as “${esc(o.name || "—")}” · ${esc(o.date ? o.date.iso : "no date")}</small></span><span class="vw-item__side"><b>${naira(o.total)}</b></span></button></li>`).join("") || `<li class="vw-empty">No unpaid orders.</li>`}</ul>`}</section>`, foot: "" };
    }
    const alt = pairs.length > 1 ? `<div class="vw-alts"><p class="vw-hint">${pairs.length} orders could match this transaction:</p><div class="vw-chips">${pairs.map(p => { const o = prepOf(p.orderId); return `<button type="button" class="vw-pill ${p === pair ? "is-on" : ""}" data-act="open-txn" data-row="${esc(row.id)}" data-order="${esc(o.id)}">${esc(o.customer)}</button>`; }).join("")}</div></div>` : "";
    const nm = pair.name, dt = pair.date; const diffDays = dt.diff;
    const cmp = `<section class="vw-card vw-card--order"><h4>X-Redro order</h4>
      <dl class="vw-dl"><dt>Customer</dt><dd>${esc(order.customer)}</dd><dt>Order</dt><dd class="vw-mono">${esc(order.ref || order.id.slice(-8).toUpperCase())}</dd>
      <dt>Payment name given</dt><dd>${esc(order.name || "Not given")}</dd><dt>Payment date given</dt><dd>${esc(order.date ? order.date.iso : order.dateText || "Not given")}</dd>
      <dt>Order total</dt><dd><b>${naira(order.total)}</b></dd><dt>Payment status</dt><dd><span class="xr-badge xr-badge--unpaid xr-badge--dot">Unpaid</span></dd></dl>
      ${order.proof ? `<button type="button" class="vw-shot" data-act="lightbox" data-id="${esc(cleanId(order.proof))}" aria-label="View the customer's payment screenshot full size"><img src="${esc(proofUrl(order.proof))}" alt="Customer payment screenshot" loading="lazy"><span>Customer screenshot (evidence). Tap to enlarge.</span></button>` : `<p class="vw-hint">The customer did not upload a screenshot.</p>`}</section>`;
    const diffs = `<section class="vw-card"><h4>Do they agree?</h4>
      ${cmpLine("Amount", true, naira(row.amount), naira(order.total), "The credited amount equals the order total.")}
      ${cmpLine("Name", nm.tier === "strong" || nm.tier === "good" || nm.tier === "single" ? true : nm.tier === "weak" ? "warn" : false, markName(row.description || row.descText, order.name), esc(order.name || "Not given"), nm.tier === "strong" ? "Every word of the payment name is in the description." : nm.tier === "good" ? "Most of the payment name is in the description." : nm.tier === "single" ? "The payment name is in the description." : nm.tier === "weak" ? "Only part of the payment name is in the description." : "The payment name is not in the description.")}
      ${cmpLine("Date", dt.state === "exact" ? true : dt.state === "far" || dt.state === "unknown" ? false : "warn", esc(row.dateText || "Not read"), esc(order.date ? order.date.iso : order.dateText || "Not given"), dt.label)}
      ${pair.problems.length ? `<ul class="vw-prob">${pair.problems.filter(x => !/^(The bank date|The statement date|The payment name|Only part)/.test(x)).map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</section>`;
    const forced = S.forced.has(V.pairKey(order.id, row.id));
    const foot = `<div class="vw-actions">
      <button type="button" class="xr-btn xr-btn--primary" data-act="confirm-one" data-row="${esc(row.id)}" data-order="${esc(order.id)}" ${S.verifying && S.verifying.running ? "disabled" : ""}>Confirm this match</button>
      <button type="button" class="xr-btn xr-btn--secondary" data-act="mark-review" data-row="${esc(row.id)}" data-order="${esc(order.id)}" ${forced ? "disabled" : ""}>${forced ? "Marked for review" : "Mark for manual review"}</button>
      <button type="button" class="xr-btn xr-btn--secondary vw-danger" data-act="reject" data-row="${esc(row.id)}" data-order="${esc(order.id)}">Reject this match</button>
      <button type="button" class="xr-btn xr-btn--ghost" data-act="view-order" data-order="${esc(order.id)}">View full order</button></div>`;
    return { body: back + `<div class="vw-status">${chip(pair.status)}</div>` + alt + bankCard + cmp + diffs, foot };
  }
  function editRowHTML(row) {
    return `<section class="vw-card"><h4>Correct what was read</h4><p class="vw-hint">Fix anything the reader got wrong. Only this transaction changes.</p>
      <div class="xr-field"><label class="xr-label" for="vwEdDate">Date</label><input class="xr-input" id="vwEdDate" value="${esc(row.dateText)}"></div>
      <div class="xr-field"><label class="xr-label" for="vwEdDesc">Name / description</label><input class="xr-input" id="vwEdDesc" value="${esc(row.description)}"></div>
      <div class="xr-field"><label class="xr-label" for="vwEdAmt">Amount credited</label><input class="xr-input" id="vwEdAmt" inputmode="decimal" value="${esc(row.amount)}"></div>
      <div class="vw-row"><button type="button" class="xr-btn xr-btn--primary" data-act="save-row" data-row="${esc(row.id)}">Save</button><button type="button" class="xr-btn xr-btn--secondary" data-act="cancel-row">Cancel</button></div></section>`;
  }
  function viewOrder() {
    const o = prepOf(S.sel && S.sel.orderId); if (!o) { S.view = "results"; return viewResults(); }
    return { body: `<button type="button" class="vw-back" data-act="back">‹ Back to results</button><section class="vw-card vw-card--order"><h4>X-Redro order</h4>
      <dl class="vw-dl"><dt>Customer</dt><dd>${esc(o.customer)}</dd><dt>Payment name given</dt><dd>${esc(o.name || "Not given")}</dd><dt>Payment date given</dt><dd>${esc(o.date ? o.date.iso : o.dateText || "Not given")}</dd><dt>Order total</dt><dd><b>${o.total == null ? "—" : naira(o.total)}</b></dd></dl>
      ${o.proof ? `<button type="button" class="vw-shot" data-act="lightbox" data-id="${esc(cleanId(o.proof))}"><img src="${esc(proofUrl(o.proof))}" alt="Customer payment screenshot" loading="lazy"><span>Customer screenshot (evidence). Tap to enlarge.</span></button>` : ""}</section>
      <section class="vw-card"><h4>No matching transaction found</h4><p>Nothing on this statement is a credit of ${o.total == null ? "this amount" : naira(o.total)} that fits the name or date. The customer may not have paid yet, or paid from another statement.</p>
      <button type="button" class="xr-btn xr-btn--secondary" data-act="pick" data-order="${esc(o.id)}">Find it on the statement myself</button></section>`,
      foot: `<button type="button" class="xr-btn xr-btn--ghost xr-btn--block" data-act="view-order" data-order="${esc(o.id)}">View full order</button>` };
  }

  /* ---------------- saved layouts ---------------- */
  const localKey = () => "xredro-layouts-" + (user ? user.$id : "x");
  const localLayouts = () => { try { return JSON.parse(localStorage.getItem(localKey()) || "[]"); } catch (e) { return []; } };
  const writeLocal = list => { try { localStorage.setItem(localKey(), JSON.stringify(list)); } catch (e) { /* storage full or blocked */ } };
  async function loadSavedLayouts() {
    try {
      const r = await databases.listDocuments(DB_ID, LAYOUTS, [Query.equal("userId", user.$id), Query.limit(50)]);
      S.savedLayouts = r.documents.map(d => { let regions = {}; try { regions = JSON.parse(d.regions); } catch (e) { /* skip */ } return { id: d.$id, name: d.name, mode: d.mode, regions }; }); S.savedRemote = true;
    } catch (e) { S.savedLayouts = localLayouts(); S.savedRemote = false; S.savedNote = S.savedLayouts.length ? "Layouts are kept on this device only." : ""; }
    if (root && S) renderPanel();
  }
  async function saveLayout(name, existingId) {
    const lay = V.sanitizeLayout(S.layout); const rec = { name: name.trim().slice(0, 60), mode: lay.mode, regions: lay.regions };
    if (!rec.name) { showToast("Give the layout a name.", "warning"); return; }
    const local = () => { const list = localLayouts(); if (existingId && existingId.startsWith("local-")) { const i = list.findIndex(x => x.id === existingId); if (i >= 0) list[i] = Object.assign(list[i], rec); } else list.push(Object.assign({ id: "local-" + Date.now().toString(36) }, rec)); writeLocal(list); S.savedLayouts = list; S.savedRemote = false; S.savedNote = "Saved on this device only (the shared layouts table is not set up yet)."; };
    try {
      if (!S.savedRemote && !existingId) throw new Error("local");
      const me = Appwrite.Role.user(user.$id);
      if (existingId && !existingId.startsWith("local-")) await databases.updateDocument(DB_ID, LAYOUTS, existingId, { name: rec.name, mode: rec.mode, regions: JSON.stringify(rec.regions), updatedAt: new Date().toISOString() });
      else { const d = await databases.createDocument(DB_ID, LAYOUTS, Appwrite.ID.unique(), { userId: user.$id, name: rec.name, mode: rec.mode, regions: JSON.stringify(rec.regions), updatedAt: new Date().toISOString() }, [Appwrite.Permission.read(me), Appwrite.Permission.update(me), Appwrite.Permission.delete(me)]); existingId = d.$id; }
      await loadSavedLayouts(); S.savedNote = "";
    } catch (e) { local(); }
    S.namingLayout = false; S.activeLayoutId = existingId || (S.savedLayouts[S.savedLayouts.length - 1] || {}).id || ""; showToast("Layout saved", "success"); renderPanel();
  }
  async function deleteLayout(id) {
    try { if (id.startsWith("local-")) throw new Error("local"); await databases.deleteDocument(DB_ID, LAYOUTS, id); await loadSavedLayouts(); }
    catch (e) { const list = localLayouts().filter(x => x.id !== id); writeLocal(list); S.savedLayouts = id.startsWith("local-") ? list : S.savedLayouts.filter(x => x.id !== id); }
    S.activeLayoutId = ""; showToast("Layout deleted", "success"); renderPanel();
  }
  function applyLayout(id) {
    const l = S.savedLayouts.find(x => x.id === id); if (!l) return;
    S.layout = V.sanitizeLayout({ mode: l.mode, regions: l.regions }); S.layoutSource = "saved"; S.activeLayoutId = id; viewer.setLayout(S.layout, true); renderPanel();
  }

  /* ---------------- file handling ---------------- */
  async function handleFile(file) {
    S.error = ""; S.needPassword = false;
    if (!file) return;
    if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { S.error = "That is not a PDF file. Please choose your bank statement as a PDF."; renderCover(); return; }
    if (file.size > MAX_PDF_BYTES) { S.error = "That file is too large (over 60 MB). Try downloading a shorter period from your bank."; renderCover(); return; }
    S.file = { name: file.name, size: file.size };
    progress("Reading statement…");
    try { S.pendingBuffer = await file.arrayBuffer(); await openBuffer(); }
    catch (e) { failLoad(e); }
  }
  async function openBuffer() {
    const copy = S.pendingBuffer.slice(0);
    try { await viewer.load(copy, S.password); } catch (e) { throw e; }
    S.pages = []; S.needPassword = false; S.pendingBuffer = null;
    progress("Reading statement…", 0);
    S.pages = await viewer.extractAll((n, t) => progress(`Reading page ${n} of ${t}…`, n / t));
    // TEXT-BASED PDFs ONLY. No OCR and no fallback: if PDF.js found too little embedded text, stop here and say so.
    const readable = V.checkExtractable(S.pages);
    if (!readable.ok) { rejectUnsupported(readable); return; }
    progress(null);
    const g = V.guessLayout(S.pages); S.layout = g.layout; S.layoutSource = g.found ? "guess" : "default"; S.step = 2; S.view = "columns"; S.panelOpen = false;
    viewer.setLayout(S.layout, true); viewer.goTo(1); S.notice = "";
    render(); setText("#vwPageNow", 1); setText("#vwPageTotal", viewer.numPages);
    if (!g.found) S.notice = "We could not find the column headings, so please place the guides yourself."; renderBanner();
  }
  const UNSUPPORTED = {
    "no-text": "This statement has no selectable text. It looks like a scan, a photograph saved as a PDF, or an image-only PDF.",
    "too-little-text": "Very little text could be read from this file, so it is not a bank statement X-Redro can use. It may be a scan, a photograph saved as a PDF, or an image-only PDF.",
    "no-figures": "This file has text but no dates or amounts to read, so it is not a bank statement X-Redro can use.",
    "empty": "This file has no pages to read."
  };
  function rejectUnsupported(r) {
    try { viewer.destroy(); } catch (e) { /* ignore */ }
    S.pages = []; S.file = null; S.pendingBuffer = null; S.step = 1; S.view = "columns";
    S.error = `Unsupported statement. ${UNSUPPORTED[r.reason] || UNSUPPORTED["no-text"]} X-Redro reads text-based PDF statements only. Nothing was processed. Please download the PDF statement from your bank's app or website (not a scan or a photo) and upload that.`;
    progress(null); render();
  }
  function failLoad(e) {
    progress(null); S.pages = [];
    const name = e && e.name;
    if (name === "PasswordException") { S.needPassword = true; S.error = e.code === 2 ? "That password did not work. Please try again." : ""; }
    else if (name === "InvalidPDFException" || name === "FormatError") { S.error = "This file could not be opened as a PDF. It may be damaged. Try downloading the statement again."; S.file = null; }
    else { console.error("Statement load failed:", e); S.error = "The statement could not be read. Check your connection and try again."; S.file = null; }
    render();
  }

  /* ---------------- matching ---------------- */
  async function runMatch() {
    S.error = "";
    try {
      progress("Extracting transactions…", 0.2); await tick();
      S.ex = V.extractRows(S.pages, S.layout, S.dateOrder === "auto" ? {} : { dateOrder: S.dateOrder }); S.rows = S.ex.rows;
      if (!S.rows.length) { progress(null); S.error = (S.ex.warnings[0] || "No credited transactions were found with these columns.") + " Drag the guides so they cover the date, description and credit columns, then try again."; S.step = 2; renderPanel(); return; }
      progress("Matching payments with orders…", 0.6); await tick();
      S.rejected = new Set(); S.forced = new Set(); S.manual = []; S.verifying = null; S.confirmAll = false; S.sel = null; S.view = "results"; S.filter = "confident";
      computeMatch();
      progress("Preparing results…", 0.9); await tick();
      S.step = 3; viewer.showRegions(false); paintHighlights(); progress(null); S.notice = "";
      const first = S.match.summary.confident ? "confident" : S.match.summary.review ? "review" : "rows"; S.filter = first; S.panelOpen = false;
      render();
    } catch (e) { console.error("Matching failed:", e); progress(null); S.error = "Something went wrong while matching. Nothing was changed. Please try again."; S.step = 2; render(); }
  }
  function computeMatch() {
    S.match = V.matchAll(S.rows, S.prepared.filter(o => !S.paid.has(o.id)), { dateTolerance: S.dateTolerance, verifiedKeys: S.verifiedKeys, usedKeys: S.used, rejected: S.rejected, forcedReview: S.forced, manual: S.manual });
  }
  function paintHighlights() {
    const list = S.rows.map(r => { const st = S.match.rowStatus.get(r.id).status; return Object.assign({}, r, { status: st, label: `${r.description || r.descText} ${naira(r.amount)}` }); });
    viewer.setHighlights(list); if (S.sel) viewer.markSelected(S.sel.rowId);
  }
  function refresh() { computeMatch(); paintHighlights(); renderPanel(); }

  /* ---------------- verifying (the only place anything is marked paid) ---------------- */
  function persistUsed(key) { try { const list = JSON.parse(localStorage.getItem(USED_KEY) || "[]"); list.push(key); localStorage.setItem(USED_KEY, JSON.stringify(list.slice(-2000))); } catch (e) { /* ignore */ } }
  function friendly(err) {
    if (err && (err.code === 401 || err.code === 403)) return "You do not have permission to change this order.";
    if (err && err.code === 404) return "This order no longer exists.";
    if (err && err.code === 429) return "Too many requests. Wait a moment and try again.";
    return (err && err.message) || "The change could not be saved.";
  }
  /* one pair, validated on its own: re-read the order, re-check the transaction, then write */
  async function verifyOne(pair) {
    const o = prepOf(pair.orderId), row = rowOf(pair.rowId);
    if (S.used.has(row.key) || S.verifiedKeys.has(row.key)) throw new Error("This transaction was already used to verify another order.");
    let fresh;
    try { fresh = await databases.getDocument(DB_ID, ORDERS, o.id); } catch (e) { throw new Error(friendly(e)); }
    if (String(fresh.status || "pending").toLowerCase() !== "pending") throw new Error("This order is no longer unpaid.");
    if (fresh.userId && user && fresh.userId !== user.$id) throw new Error("This order does not belong to your store.");
    if (V.parseMoney(fresh.totalAmount) !== o.total) throw new Error("The order total changed after the statement was matched. Run the match again.");
    const patch = { status: "paid" };
    if ("verifiedTx" in fresh) patch.verifiedTx = row.key;          // lets other devices see this transaction is used (needs the optional field)
    if ("verifiedAt" in fresh) patch.verifiedAt = new Date().toISOString();
    let saved; try { saved = await databases.updateDocument(DB_ID, ORDERS, o.id, patch); } catch (e) { throw new Error(friendly(e)); }
    const local = allOrders.find(x => x.$id === o.id); if (local) { Object.assign(local, patch); if (saved && saved.$updatedAt) local.$updatedAt = saved.$updatedAt; }
    S.used.add(row.key); S.verifiedKeys.add(row.key); persistUsed(row.key);
    S.paid.add(o.id);                                              // stays in S.prepared so screens still showing it keep working
  }
  async function verifyMany(pairs) {
    const v = S.verifying = { running: true, done: false, index: 0, total: pairs.length, ok: [], failed: [] }; S.confirmAll = false; renderPanel();
    for (const p of pairs) {
      v.index++; const o = prepOf(p.orderId);
      try { await verifyOne(p); v.ok.push(o.customer); } catch (e) { v.failed.push({ name: o ? o.customer : "Order", reason: e.message, pair: p }); }
      renderPanel(); await tick();
    }
    v.running = false; v.done = true; S.verifying = v; refresh();
    showToast(v.failed.length ? `${v.ok.length} verified, ${v.failed.length} could not be verified` : `${v.ok.length} order${v.ok.length === 1 ? "" : "s"} marked as paid`, v.failed.length ? "warning" : "success");
  }

  /* ---------------- events ---------------- */
  function openTxn(rowId, orderId) { S.sel = { rowId, orderId: orderId || null }; S.view = "txn"; S.editRow = null; const r = rowOf(rowId); if (r) { viewer.scrollToRow(r); viewer.markSelected(rowId); } renderPanel(); renderPanelChrome(); }
  function onRowClick(rowId) {
    if (!S || S.step !== 3 || !S.match) return;
    if (S.pick) { const orderId = S.pick; S.pick = null; S.manual.push({ orderId, rowId }); refresh(); renderBanner(); openTxn(rowId, orderId); return; }
    openTxn(rowId);
  }
  function onClick(e) {
    const t = e.target.closest("[data-act]"); if (!t) return; const a = t.dataset.act;
    if (a === "close") window.closeVerifyOverlay();
    else if (a === "prev") viewer.goTo(viewer.currentPage - 1); else if (a === "next") viewer.goTo(viewer.currentPage + 1);
    else if (a === "zoomin") viewer.zoomIn(); else if (a === "zoomout") viewer.zoomOut(); else if (a === "fitwidth") viewer.fitWidth(); else if (a === "fitpage") viewer.fitPage();
    else if (a === "fullscreen") toggleFull();
    else if (a === "sheet") { S.panelOpen = !S.panelOpen; renderPanelChrome(); }
    else if (a === "unlock") { S.password = root.querySelector("#vwPw").value; progress("Opening statement…"); openBuffer().catch(failLoad); }
    else if (a === "cancel-pw") { S.needPassword = false; S.error = ""; S.pendingBuffer = null; S.password = ""; S.file = null; render(); }
    else if (a === "mode") { const m = t.dataset.mode; if (m !== S.layout.mode) { const prev = S.layout; S.layout = V.sanitizeLayout(V.DEFAULT_LAYOUTS[m]); if (m === "two" && prev.regions.credit) S.layout.regions.credit = prev.regions.credit; if (m === "three" && prev.regions.credit) S.layout.regions.credit = prev.regions.credit; S.layoutSource = "manual"; viewer.setLayout(S.layout, true); renderPanel(); } }
    else if (a === "nudge") { const k = t.dataset.key, d = Number(t.dataset.d), r = S.layout.regions[k]; const w = r.x1 - r.x0; let x0 = Math.min(1 - w, Math.max(0, r.x0 + d)); S.layout.regions[k] = { x0, x1: x0 + w }; S.layoutSource = "manual"; viewer.setLayout(S.layout, true); }
    else if (a === "match") runMatch();
    else if (a === "to-columns") { S.step = 2; S.view = "columns"; S.confirmAll = false; viewer.setHighlights([]); viewer.setLayout(S.layout, true); render(); }
    else if (a === "layout-name") { S.namingLayout = true; renderPanel(); const i = root.querySelector("#vwLayoutName"); if (i) i.focus(); }
    else if (a === "layout-cancel") { S.namingLayout = false; renderPanel(); }
    else if (a === "layout-save") saveLayout(root.querySelector("#vwLayoutName").value, "");
    else if (a === "layout-apply") applyLayout(S.activeLayoutId);
    else if (a === "layout-update") { const l = S.savedLayouts.find(x => x.id === S.activeLayoutId); if (l) saveLayout(l.name, l.id); }
    else if (a === "layout-delete") { const l = S.savedLayouts.find(x => x.id === S.activeLayoutId); if (l && confirm(`Delete the layout “${l.name}”?`)) deleteLayout(l.id); }
    else if (a === "filter") { S.filter = t.dataset.f; renderPanel(); }
    else if (a === "open-txn") openTxn(t.dataset.row, t.dataset.order);
    else if (a === "open-order") { S.sel = { orderId: t.dataset.order }; S.view = "order"; renderPanel(); renderPanelChrome(); }
    else if (a === "back") { S.view = "results"; S.sel = null; S.editRow = null; viewer.markSelected(null); renderPanel(); renderPanelChrome(); }
    else if (a === "pick") { S.pick = t.dataset.order; S.view = "results"; S.panelOpen = false; renderPanel(); renderPanelChrome(); renderBanner(); }
    else if (a === "cancel-pick") { S.pick = null; renderBanner(); }
    else if (a === "assign") { S.manual.push({ orderId: t.dataset.order, rowId: t.dataset.row }); refresh(); openTxn(t.dataset.row, t.dataset.order); }
    else if (a === "confirm-one") {
      const pair = S.match.pairs.find(p => p.orderId === t.dataset.order && p.rowId === t.dataset.row); if (!pair) return;
      t.disabled = true; S.verifying = null; verifyOne(pair).then(() => { showToast("Order marked as paid", "success"); S.view = "results"; S.sel = null; refresh(); renderPanelChrome(); }).catch(err => { t.disabled = false; showToast(err.message, "error"); });
    }
    else if (a === "mark-review") { S.forced.add(V.pairKey(t.dataset.order, t.dataset.row)); refresh(); showToast("Marked for manual review", "success"); }
    else if (a === "reject") { S.rejected.add(V.pairKey(t.dataset.order, t.dataset.row)); S.view = "results"; S.sel = null; refresh(); renderPanelChrome(); showToast("Match rejected. It will not be suggested again.", "success"); }
    else if (a === "view-order") { const id = t.dataset.order; window.closeVerifyOverlay(); if (typeof xrOpenOrderCard === "function") xrOpenOrderCard(id); }
    else if (a === "lightbox") lightbox(t.dataset.id);
    else if (a === "verify-all") { S.confirmAll = true; S.verifying = null; renderPanel(); }
    else if (a === "verify-cancel") { S.confirmAll = false; renderPanel(); }
    else if (a === "verify-confirm") verifyMany(V.verifyAllPlan(S.match));
    else if (a === "retry-failed") { const again = S.verifying.failed.map(f => f.pair).filter(p => S.prepared.some(o => o.id === p.orderId)); computeMatch(); const ok = new Set(V.verifyAllPlan(S.match).map(p => V.pairKey(p.orderId, p.rowId))); verifyMany(again.filter(p => ok.has(V.pairKey(p.orderId, p.rowId)))); }
    else if (a === "set-dmy") { S.dateOrder = "dmy"; runMatch(); }
    else if (a === "edit-row") { S.editRow = t.dataset.row; renderPanel(); }
    else if (a === "cancel-row") { S.editRow = null; renderPanel(); }
    else if (a === "save-row") {
      const id = t.dataset.row; const i = S.rows.findIndex(r => r.id === id); if (i < 0) return;
      const amt = V.parseMoney(root.querySelector("#vwEdAmt").value);
      if (!(amt > 0)) { showToast("Enter the amount as a number, for example 15000.00", "warning"); return; }
      S.rows[i] = V.editRow(S.rows[i], { date: root.querySelector("#vwEdDate").value, description: root.querySelector("#vwEdDesc").value, amount: amt }, S.ex ? S.ex.dateOrder : "dmy"); V.finalizeRows(S.rows);
      S.editRow = null; refresh();
    }
  }
  function onChange(e) {
    const t = e.target;
    if (t.id === "vwFileInput") handleFile(t.files[0]);
    else if (t.id === "vwOrder") { S.dateOrder = t.value; }
    else if (t.id === "vwTol") { S.dateTolerance = Number(t.value); }
    else if (t.id === "vwLayoutSel") { S.activeLayoutId = t.value; renderPanel(); if (S.activeLayoutId) applyLayout(S.activeLayoutId); }
  }
  function onInput() { /* reserved */ }
  function lightbox(id) {
    const lb = document.createElement("div"); lb.className = "vw-lightbox"; lb.setAttribute("role", "dialog"); lb.setAttribute("aria-label", "Customer payment screenshot");
    lb.innerHTML = `<button type="button" class="xr-btn xr-btn--secondary vw-lightbox__close" aria-label="Close screenshot">Close</button><img src="${esc(proofUrl(id))}" alt="Customer payment screenshot">`;
    lb.addEventListener("click", () => lb.remove()); root.appendChild(lb);
  }
  function toggleFull() {
    const doc = root.querySelector(".vw-doc");
    if (document.fullscreenElement) { document.exitFullscreen(); root.classList.remove("vw--focus"); return; }
    root.classList.toggle("vw--focus");
    if (doc.requestFullscreen) doc.requestFullscreen().catch(() => { /* focus mode still applies */ });
    setTimeout(() => viewer.refit(), 200);
  }
  document.addEventListener("fullscreenchange", () => { if (root && !document.fullscreenElement) root.classList.remove("vw--focus"); if (viewer) setTimeout(() => viewer.refit(), 200); });
  // drag and drop of the PDF onto the statement area
  document.addEventListener("dragover", e => { if (root && S && !S.pages.length && e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); root.classList.add("is-drop"); } });
  document.addEventListener("dragleave", e => { if (root && !e.relatedTarget) root.classList.remove("is-drop"); });
  document.addEventListener("drop", e => { if (root && S && !S.pages.length && e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); root.classList.remove("is-drop"); handleFile(e.dataTransfer.files[0]); } });
})();
