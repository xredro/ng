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

const VERIFY_HEADER_KEYWORDS = [
  "date", "description", "narration", "details", "remarks",
  "credit", "debit", "balance", "amount", "cr", "dr",
  "value date", "transaction", "reference", "ref"
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

    console.error("Statement PDF error:", err);
    showVerifyError(
      "Could not read this PDF. Please check that it is a valid statement PDF and try again."
    );
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
    errEl.textContent = "That password couldn't unlock this PDF. Try again.";
    errEl.classList.remove("hidden");
  }
}

async function loadStatementPdf(buffer, password) {
  renderVerifyProgress("statement", "Reading statement PDF…");

  const loadingTask = pdfjsLib.getDocument({
    data: buffer.slice(0),
    password: password || undefined
  });

  const pdf = await loadingTask.promise;
  const pages = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    updateVerifyProgress(
      `Reading statement page ${i} of ${pdf.numPages}…`,
      i - 1,
      pdf.numPages
    );

    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    pages.push(content.items.map(it => ({
      text: it.str,
      x: it.transform[4],
      y: it.transform[5],
      width: it.width || 0,
      height: it.height || 0
    })));
  }

  verifyState.statementText = pages;
  await detectStatementTables();
}

/* =========================================================
   PDF TABLE / COLUMN EXTRACTION
========================================================= */

