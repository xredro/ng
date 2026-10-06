/* =========================================================
   X-REDRO PAYMENT VERIFICATION
   ---------------------------------------------------------
   Statement-first, same-image verification.

   Flow:
   1. Seller uploads a bank-statement PDF.
   2. PDF.js extracts transaction rows and headers.
   3. Seller explicitly selects Date, Name/Description, Credit.
   4. Rows without a valid positive Credit are skipped.
   5. Every non-empty cell from valid rows is retained.
   6. All unpaid orders with payment-proof images are OCR'd once.
   7. OCR text is normalized, tokenized and indexed by amount/date/token.
   8. Each statement row searches the image collection.
   9. Date + Name/Description + Credit MUST match in the SAME image.
  10. Other row cells are supporting evidence only.
  11. Results are deterministic: MATCHED, STRONG MATCH, REVIEW REQUIRED,
      NOT VERIFIED, or SKIPPED.
  12. No receiving-account/business-name input is used.
  13. Everything is processed locally in the browser.
========================================================= */

const VERIFY_CREDIT_HEADER_SYNONYMS = [
  "credit", "cr", "creditamount", "creditamt", "amountcredited",
  "deposit", "deposits", "inflow", "inflows", "moneyin",
  "received", "amountreceived", "paidin", "lodgement"
];


const VERIFY_GENERIC_TOKENS = new Set([
  "the", "and", "for", "from", "to", "of", "by", "with",
  "transfer", "payment", "transaction", "bank", "account",
  "amount", "credit", "credited", "debit", "deposits", "deposit",
  "received", "money", "inflow", "cash", "online", "mobile",
  "successful", "success", "completed", "paid", "na", "n", "a"
]);

const VERIFY_DATE_REGEXES = [
  /\b\d{4}-\d{1,2}-\d{1,2}\b/,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /\b\d{1,2}-\d{1,2}-\d{2,4}\b/,
  /\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}\b/,
  /\b[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4}\b/
];

const MONTH_NAMES = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12"
};

const VERIFY_STORAGE_BUCKET = "696825350032fe17c1eb";
const VERIFY_PROJECT_ID = "695981480033c7a4eb0d";

let verifyState = createVerifyState();

function createVerifyState() {
  return {
    statementText: null,
    statementTables: [],
    selectedColumns: null,
    statementRows: [],
    validStatementRows: [],
    skippedStatementRows: [],
    pendingPayments: [],
    ocrImages: [],
    imageIndex: {
      amountIndex: new Map(),
      dateIndex: new Map(),
      tokenIndex: new Map()
    },
    results: [],
    columnPickerResolve: null,
    _statementBuffer: null,
    ocrWorker: null
  };
}

/* =========================================================
   OVERLAY / ENTRY
========================================================= */

