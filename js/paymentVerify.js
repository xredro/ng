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
    const viewport = page.getViewport({ scale: 1 });

    // Keep the PDF's real 2-D coordinate system. We do not need to display
    // this canvas; it is a spatial working surface used to reconstruct the
    // table before any normalization or matching happens.
    pages.push({
      width: viewport.width,
      height: viewport.height,
      items: content.items.map((it, itemIndex) => {
        const x = Number(it.transform?.[4]) || 0;
        const y = Number(it.transform?.[5]) || 0;
        const width = Math.max(0, Number(it.width) || 0);
        const height = Math.max(0, Number(it.height) || 0);
        return {
          id: `p${i}-t${itemIndex}`,
          text: String(it.str || ''),
          x, y, width, height,
          right: x + width,
          top: y + height,
          centerX: x + width / 2,
          centerY: y + height / 2
        };
      })
    });
  }

  verifyState.statementText = pages;
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

function groupIntoRows(itemsOrPage, yTolerance) {
  // Compatibility wrapper: the rest of the verifier can continue to work
  // with rows, while extraction itself is now based on a 2-D page model.
  if (itemsOrPage && !Array.isArray(itemsOrPage) && Array.isArray(itemsOrPage.items)) {
    return build2DPageModel(itemsOrPage).rows;
  }
  return build2DPageModel({ items: Array.isArray(itemsOrPage) ? itemsOrPage : [] }).rows;
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

const VERIFY_COMPOSITE_HEADERS = [
  "value date", "posting date", "transaction date", "transaction datetime",
  "transaction details / narration",
  "transaction time", "customer name", "credit amount", "amount credited",
  "amount received", "transaction details", "transaction description",
  "reference code", "trace code", "account name", "account number"
];

function isKnownHeaderText(text) {
  const normalized = normalizeHeaderWord(text);
  return VERIFY_HEADER_PATTERNS.some(p => normalizeHeaderWord(p) === normalized);
}

function groupHeaderCells(headerRow) {
  const items=[...headerRow.items]
    .filter(it=>String(it.text||'').trim())
    .sort((a,b)=>a.x-b.x);
  const cells=[];

  // A PDF may expose an entire header line as ONE TextItem, e.g.
  // "Value Date Description Debit Credit Channel". In that case the item
  // rectangle is the whole line, but findHeaderLabelsInItem() can recover
  // approximate positions for the individual header labels. This is only
  // used to discover the schema; transaction reconstruction happens later.
  for (const item of items) {
    const embedded = findHeaderLabelsInItem(item);
    if (embedded.length >= 2) {
      for (const m of embedded) {
        const text = String(m.text || '').replace(/\s+/g,' ').trim();
        if (!text) continue;
        cells.push({
          x: m.x,
          end: m.end,
          center: m.center,
          text
        });
      }
    } else {
      const single=String(item.text||'').replace(/\s+/g,' ').trim();
      if (isKnownHeaderText(single)) {
        const x=Number(item.x)||0;
        const end=x+(Number(item.width)||0);
        cells.push({x,end,center:(x+end)/2,text:single});
      }
    }
  }

  // Also handle a header that arrives as several adjacent TextItems, including
  // explicitly allowed composite labels such as "Value Date".
  const directItems=items;
  for(let i=0;i<directItems.length;i++){
    const single=String(directItems[i].text||'').replace(/\s+/g,' ').trim();
    let composite=null, compositeEnd=i;
    for(let end=i+1;end<Math.min(directItems.length,i+4);end++){
      const candidate=directItems.slice(i,end+1)
        .map(x=>String(x.text||'').trim()).join(' ')
        .replace(/\s+/g,' ').trim().toLowerCase();
      if(VERIFY_COMPOSITE_HEADERS.includes(candidate)) {
        composite=candidate;
        compositeEnd=end;
      }
    }
    if(composite){
      const first=directItems[i],last=directItems[compositeEnd];
      cells.push({
        x:Number(first.x)||0,
        end:(Number(last.x)||0)+(Number(last.width)||0),
        center:((Number(first.x)||0)+((Number(last.x)||0)+(Number(last.width)||0)))/2,
        text:directItems.slice(i,compositeEnd+1).map(x=>String(x.text||'').trim()).join(' ').replace(/\s+/g,' ').trim()
      });
      i=compositeEnd;
    }
  }

  // Remove duplicates created when a PDF supplies both embedded and separate
  // header fragments. Prefer the wider/explicit header label when positions
  // are nearly identical.
  cells.sort((a,b)=>a.x-b.x || a.end-b.end);
  const dedup=[];
  for(const cell of cells){
    const existing=dedup.find(c=>
      Math.abs(c.x-cell.x)<=3 &&
      Math.abs(c.end-cell.end)<=6 &&
      normalizeHeaderWord(c.text)===normalizeHeaderWord(cell.text)
    );
    if(!existing) dedup.push(cell);
  }
  return dedup.sort((a,b)=>a.x-b.x);
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

function xRangesOverlap(aLeft, aRight, bLeft, bRight) {
  return Math.max(aLeft, bLeft) < Math.min(aRight, bRight);
}

function columnDirectlyUnderHeader(x, width, boundary) {
  const left = Number(x) || 0;
  const right = left + Math.max(0, Number(width) || 0);
  const center = (left + right) / 2;
  const coreLeft = Number(boundary.headerX) || 0;
  const coreRight = Number(boundary.headerEnd) || coreLeft;

  // A fragment whose centre is inside the real header box is a direct hit.
  if (center >= coreLeft && center <= coreRight) return true;

  // This also catches right/left-aligned values whose box overlaps the
  // physical header box even though their centre sits just outside it.
  return xRangesOverlap(left, right, coreLeft, coreRight);
}

function columnAtX(x,boundaries) {
  if (!boundaries.length) return -1;

  // The header's physical X span is the strongest anchor. This matters for
  // compact headers such as "Credit" where the text itself is narrower than
  // the data column.
  for (let i=0;i<boundaries.length;i++) {
    const b = boundaries[i];
    const left = Number(b.headerX);
    const right = Number(b.headerEnd);
    if (Number.isFinite(left) && Number.isFinite(right) && x >= left && x <= right) {
      return i;
    }
  }

  // Otherwise use the data corridor created from neighbouring header centres.
  for (let i=0;i<boundaries.length;i++) {
    if (x>=boundaries[i].x && x<boundaries[i].end) return i;
  }

  let best=0,d=Infinity;
  boundaries.forEach((b,i)=>{
    const n=Math.abs(x-b.center);
    if(n<d){d=n;best=i;}
  });
  return best;
}

function assignToColumn(x,width,boundaries) {
  if (!boundaries.length) return -1;

  // First try the actual header-sized horizontal footprint. This is the
  // "directly underneath the header" rule requested for the spatial table.
  for (let i=0;i<boundaries.length;i++) {
    if (columnDirectlyUnderHeader(x, width, boundaries[i])) return i;
  }

  return columnAtX((Number(x)||0)+Math.max(0,Number(width)||0)/2,boundaries);
}

function estimateTextFragmentPositions(item, boundaries = []) {
  const text = String(item.text || '').replace(/\s+/g, ' ').trim();
  const x = Number(item.x) || 0;
  const width = Math.max(0, Number(item.width) || 0);
  if (!text) return [];

  /*
   * PDF.js can legally return one TextItem for several visually separate
   * cells.  TextItem.width is the width of the WHOLE item, so blindly using
   * one character-per-pixel spacing causes the internal columns to collapse.
   *
   * We still need an approximate position for each token, but we deliberately
   * keep the original whitespace. Large whitespace gaps are useful evidence
   * of a cell boundary and are therefore represented as gaps rather than
   * silently treating every character as equally spaced.
   */
  const raw = String(item.text || '').replace(/\r?\n/g, ' ');
  const tokens = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(raw))) {
    tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  if (!tokens.length) return [];

  // Character-width estimate is only a starting coordinate. The assignment
  // stage below can move a token to the only plausible column when the
  // approximate coordinate conflicts with the table schema.
  const charWidth = width > 0 && raw.length ? width / raw.length : 0;
  return tokens.map(t => {
    const left = x + t.start * charWidth;
    const right = x + t.end * charWidth;
    return {
      text: t.text,
      x: left,
      right,
      center: (left + right) / 2,
      start: t.start,
      end: t.end
    };
  });
}

function tokenColumnCompatibility(token, boundary, index, boundaries) {
  const text = String(token || '').trim();
  const lower = text.toLowerCase();
  const header = normalizeHeaderLabel(boundary?.header || '');
  const dateLike = looksLikeDate(text);
  const timeLike = /^\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?$/i.test(text);
  const amountLike = /^(?:₦|NGN|N|\$|€|£)?\s*\d[\d,.]*$/.test(text);
  const channelLike = /^(mobile|ussd|web|pos|atm|internet|app|branch)$/i.test(text);

  let score = 0;
  if (header === 'date' || header === 'datetime') score += dateLike ? 12 : 0;
  if (header === 'time') score += timeLike ? 12 : 0;
  if (header === 'debit' || header === 'credit' || header === 'balance') score += amountLike ? 10 : 0;
  if (header === 'channel') score += channelLike ? 12 : 0;
  if (header === 'reference') score += /^\d{8,}$/.test(text.replace(/\D/g,'')) ? 12 : 0;
  if (header === 'description' || header === 'name') score += (!dateLike && !timeLike && !amountLike && !channelLike) ? 2 : 0;

  // Numeric tokens are especially ambiguous between Debit and Credit. Their
  // left-to-right order is therefore handled by the monotonic solver rather
  // than by this semantic score alone.
  return score;
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
  if (!item) return [];
  if (Array.isArray(item.__spatialTokens)) return item.__spatialTokens;
  const tokens = measureTokenLayout(item);
  // Cache once per native PDF.js text item. This is critical for large
  // statements because alignment detection and reconstruction both reuse
  // the same tokens.
  try { Object.defineProperty(item, "__spatialTokens", { value: tokens, enumerable: false }); }
  catch (_) { item.__spatialTokens = tokens; }
  return tokens;
}

function collectRowBoundaryEvidence(row, minGap = null) {
  const tokens = row.items.flatMap(expandSpatialTokens)
    .filter(t => String(t.text || '').trim())
    .sort((a,b) => a.x-b.x || a.right-b.right);
  if (tokens.length < 2) return [];

  const widths = tokens.map(t => Math.max(1, t.width)).sort((a,b)=>a-b);
  const medianWidth = widths[Math.floor(widths.length/2)] || 10;
  const gapThreshold = Number.isFinite(minGap) ? minGap : Math.max(8, medianWidth * 0.9);
  const evidence = [];

  for (let i=0;i<tokens.length-1;i++) {
    const a=tokens[i], b=tokens[i+1];
    const gap=Math.max(0, b.x-a.right);
    if (gap < gapThreshold) continue;

    // A candidate boundary is the open space before the next aligned word.
    // Keep both the next-word start and the midpoint: repeated next-word X
    // positions are the strongest signal, while midpoint is useful when
    // text widths vary substantially.
    evidence.push({
      leftToken:a,
      rightToken:b,
      gap,
      boundaryX:(a.right+b.x)/2,
      nextStartX:b.x,
      prevEndX:a.right,
      confidence:Math.min(1, gap / Math.max(gapThreshold, 1))
    });
  }
  return evidence;
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

function buildGlobalXLanes(rows, boundaries, headers) {
  if (!rows?.length || !boundaries?.length) return boundaries || [];

  // Structural lane learning does not need every transaction in a huge
  // statement. Use a representative sample, while reconstruction still
  // processes every row. This keeps detection responsive on long PDFs.
  const sampleRows = rows.length > 240
    ? rows.filter((_, i) => i < 120 || i % Math.ceil(rows.length / 120) === 0).slice(0, 240)
    : rows;

  const rowData = sampleRows.map(row => ({
    row,
    tokens: row.items.flatMap(expandSpatialTokens)
      .filter(t => String(t.text || '').trim())
      .sort((a,b)=>a.x-b.x || a.right-b.right)
  })).filter(r=>r.tokens.length);

  const allTokens=rowData.flatMap(r=>r.tokens);
  const rowEvidence=rowData.map(r=>collectRowBoundaryEvidence(r.row));
  const expectedBoundaries=Math.max(0,boundaries.length-1);
  const headerCenters=boundaries.map(b=>Number(b.headerCenterX ?? b.center));

  /*
   * VERTICAL ALIGNMENT / GAP MAP
   * ----------------------------
   * This is the key reconstruction model.
   *
   * We do NOT turn every repeated token X into a column.  A second word in a
   * cell naturally has its own X (DAVID-x255, OBI-x277) and must remain in the
   * same cell.
   *
   * Instead, each row contributes evidence where there is a meaningful
   * horizontal gap between adjacent words.  The X position of the word after
   * that gap is a potential START OF THE NEXT COLUMN. Repeated starts such as
   *
   *   DAVID   x255   OBI x277
   *   SANDRA  x254   OBI x277
   *
   * are therefore interpreted as word alignment evidence, while the gap
   * structure tells us whether that alignment is actually a cell boundary.
   */
  const nextStartClusters=clusterEvidence(
    rowEvidence.flatMap(ev=>ev.map(e=>e.nextStartX)), 5
  );
  const midpointClusters=clusterEvidence(
    rowEvidence.flatMap(ev=>ev.map(e=>e.boundaryX)), 6
  );

  // Candidate starts are scored by how many different rows support them.
  const candidateStarts=nextStartClusters.map(c=>{
    const supportingRows=new Set();
    rowEvidence.forEach((ev,rowIndex)=>{
      if(ev.some(e=>Math.abs(e.nextStartX-c.center)<=5)) supportingRows.add(rowIndex);
    });
    return {
      x:c.center,
      rowSupport:supportingRows.size,
      frequency:c.weight,
      score:supportingRows.size*3+c.weight
    };
  }).sort((a,b)=>b.score-a.score || a.x-b.x);

  const rowCount=Math.max(1,rowData.length);
  const selected=[];
  let previousX=-Infinity;

  for(let col=1; col<boundaries.length; col++) {
    const headerX=headerCenters[col];
    const prevHeaderX=headerCenters[col-1];
    const broadLeft=(Number(prevHeaderX)+Number(headerX))/2 - 70;
    const broadRight= col+1<boundaries.length
      ? (Number(headerX)+Number(headerCenters[col+1]))/2 + 70
      : Infinity;

    const candidates=candidateStarts.filter(c=>
      c.x>previousX+8 && c.x>=broadLeft && c.x<=broadRight
    );

    let pick=candidates[0] || null;

    // If no strong gap-start exists, use the midpoint gap evidence nearest the
    // header only as a low-confidence fallback. This prevents invented lanes.
    if(!pick) {
      const mids=midpointClusters
        .map(c=>({x:c.center,rowSupport:0,frequency:c.weight,score:c.weight}))
        .filter(c=>c.x>previousX+8 && c.x>=broadLeft && c.x<=broadRight)
        .sort((a,b)=>Math.abs(a.x-headerX)-Math.abs(b.x-headerX));
      if(mids.length) pick=mids[0];
    }

    if(!pick) pick={x:headerX,rowSupport:0,frequency:0,score:0,fallback:true};
    selected.push(pick);
    previousX=pick.x;
  }

  // First column begins at the left edge of the table. Subsequent columns use
  // the repeated next-word start. This creates bands, not nearest-word lanes.
  const anchors=[
    Number.isFinite(Number(boundaries[0].headerX)) ? Number(boundaries[0].headerX) : (allTokens[0]?.x || 0),
    ...selected.map(s=>Number(s.x))
  ];

  for(let i=1;i<anchors.length;i++) {
    if(!(anchors[i]>anchors[i-1])) anchors[i]=anchors[i-1]+1;
  }

  return boundaries.map((b,i)=>{
    const next=anchors[i+1];
    const selectedEvidence=i===0 ? {rowSupport:rowCount,frequency:rowCount,score:rowCount*3} : selected[i-1];
    const kind=headerColumnKind(headers[i] || b.header);

    // Numeric columns are additionally validated by repeated right edges. A
    // right edge never creates a new text column by itself.
    const numericTokens=allTokens.filter(t=>kind==='numeric' && Number.isFinite(t.right));
    const rightClusters=clusterEvidence(numericTokens.map(t=>t.right),4);

    return {
      ...b,
      index:i,
      kind,
      anchorX:anchors[i],
      laneLeft:anchors[i],
      laneRight:Number.isFinite(next) ? next : Infinity,
      repeatedLeft:selectedEvidence.frequency || 0,
      rowSupport:selectedEvidence.rowSupport || 0,
      laneConfidence:Math.min(1,(selectedEvidence.rowSupport || 0)/rowCount),
      rightClusters:rightClusters.slice(0,5),
      alignmentModel:'vertical-gap-alignment',
      fallback:!!selectedEvidence.fallback
    };
  });
}

function assignRowTokensToXLanes(row, lanes, headers) {
  const tokens=row.items.flatMap(expandSpatialTokens)
    .filter(t=>String(t.text||'').trim())
    .sort((a,b)=>a.x-b.x || a.right-b.right);
  if(!tokens.length || !lanes.length) return [];

  const groups=new Map();
  for(const token of tokens){
    let col=0;
    // Band assignment: a word remains in its current cell until its X reaches
    // the next structural start discovered from repeated vertical alignment.
    for(let i=lanes.length-1;i>=0;i--){
      if(Number(token.x)>=Number(lanes[i].laneLeft)-2.5){ col=i; break; }
    }
    if(!groups.has(col)) groups.set(col,[]);
    groups.get(col).push(token.text);
  }

  return [...groups.entries()].sort((a,b)=>a[0]-b[0]).map(([col,parts])=>({
    col,
    text:parts.join(' '),
    positionConfidence:lanes[col].laneConfidence>=0.55?'coordinate-alignment':'mixed-coordinate'
  }));
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
function extractAllAmounts(text) {
  return amountCandidatesFromText(text).map(x=>x.value);
}

function mergeContinuationRows(rows,boundaries,headers){
  if(!rows.length||!boundaries.length)return rows;const out=[];
  const hasDateOrAmount=items=>{const t=items.map(x=>x.text||"").join(" ");return !!extractDate(t)||extractAmount(t)!==null;};
  for(const row of rows){if(!out.length){out.push(row);continue;}const prev=out[out.length-1],text=row.items.map(x=>String(x.text||"").trim()).filter(Boolean).join(" ");const gap=Math.abs(Number(prev.centerY)-Number(row.centerY)),fx=Number(row.items[0]?.x)||0;const textCol=boundaries.some((b,i)=>{const h=normalizeHeaderLabel(headers[i]||"");return(h==="name"||h==="description")&&fx>=b.x-12&&fx<=b.end+12;});if(text&&gap<=18&&!hasDateOrAmount(row.items)&&textCol&&hasDateOrAmount(prev.items)){prev.items.push(...row.items);prev.items.sort((a,b)=>a.x-b.x);}else out.push(row);}return out;
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

    // Repeated header is optional on continuation pages.
    headerIdx = detectHeaderRow(rows);
  } else {
    headerIdx = detectHeaderRow(rows);
    if (headerIdx === -1) return null;

    const headerCells = groupHeaderCells(rows[headerIdx]);
    if (headerCells.length < 2) return null;

    headers = headerCells.map(c => c.text);
    boundaries = buildColumnBoundaries(rows[headerIdx]);

    // Header discovery is deliberately permissive. A selectable PDF with a
    // recognizable header is allowed through even if the first reconstruction
    // pass cannot yet classify every data row. The seller can inspect the
    // preview and select the authoritative Date / Name-Description / Credit
    // columns before transaction filtering occurs.
    if (!headers.length || !boundaries.length) return null;
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

    // Reject page furniture/footers instead of turning it into a fake
    // transaction row. A row must look like a transaction before it enters
    // the verification dataset.
    if (!rowLooksLikeTransaction(cleaned, headers)) continue;

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
    let table = null;
    try {
      table = buildTableFromPage(
        verifyState.statementText[i],
        canonicalSchema
      );
    } catch (pageError) {
      // One unusual page must not freeze/abort the entire statement. Keep
      // scanning later pages and report the skipped page in progress.
      console.warn(`Statement table reconstruction skipped page ${i + 1}:`, pageError);
      table = null;
    }

    if (table && table.headers?.length && table.boundaries?.length) {
      if (!canonicalSchema) {
        canonicalSchema = {
          headers: [...table.headers],
          boundaries: table.boundaries.map(b => ({ ...b })),
          xLanes: (table.xLanes || []).map(l => ({ ...l }))
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

    // Let the browser paint the progress UI between expensive PDF pages.
    // Without yielding, mobile browsers can look frozen even while JS is
    // still working.
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  verifyState.statementTables = tables;

  if (!tables.length) {
    showVerifyError(
      "Couldn't detect a recognizable transaction header in this statement. The PDF text could not be mapped to a table header."
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

function intersectIds(a, b) {
  const bSet = new Set(b);
  return a.filter(id => bSet.has(id));
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