function groupIntoRows(items, yTolerance = 3) {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const rows = [];

  sorted.forEach(item => {
    let row = rows.find(r => Math.abs(r.y - item.y) <= yTolerance);
    if (!row) {
      row = { y: item.y, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  });

  rows.forEach(r => r.items.sort((a, b) => a.x - b.x));
  return rows;
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
    .replace(/^channel$/, "channel");
}

function looksLikeDate(s) {
  if (!s) return false;
  return VERIFY_DATE_REGEXES.some(r => r.test(String(s)));
}

function looksLikeNumber(s) {
  return /^[₦$€£]?\s?[\d.,]+$/.test((s || "").trim()) && /\d/.test(s);
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

function findHeaderLabelsInItem(item) {
  const text = String(item.text || "").replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  if (!text) return [];

  const matches = [];
  const occupied = [];

  const patterns = [...VERIFY_HEADER_PATTERNS].sort(
    (a, b) => b.length - a.length
  );

  patterns.forEach(pattern => {
    const regex = new RegExp(escapeRegExp(pattern), "gi");
    let match;

    while ((match = regex.exec(lower))) {
      const start = match.index;
      const end = start + match[0].length;

      const overlaps = occupied.some(r => start < r.end && end > r.start);
      if (overlaps) continue;

      occupied.push({ start, end });
      matches.push({
        start,
        end,
        text: text.slice(start, end)
      });
    }
  });

  matches.sort((a, b) => a.start - b.start);

  const itemX = Number(item.x) || 0;
  const itemWidth = Number(item.width) || 0;
  const charWidth = text.length ? itemWidth / text.length : 0;

  return matches.map(m => ({
    x: itemX + (m.start * charWidth),
    end: itemX + (m.end * charWidth),
    center: itemX + (((m.start + m.end) / 2) * charWidth),
    text: m.text
  }));
}

function groupHeaderCells(headerRow) {
  const items = [...headerRow.items]
    .filter(it => String(it.text || "").trim())
    .sort((a, b) => a.x - b.x);

  const cells = [];
  const patterns = [...VERIFY_HEADER_PATTERNS].sort((a,b) => b.length - a.length);

  // PDF.js may split one visible header into several text fragments, e.g.
  // ["Reference", "/", "Code"]. Merge only when the combined visible text
  // is a known header. This prevents fragments such as "n" or "0" from
  // becoming fake columns.
  for (let i = 0; i < items.length; i++) {
    let best = null;
    let bestEnd = i;
    for (let end = i; end < Math.min(items.length, i + 4); end++) {
      const candidate = items.slice(i, end + 1).map(x => String(x.text || '').trim()).join(' ').replace(/\s+/g, ' ').trim();
      const norm = normalizeHeaderWord(candidate);
      const matched = patterns.find(p => normalizeHeaderWord(p) === norm);
      if (matched) {
        best = matched;
        bestEnd = end;
      }
    }
    if (best) {
      const first = items[i], last = items[bestEnd];
      cells.push({
        x: Number(first.x) || 0,
        end: (Number(last.x)||0) + (Number(last.width)||0),
        center: ((Number(first.x)||0) + ((Number(last.x)||0)+(Number(last.width)||0))) / 2,
        text: items.slice(i,bestEnd+1).map(x => String(x.text||'').trim()).join(' ').replace(/\s+/g,' ').trim()
      });
      i = bestEnd;
      continue;
    }

    const single = String(items[i].text || '').replace(/\s+/g,' ').trim();
    if (patterns.some(p => normalizeHeaderWord(p) === normalizeHeaderWord(single))) {
      cells.push({
        x: Number(items[i].x)||0,
        end: (Number(items[i].x)||0)+(Number(items[i].width)||0),
        center: (Number(items[i].x)||0)+(Number(items[i].width)||0)/2,
        text: single
      });
    }
    // Unknown fragments are deliberately ignored. They are not promoted to
    // phantom columns.
  }

  return cells;
}

function detectHeaderRow(rows) {
  let bestIndex = -1;
  let bestScore = 0;

  rows.forEach((row, index) => {
    const cells = groupHeaderCells(row);
    if (cells.length < 3) return;

    const normalized = cells.map(c => normalizeHeaderLabel(c.text));
    const hasDate = normalized.some(n =>
      n === "date" || n === "datetime" || n === "time"
    );
    const hasCredit = normalized.some(n =>
      n === "credit" || VERIFY_CREDIT_HEADER_SYNONYMS.includes(n)
    );
    const hasDescription = normalized.some(n =>
      n === "description" || n === "name" || n === "reference" ||
      n === "debit" || n === "balance" || n === "channel"
    );

    let score = 0;
    if (hasDate) score += 3;
    if (hasCredit) score += 4;
    if (hasDescription) score += 2;

    // A genuine transaction header should contain at least Date/Time and
    // Credit, plus another transaction-related field.
    if (score >= 7 && score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function buildColumnBoundaries(headerRow) {
  const cells = groupHeaderCells(headerRow);

  return cells
    .map(cell => ({
      x: cell.x,
      end: cell.end,
      center: cell.center,
      header: cell.text
    }))
    .filter(c => Number.isFinite(c.center));
}

function assignToColumn(x, width, boundaries) {
  if (!boundaries.length) return -1;

  const start = Number(x) || 0;

  // Statement tables are overwhelmingly left-anchored by column. Use the
  // header's actual x-start rather than the distance to a header text item;
  // this prevents long transaction strings from jumping into the next
  // column simply because their text width is large.
  let best = 0;

  for (let i = 1; i < boundaries.length; i++) {
    if (start >= boundaries[i].x) best = i;
    else break;
  }

  return best;
}

function splitItemAcrossColumns(item, boundaries) {
  const text = String(item.text || '').trim();
  if (!text || !boundaries.length) return [];

  // Never slice PDF.js text by character position. That was causing
  // truncated names/descriptions and stray leading characters in amounts
  // and references. Each PDF text item belongs to the column containing
  // its horizontal center; adjacent fragments from the same cell are
  // concatenated later by buildTableFromPage().
  const start = Number(item.x) || 0;
  const width = Math.max(0, Number(item.width) || 0);
  const center = start + width / 2;
  let col = 0;
  for (let i = 1; i < boundaries.length; i++) {
    if (center >= boundaries[i].x) col = i;
    else break;
  }
  return [{ col, text }];
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

function rowLooksLikeTransaction(cells, headers) {
  const dateIndexes = [];
  const creditIndexes = [];

  headers.forEach((h, i) => {
    const n = normalizeHeaderLabel(h);
    if (n === "date" || n === "datetime" || n === "time") dateIndexes.push(i);
    if (n === "credit" || VERIFY_CREDIT_HEADER_SYNONYMS.includes(n)) creditIndexes.push(i);
  });

  const hasDate = dateIndexes.some(i => looksLikeDate(cells[i]));
  const hasCredit = creditIndexes.some(i => extractAmount(cells[i]) !== null);

  // Some bank statements have date/time split across cells. A transaction
  // row still needs a recognizable date OR a valid credit value.
  return hasDate || hasCredit;
}


function cleanExtractedCell(value, header = "") {
  let text = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const h = normalizeHeaderLabel(header);

  // PDF fonts sometimes expose the naira glyph as a detached "n"/"0".
  // Remove only an isolated leading artifact when the remainder is clearly
  // a monetary/reference value; do not globally strip legitimate letters.
  if (h === "credit" || h === "debit" || h === "balance") {
    text = text.replace(/^(?:n|ngn|₦|□|■|0\s*)(?=\d)/i, "");
  }
  if (h === "reference") {
    text = text.replace(/^(?:□|■|n)(?=\d{5,})/i, "");
  }

  // Remove common extraction-only square glyphs left behind by unsupported
  // currency fonts, but keep real alphanumeric cell content intact.
  text = text.replace(/^[□■]+(?=\d)/, "");

  return text.trim();
}

function cleanRowCells(cells, headers) {
  return cells.map((value, i) => cleanExtractedCell(value, headers[i] || ""));
}

function buildTableFromPage(pageItems, schemaHint = null) {
  const rows = groupIntoRows(pageItems);

  let headerIdx = -1;
  let boundaries = [];
  let headers = [];

  if (schemaHint?.headers?.length && schemaHint?.boundaries?.length) {
    headers = [...schemaHint.headers];
    boundaries = schemaHint.boundaries.map(b => ({ ...b }));

    // Repeated header is optional on continuation pages.
    headerIdx = detectHeaderRow(rows);
  } else {
    headerIdx = detectHeaderRow(rows);
    if (headerIdx === -1) return null;

    const headerCells = groupHeaderCells(rows[headerIdx]);
    if (headerCells.length < 3) return null;

    headers = headerCells.map(c => c.text);
    boundaries = buildColumnBoundaries(rows[headerIdx]);

    // Never manufacture blank "Column N" names here. If the PDF did not
    // expose a real header, that position is not considered a column.
    if (headers.length !== boundaries.length) return null;
  }

  const dataStart = headerIdx >= 0 ? headerIdx + 1 : 0;
  const tableRows = [];

  for (let i = dataStart; i < rows.length; i++) {
    const cells = new Array(headers.length).fill("");

    rows[i].items.forEach(it => {
      splitItemAcrossColumns(it, boundaries).forEach(part => {
        const col = part.col;
        if (col < 0 || col >= cells.length) return;

        const value = String(part.text || "").trim();
        if (!value) return;

        cells[col] = cells[col]
          ? `${cells[col]} ${value}`
          : value;
      });
    });

    const cleaned = cleanRowCells(cells, headers);

    if (!cleaned.some(Boolean)) continue;
    if (rowLooksLikeRepeatedHeader(cleaned, headers)) continue;

    // Reject page furniture/footers instead of turning it into a fake
    // transaction row. A row must look like a transaction before it enters
    // the verification dataset.
    if (!rowLooksLikeTransaction(cleaned, headers)) continue;

    tableRows.push(cleaned);
  }

  return {
    headers,
    rows: tableRows,
    boundaries
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
          boundaries: table.boundaries.map(b => ({ ...b }))
        };
      }

      // Only tables with the same real header structure belong to the same
      // statement transaction table. Page furniture is ignored.
      const sameSchema =
        table.headers.length === canonicalSchema.headers.length &&
        table.headers.every((h, index) =>
          normalizeHeaderWord(h) === normalizeHeaderWord(canonicalSchema.headers[index])
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

  const headers = table.headers.filter(Boolean);

  const selectOptions = (id, preferredFn) => headers.map((h, i) =>
    `<option value="${i}" ${preferredFn(h, i) ? "selected" : ""}>
      ${escapeHtml(h)}
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

async function ocrPaymentImage(order, worker) {
  const imageId = String(order.paymentProof);
  const url = paymentImageUrl(imageId);

  let rawText = "";
  let firstResult = null;

  if (worker) {
    // PSM 6 is a good default for the structured receipt/screen images.
    try {
      await worker.setParameters({ tessedit_pageseg_mode: "6" });
    } catch (_) {}
    firstResult = await worker.recognize(url);
    rawText = firstResult?.data?.text || "";
  } else {
    firstResult = await Tesseract.recognize(url, "eng", {
      tessedit_pageseg_mode: "6"
    });
    rawText = firstResult?.data?.text || "";
  }

  let searchable = buildSearchableImageRecord(rawText);

  // A common receipt-OCR failure is losing a digit/group separator from a
  // currency value, e.g. reading "₦18,500.00" as "₦18.00". Do not guess the
  // missing digits. Instead, run a second segmentation pass and merge its OCR
  // evidence with the first pass when the first amount looks suspicious.
  const suspiciousCurrency = /(?:₦|NGN|N)\s*\d{1,3}\.\d{1,2}(?!\d)/i.test(rawText) &&
    searchable.amounts.some(a => a > 0 && a < 100);

  if (suspiciousCurrency) {
    let secondText = "";
    try {
      if (worker) {
        await worker.setParameters({ tessedit_pageseg_mode: "11" });
        const second = await worker.recognize(url);
        secondText = second?.data?.text || "";
        await worker.setParameters({ tessedit_pageseg_mode: "6" });
      } else {
        const second = await Tesseract.recognize(url, "eng", {
          tessedit_pageseg_mode: "11"
        });
        secondText = second?.data?.text || "";
      }
    } catch (err) {
      console.warn("Secondary OCR pass failed:", err);
    }

    if (secondText) {
      const secondary = buildSearchableImageRecord(secondText);
      rawText = `${rawText}\n${secondText}`;
      searchable = buildSearchableImageRecord(rawText);
    }
  }

  return {
    id: imageId,
    orderIds: [order.$id],
    order,
    rawText,
    normalizedText: searchable.normalizedText,
    tokens: searchable.tokens,
    amounts: searchable.amounts,
    dates: searchable.dates,
    times: searchable.times,
    ocrError: false
  };
}

function mergeDuplicateImageRecords(images) {
  const map = new Map();

  images.forEach(img => {
    const existing = map.get(img.id);
    if (!existing) {
      map.set(img.id, img);
      return;
    }

    existing.orderIds = [...new Set([
      ...(existing.orderIds || []),
      ...(img.orderIds || [])
    ])];
  });

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

function extractAmount(raw) {
  if (raw === null || raw === undefined) return null;

  let text = String(raw).trim();
  if (!/\d/.test(text)) return null;

  text = text
    .replace(/₦|NGN|N|USD|\$|EUR|€|GBP|£/gi, "")
    .replace(/\bamount\b\s*:?\s*/gi, "")
    .trim();

  // Parentheses are treated as negative values. They are never valid Credit.
  const negative = /^\(.*\)$/.test(text) || /^-/.test(text);
  if (negative) return null;

  const europeanStyle = /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(text);

  if (europeanStyle) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else {
    text = text.replace(/,/g, "");
  }

  const num = Number.parseFloat(text);
  if (!Number.isFinite(num)) return null;

  return Math.round(num * 100) / 100;
}

function extractAllAmounts(text) {
  const found = new Set();
  const source = String(text || "").normalize("NFKC");

  // Keep currency-labelled amounts as the strongest OCR evidence. OCR can
  // separate grouped digits (e.g. "N 18 500.00") or detach a comma, so we
  // also inspect a short window after each currency marker and reconstruct
  // contiguous numeric groups without inventing digits.
  const currencyRe = /(?:₦|NGN|N|USD|\$|EUR|€|GBP|£)\s*([^\n]{1,36})/gi;
  let m;
  while ((m = currencyRe.exec(source))) {
    const tail = m[1];

    // Normal, grouped or decimal amount immediately after currency marker.
    const direct = tail.match(/^\s*([0-9]{1,3}(?:[,.][0-9]{3})*(?:[.,][0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/);
    if (direct) {
      const amount = extractAmount(direct[1]);
      if (amount !== null && amount > 0) found.add(amount.toFixed(2));
    }

    // OCR sometimes turns "18,500.00" into "18 500.00" or "18 500 00".
    // Reconstruct only when the numeric pieces are adjacent in the currency
    // window; this does not guess missing digits.
    const grouped = tail.match(/^\s*(\d{1,3})[\s,](\d{3})(?:[.,](\d{1,2}))?/);
    if (grouped) {
      const amountText = `${grouped[1]},${grouped[2]}${grouped[3] ? `.${grouped[3]}` : ""}`;
      const amount = extractAmount(amountText);
      if (amount !== null && amount > 0) found.add(amount.toFixed(2));
    }
  }

  // Also collect unlabelled grouped/decimal amounts. These are weaker OCR
  // evidence but useful for receipts where the currency symbol was missed.
  const matches = source.match(
    /\b\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?\b|\b\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?\b|\b\d+(?:\.\d{1,2})\b/g
  ) || [];

  matches.forEach(matched => {
    const amount = extractAmount(matched);
    if (amount !== null && amount > 0) found.add(amount.toFixed(2));
  });

  return [...found].map(Number);
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

  return {
    normalizedText,
    tokens,
    amounts: extractAllAmounts(rawText),
    dates: extractAllDates(rawText),
    times: extractAllTimes(rawText)
  };
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
    image.amounts.forEach(amount =>
      addIndexValue(amountIndex, Number(amount).toFixed(2), image.id)
    );

    image.dates.forEach(date =>
      addIndexValue(dateIndex, date, image.id)
    );

    image.tokens.forEach(token =>
      addIndexValue(tokenIndex, token.toLowerCase(), image.id)
    );

    if (index % 25 === 0) {
      updateVerifyProgress(
        `Indexing payment images ${index + 1} of ${verifyState.ocrImages.length}…`,
        index + 1,
        verifyState.ocrImages.length,
        `Current image ${index + 1} • Building amount, date and text indexes`
      );
    }
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

function intersectIds(a, b) {
  const bSet = new Set(b);
  return a.filter(id => bSet.has(id));
}

function imageHasAmount(image, amount) {
  return image.amounts.some(v => Math.abs(Number(v) - Number(amount)) < 0.01);
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

  const tokens = meaningfulTokens(field);
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

function findSupportingEvidence(row, image) {
  const primaryIndexes = new Set([
    verifyState.selectedColumns.dateCol,
    verifyState.selectedColumns.nameCol,
    verifyState.selectedColumns.creditCol
  ]);

  const matches = [];

  row.cells.forEach(cell => {
    if (primaryIndexes.has(cell.columnIndex)) return;

    if (cellMatchesImage(cell.value, image)) {
      matches.push(cell.value);
    }
  });

  return [...new Set(matches)];
}

function findCoreMatchesForRow(row) {
  if (row.credit === null || row.credit <= 0) {
    return {
      type: "SKIPPED",
      row,
      candidates: [],
      reason: "No valid positive Credit."
    };
  }

  if (!row.date) {
    return {
      type: "REVIEW REQUIRED",
      row,
      candidates: [],
      reason: "The selected Date column could not be normalized for this row."
    };
  }

  if (!row.nameRaw) {
    return {
      type: "REVIEW REQUIRED",
      row,
      candidates: [],
      reason: "The selected Name / Description cell is empty."
    };
  }

  // Candidate narrowing starts with the mandatory Credit amount.
  let candidateIds = getAmountCandidates(row.credit);

  if (!candidateIds.length) {
    return {
      type: "NOT VERIFIED",
      row,
      candidates: [],
      reason: "No payment image contains the statement Credit amount."
    };
  }

  // Date must also occur in the SAME image.
  candidateIds = candidateIds.filter(id => {
    const image = getImageById(id);
    return image && imageHasDate(image, row.date);
  });

  if (!candidateIds.length) {
    return {
      type: "NOT VERIFIED",
      row,
      candidates: [],
      reason: "No payment image contains both the statement Credit amount and Date."
    };
  }

  // Name / Description must be present in the SAME candidate image.
  const nameMatches = candidateIds.filter(id => {
    const image = getImageById(id);
    return image && textFieldMatchesImage(row.nameRaw, image);
  });

  if (!nameMatches.length) {
    return {
      type: "NOT VERIFIED",
      row,
      candidates: [],
      reason: "No single payment image contains the required Credit, Date, and Name / Description."
    };
  }

  return {
    type: "CORE",
    row,
    candidates: nameMatches
  };
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

    for (const amount of image.amounts || []) {
      const rows = rowsByAmount.get(Number(amount).toFixed(2)) || [];
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
          <div><strong>Payment image checked</strong><small>${escapeHtml(result.matchedImage.dates?.[0] || "Date not detected")} · ${result.matchedImage.amounts?.[0] != null ? `₦${Number(result.matchedImage.amounts[0]).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}` : "Amount not detected"}</small></div>
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