function ensureVerifyOverlay() {
  if (document.getElementById("verifyOverlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "verifyOverlay";
  overlay.className = "verify-overlay hidden";
  overlay.innerHTML = `
    <div class="verify-panel">
      <button class="verify-close" aria-label="Close" onclick="closeVerifyOverlay()">&times;</button>
      <div id="verifyBody"></div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function openVerifyOverlay() {
  ensureVerifyOverlay();
  verifyState = createVerifyState();
  document.getElementById("verifyOverlay").classList.remove("hidden");
  renderVerifyStepStatement();
}

function closeVerifyOverlay() {
  const overlay = document.getElementById("verifyOverlay");
  if (overlay) overlay.classList.add("hidden");

  if (verifyState.ocrWorker) {
    try {
      verifyState.ocrWorker.terminate();
    } catch (_) {}
    verifyState.ocrWorker = null;
  }
}

/* =========================================================
   STATUS / PROGRESS UI
========================================================= */

function renderVerifyStepStatement() {
  const body = document.getElementById("verifyBody");
  body.innerHTML = `
    <h2>Verify Payments</h2>
    <p class="verify-sub">
      Upload the bank statement covering the payments you want to check.
      The statement is used as the source of truth; payment images are searched
      for matching evidence.
    </p>

    <label class="verify-upload">
      <input type="file" accept="application/pdf" hidden onchange="handleStatementUpload(this)">
      <div class="verify-upload-ui">
        <span class="upload-icon">&#8593;</span>
        <span>Upload statement PDF</span>
        <small>PDF is processed locally in this browser</small>
      </div>
    </label>

    <div id="verifyStatementStatus" class="verify-status-line"></div>
  `;
}

function renderVerifyProgress(stage, detail, stats = {}) {
  const body = document.getElementById("verifyBody");
  if (!body) return;

  const stages = [
    ["statement", "Loading bank statement"],
    ["table", "Detecting transaction table"],
    ["columns", "Selecting statement columns"],
    ["filter", "Filtering Credit rows"],
    ["ocr", "OCR processing payment images"],
    ["index", "Building searchable indexes"],
    ["match", "Matching transactions"],
    ["final", "Finalizing results"]
  ];

  const activeIndex = Math.max(
    0,
    stages.findIndex(s => s[0] === stage)
  );

  body.innerHTML = `
    <div class="verify-progress">
      <h2>Verifying payments…</h2>
      <div class="verify-stage-list">
        ${stages.map((s, i) => {
          const cls = i < activeIndex ? "done" : (i === activeIndex ? "active" : "");
          const icon = i < activeIndex ? "&#10003;" : (i === activeIndex ? "&#9679;" : "&#9675;");
          return `
            <div class="verify-stage ${cls}">
              <span>${icon}</span>
              <span>${escapeHtml(s[1])}</span>
            </div>
          `;
        }).join("")}
      </div>

      <div class="verify-progress-main">
        <strong>${escapeHtml(detail || "")}</strong>
        ${stats.total != null ? `
          <div class="verify-progress-track">
            <div class="verify-progress-bar" style="width:${Math.max(0, Math.min(100, stats.percent || 0))}%"></div>
          </div>
        ` : ""}
      </div>

      ${stats.extra ? `<div class="verify-progress-extra">${escapeHtml(stats.extra)}</div>` : ""}
    </div>
  `;
}

function updateVerifyProgress(detail, current, total, extra = "") {
  const main = document.querySelector(".verify-progress-main");
  if (!main) return;

  const safeTotal = Math.max(0, Number(total) || 0);
  const safeCurrent = Math.max(0, Math.min(safeTotal, Number(current) || 0));
  const percent = safeTotal ? Math.round((safeCurrent / safeTotal) * 100) : 0;

  main.innerHTML = `
    <strong>${escapeHtml(detail || "")}</strong>
    ${safeTotal ? `
      <div class="verify-progress-track">
        <div class="verify-progress-bar" style="width:${percent}%"></div>
      </div>
    ` : ""}
  `;

  const extraEl = document.querySelector(".verify-progress-extra");
  if (extraEl) extraEl.textContent = extra || "";
}

/* =========================================================
   STEP 1 — STATEMENT UPLOAD
========================================================= */

async function handleStatementUpload(input) {
  const file = input.files[0];
  if (!file) return;

  renderVerifyProgress("statement", "Reading statement PDF…");

  try {
    const buffer = await file.arrayBuffer();
    verifyState._statementBuffer = buffer;
    await loadStatementPdf(buffer, null);
  } catch (err) {
    if (err && (err.name === "PasswordException" || err.code === 1)) {
      renderVerifyPasswordPrompt();
      return;
    }

    console.error("Statement PDF processing error:", err);
    showVerifyError(verifyPdfErrorMessage(err, "Could not process this PDF."));
  }
}

function renderVerifyPasswordPrompt() {
  const body = document.getElementById("verifyBody");
  body.innerHTML = `
    <h2>Password Protected</h2>
    <p class="verify-sub">
      This statement PDF is password protected. Enter the password to access the statement.
    </p>

    <div class="form-group">
      <input id="verifyPdfPassword" type="password" placeholder="PDF password" autocomplete="off">
    </div>

    <div id="verifyPasswordError" class="verify-error hidden"></div>

    <button class="verify-btn-primary" onclick="submitVerifyPassword()">Unlock</button>
  `;
  setTimeout(() => document.getElementById("verifyPdfPassword")?.focus(), 50);
}

async function submitVerifyPassword() {
  const input = document.getElementById("verifyPdfPassword");
  const errEl = document.getElementById("verifyPasswordError");
  if (!input) return;

  const pw = input.value;
  if (!pw) {
    errEl.textContent = "Enter the PDF password.";
    errEl.classList.remove("hidden");
    return;
  }

  errEl.classList.add("hidden");
  input.disabled = true;

  try {
    await loadStatementPdf(verifyState._statementBuffer, pw);
  } catch (err) {
    console.error("PDF password error:", err);
    input.disabled = false;
    const info = getPdfReaderError(err);
    errEl.textContent = info.type === "incorrect-password"
      ? "That password is incorrect. Try again."
      : verifyPdfErrorMessage(err, "The PDF could not be unlocked. Try again.");
    errEl.classList.remove("hidden");
  }
}

function getPdfReaderError(err) {
  const name = String(err?.name || "");
  const code = Number(err?.code);
  const message = String(err?.message || "");

  if (name === "PasswordException" || code === 1 || code === 2) {
    return { type: code === 2 ? "incorrect-password" : "password-required", message };
  }
  if (name === "InvalidPDFException") {
    return { type: "invalid-pdf", message };
  }
  if (name === "MissingPDFException") {
    return { type: "missing-pdf", message };
  }
  if (name === "UnexpectedResponseException") {
    return { type: "network", message };
  }
  if (name === "UnknownErrorException") {
    return { type: "pdf-error", message };
  }
  if (/worker|fake worker|setting up worker|loading worker/i.test(message)) {
    return { type: "worker", message };
  }
  return { type: "unknown", message };
}

function verifyPdfErrorMessage(err, fallback = "Could not read this PDF.") {
  const info = getPdfReaderError(err);
  switch (info.type) {
    case "invalid-pdf":
      return "This file is not a valid PDF or the PDF is damaged.";
    case "missing-pdf":
      return "The PDF file could not be read. Please choose the file again.";
    case "network":
      return "The PDF reader could not load required PDF data. Check your connection and try again.";
    case "worker":
      return "The PDF reader worker could not start. The reader will try again without the worker.";
    case "pdf-error":
      return info.message ? `PDF.js could not extract this PDF: ${info.message}` : fallback;
    default:
      return info.message ? `${fallback} ${info.message}` : fallback;
  }
}

function normalizePdfTextItem(item, pageNumber, itemIndex) {
  const transform = Array.isArray(item?.transform) ? item.transform : [];
  const x = Number.isFinite(Number(transform[4])) ? Number(transform[4]) : 0;
  const y = Number.isFinite(Number(transform[5])) ? Number(transform[5]) : 0;
  const width = Number.isFinite(Number(item?.width)) ? Math.max(0, Number(item.width)) : 0;
  const height = Number.isFinite(Number(item?.height)) ? Math.max(0, Number(item.height)) : 0;
  const text = String(item?.str ?? "").replace(/\u0000/g, "");

  return {
    id: `p${pageNumber}-t${itemIndex}`,
    text,
    x,
    y,
    width,
    height,
    right: x + width,
    top: y + height,
    centerX: x + width / 2,
    centerY: y + height / 2,
    transform: transform.map(v => Number.isFinite(Number(v)) ? Number(v) : 0),
    hasEOL: !!item?.hasEOL,
    dir: String(item?.dir || ""),
    fontName: String(item?.fontName || "")
  };
}

async function extractPdfPageText(page, pageNumber) {
  let content;
  let firstError = null;

  // First pass: normal PDF.js extraction. disableCombineTextItems is kept
  // false here because many real bank PDFs expose useful multi-word items.
  try {
    content = await page.getTextContent({
      normalizeWhitespace: false,
      disableCombineTextItems: false,
      includeMarkedContent: false
    });
  } catch (err) {
    firstError = err;
  }

  // Second pass: ask PDF.js for less-combined text items. This often recovers
  // selectable text from PDFs whose font/text streams are unusually fragmented.
  if (!content) {
    try {
      content = await page.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: true,
        includeMarkedContent: false
      });
    } catch (err) {
      throw firstError || err;
    }
  }

  const items = Array.isArray(content?.items)
    ? content.items
        .map((item, index) => normalizePdfTextItem(item, pageNumber, index))
        .filter(item => item.text.trim() || item.width > 0 || item.height > 0)
    : [];

  return {
    items,
    rawItemCount: Array.isArray(content?.items) ? content.items.length : 0
  };
}

function assertPdfReaderAvailable() {
  if (typeof window === "undefined" || typeof window.pdfjsLib === "undefined") {
    throw new Error("PDF.js is not loaded. Check that pdf.min.js is loaded before paymentVerify.js.");
  }
  if (typeof window.pdfjsLib.getDocument !== "function") {
    throw new Error("The loaded PDF.js library is incomplete or incompatible.");
  }
}

async function openPdfDocument(buffer, password, useWorker = true) {
  assertPdfReaderAvailable();

  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 5) {
    throw new Error("The selected file is empty or is not a readable PDF.");
  }

  // A quick signature check gives a much clearer error than PDF.js's generic
  // UnknownError for files renamed to .pdf.
  const signature = new TextDecoder("latin1").decode(new Uint8Array(buffer.slice(0, 5)));
  if (signature !== "%PDF-") {
    throw new Error("The selected file does not contain a valid PDF header.");
  }

  const options = {
    data: buffer.slice(0),
    password: password || undefined,
    useWorker
  };

  const loadingTask = window.pdfjsLib.getDocument(options);
  return await loadingTask.promise;
}

async function loadStatementPdf(buffer, password) {
  renderVerifyProgress("statement", "Reading statement PDF…");

  let pdf;
  try {
    pdf = await openPdfDocument(buffer, password, true);
  } catch (err) {
    const info = getPdfReaderError(err);
    // If the worker cannot start (blocked CDN, CSP, browser issue), PDF.js
    // can still extract text on the main thread. This is a reader fallback;
    // reconstruction remains completely unchanged.
    if (info.type === "worker") {
      try {
        pdf = await openPdfDocument(buffer, password, false);
      } catch (fallbackErr) {
        throw fallbackErr;
      }
    } else {
      throw err;
    }
  }

  if (!pdf || !Number.isFinite(pdf.numPages) || pdf.numPages < 1) {
    throw new Error("The PDF contains no readable pages.");
  }

  const pages = [];
  let pagesWithText = 0;
  let failedPages = [];
  let totalItems = 0;

  for (let i = 1; i <= pdf.numPages; i++) {
    updateVerifyProgress(
      `Reading statement page ${i} of ${pdf.numPages}…`,
      i - 1,
      pdf.numPages,
      failedPages.length ? `${failedPages.length} page(s) could not be extracted yet.` : ""
    );

    let page;
    try {
      page = await pdf.getPage(i);
    } catch (err) {
      failedPages.push(i);
      pages.push({ width: 0, height: 0, items: [], pageNumber: i, extractionError: verifyPdfErrorMessage(err, "Could not open this page.") });
      continue;
    }

    let viewport;
    try {
      viewport = page.getViewport({ scale: 1 });
    } catch (_) {
      viewport = { width: 0, height: 0 };
    }

    try {
      const extracted = await extractPdfPageText(page, i);
      totalItems += extracted.items.length;
      if (extracted.items.some(item => item.text.trim())) pagesWithText++;

      pages.push({
        pageNumber: i,
        width: Number(viewport.width) || 0,
        height: Number(viewport.height) || 0,
        items: extracted.items,
        rawItemCount: extracted.rawItemCount
      });
    } catch (err) {
      failedPages.push(i);
      pages.push({
        pageNumber: i,
        width: Number(viewport.width) || 0,
        height: Number(viewport.height) || 0,
        items: [],
        extractionError: verifyPdfErrorMessage(err, "Could not extract text from this page.")
      });
    }
  }

  updateVerifyProgress(
    "Finished reading PDF text.",
    pdf.numPages,
    pdf.numPages,
    `${pagesWithText}/${pdf.numPages} page(s) contain selectable text • ${totalItems.toLocaleString()} text item(s)`
  );

  verifyState.statementText = pages;

  if (!pagesWithText) {
    throw new Error(
      failedPages.length === pdf.numPages
        ? "PDF.js could not extract text from any page. The PDF may be damaged, encrypted with unsupported restrictions, or image/scanned-only."
        : "No selectable text was found in this PDF. A scanned/image-only statement needs OCR before it can be reconstructed."
    );
  }

  // Do not silently fail merely because one page is malformed. Valid pages
  // are still passed to the existing table reconstruction layer.
  await detectStatementTables();
}

/* =========================================================
   PDF TABLE / COLUMN EXTRACTION
========================================================= */

function build2DPageModel(page) {
  const items = Array.isArray(page?.items) ? page.items : (Array.isArray(page) ? page : []);
  const heights = items.map(i => Number(i.height) || 0).filter(h => h > 0).sort((a,b)=>a-b);
  const medianHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
  const yTolerance = Math.max(2, Math.min(5, medianHeight * 0.45));

  // This is the virtual/off-screen 2-D canvas. Coordinates are preserved,
  // not rasterized, so large statements do not pay the memory cost of a
  // pixel-by-pixel canvas. Every fragment is a positioned rectangle.
  const canvas = {
    width: Number(page?.width) || 0,
    height: Number(page?.height) || 0,
    items: items.map(item => ({
      ...item,
      x: Number(item.x) || 0,
      y: Number(item.y) || 0,
      width: Math.max(0, Number(item.width) || 0),
      height: Math.max(0, Number(item.height) || 0),
      right: Number.isFinite(item.right) ? item.right : (Number(item.x)||0)+(Number(item.width)||0),
      top: Number.isFinite(item.top) ? item.top : (Number(item.y)||0)+(Number(item.height)||0),
      centerX: Number.isFinite(item.centerX) ? item.centerX : (Number(item.x)||0)+(Number(item.width)||0)/2,
      centerY: Number.isFinite(item.centerY) ? item.centerY : (Number(item.y)||0)+(Number(item.height)||0)/2
    }))
  };

  const sorted = [...canvas.items]
    .filter(i => String(i.text || '').trim())
    .sort((a,b) => b.centerY - a.centerY || a.x - b.x);

  const rows = [];
  for (const item of sorted) {
    let best = null;
    let bestDistance = Infinity;
    for (const row of rows) {
      const d = Math.abs(row.centerY - item.centerY);
      if (d <= yTolerance && d < bestDistance) {
        best = row;
        bestDistance = d;
      }
    }
    if (!best) {
      best = { centerY: item.centerY, items: [] };
      rows.push(best);
    }
    best.items.push(item);
    best.centerY = best.items.reduce((sum, x) => sum + x.centerY, 0) / best.items.length;
  }

  rows.sort((a,b)=>b.centerY-a.centerY);
  rows.forEach((row, index) => {
    row.index = index;
    row.items.sort((a,b)=>a.x-b.x);
    row.x = row.items.length ? Math.min(...row.items.map(x=>x.x)) : 0;
    row.right = row.items.length ? Math.max(...row.items.map(x=>x.right)) : 0;
  });

  canvas.rows = rows;
  return canvas;
}


function normalizeHeaderWord(s) {
  return (s || "").toLowerCase().replace(/[^a-z]/g, "");
}

function normalizeHeaderLabel(s) {
  return normalizeHeaderWord(s)
    .replace(/^value$/, "date")
    .replace(/^valuedate$/, "date")
    .replace(/^postingdate$/, "date")
    .replace(/^transactiondate$/, "date")
    .replace(/^transactiondatetime$/, "datetime")
    .replace(/^datetime$/, "datetime")
    .replace(/^timestamp$/, "datetime")
    .replace(/^time$/, "time")
    .replace(/^transactiontime$/, "time")
    .replace(/^counterparty$/, "name")
    .replace(/^customername$/, "name")
    .replace(/^sender$/, "name")
    .replace(/^beneficiary$/, "name")
    .replace(/^narration$/, "description")
    .replace(/^details$/, "description")
    .replace(/^particulars?$/, "description")
    .replace(/^remarks?$/, "description")
    .replace(/^transactiondetails$/, "description")
    .replace(/^transactiondescription$/, "description")
    .replace(/^reference$/, "reference")
    .replace(/^ref$/, "reference")
    .replace(/^refcode$/, "reference")
    .replace(/^trace$/, "reference")
    .replace(/^tracecode$/, "reference")
    .replace(/^creditamount$/, "credit")
    .replace(/^amountcredited$/, "credit")
    .replace(/^amountreceived$/, "credit")
    .replace(/^received$/, "credit")
    .replace(/^deposit$/, "credit")
    .replace(/^inflow$/, "credit")
    .replace(/^deposits$/, "credit")
    .replace(/^debitamount$/, "debit")
    .replace(/^amountdebited$/, "debit")
    .replace(/^balance$/, "balance")
    .replace(/^runningbalance$/, "balance")
    .replace(/^channel$/, "channel")
    .replace(/^novalue$/, "novalue")
    .replace(/^novaluecolumn$/, "novalue");
}

function looksLikeDate(s) {
  if (!s) return false;
  return VERIFY_DATE_REGEXES.some(r => r.test(String(s)));
}


/*
 * PDF.js exposes text as individual positioned fragments. A header such as
 * "Reference / Code" can therefore arrive as two fragments. The old parser
 * treated BOTH fragments as separate columns, which created phantom columns
 * ("Column 2", "Column 3", ...). Header fragments are first merged into
 * actual header cells, then those cells define the real table schema.
 */
const VERIFY_HEADER_PATTERNS = [
  "date / date-time",
  "date / datetime",
  "date / date time",
  "time / timestamp",
  "name / description",
  "transaction details / narration",
  "narration / description",
  "reference / code",
  "transaction description",
  "transaction details",
  "running balance",
  "posting date",
  "transaction date",
  "value date",
  "customer name",
  "credit amount",
  "amount credited",
  "amount received",
  "debit amount",
  "amount debited",
  "transaction time",
  "timestamp",
  "counterparty",
  "description",
  "narration",
  "particulars",
  "remarks",
  "reference",
  "trace",
  "channel",
  "balance",
  "credit",
  "debit",
  "datetime",
  "date",
  "time",
  "name",
  "ref"
];

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}




function groupHeaderCells(headerRow) {
  // FIXED: old implementation used an allowlist and silently dropped columns
  // text wasn't on the list — causing real columns to disappear, their
  // data to bleed into adjacent recognised columns ("unnecessary stuff"),
  // and the column-picker indices to mismatch the table-row arrays
  // ("Column 2 / Column 3" phantom entries).
  //
  // New approach: purely spatial. Every text fragment in the header row
  // is kept; physically-close fragments (one multi-word header) are joined.
  // Nothing is discarded on pattern grounds.

  const items = [...(headerRow?.items || [])]
    .filter(it => String(it.text || "").trim())
    .sort((a, b) => (Number(a.x) || 0) - (Number(b.x) || 0));

  if (!items.length) return [];

  // Calibrate the gap threshold from the median character width so the
  // function works across narrow compact tables and wide ones alike.
  const charWidths = items.map(it => {
    const w = Math.max(0, Number(it.width) || 0);
    const len = String(it.text || "").trim().length;
    return len ? w / len : 0;
  }).filter(w => w > 0).sort((a, b) => a - b);
  const medianCW = charWidths.length
    ? charWidths[Math.floor(charWidths.length / 2)]
    : 6;
  // Words within the same header cell are typically ≤ 1.5 chars apart.
  // A gap wider than ~2 chars separates distinct header cells.
  const gapThreshold = Math.max(8, medianCW * 2.2);

  const clusters = [];
  let cluster = {
    items: [items[0]],
    x: Number(items[0].x) || 0,
    end: (Number(items[0].x) || 0) + (Number(items[0].width) || 0)
  };

  for (let i = 1; i < items.length; i++) {
    const it = items[i];
    const itemX = Number(it.x) || 0;
    const gap = itemX - cluster.end;

    if (gap <= gapThreshold) {
      cluster.items.push(it);
      cluster.end = Math.max(cluster.end, itemX + (Number(it.width) || 0));
    } else {
      clusters.push(cluster);
      cluster = { items: [it], x: itemX, end: itemX + (Number(it.width) || 0) };
    }
  }
  clusters.push(cluster);

  return clusters
    .map(cl => {
      const text = cl.items
        .map(it => String(it.text || "").trim())
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return { x: cl.x, end: cl.end, center: (cl.x + cl.end) / 2, text };
    })
    // Only discard genuinely empty cells or pure-punctuation artefacts —
    // never drop a cell because its text is not on an allowlist.
    .filter(cell => cell.text && /[A-Za-z0-9]/.test(cell.text));
}

function detectHeaderRow(rows) {
  // FIXED: old implementation required exact normalizeHeaderLabel() matches
  // (e.g. n === "credit") so it missed any column whose header text wasn't
  // mapped by that function — e.g. "Lodgements (CR)", "WITHDRAWALS",
  // "AMOUNT", "S/N".  Raising the threshold to 7 made it even stricter.
  //
  // New approach: plain substring / word-boundary regex on the raw header
  // text.  This recognises the real variety of Nigerian bank statement
  // headers without requiring an exhaustive mapping dictionary.

  let bestIndex = -1;
  let bestScore = 0;

  rows.forEach((row, index) => {
    const cells = groupHeaderCells(row);
    if (cells.length < 2) return;

    const texts = cells.map(c => String(c.text || "").toLowerCase());

    const hasDate = texts.some(t =>
      /\bdate\b|\bvalue\s*date\b|\bposting\s*date\b|\btran(?:saction)?\s*date\b|\btime\b|\btimestamp\b/.test(t)
    );

    const hasAmount = texts.some(t =>
      /\bcredit\b|\blodge(?:ment)?s?\b|\binflow\b|\bdeposit\b|\breceived?\b|\bamount\b|\bdebit\b|\bwithdraw(?:al)?s?\b|\boutflow\b|\bbalance\b/.test(t)
    );

    const hasDescription = texts.some(t =>
      /\bdescription\b|\bnarration\b|\bdetails?\b|\bparticular\b|\bname\b|\bremarks?\b|\breference\b|\bref\b|\btransaction\b/.test(t)
    );

    let score = 0;
    if (hasDate)        score += 3;
    if (hasAmount)      score += 4;
    if (hasDescription) score += 2;
    if (cells.length >= 3) score += 1;
    if (cells.length >= 5) score += 1;

    // At minimum we need a date column AND an amount column.
    if (score >= 7 && score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function buildColumnBoundaries(headerRow) {
  const cells = groupHeaderCells(headerRow)
    .map(cell => ({
      x: Number(cell.x) || 0,
      end: Number.isFinite(Number(cell.end)) ? Number(cell.end) : (Number(cell.x)||0)+(Number(cell.width)||0),
      center: Number(cell.center),
      header: String(cell.text || '').trim()
    }))
    .filter(c => Number.isFinite(c.center))
    .sort((a,b)=>a.center-b.center);

  if (!cells.length) return [];

  /*
   * Header-anchored column model.
   *
   * The header text itself is the most reliable structural landmark in a
   * selectable PDF. Keep its real bounding box (headerLeft/headerRight), then
   * create a wider data corridor around it. The corridor is bounded by the
   * midpoint between neighboring header centres, so right-aligned numbers and
   * wider data cells can still belong to the correct header.
   *
   * This gives us two levels of evidence:
   *   1. headerCore  = the actual physical header box
   *   2. column zone = the usable area for data underneath that header
   */
  return cells.map((c, i) => {
    const prev = cells[i-1];
    const next = cells[i+1];

    const leftCorridor = prev
      ? (prev.center + c.center) / 2
      : Math.min(c.x, c.center - Math.max(24, c.end-c.x));
    const rightCorridor = next
      ? (c.center + next.center) / 2
      : Math.max(c.end, c.center + Math.max(24, c.end-c.x));

    return {
      x: leftCorridor,
      end: rightCorridor,
      center: c.center,
      header: c.header,
      headerX: c.x,
      headerEnd: c.end,
      headerWidth: Math.max(0, c.end - c.x),
      headerCenterX: c.center,
      // Kept separately so matching can distinguish actual header geometry
      // from the wider data corridor.
      headerCore: {
        x: c.x,
        end: c.end,
        center: c.center,
        width: Math.max(0, c.end - c.x)
      }
    };
  });
}







function measureTokenLayout(item) {
  const raw = String(item?.text || '').replace(/\r?\n/g, ' ');
  const x = Number(item?.x) || 0;
  const width = Math.max(0, Number(item?.width) || 0);
  if (!raw.trim()) return [];

  const matches = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(raw))) {
    matches.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  if (!matches.length) return [];

  /*
   * PDF.js normally gives us one TextItem rectangle, not glyph-by-glyph X
   * coordinates.  A proportional-character estimate is therefore only a
   * fallback.  We improve it with browser font measurement when available,
   * then scale the measured run to the PDF.js item width.
   */
  let charWidths = null;
  try {
    if (typeof document !== 'undefined') {
      const canvas = measureTokenLayout._canvas || (measureTokenLayout._canvas = document.createElement('canvas'));
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const fontSize = Math.max(8, Number(item?.height) || 10);
        ctx.font = `${fontSize}px sans-serif`;
        charWidths = Array.from(raw).map(ch => ctx.measureText(ch).width);
        const measured = charWidths.reduce((a,b)=>a+b,0);
        if (!(measured > 0)) charWidths = null;
        else {
          const scale = width > 0 ? width / measured : 1;
          charWidths = charWidths.map(v => v * scale);
        }
      }
    }
  } catch (_) { charWidths = null; }

  const prefix = [0];
  if (charWidths) {
    for (const w of charWidths) prefix.push(prefix[prefix.length-1] + w);
  }
  const fallbackChar = width > 0 && raw.length ? width / raw.length : 0;

  return matches.map((t, i) => {
    const left = x + (charWidths ? prefix[t.start] : t.start * fallbackChar);
    const right = x + (charWidths ? prefix[t.end] : t.end * fallbackChar);
    return {
      id: `${item.id || 'item'}-w${i}`,
      text: t.text,
      x: left,
      right,
      center: (left + right) / 2,
      y: Number(item.y) || 0,
      centerY: Number(item.centerY) || Number(item.y) || 0,
      width: Math.max(0, right-left),
      sourceItemId: item.id,
      positionConfidence: matches.length === 1 ? 'native-item' : (charWidths ? 'estimated-font' : 'estimated-token')
    };
  });
}

function expandSpatialTokens(item) {
  return measureTokenLayout(item);
}


function medianNumber(values) {
  const nums = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!nums.length) return 0;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function clusterEvidence(values, tolerance = 5) {
  const sorted=values.filter(v=>Number.isFinite(v)).sort((a,b)=>a-b);
  const clusters=[];
  for(const value of sorted){
    const last=clusters[clusters.length-1];
    if(!last || Math.abs(value-last.center)>tolerance){
      clusters.push({center:value, values:[value], weight:1});
    } else {
      last.values.push(value);
      last.center=medianNumber(last.values);
      last.weight++;
    }
  }
  return clusters;
}

function headerColumnKind(header) {
  const n = normalizeHeaderLabel(header);
  if (n === "date" || n === "datetime") return "date";
  if (n === "time") return "time";
  if (n === "credit" || VERIFY_CREDIT_HEADER_SYNONYMS.includes(n)) return "numeric";
  if (n === "debit" || n === "balance") return "numeric";
  if (n === "reference") return "reference";
  if (n === "channel") return "channel";
  return "text";
}

function buildGlobalXLanes(rows, boundaries, headers) {
  if (!boundaries?.length) return [];

  /*
   * IMPORTANT: the header is the structural source of truth.
   *
   * Earlier versions tried to move each column boundary toward repeated word
   * starts found in transaction rows. That is unsafe: a name such as
   * "DAVID OBI" naturally has two different X positions, and a long
   * description can contain many apparent "column starts". The result was
   * columns disappearing or whole cells shifting one column to the right.
   *
   * PDF.js gives us the real X/Y positions of the text items. We therefore
   * keep the header centres fixed and use the midpoint between neighbouring
   * header centres as the structural boundary. Repeated row alignment is
   * retained as diagnostic evidence only; it can never delete or move a
   * header-defined column.
   */
  const rowData = (rows || []).map(row => ({
    row,
    tokens: row.items.flatMap(expandSpatialTokens)
      .filter(t => String(t.text || '').trim())
      .sort((a,b) => a.x - b.x || a.right - b.right)
  })).filter(r => r.tokens.length);

  const rowCount = Math.max(1, rowData.length);
  const centers = boundaries.map((b, i) => {
    const c = Number(b.headerCenterX ?? b.center);
    return Number.isFinite(c) ? c : Number(b.headerX) || 0;
  });

  // Monotonic repair only protects against malformed header coordinates. It
  // never invents an extra column.
  for (let i = 1; i < centers.length; i++) {
    if (!(centers[i] > centers[i - 1])) centers[i] = centers[i - 1] + 1;
  }

  return boundaries.map((b, i) => {
    const left = i === 0
      ? (Number.isFinite(Number(b.headerX)) ? Number(b.headerX) : centers[i] - 40)
      : (centers[i - 1] + centers[i]) / 2;
    const right = i === boundaries.length - 1
      ? Math.max(Number(b.headerEnd) || centers[i] + 40, centers[i] + 40)
      : (centers[i] + centers[i + 1]) / 2;

    const kind = headerColumnKind(headers?.[i] || b.header || '');
    const allTokens = rowData.flatMap(r => r.tokens);
    const numericTokens = allTokens.filter(t => kind === 'numeric' && Number.isFinite(t.right));
    const rightClusters = clusterEvidence(numericTokens.map(t => t.right), 4);

    // Count rows whose tokens have meaningful content inside this structural
    // band. This is confidence metadata only, never a reason to remove a
    // column or row.
    let rowSupport = 0;
    for (const r of rowData) {
      if (r.tokens.some(t => t.center >= left && t.center < right)) rowSupport++;
    }

    return {
      ...b,
      index: i,
      kind,
      anchorX: centers[i],
      laneLeft: left,
      laneRight: right,
      repeatedLeft: rowSupport,
      rowSupport,
      laneConfidence: rowSupport / rowCount,
      rightClusters: rightClusters.slice(0, 5),
      alignmentModel: 'header-center-midpoint',
      fallback: false
    };
  });
}

function assignRowTokensToXLanes(row, lanes, headers) {
  const tokens = row?.items?.flatMap(expandSpatialTokens)
    .filter(t => String(t.text || '').trim())
    .sort((a,b) => a.x - b.x || a.right - b.right) || [];
  if (!tokens.length || !lanes.length) return [];

  const groups = Array.from({ length: lanes.length }, () => []);

  for (const token of tokens) {
    const center = Number.isFinite(Number(token.center))
      ? Number(token.center)
      : (Number(token.x) || 0) + (Number(token.width) || 0) / 2;

    // Primary rule: token centre belongs to the header-defined structural
    // band. This preserves every real column and keeps words such as
    // "DAVID" + "OBI" together when both are inside Name's band.
    let col = lanes.findIndex(l => center >= l.laneLeft && center < l.laneRight);

    // A token can sit just outside a band because its PDF.js text box is
    // right/left aligned. Use overlap as a second, deterministic rule.
    if (col < 0) {
      let best = -1;
      let bestOverlap = 0;
      const left = Number(token.x) || center;
      const right = Number(token.right) || center;
      lanes.forEach((lane, i) => {
        const overlap = Math.max(0, Math.min(right, lane.laneRight) - Math.max(left, lane.laneLeft));
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = i;
        }
      });
      col = best >= 0 ? best : (center < lanes[0].laneLeft ? 0 : lanes.length - 1);
    }

    groups[col].push(token.text);
  }

  // IMPORTANT: do not drop empty columns. The caller creates the full header
  // length array; returning only populated groups here is fine as long as all
  // populated groups retain their original column index.
  return groups
    .map((parts, col) => ({
      col,
      text: parts.join(' ').trim(),
      positionConfidence: lanes[col].laneConfidence >= 0.55
        ? 'coordinate-alignment'
        : 'header-alignment'
    }))
    .filter(part => part.text);
}


function rowLooksLikeRepeatedHeader(cells, headers) {
  const normalizedCells = cells.map(c => normalizeHeaderWord(c));
  const normalizedHeaders = headers.map(h => normalizeHeaderWord(h));

  let matches = 0;
  normalizedHeaders.forEach((h, i) => {
    if (h && normalizedCells[i] && normalizedCells[i] === h) matches++;
  });

  return matches >= Math.max(2, Math.ceil(headers.length * 0.5));
}



function stripExtractionArtifacts(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[□■�￼]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanExtractedCell(value, header = '') {
  let text = stripExtractionArtifacts(value);
  const h = normalizeHeaderLabel(header);
  if (!text) return '';

  // A lone dash is a missing cell, never evidence.
  if (/^[-–—_]+$/.test(text)) return '';

  if (h === 'credit' || h === 'debit' || h === 'balance') {
    text = text.replace(/^[|Il]+\s*(?=(?:₦|NGN|N)\b)/i, '');
    text = text.replace(/^[-–—]+\s*/, '').trim();
  }
  if (h === 'reference') {
    text = text.replace(/^[|IlOoNn]+\s*(?=\d{5,})/i, '').trim();
  }
  return text;
}
function cleanRowCells(cells, headers) {
  return cells.map((v,i)=>cleanExtractedCell(v, headers[i] || ''));
}

function parseNumericAmountCandidate(raw) {
  let c = String(raw || '')
    .replace(/[₦$€£]/g, '')
    .replace(/\b(?:NGN|USD|EUR|GBP)\b/gi, '')
    .replace(/[^0-9.,\s]/g, '')
    .trim();
  if (!c) return null;

  // Spaces between thousands are valid OCR output: 18 500 -> 18500.
  if (/^\d{1,3}(?:\s\d{3})+(?:[.,]\d{1,2})?$/.test(c)) c = c.replace(/\s+/g, ',');
  else c = c.replace(/\s+/g, '');

  // Nigerian statement/payment amounts normally use comma thousands and a
  // decimal fraction. Handle the common European-style alternative too.
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(c)) {
    c = c.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(c)) {
    c = c.replace(/,/g, '');
  } else {
    c = c.replace(/,/g, '');
  }

  const n = Number.parseFloat(c);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function amountCandidatesFromText(raw) {
  const source = stripExtractionArtifacts(raw);
  if (!source || !/\d/.test(source)) return [];
  const found = new Map();

  const add = (rawValue, strength, reason) => {
    const value = parseNumericAmountCandidate(rawValue);
    if (value === null) return;
    const integerDigits = String(Math.trunc(value)).replace(/\D/g, '');

    // Never treat common non-money numeric artifacts as payment amounts.
    // Dates, times, phone/account/reference IDs are especially dangerous.
    if (integerDigits.length < 2 || integerDigits.length > 7) return;
    if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(String(rawValue).trim())) return;

    const key = value.toFixed(2);
    const previous = found.get(key);
    const evidence = { value, strength, raw: String(rawValue), reason, repaired: reason === 'currency-labelled-ocr-repair' };
    if (!previous || strength > previous.strength) found.set(key, evidence);
  };

  // Currency-labelled numbers are the strongest evidence.
  const currency = /(?:₦|NGN|\bN\b|USD|EUR|GBP|[$€£])\s*([0-9OoIl][0-9OoIl,\.\s]{0,20})/gi;
  let m;
  while ((m = currency.exec(source))) {
    const fragment = m[1].trim();
    const repairedFragment = fragment.replace(/[Oo]/g, '0').replace(/(?<=^|[\s,])(?:[Il])(?=\d)/g, '1');
    const candidate = repairedFragment.match(/^\d{1,3}(?:(?:,|\.)\d{3})*(?:[.,]\d{1,2})?$/) ||
      repairedFragment.match(/^\d{1,3}(?:\s\d{3})+(?:[.,]\d{1,2})?$/);
    if (candidate) add(candidate[0], fragment === repairedFragment ? 100 : 72, fragment === repairedFragment ? 'currency-labelled' : 'currency-labelled-ocr-repair');
  }

  // Grouped amounts without a currency symbol. These are much safer than
  // arbitrary digit runs because bank amounts commonly use separators.
  const grouped = source.match(/(?<![\d,\.])\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?(?![\d,\.])/g) || [];
  grouped.forEach(v => add(v, 82, 'grouped-number'));

  // Plain 4–7 digit numbers can be payment amounts, but deliberately score
  // them weakly. They are only useful when the statement matcher asks for the
  // exact same value; long reference IDs are excluded.
  const plain = source.match(/(?<![\d,:./-])\d{4,7}(?:\.\d{1,2})?(?![\d,:./-])/g) || [];
  plain.forEach(v => add(v, 48, 'plain-number'));

  const values = [...found.values()];
  // If OCR repair recovered a statement-sized value, do not expose a smaller
  // suffix such as 8,500 that came from the same corrupted token (e.g. l8,500).
  const repaired = values.filter(v => v.reason === 'currency-labelled-ocr-repair');
  const filtered = values.filter(v => !repaired.some(r =>
    v.value !== r.value &&
    String(Math.trunc(r.value)).endsWith(String(Math.trunc(v.value)))
  ));
  return filtered.sort((a,b)=>b.strength-a.strength || b.value-a.value);
}
function extractAmount(raw) {
  const c = amountCandidatesFromText(raw);
  return c.length ? c[0].value : null;
}

function mergeContinuationRows(rows,boundaries,headers){
  if(!rows.length||!boundaries.length)return rows;

  // PDF.js can place a single logical transaction on several visual Y rows.
  // Do NOT use arbitrary digits as proof that a row is a new transaction:
  // narration/reference text commonly contains numbers such as 2070I7SV or
  // 628749317248. Instead, inspect the actual structural columns.
  const columnIndexForToken = token => {
    const center = Number.isFinite(Number(token.center))
      ? Number(token.center)
      : (Number(token.x)||0) + (Number(token.width)||0)/2;
    let col = boundaries.findIndex(b => center >= b.x && center < b.end);
    if (col >= 0) return col;
    let best=-1, overlap=0;
    for(let i=0;i<boundaries.length;i++){
      const left=Math.max(Number(token.x)||0, Number(boundaries[i].x)||0);
      const right=Math.min(Number(token.right)||((Number(token.x)||0)+(Number(token.width)||0)), Number(boundaries[i].end)||0);
      const o=Math.max(0,right-left);
      if(o>overlap){overlap=o;best=i;}
    }
    return best;
  };

  const tokensFor = row => row.items.flatMap(expandSpatialTokens).filter(t=>String(t.text||'').trim());
  const semantic = headers.map(h=>normalizeHeaderLabel(h||''));
  const dateCols = semantic.map((h,i)=>({h,i})).filter(x=>x.h==='date'||x.h==='datetime'||x.h==='time').map(x=>x.i);
  const moneyCols = semantic.map((h,i)=>({h,i})).filter(x=>['credit','debit','balance','amount','inflow','outflow'].includes(x.h)).map(x=>x.i);
  const textCols = semantic.map((h,i)=>({h,i})).filter(x=>x.h==='name'||x.h==='description'||x.h==='reference'||x.h==='channel'||x.h==='details').map(x=>x.i);

  const rowHasDate = row => tokensFor(row).some(t=>{
    const col=columnIndexForToken(t);
    return dateCols.includes(col) && looksLikeDate(t.text);
  });

  const numericAmount = text => {
    const s=String(text||'').trim();
    if(!s || /^(?:-|—|–|n\/a)$/i.test(s)) return false;
    // Only treat clearly amount-like values as monetary evidence. Long
    // references and alphanumeric narration IDs therefore cannot block a
    // continuation merge.
    return /^(?:₦|NGN|N|\$|€|£)?\s*\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(s) ||
           /^(?:₦|NGN|N|\$|€|£)\s*\d+(?:\.\d{1,2})?$/.test(s) ||
           /^\d+(?:\.\d{1,2})?$/.test(s) && s.replace(/\D/g,'').length<=7;
  };

  const rowHasMoneyInStructuralColumn = row => tokensFor(row).some(t=>{
    const col=columnIndexForToken(t);
    return moneyCols.includes(col) && numericAmount(t.text);
  });

  const rowHasMeaningfulText = row => tokensFor(row).some(t=>{
    const col=columnIndexForToken(t);
    return textCols.includes(col) && /[A-Za-z]/.test(String(t.text||''));
  });

  const rowStartsInTextColumn = row => tokensFor(row).some(t=>{
    const col=columnIndexForToken(t);
    return textCols.includes(col);
  });

  const yDistances=[];
  for(let i=1;i<rows.length;i++){
    const d=Math.abs(Number(rows[i-1].centerY)-Number(rows[i].centerY));
    if(Number.isFinite(d)&&d>0)yDistances.push(d);
  }
  const typicalGap=Math.max(4, medianNumber(yDistances)||10);
  const maxContinuationGap=Math.max(18, Math.min(30, typicalGap*2.8));

  const out=[];
  for(const row of rows){
    if(!out.length){out.push(row);continue;}

    const prev=out[out.length-1];
    const gap=Math.abs(Number(prev.centerY)-Number(row.centerY));
    const text=String(row.items.map(x=>x.text||'').join(' ')).replace(/\s+/g,' ').trim();

    const currentHasDate=rowHasDate(row);
    const currentHasMoney=rowHasMoneyInStructuralColumn(row);
    const currentHasText=rowHasMeaningfulText(row);
    const startsInText=rowStartsInTextColumn(row);

    // A continuation must look like text belonging to an existing text cell,
    // must not introduce a new date, and must not introduce a monetary value
    // in a real amount column. Numbers embedded in narration/reference text
    // are therefore harmless.
    const previousIsTransaction=rowHasDate(prev) || rowHasMoneyInStructuralColumn(prev) || rowHasMeaningfulText(prev);
    const continuation = Boolean(
      text &&
      gap <= maxContinuationGap &&
      !currentHasDate &&
      !currentHasMoney &&
      currentHasText &&
      startsInText &&
      previousIsTransaction
    );

    if(continuation){
      prev.items.push(...row.items);
      // Keep the original X ordering within each visual line while retaining
      // the Y coordinate so later tokenization can reconstruct the text in
      // visual order.
      prev.items.sort((a,b)=>Number(b.centerY)-Number(a.centerY)||Number(a.x)-Number(b.x));
      prev.centerY=(prev.items.reduce((sum,x)=>sum+(Number(x.centerY)||0),0)/prev.items.length);
    }else{
      out.push(row);
    }
  }
  return out;
}

// Collapse a multi-line header into one logical header row without requiring
// every header label to share the same PDF Y coordinate. This is deliberately
// separate from body continuation logic.
function mergeHeaderContinuationRows(rows, headerIdx){
  if(headerIdx<0 || headerIdx>=rows.length) return {rows, headerIdx};
  const all=[...rows];
  const base=all[headerIdx];
  const heights=all.map(r=>Math.abs(Number(r.centerY)||0));
  const gaps=[];
  for(let i=1;i<heights.length;i++){const d=Math.abs(heights[i]-heights[i-1]);if(d>0)gaps.push(d);}
  const typicalGap=Math.max(4,medianNumber(gaps)||10);
  const maxGap=Math.max(18,Math.min(30,typicalGap*2.8));
  const headerWords=/^(?:date|time|value|trans\.?|transaction|posting|description|narration|name|credit|debit|balance|amount|reference|ref|channel|no\.?|number|details|particulars?|remarks?)$/i;

  const isContinuation=row=>{
    const cells=groupHeaderCells(row);
    if(!cells.length || cells.length>Math.max(3,groupHeaderCells(base).length)) return false;
    const text=cells.map(c=>c.text).join(' ').trim();
    if(!text || text.length>80) return false;
    if(row.items.some(it=>looksLikeDate(it.text))) return false;
    const words=text.split(/\s+/).filter(Boolean);
    return words.length<=8 && words.some(w=>headerWords.test(w.replace(/[.:]/g,'')));
  };

  // Usually the second line is below the semantic header. Also allow a small
  // preceding line because some PDFs position a stacked header unusually.
  let start=headerIdx, end=headerIdx;
  for(let i=headerIdx+1;i<all.length;i++){
    const gap=Math.abs(Number(all[i].centerY)-Number(all[end].centerY));
    if(gap<=maxGap && isContinuation(all[i])) end=i; else break;
  }
  for(let i=headerIdx-1;i>=0;i--){
    const gap=Math.abs(Number(all[i].centerY)-Number(all[start].centerY));
    if(gap<=maxGap && isContinuation(all[i])) start=i; else break;
  }

  if(start===headerIdx && end===headerIdx) return {rows,headerIdx};
  const combined={...base,items:[]};
  for(let i=start;i<=end;i++) combined.items.push(...all[i].items);
  combined.items.sort((a,b)=>Number(a.x)-Number(b.x)||Number(b.centerY)-Number(a.centerY));
  combined.centerY=(combined.items.reduce((sum,x)=>sum+(Number(x.centerY)||0),0)/Math.max(1,combined.items.length));
  const next=all.filter((_,i)=>i<start||i>end);
  next.splice(start,0,combined);
  return {rows:next,headerIdx:start};
}

function headersSemanticallyCompatible(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((value, index) => {
    const left = normalizeHeaderLabel(value);
    const right = normalizeHeaderLabel(b[index]);
    return left === right || normalizeHeaderWord(value) === normalizeHeaderWord(b[index]);
  });
}

function findRepeatedSchemaHeaderRow(rows, expectedHeaders) {
  if (!Array.isArray(rows) || !Array.isArray(expectedHeaders) || !expectedHeaders.length) return -1;

  for (let i = 0; i < rows.length; i++) {
    const cells = groupHeaderCells(rows[i]);
    if (cells.length !== expectedHeaders.length) continue;
    if (headersSemanticallyCompatible(cells.map(c => c.text), expectedHeaders)) return i;
  }
  return -1;
}

function buildTableFromPage(pageItems, schemaHint = null) {
  const pageModel = (pageItems && !Array.isArray(pageItems) && Array.isArray(pageItems.items))
    ? build2DPageModel(pageItems)
    : build2DPageModel({ items: Array.isArray(pageItems) ? pageItems : [] });
  let rows = pageModel.rows;

  let headerIdx = -1;
  let boundaries = [];
  let headers = [];

  if (schemaHint?.headers?.length && schemaHint?.boundaries?.length) {
    headers = [...schemaHint.headers];
    boundaries = schemaHint.boundaries.map(b => ({ ...b }));

    // A continuation page may have no repeated header at all. Do NOT run the
    // generic header detector here because a normal transaction row can look
    // like a header (date + amount + description) and would then be discarded.
    headerIdx = findRepeatedSchemaHeaderRow(rows, headers);
  } else {
    headerIdx = detectHeaderRow(rows);
    if (headerIdx === -1) return null;

    // A header may be physically stacked across multiple PDF Y coordinates.
    // Collapse those visual header rows into one logical row before deriving
    // column boundaries. This does not alter transaction rows.
    const mergedHeader = mergeHeaderContinuationRows(rows, headerIdx);
    rows = mergedHeader.rows;
    headerIdx = mergedHeader.headerIdx;

    const headerCells = groupHeaderCells(rows[headerIdx]);
    if (headerCells.length < 3) return null;

    headers = headerCells.map(c => c.text);
    boundaries = buildColumnBoundaries(rows[headerIdx]);

    // Never manufacture blank "Column N" names here. If the PDF did not
    // expose a real header, that position is not considered a column.
    if (headers.length !== boundaries.length) return null;
  }

  rows = mergeContinuationRows(rows, boundaries, headers);

  const dataStart = headerIdx >= 0 ? headerIdx + 1 : 0;
  const tableRows = [];
  const dataRowsForLaneLearning = rows.slice(dataStart).filter(row => row.items?.length);
  const xLanes = buildGlobalXLanes(dataRowsForLaneLearning, boundaries, headers);

  for (let i = dataStart; i < rows.length; i++) {
    const cells = new Array(headers.length).fill("");

    // Reconstruct the whole physical row at once. This lets repeated X
    // coordinates determine where a cell starts and prevents a long
    // Description from spilling into Credit merely because its last word is
    // physically closer to the Credit header.
    const parts = assignRowTokensToXLanes(rows[i], xLanes, headers);
    parts.forEach(part => {
      const col = part.col;
      if (col < 0 || col >= cells.length) return;
      const value = String(part.text || "").trim();
      if (!value) return;
      cells[col] = cells[col] ? `${cells[col]} ${value}` : value;
    });

    const cleaned = cleanRowCells(cells, headers);

    if (!cleaned.some(Boolean)) continue;
    if (rowLooksLikeRepeatedHeader(cleaned, headers)) continue;

    // Preserve the complete physical row. Do not discard it merely because
    // date/credit recognition failed at extraction time: the seller will
    // explicitly choose Date / Name-Description / Credit later, and a shifted
    // or partially formatted row must not silently disappear from the preview.
    // Very small one-cell page furniture is still ignored.
    if (cleaned.filter(Boolean).length < 2) continue;

    tableRows.push(cleaned);
  }

  return {
    headers,
    rows: tableRows,
    boundaries,
    xLanes
  };
}

async function detectStatementTables() {
  renderVerifyProgress("table", "Detecting the transactions table…");

  const tables = [];

  let canonicalSchema = null;

  for (let i = 0; i < verifyState.statementText.length; i++) {
    // The first real transaction table establishes the exact column schema.
    // Continuation pages reuse it instead of inventing new columns from
    // arbitrary PDF.js text fragments.
    const table = buildTableFromPage(
      verifyState.statementText[i],
      canonicalSchema
    );

    if (table && table.rows.length) {
      if (!canonicalSchema) {
        canonicalSchema = {
          headers: [...table.headers],
          boundaries: table.boundaries.map(b => ({ ...b })),
          xLanes: (table.xLanes || []).map(l => ({ ...l }))
        };
      }

      // Only tables with the same real header structure belong to the same
      // statement transaction table. Page furniture is ignored.
      const sameSchema = headersSemanticallyCompatible(
        table.headers,
        canonicalSchema.headers
      );

      if (sameSchema) tables.push(table);
    }

    updateVerifyProgress(
      `Scanning statement page ${i + 1} of ${verifyState.statementText.length}…`,
      i + 1,
      verifyState.statementText.length
    );
  }

  verifyState.statementTables = tables;

  if (!tables.length) {
    showVerifyError(
      "Couldn't detect a transaction table in this statement. The PDF needs selectable text with a recognizable table header."
    );
    return;
  }

  renderStatementColumnPicker();
}

/* =========================================================
   STEP 2 — SELLER SELECTS DATE / NAME-DESCRIPTION / CREDIT
========================================================= */

function renderStatementColumnPicker() {
  const body = document.getElementById("verifyBody");
  const table = verifyState.statementTables[0];

  // FIXED: filter(Boolean) was creating a mismatch between the displayed
  // option index (position in the filtered array) and the actual column
  // index inside table.rows (position in the full array).  When the seller
  // selected e.g. "Credit" at filtered-index 2, confirmStatementColumns()
  // stored creditCol=2 but the data lived at original-index 3, so every
  // subsequent cell lookup read the wrong column.
  //
  // We now use the UNFILTERED headers array and show every column.
  // Empty-text entries (rare with the new groupHeaderCells) get a clear
  // "(column N)" placeholder so the seller can still identify them.
  const headers = table.headers;

  const selectOptions = (id, preferredFn) => headers.map((h, i) =>
    `<option value="${i}" ${preferredFn(h, i) ? "selected" : ""}>
      ${escapeHtml(h || `(column ${i + 1})`)}
    </option>`
  ).join("");

  body.innerHTML = `
    <h2>Select Statement Columns</h2>
    <p class="verify-sub">
      Select the three primary columns yourself. These choices are authoritative:
      <strong>Date</strong>, <strong>Name / Description</strong>, and <strong>Credit</strong>.
      Other columns will still be retained as supporting evidence.
    </p>

    <div class="verify-column-selects">
      <div class="form-group">
        <label for="verifyDateColumn">Date column</label>
        <select id="verifyDateColumn">
          ${selectOptions("date", h => {
            const n = normalizeHeaderWord(h);
            return n === "date" || n === "valuedate" || n.includes("date");
          })}
        </select>
      </div>

      <div class="form-group">
        <label for="verifyNameColumn">Name / Description column</label>
        <select id="verifyNameColumn">
          ${selectOptions("name", h => {
            const n = normalizeHeaderWord(h);
            return n.includes("description") || n.includes("narration") ||
                   n.includes("details") || n.includes("name") ||
                   n.includes("remarks") || n.includes("particular");
          })}
        </select>
      </div>

      <div class="form-group">
        <label for="verifyCreditColumn">Credit column</label>
        <select id="verifyCreditColumn">
          ${selectOptions("credit", h =>
            VERIFY_CREDIT_HEADER_SYNONYMS.includes(normalizeHeaderWord(h))
          )}
        </select>
      </div>
    </div>

    <div class="verify-table-preview">
      <div class="verify-preview-title">Statement preview</div>
      <div class="verify-preview-scroll">
        <table>
          <thead>
            <tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr>
          </thead>
          <tbody>
            ${table.rows.slice(0, 8).map(row => `
              <tr>${row.map(c => `<td>${escapeHtml(c)}</td>`).join("")}</tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <small>Preview from the first detected transaction table. The selected columns are applied to all detected statement pages with the same table structure.</small>
    </div>

    <div id="verifyColumnError" class="verify-error hidden"></div>
    <button class="verify-btn-primary" onclick="confirmStatementColumns()">Continue</button>
  `;
}

function confirmStatementColumns() {
  const dateCol = Number(document.getElementById("verifyDateColumn")?.value);
  const nameCol = Number(document.getElementById("verifyNameColumn")?.value);
  const creditCol = Number(document.getElementById("verifyCreditColumn")?.value);
  const error = document.getElementById("verifyColumnError");

  if (
    !Number.isInteger(dateCol) ||
    !Number.isInteger(nameCol) ||
    !Number.isInteger(creditCol) ||
    dateCol === nameCol ||
    dateCol === creditCol ||
    nameCol === creditCol
  ) {
    error.textContent = "Select three different columns for Date, Name / Description, and Credit.";
    error.classList.remove("hidden");
    return;
  }

  verifyState.selectedColumns = { dateCol, nameCol, creditCol };
  processStatementRows();
}

/* =========================================================
   STEP 3 — PRESERVE ALL ROW CONTENT + FILTER CREDIT
========================================================= */

function processStatementRows() {
  renderVerifyProgress("filter", "Filtering statement rows by Credit…");

  const selected = verifyState.selectedColumns;
  const statementRows = [];
  const validRows = [];
  const skippedRows = [];
  let globalRowNumber = 0;

  verifyState.statementTables.forEach((table, tableIndex) => {
    table.rows.forEach(cells => {
      globalRowNumber++;

      const allCells = cells.map((value, index) => ({
        columnIndex: index,
        value: String(value || "").trim()
      })).filter(c => c.value);

      const rawDate = cells[selected.dateCol] || "";
      const rawName = cells[selected.nameCol] || "";
      const rawCredit = cells[selected.creditCol] || "";

      const credit = extractAmount(rawCredit);
      const dateInfo = extractDate(rawDate);

      const row = {
        id: `statement-${globalRowNumber}`,
        rowNumber: globalRowNumber,
        tableIndex,
        cells: allCells,
        rawCells: [...cells],
        dateRaw: String(rawDate).trim(),
        nameRaw: String(rawName).trim(),
        creditRaw: String(rawCredit).trim(),
        date: dateInfo ? dateInfo.date : null,
        time: dateInfo ? dateInfo.time : null,
        credit,
        status: null,
        skipReason: null
      };

      // A payment candidate must have a valid positive Credit.
      if (credit === null || credit <= 0) {
        row.status = "SKIPPED";
        row.skipReason = "No valid positive Credit";
        skippedRows.push(row);
      } else {
        row.status = "PENDING";
        validRows.push(row);
      }

      statementRows.push(row);
    });
  });

  verifyState.statementRows = statementRows;
  verifyState.validStatementRows = validRows;
  verifyState.skippedStatementRows = skippedRows;

  updateVerifyProgress(
    `Statement rows: ${statementRows.length.toLocaleString()} detected • ${validRows.length.toLocaleString()} valid Credit • ${skippedRows.length.toLocaleString()} skipped`,
    statementRows.length,
    Math.max(1, statementRows.length),
    `Valid positive Credit rows: ${validRows.length.toLocaleString()} • Skipped rows: ${skippedRows.length.toLocaleString()}`
  );

  const pendingPayments = Array.isArray(allOrders)
    ? allOrders.filter(o => o.status === "pending" && o.paymentProof)
    : [];

  // One OCR record per unique payment-proof image.
  const seen = new Set();
  verifyState.pendingPayments = pendingPayments.filter(order => {
    const id = String(order.paymentProof);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  renderCreditFilterSummary();
}

function renderCreditFilterSummary() {
  const body = document.getElementById("verifyBody");

  body.innerHTML = `
    <h2>Statement Ready</h2>
    <p class="verify-sub">
      The transaction table has been reconstructed from the PDF and the selected
      Date, Name / Description and Credit fields will be used as primary evidence.
      Additional statement content is retained for deeper comparison.
    </p>

    <div class="verify-info-box">
      <strong>Verification method</strong><br>
      Each payment image is checked against the best available unused statement
      transaction. The complete OCR text and the complete statement row are compared,
      not just the three primary fields.
    </div>

    <button class="verify-btn-primary" onclick="startImageProcessing()">Continue to payment images</button>
  `;
}

/* =========================================================
   OCR / SEARCHABLE PAYMENT IMAGE COLLECTION
========================================================= */

function paymentImageUrl(fileId) {
  return `https://nyc.cloud.appwrite.io/v1/storage/buckets/${VERIFY_STORAGE_BUCKET}/files/${encodeURIComponent(fileId)}/view?project=${VERIFY_PROJECT_ID}`;
}

async function startImageProcessing() {
  if (!verifyState.pendingPayments.length) {
    showVerifyNoImages();
    return;
  }

  renderVerifyProgress(
    "ocr",
    "Preparing payment images…",
    {
      current: 0,
      total: verifyState.pendingPayments.length,
      remaining: verifyState.pendingPayments.length,
      percent: 0
    }
  );

  let worker = null;
  let activeImageNumber = 0;
  const totalImages = verifyState.pendingPayments.length;

  try {
    if (Tesseract && typeof Tesseract.createWorker === "function") {
      worker = await Tesseract.createWorker("eng", 1, {
        logger: message => {
          if (!message || activeImageNumber < 1) return;
          const inner = Math.max(0, Math.min(1, Number(message.progress) || 0));
          const overall = ((activeImageNumber - 1 + inner) / totalImages) * 100;
          const label = message.status ? String(message.status).replace(/_/g, " ") : "recognizing text";
          updateVerifyProgress(
            `OCR image ${activeImageNumber} of ${totalImages} • ${label}`,
            Math.round(overall),
            100,
            `Payment image ${activeImageNumber} of ${totalImages} • OCR engine ${Math.round(inner * 100)}%`
          );
        }
      });
      verifyState.ocrWorker = worker;
    }
  } catch (err) {
    console.warn("Could not create persistent OCR worker; using Tesseract.recognize.", err);
  }

  const images = [];

  for (let i = 0; i < verifyState.pendingPayments.length; i++) {
    const order = verifyState.pendingPayments[i];
    const imageId = String(order.paymentProof);
    const current = i + 1;
    activeImageNumber = current;

    updateVerifyProgress(
      `OCR processing payment image ${current} of ${verifyState.pendingPayments.length}…`,
      current,
      verifyState.pendingPayments.length,
      `Current payment image ${current.toLocaleString()} • Remaining ${(verifyState.pendingPayments.length - current).toLocaleString()}`
    );

    try {
      const image = await ocrPaymentImage(order, worker);
      images.push(image);
    } catch (err) {
      console.error(`OCR failed for payment image ${imageId}:`, err);
      images.push({
        id: imageId,
        orderIds: [order.$id],
        order,
        rawText: "",
        normalizedText: "",
        tokens: [],
        amounts: [],
        dates: [],
        times: [],
        ocrError: true
      });
    }

    // Yield to the browser so progress text can repaint.
    await nextFrame();
  }

  if (worker) {
    try {
      await worker.terminate();
    } catch (_) {}
    verifyState.ocrWorker = null;
  }

  verifyState.ocrImages = mergeDuplicateImageRecords(images);

  renderVerifyProgress(
    "index",
    "Building searchable indexes…",
    {
      current: 0,
      total: Math.max(1, verifyState.ocrImages.length),
      remaining: verifyState.ocrImages.length,
      percent: 0,
      extra: `Preparing ${verifyState.ocrImages.length.toLocaleString()} payment images for matching`
    }
  );

  await buildImageIndexes();
  await nextFrame();
  await runStatementFirstVerification();
}

async function ocrPaymentImage(order,worker){
  const imageId=String(order.paymentProof),url=paymentImageUrl(imageId),texts=[];
  const recognize=async(source,psm)=>{if(worker){try{await worker.setParameters({tessedit_pageseg_mode:String(psm)});}catch(_){}const r=await worker.recognize(source);return r?.data?.text||"";}const r=await Tesseract.recognize(source,"eng",{tessedit_pageseg_mode:String(psm)});return r?.data?.text||"";};
  texts.push(await recognize(url,6)); let q=buildSearchableImageRecord(texts.join("\n"));
  const weak=q.amounts.length===0||q.dates.length===0||q.amounts.some(a=>a>0&&a<100);
  if(weak)try{texts.push(await recognize(url,11));}catch(e){console.warn("Sparse OCR pass failed",e);}
  q=buildSearchableImageRecord(texts.join("\n"));
  if(q.amounts.length===0||q.dates.length===0)try{texts.push(await recognize(url,12));}catch(e){console.warn("Block OCR pass failed",e);}
  const rawText=texts.filter(Boolean).join("\n--- OCR PASS ---\n"); q=buildSearchableImageRecord(rawText);
  // Keep raw OCR evidence separate from repaired evidence. A repair may only
  // become searchable if it can be justified against an actual statement
  // credit. This prevents OCR fragments such as 4, 8, 0, or a reference ID
  // from silently becoming a payment amount.
  const statementCredits = new Set(
    (verifyState.validStatementRows || [])
      .filter(r => Number(r.credit) > 0)
      .map(r => Number(r.credit).toFixed(2))
  );

  const evidence = new Map((q.amountEvidence || []).map(e => [e.value.toFixed(2), e]));
  // OCR-only numeric repairs are not trusted unless the repaired value exists
  // in the statement's actual Credit column.
  for (const [key, e] of [...evidence.entries()]) {
    if (e.repaired && !statementCredits.has(key)) evidence.delete(key);
  }
  const rawCurrency = rawText.match(/(?:₦|NGN|\bN\b)\s*[0-9][0-9,\.\s]{3,24}/gi) || [];
  rawCurrency.forEach(fragment => {
    const digits = fragment.replace(/\D/g, '');
    if (digits.length < 4 || digits.length > 7) return;
    const direct = parseNumericAmountCandidate(fragment);
    if (direct !== null && statementCredits.has(direct.toFixed(2))) return;

    // Conservative OCR repair: only remove ONE leading digit when the result
    // is an exact statement credit and the original is not.
    if (digits.length >= 5) {
      const repairedValue = Number(digits.slice(1));
      if (Number.isFinite(repairedValue) && statementCredits.has(repairedValue.toFixed(2))) {
        evidence.set(repairedValue.toFixed(2), {
          value: repairedValue,
          strength: 55,
          raw: fragment,
          reason: 'statement-confirmed-ocr-repair',
          repaired: true
        });
      }
    }
  });

  // If an exact statement-confirmed repair exists, discard the unconfirmed
  // one-leading-digit value that caused it. This is what prevents a receipt
  // like OCR='₦418,500' from being displayed/matched as 418,500 when the
  // statement actually contains ₦18,500.
  for (const e of [...evidence.values()]) {
    if (!e.repaired) {
      const key = Number(e.value).toFixed(2);
      const directIsStatementValue = statementCredits.has(key);
      const repairedExists = [...evidence.values()].some(r => r.repaired && r.value !== e.value);
      if (!directIsStatementValue && repairedExists && e.reason === 'currency-labelled') {
        evidence.delete(key);
      }
    }
  }

  q.amountEvidence = [...evidence.values()];
  q.amounts = q.amountEvidence.map(e => e.value);
  return {id:imageId,orderIds:[order.$id],order,rawText,normalizedText:q.normalizedText,tokens:q.tokens,amounts:q.amounts,amountEvidence:q.amountEvidence,dates:q.dates,times:q.times,ocrError:false};
}

function mergeDuplicateImageRecords(images){
  const map=new Map();
  images.forEach(img=>{const existing=map.get(img.id);if(!existing){map.set(img.id,img);return;}existing.orderIds=[...new Set([...(existing.orderIds||[]),...(img.orderIds||[])])];existing.amounts=[...new Set([...(existing.amounts||[]),...(img.amounts||[])])];existing.amountEvidence=[...(existing.amountEvidence||[]),...(img.amountEvidence||[])];existing.dates=[...new Set([...(existing.dates||[]),...(img.dates||[])])];existing.times=[...new Set([...(existing.times||[]),...(img.times||[])])];});
  return [...map.values()];
}

/* =========================================================
   NORMALIZATION / TOKENIZATION
========================================================= */

function normalizeYear(y) {
  y = String(y);
  if (y.length === 2) return (Number(y) > 50 ? "19" : "20") + y;
  return y;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function extractDate(raw) {
  if (!raw) return null;
  const text = String(raw).trim();

  let time = null;
  const timeMatch = text.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
  if (timeMatch) {
    time = `${pad2(timeMatch[1])}:${timeMatch[2]}:${timeMatch[3] || "00"}`;
  }

  let m = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    return {
      date: `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`,
      time
    };
  }

  m = text.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})\b/);
  if (m) {
    const mon = MONTH_NAMES[m[2].slice(0, 3).toLowerCase()];
    if (mon) {
      return {
        date: `${normalizeYear(m[3])}-${mon}-${pad2(m[1])}`,
        time
      };
    }
  }

  m = text.match(/\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})\b/);
  if (m) {
    const mon = MONTH_NAMES[m[1].slice(0, 3).toLowerCase()];
    if (mon) {
      return {
        date: `${normalizeYear(m[3])}-${mon}-${pad2(m[2])}`,
        time
      };
    }
  }

  m = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
  if (m) {
    let day = Number(m[1]);
    let month = Number(m[2]);

    if (month > 12 && day <= 12) {
      [day, month] = [month, day];
    }

    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return {
        date: `${normalizeYear(m[3])}-${pad2(month)}-${pad2(day)}`,
        time
      };
    }
  }

  return null;
}

function extractAllDates(text) {
  const found = new Set();
  const source = String(text || "");

  const candidates = source.match(
    /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2}-\d{1,2}-\d{2,4}\b|\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}\b|\b[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4}\b/gi
  ) || [];

  candidates.forEach(c => {
    const d = extractDate(c);
    if (d) found.add(d.date);
  });

  return [...found];
}

function extractAllTimes(text) {
  const found = new Set();
  const matches = String(text || "").match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g) || [];

  matches.forEach(t => {
    const p = t.split(":");
    found.add(`${pad2(p[0])}:${p[1]}:${p[2] || "00"}`);
  });

  return [...found];
}

function normalizeSearchText(s) {
  return String(s || "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/₦/g, " NGN ")
    .replace(/&/g, " AND ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeSearchText(s) {
  const normalized = normalizeSearchText(s);
  if (!normalized) return [];

  return [...new Set(
    normalized
      .split(" ")
      .map(t => t.trim())
      .filter(t => t.length >= 2)
  )];
}

function meaningfulTokens(s) {
  return tokenizeSearchText(s).filter(t =>
    !VERIFY_GENERIC_TOKENS.has(t.toLowerCase()) &&
    !/^\d{1,2}$/.test(t) &&
    t !== "NGN"
  );
}

function buildSearchableImageRecord(rawText) {
  const normalizedText = normalizeSearchText(rawText);
  const tokens = tokenizeSearchText(rawText);

  const amountEvidence=amountCandidatesFromText(rawText);
  return {normalizedText,tokens,amounts:amountEvidence.map(x=>x.value),amountEvidence,dates:extractAllDates(rawText),times:extractAllTimes(rawText)};
}

/* =========================================================
   INDEXES
========================================================= */

function addIndexValue(index, key, imageId) {
  if (!key) return;

  if (!index.has(key)) index.set(key, new Set());
  index.get(key).add(imageId);
}

async function buildImageIndexes() {
  const amountIndex = new Map();
  const dateIndex = new Map();
  const tokenIndex = new Map();

  verifyState.ocrImages.forEach((image, index) => {
    (image.amountEvidence || image.amounts.map(v => ({value:v}))).forEach(e =>
      addIndexValue(amountIndex, Number(e.value).toFixed(2), image.id)
    );

    image.dates.forEach(date =>
      addIndexValue(dateIndex, date, image.id)
    );

    image.tokens.forEach(token =>
      addIndexValue(tokenIndex, token.toLowerCase(), image.id)
    );

    updateVerifyProgress(
      `Building searchable indexes: image ${index + 1} of ${verifyState.ocrImages.length}…`,
      index + 1,
      verifyState.ocrImages.length,
      `Amount index • Date index • Token index • Remaining ${Math.max(0, verifyState.ocrImages.length - index - 1)}`
    );

  });

  verifyState.imageIndex = {
    amountIndex,
    dateIndex,
    tokenIndex
  };
}

/* =========================================================
   STATEMENT-FIRST MATCHING
========================================================= */

function getImageById(id) {
  return verifyState.ocrImages.find(img => img.id === id) || null;
}

function getAmountCandidates(amount) {
  const set = verifyState.imageIndex.amountIndex.get(Number(amount).toFixed(2));
  return set ? [...set] : [];
}


function imageHasAmount(image, amount) {
  const target=Number(amount);if(!Number.isFinite(target))return false;
  return (image.amountEvidence||image.amounts.map(v=>({value:v}))).some(e=>Math.abs(Number(e.value)-target)<0.01);
}

function imageHasDate(image, date) {
  return !!date && image.dates.includes(date);
}

function textFieldMatchesImage(value, image) {
  const field = String(value || "").trim();
  if (!field || !image.normalizedText) return false;

  const normalizedField = normalizeSearchText(field);
  if (!normalizedField) return false;

  if (image.normalizedText.includes(normalizedField)) return true;

  const tokens = meaningfulTokens(field).filter(t => !/^\d+$/.test(t));
  if (!tokens.length) return false;

  const imageTokens = new Set((image.tokens || []).map(t => t.toLowerCase()));
  const matched = tokens.filter(t => imageTokens.has(t.toLowerCase())).length;
  const ratio = matched / tokens.length;

  // Names/counterparties are identity evidence. Avoid accepting a single
  // shared surname or generic narration word when a multi-token identity is
  // available.
  if (tokens.length === 1) return matched === 1;
  if (tokens.length === 2) return matched === 2;
  return ratio >= 0.75 && matched >= 2;
}

function extractEvidenceFromCell(cellValue) {
  const value = String(cellValue || "").trim();
  if (!value) return null;

  return {
    value,
    amount: extractAmount(value),
    dates: extractAllDates(value),
    tokens: meaningfulTokens(value)
  };
}

function cellMatchesImage(cellValue, image) {
  const evidence = extractEvidenceFromCell(cellValue);
  if (!evidence) return false;

  if (
    evidence.amount !== null &&
    imageHasAmount(image, evidence.amount)
  ) {
    return true;
  }

  if (
    evidence.dates.length &&
    evidence.dates.some(d => imageHasDate(image, d))
  ) {
    return true;
  }

  if (evidence.tokens.length) {
    const imageTokens = new Set(image.tokens.map(t => t.toLowerCase()));
    const matched = evidence.tokens.filter(t => imageTokens.has(t.toLowerCase())).length;

    if (evidence.tokens.length === 1) {
      return matched === 1;
    }

    if (matched / evidence.tokens.length >= 0.6) {
      return true;
    }
  }

  const normalized = normalizeSearchText(valueForSearch(cellValue));
  return normalized.length >= 4 && image.normalizedText.includes(normalized);
}

function valueForSearch(v) {
  return String(v || "")
    .replace(/\bNGN\b/gi, " ")
    .replace(/₦/g, " ")
    .trim();
}



function renderLiveImageCheck(image, index, total, candidates, statusText = "Checking…") {
  const body = document.getElementById("verifyBody");
  if (!body) return;
  const percent = total ? Math.round(((index + 1) / total) * 100) : 0;
  const candidateHtml = candidates.length
    ? candidates.slice(0, 3).map((c, i) => `
        <div class="verify-live-candidate">
          <span>Candidate ${i + 1}</span>
          <strong>${escapeHtml(c.row.nameRaw || "Unnamed transaction")}</strong>
          <small>${escapeHtml(c.row.dateRaw || "Date unavailable")} · ${c.row.credit != null ? `₦${Number(c.row.credit).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}` : "Credit unavailable"}</small>
          <em>Match strength ${Math.min(99, Math.round(c.score))}%</em>
        </div>
      `).join("")
    : `<div class="verify-live-empty">No compatible unused statement transaction found yet.</div>`;

  body.innerHTML = `
    <div class="verify-progress">
      <h2>Checking payment image</h2>
      <div class="verify-stage-list">
        <div class="verify-stage done"><span>✓</span><span>Statement reconstructed</span></div>
        <div class="verify-stage done"><span>✓</span><span>Payment OCR extracted</span></div>
        <div class="verify-stage active"><span>●</span><span>Comparing this payment</span></div>
        <div class="verify-stage"><span>○</span><span>Finalizing result</span></div>
      </div>
      <div class="verify-progress-main">
        <strong>${escapeHtml(statusText)}</strong>
        <div class="verify-progress-track"><div class="verify-progress-bar" style="width:${percent}%"></div></div>
      </div>
      <div class="verify-live-image-card">
        <div class="verify-live-image-wrap">
          <img src="${escapeHtml(paymentImageUrl(image.id))}" alt="Payment proof being checked" loading="eager">
        </div>
        <div class="verify-live-image-info">
          <strong>Payment proof</strong>
          <div class="verify-live-facts">
            <span>Amount: ${image.amounts.length ? image.amounts.map(a => `₦${Number(a).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`).join(", ") : "not detected"}</span>
            <span>Date: ${image.dates.length ? image.dates.join(", ") : "not detected"}</span>
            <span>Time: ${image.times.length ? image.times.slice(0,3).join(", ") : "not detected"}</span>
          </div>
        </div>
      </div>
      <div class="verify-live-candidates">
        <div class="verify-live-title">Best statement matches</div>
        ${candidateHtml}
      </div>
    </div>
  `;
}

async function runStatementFirstVerification() {
  const images = verifyState.ocrImages;
  const availableRows = verifyState.validStatementRows.filter(r => r.credit > 0);
  const rowsByAmount = new Map();
  availableRows.forEach(row => {
    const key = Number(row.credit).toFixed(2);
    if (!rowsByAmount.has(key)) rowsByAmount.set(key, []);
    rowsByAmount.get(key).push(row);
  });

  const usedRowIds = new Set();
  const results = [];

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    const candidateRows = [];
    const seenRowIds = new Set();

    const amountEvidence = image.amountEvidence || (image.amounts || []).map(value => ({ value }));
    for (const evidence of amountEvidence) {
      const amount = Number(evidence.value);
      const rows = rowsByAmount.get(amount.toFixed(2)) || [];
      rows.forEach(row => {
        if (!usedRowIds.has(row.id) && !seenRowIds.has(row.id)) {
          seenRowIds.add(row.id);
          candidateRows.push(row);
        }
      });
    }

    // Amount -> date is only candidate narrowing. The final decision always
    // compares the complete statement row against the complete OCR image.
    const datedCandidates = candidateRows.filter(row =>
      row.date && (image.dates || []).includes(row.date)
    );
    const rowsToScore = datedCandidates.length ? datedCandidates : candidateRows;
    const candidates = rowsToScore
      .map(row => scoreImageAgainstStatementRow(image, row))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    renderLiveImageCheck(
      image,
      i,
      images.length,
      candidates,
      `Comparing payment image ${i + 1} against its strongest unused statement candidates…`
    );
    await nextFrame();

    const best = candidates[0];
    const second = candidates[1];
    let result;

    // More than two viable rows is explicitly unsafe: force manual review.
    if (candidates.length > 2) {
      result = {
        row: best?.row || makeUnmatchedImageRow(image, i),
        verdict: "REVIEW REQUIRED",
        imageCandidates: candidates.slice(0, 3).map(c => c.row),
        matchedImage: null,
        checks: { date: true, name: true, credit: true, supporting: best?.supporting?.length || 0 },
        supporting: best?.supporting || [],
        reason: `${candidates.length} unused statement transactions are compatible with this payment image. More than two possible matches requires manual review. No statement row was marked used.`
      };
    } else if (!best) {
      result = {
        row: makeUnmatchedImageRow(image, i),
        verdict: "NOT VERIFIED",
        imageCandidates: [],
        matchedImage: image,
        checks: { date: false, name: false, credit: false, supporting: 0 },
        supporting: [],
        reason: "No unused statement transaction contains the required Credit, Date and Name / Description in the same transaction."
      };
    } else if (second && (best.score - second.score < 12 || best.supporting.length === second.supporting.length)) {
      result = {
        row: best.row,
        verdict: "REVIEW REQUIRED",
        imageCandidates: [best.row, second.row],
        matchedImage: image,
        checks: { date: true, name: true, credit: true, supporting: best.supporting.length },
        supporting: best.supporting,
        reason: "Two unused statement transactions are close enough in evidence that automatic selection would be unsafe. No row was marked used."
      };
    } else {
      usedRowIds.add(best.row.id);
      best.row.status = "USED";
      result = {
        row: best.row,
        verdict: best.supporting.length >= 2 ? "STRONG MATCH" : "MATCHED",
        imageCandidates: [best.row],
        matchedImage: image,
        checks: { date: true, name: true, credit: true, supporting: best.supporting.length },
        supporting: best.supporting,
        reason: best.supporting.length
          ? `The payment image matched the same statement transaction on Date, Name / Description and Credit, with ${best.supporting.length} additional field match${best.supporting.length === 1 ? "" : "es"}.`
          : "The payment image matched one unused statement transaction on the required Date, Name / Description and Credit fields."
      };

      for (const orderId of image.orderIds || []) {
        try {
          await databases.updateDocument(DB_ID, ORDERS, orderId, { status: "paid" });
        } catch (err) {
          console.error("Failed to update matched order status:", orderId, err);
        }
      }
    }

    results.push(result);
    await nextFrame();
  }

  // Results are image-driven. Unused statement rows are not re-analyzed and
  // are not rendered as fake payment results. This keeps the review focused on
  // exactly what the seller's payment images were checked against.
  verifyState.results = results;

  await renderFinalVerificationResults();
}

function makeUnmatchedImageRow(image, index) {
  return {
    id: `unmatched-image-${image.id}-${index}`,
    rowNumber: `Payment image ${index + 1}`,
    cells: [], date: null, credit: null,
    nameRaw: `Payment image ${index + 1}`
  };
}

function normalizedTokenSet(text) {
  return new Set(meaningfulTokens(text).map(t => t.toLowerCase()));
}

function compareCellToImage(cellValue, image) {
  const value = String(cellValue || "").trim();
  if (!value) return { score: 0, matched: false, detail: "" };

  const normalized = normalizeSearchText(value);
  if (!normalized) return { score: 0, matched: false, detail: "" };

  if (image.normalizedText.includes(normalized)) {
    return { score: 18, matched: true, detail: value };
  }

  const tokens = normalizedTokenSet(value);
  if (!tokens.size) return { score: 0, matched: false, detail: "" };
  const imageTokens = new Set((image.tokens || []).map(t => String(t).toLowerCase()));
  let hits = 0;
  tokens.forEach(t => { if (imageTokens.has(t)) hits++; });
  const ratio = hits / tokens.size;

  if (ratio >= 0.8) return { score: 14, matched: true, detail: value };
  if (ratio >= 0.6 && tokens.size >= 2) return { score: 9, matched: true, detail: value };
  if (ratio >= 0.5 && tokens.size >= 3) return { score: 6, matched: true, detail: value };

  return { score: 0, matched: false, detail: "" };
}

function compareWholeRowToImage(row, image) {
  const values = (row.cells || [])
    .map(c => String(c.value || "").trim())
    .filter(Boolean);
  const rowText = values.join(" ");
  const rowTokens = normalizedTokenSet(rowText);
  if (!rowTokens.size) return { score: 0, coverage: 0, hits: 0 };

  const imageTokens = new Set((image.tokens || []).map(t => String(t).toLowerCase()));
  let hits = 0;
  rowTokens.forEach(t => { if (imageTokens.has(t)) hits++; });
  const coverage = hits / rowTokens.size;

  // Whole-row comparison is deliberately supporting evidence only. It cannot
  // create a match when the mandatory amount/date/name requirements fail.
  if (coverage >= 0.80) return { score: 22, coverage, hits };
  if (coverage >= 0.65) return { score: 15, coverage, hits };
  if (coverage >= 0.50) return { score: 8, coverage, hits };
  return { score: 0, coverage, hits };
}

function scoreImageAgainstStatementRow(image, row) {
  if (!row.date || row.credit == null || row.credit <= 0 || !row.nameRaw) return null;
  if (!imageHasAmount(image, row.credit)) return null;
  if (!imageHasDate(image, row.date)) return null;
  if (!textFieldMatchesImage(row.nameRaw, image)) return null;

  let score = 100;
  const supporting = [];
  const cellMatches = [];

  // Primary fields receive explicit weight. All remaining non-empty cells are
  // then compared against the same OCR record as supporting evidence.
  const primaryIndexes = new Set([
    verifyState.selectedColumns.dateCol,
    verifyState.selectedColumns.nameCol,
    verifyState.selectedColumns.creditCol
  ]);

  row.cells.forEach(cell => {
    if (primaryIndexes.has(cell.columnIndex)) return;
    const compared = compareCellToImage(cell.value, image);
    if (compared.matched) {
      score += compared.score;
      supporting.push(cell.value);
      cellMatches.push({ value: cell.value, score: compared.score });
    }
  });

  // Exact supporting date/time/reference/amount evidence gets additional weight.
  const wholeRow = compareWholeRowToImage(row, image);
  if (wholeRow.score) {
    score += wholeRow.score;
    supporting.push(`Whole transaction content (${wholeRow.hits} matching terms)`);
  }

  const rowTime = row.cells.map(c => c.value).find(v => /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(String(v || "")));
  if (rowTime && (image.times || []).length) {
    const rowTimes = extractAllTimes(rowTime);
    if (rowTimes.some(t => image.times.includes(t))) {
      score += 15;
      supporting.push(rowTime);
    }
  }

  return {
    row,
    score,
    supporting: [...new Set(supporting)],
    cellMatches,
    core: { date: true, name: true, credit: true }
  };
}

/* =========================================================
   RESULTS
========================================================= */

async function renderFinalVerificationResults() {
  renderVerifyProgress("final", "Finalizing verification results…");

  const matched = verifyState.results.filter(
    r => r.verdict === "MATCHED" || r.verdict === "STRONG MATCH"
  ).length;
  const strong = verifyState.results.filter(r => r.verdict === "STRONG MATCH").length;
  const review = verifyState.results.filter(r => r.verdict === "REVIEW REQUIRED").length;
  const notVerified = verifyState.results.filter(r => r.verdict === "NOT VERIFIED").length;
  const skipped = verifyState.results.filter(r => r.verdict === "SKIPPED").length;

  const body = document.getElementById("verifyBody");

  body.innerHTML = `
    <h2>Payment Verification Complete</h2>
    <p class="verify-sub">
      Matching was performed from statement rows against the complete OCR/searchable
      payment-image collection. The three primary fields had to match in the same image.
    </p>

    <div class="verify-count-grid verify-final-counts">
      <div class="matched"><strong>${matched.toLocaleString()}</strong><span>Matched</span></div>
      <div class="strong"><strong>${strong.toLocaleString()}</strong><span>Strong match</span></div>
      <div class="review"><strong>${review.toLocaleString()}</strong><span>Review required</span></div>
      <div class="failed"><strong>${notVerified.toLocaleString()}</strong><span>Not verified</span></div>
      <div class="skipped"><strong>${skipped.toLocaleString()}</strong><span>Skipped</span></div>
    </div>

    <div class="verify-results" id="verifyResultsList">
      ${verifyState.results.map(renderVerifyResultCard).join("")}
    </div>

    <button class="verify-btn-primary" onclick="closeVerifyOverlay()">Done</button>
  `;

  // Keep the existing order list in sync after matched orders were updated.
  try {
    await fetchOrders();
  } catch (err) {
    console.warn("Could not refresh orders after verification:", err);
  }
}

function renderVerifyResultCard(result) {
  const row = result.row;
  const title = row.nameRaw || `Statement row ${row.rowNumber}`;

  const statusClass = {
    "MATCHED": "matched",
    "STRONG MATCH": "strong",
    "REVIEW REQUIRED": "review",
    "NOT VERIFIED": "not-verified",
    "SKIPPED": "skipped"
  }[result.verdict] || "not-verified";

  const line = (ok, label) =>
    `<div class="verify-check ${ok ? "ok" : "fail"}">
      ${ok ? "&#10003;" : "&#10007;"} ${escapeHtml(label)}
    </div>`;

  const supportingHtml = result.supporting?.length
    ? `<div class="verify-supporting">
        <strong>Supporting evidence:</strong>
        ${result.supporting.map(v => `<span>${escapeHtml(v)}</span>`).join("")}
       </div>`
    : "";

  return `
    <div class="verify-result-card ${statusClass}">
      <div class="verify-result-head">
        <strong>${escapeHtml(title)}</strong>
        <span class="verify-verdict-tag">${escapeHtml(result.verdict)}</span>
      </div>

      <div class="verify-row-meta">
        ${row.date ? escapeHtml(row.date) : "Date unavailable"}
        ${row.credit != null ? ` • ₦${Number(row.credit).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}` : ""}
      </div>

      ${result.verdict !== "SKIPPED" ? `
        ${line(!!result.checks?.date, "Date matched")}
        ${line(!!result.checks?.name, "Name / Description matched")}
        ${line(!!result.checks?.credit, "Credit matched")}
      ` : `
        <div class="verify-check fail">&#10007; No valid positive Credit — row skipped</div>
      `}

      ${result.matchedImage ? `
        <div class="verify-matched-image">
          <img src="${escapeHtml(paymentImageUrl(result.matchedImage.id))}" alt="Matched payment proof" loading="lazy">
          <div><strong>Payment image checked</strong><small>${escapeHtml(result.row?.date || result.matchedImage.dates?.[0] || "Date not detected")} · ${result.row?.credit != null ? `₦${Number(result.row.credit).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}` : (result.matchedImage.amounts?.[0] != null ? `₦${Number(result.matchedImage.amounts[0]).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}` : "Amount not detected")}</small></div>
        </div>
        <div class="verify-check ok">&#10003; Required fields found in the same payment image</div>
      ` : ""}

      ${result.imageCandidates?.length ? `
        <div class="verify-candidate-note">
          ${result.imageCandidates.length} payment image${result.imageCandidates.length === 1 ? "" : "s"} satisfied the core search.
        </div>
      ` : ""}

      ${supportingHtml}

      ${result.matchedImage ? `
        <div class="verify-comparison-breakdown">
          <strong>Comparison used</strong>
          <span class="compare-ok">Date ✓</span>
          <span class="compare-ok">Name / Description ✓</span>
          <span class="compare-ok">Credit ✓</span>
          ${result.supporting?.slice(0, 6).map(v => `<span class="compare-support">${escapeHtml(v)} ✓</span>`).join("") || ""}
        </div>
      ` : ""}

      ${result.verdict === "REVIEW REQUIRED" && result.imageCandidates?.length ? `
        <div class="verify-review-candidates">
          <strong>Possible matches</strong>
          ${result.imageCandidates.slice(0, 3).map((r, i) => `<span>Candidate ${i + 1}: ${escapeHtml(r.nameRaw || "Unnamed transaction")} · ${escapeHtml(r.dateRaw || "Date unavailable")} · ${r.credit != null ? `₦${Number(r.credit).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}` : "Credit unavailable"}</span>`).join("")}
        </div>
      ` : ""}

      <p class="verify-reason">${escapeHtml(result.reason || "")}</p>
    </div>
  `;
}

function showVerifyNoImages() {
  const body = document.getElementById("verifyBody");

  body.innerHTML = `
    <h2>No Payment Images Found</h2>
    <p class="verify-sub">
      The statement was processed, but there are no unpaid orders with payment-proof
      images available for comparison.
    </p>

    <div class="verify-count-grid">
      <div><strong>${verifyState.statementRows.length.toLocaleString()}</strong><span>Rows detected</span></div>
      <div><strong>${verifyState.validStatementRows.length.toLocaleString()}</strong><span>Valid Credit</span></div>
      <div><strong>${verifyState.skippedStatementRows.length.toLocaleString()}</strong><span>Skipped</span></div>
    </div>

    <button class="verify-btn-primary" onclick="closeVerifyOverlay()">Close</button>
  `;
}

function showVerifyError(message) {
  const body = document.getElementById("verifyBody");
  if (!body) return;

  body.innerHTML = `
    <h2>Verification could not continue</h2>
    <div class="verify-error">${escapeHtml(message)}</div>
    <button class="verify-btn-primary" onclick="renderVerifyStepStatement()">Try Again</button>
  `;
}

/* =========================================================
   SMALL UTILITIES
========================================================= */

function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}
