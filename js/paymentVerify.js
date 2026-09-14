/* =========================================================
   PAYMENT VERIFICATION
   =========================================================
   Self-contained feature file. Does not modify or redefine
   anything from orders.js — it reuses the existing globals
   (allOrders, DB_ID, ORDERS, databases, Query, getCardTitle,
   normalizeAmount, fetchOrders) that are already declared
   there and loaded on the same page before this file.

   Everything below runs client-side only:
   - Tesseract.js  → OCR on payment proof images
   - PDF.js        → text + coordinate extraction from the
                     bank statement PDF
   - Plain JS      → all field detection, normalization,
                     matching and the final VERIFIED /
                     NOT VERIFIED decision (deterministic,
                     no AI/LLM involved in the decision).
========================================================= */

/* =========================
   CONFIG
========================= */

const VERIFY_CREDIT_HEADER_SYNONYMS = [
  "credit", "cr", "creditamount", "creditamt", "amountcredited",
  "deposit", "deposits", "inflow", "inflows", "moneyin",
  "received", "amountreceived"
];

const VERIFY_HEADER_KEYWORDS = [
  "date", "description", "narration", "details", "remarks",
  "credit", "debit", "balance", "amount", "cr", "dr", "value date", "transaction"
];

/* =========================
   STATE
========================= */

let verifyState = {
  businessName: "",
  statementText: null,       // extracted PDF pages: [{ items: [...] }]
  statementTransactions: [], // [{ name, date, credit }]
  pendingPayments: [],       // orders needing verification
  results: [],                // [{ order, extracted, checks, verdict, reason }]
  columnPickerResolve: null,
  pdfPassword: null
};

/* =========================
   OVERLAY SCAFFOLDING (injected once, on demand)
========================= */

function ensureVerifyOverlay() {
  if (document.getElementById("verifyOverlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "verifyOverlay";
  overlay.className = "verify-overlay hidden";
  overlay.innerHTML = `
    <div class="verify-panel">
      <button class="verify-close" onclick="closeVerifyOverlay()">&times;</button>
      <div id="verifyBody"></div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function openVerifyOverlay() {
  ensureVerifyOverlay();
  verifyState = {
    businessName: "",
    statementText: null,
    statementTransactions: [],
    pendingPayments: [],
    results: [],
    columnPickerResolve: null,
    pdfPassword: null
  };
  document.getElementById("verifyOverlay").classList.remove("hidden");
  renderVerifyStepName();
}

function closeVerifyOverlay() {
  const overlay = document.getElementById("verifyOverlay");
  if (overlay) overlay.classList.add("hidden");
}

/* =========================
   STEP 1 — seller enters receiving account/business name
========================= */

function renderVerifyStepName() {
  const body = document.getElementById("verifyBody");
  body.innerHTML = `
    <h2>Verify Payments</h2>
    <p class="verify-sub">
      Enter the name of the receiving bank account or business you're
      verifying against. This only applies to this session — it isn't
      pulled from your saved profile, since you may be verifying a
      different account.
    </p>

    <div class="form-group">
      <label>Receiving account / business name</label>
      <input id="verifyBusinessName" type="text" placeholder="e.g. ABC STORE LTD">
    </div>

    <button class="verify-btn-primary" onclick="submitVerifyBusinessName()">Continue</button>
  `;
  setTimeout(() => document.getElementById("verifyBusinessName")?.focus(), 50);
}

function submitVerifyBusinessName() {
  const val = document.getElementById("verifyBusinessName").value.trim();
  if (!val) {
    showToast("Enter the receiving account/business name to continue.", "error");
    return;
  }
  verifyState.businessName = val;
  renderVerifyStepStatement();
}

/* =========================
   STEP 2 — upload bank statement PDF
========================= */

function renderVerifyStepStatement() {
  const body = document.getElementById("verifyBody");
  body.innerHTML = `
    <h2>Upload Bank Statement</h2>
    <p class="verify-sub">
      Verifying against <strong>${escapeHtml(verifyState.businessName)}</strong>.
      Upload the statement of account PDF covering the payments you want to check.
    </p>

    <label class="verify-upload">
      <input type="file" accept="application/pdf" hidden onchange="handleStatementUpload(this)">
      <div class="verify-upload-ui">
        <span class="upload-icon">&#8593;</span>
        <span>Upload statement PDF</span>
      </div>
    </label>

    <div id="verifyStatementStatus" class="verify-status-line"></div>
  `;
}

async function handleStatementUpload(input) {
  const file = input.files[0];
  if (!file) return;

  const statusEl = document.getElementById("verifyStatementStatus");
  statusEl.textContent = "Reading PDF…";

  const buffer = await file.arrayBuffer();
  verifyState._statementBuffer = buffer;

  try {
    await loadStatementPdf(buffer, null);
  } catch (err) {
    if (err && err.name === "PasswordException") {
      renderVerifyPasswordPrompt();
      return;
    }
    console.error(err);
    statusEl.textContent = "Could not read this PDF. Please try another file.";
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
      <input id="verifyPdfPassword" type="password" placeholder="PDF password">
    </div>

    <div id="verifyPasswordError" class="verify-error hidden"></div>

    <button class="verify-btn-primary" onclick="submitVerifyPassword()">Unlock</button>
  `;
  setTimeout(() => document.getElementById("verifyPdfPassword")?.focus(), 50);
}

async function submitVerifyPassword() {
  const pw = document.getElementById("verifyPdfPassword").value;
  const errEl = document.getElementById("verifyPasswordError");
  errEl.classList.add("hidden");

  try {
    await loadStatementPdf(verifyState._statementBuffer, pw);
  } catch (err) {
    errEl.textContent = "That password couldn't unlock this PDF. Try again.";
    errEl.classList.remove("hidden");
  }
}

async function loadStatementPdf(buffer, password) {
  const loadingTask = pdfjsLib.getDocument({
    data: buffer.slice(0), // pdf.js detaches the buffer, keep the original safe
    password: password || undefined
  });

  const pdf = await loadingTask.promise;
  const pages = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map(it => ({
      text: it.str,
      x: it.transform[4],
      y: it.transform[5]
    })));
  }

  verifyState.statementText = pages;
  await detectStatementTable();
}

/* =========================
   TABLE / COLUMN DETECTION
========================= */

function groupIntoRows(items, yTolerance = 3) {
  const sorted = [...items].sort((a, b) => b.y - a.y); // top to bottom
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

function looksLikeDate(s) {
  return VERIFY_DATE_REGEXES.some(r => r.test(s));
}

function looksLikeNumber(s) {
  return /^[₦$€]?\s?[\d.,]+$/.test((s || "").trim()) && /\d/.test(s);
}

function detectHeaderRow(rows) {
  for (let i = 0; i < rows.length; i++) {
    const text = rows[i].items.map(it => normalizeHeaderWord(it.text)).join(" ");
    const hits = VERIFY_HEADER_KEYWORDS.filter(k => text.includes(k.replace(/[^a-z]/g, "")));
    if (hits.length >= 2 && rows[i].items.length >= 2) {
      return i;
    }
  }
  return -1;
}

function buildColumnBoundaries(headerRow) {
  return headerRow.items.map(it => it.x).sort((a, b) => a - b);
}

function assignToColumn(x, boundaries) {
  let best = 0;
  let bestDist = Infinity;
  boundaries.forEach((b, i) => {
    const d = Math.abs(x - b);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

async function detectStatementTable() {
  const statusEl = document.getElementById("verifyStatementStatus");
  if (statusEl) statusEl.textContent = "Detecting the transactions table…";

  let allTransactions = [];

  for (const pageItems of verifyState.statementText) {
    const rows = groupIntoRows(pageItems);
    const headerIdx = detectHeaderRow(rows);
    if (headerIdx === -1) continue;

    const headerRow = rows[headerIdx];
    const boundaries = buildColumnBoundaries(headerRow);
    const headerCells = new Array(boundaries.length).fill("");
    headerRow.items.forEach(it => {
      const col = assignToColumn(it.x, boundaries);
      headerCells[col] = (headerCells[col] + " " + it.text).trim();
    });

    // Build the raw table (rows below the header, until the numbers thin out)
    const tableRows = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const cells = new Array(boundaries.length).fill("");
      rows[i].items.forEach(it => {
        const col = assignToColumn(it.x, boundaries);
        cells[col] = (cells[col] ? cells[col] + " " : "") + it.text;
      });
      if (cells.some(c => c.trim())) tableRows.push(cells);
    }
    if (!tableRows.length) continue;

    // Date column: whichever column matches a date pattern most often
    let dateCol = -1, dateHits = -1;
    for (let c = 0; c < boundaries.length; c++) {
      const hits = tableRows.filter(r => looksLikeDate(r[c])).length;
      if (hits > dateHits) { dateHits = hits; dateCol = c; }
    }

    // Credit column: header text matches known synonyms first
    let creditCol = headerCells.findIndex(h =>
      VERIFY_CREDIT_HEADER_SYNONYMS.includes(normalizeHeaderWord(h))
    );

    // Name/description column: not the date column, not a numeric-heavy column,
    // highest average text length
    let nameCol = -1, bestAvgLen = -1;
    for (let c = 0; c < boundaries.length; c++) {
      if (c === dateCol || c === creditCol) continue;
      const values = tableRows.map(r => r[c]).filter(Boolean);
      if (!values.length) continue;
      const numericRatio = values.filter(looksLikeNumber).length / values.length;
      if (numericRatio > 0.5) continue; // mostly numbers — not a name column
      const avgLen = values.reduce((s, v) => s + v.length, 0) / values.length;
      if (avgLen > bestAvgLen) { bestAvgLen = avgLen; nameCol = c; }
    }

    if (creditCol === -1) {
      // Can't confidently detect the Credit column — ask the seller.
      creditCol = await askUserForCreditColumn(headerCells);
    }

    if (dateCol === -1 || nameCol === -1 || creditCol === -1) continue;

    tableRows.forEach(r => {
      const rawDate = r[dateCol];
      const rawName = r[nameCol];
      const rawCredit = r[creditCol];
      if (!rawDate || !rawCredit) return;

      const credit = extractAmount(rawCredit);
      const date = extractDate(rawDate);
      if (credit === null || !date) return;

      allTransactions.push({
        name: (rawName || "").trim(),
        date: date.date,
        credit
      });
    });
  }

  verifyState.statementTransactions = allTransactions;

  if (!allTransactions.length) {
    if (statusEl) statusEl.textContent =
      "Couldn't detect a transactions table in this statement. Please check the file and try again.";
    return;
  }

  runPaymentVerification();
}

function askUserForCreditColumn(headerCells) {
  return new Promise(resolve => {
    const body = document.getElementById("verifyBody");
    body.innerHTML = `
      <h2>Which column is Credit / Money Received?</h2>
      <p class="verify-sub">We couldn't confidently detect this from the statement header.</p>

      <div class="verify-column-options">
        ${headerCells.map((h, i) => `
          <label class="verify-column-option">
            <input type="radio" name="creditColumn" value="${i}">
            <span>${escapeHtml(h || "(column " + (i + 1) + ")")}</span>
          </label>
        `).join("")}
      </div>

      <button class="verify-btn-primary" onclick="confirmCreditColumnChoice()">Continue</button>
    `;
    verifyState.columnPickerResolve = resolve;
  });
}

function confirmCreditColumnChoice() {
  const picked = document.querySelector('input[name="creditColumn"]:checked');
  if (!picked) {
    showToast("Select a column to continue.", "error");
    return;
  }
  const idx = Number(picked.value);
  if (verifyState.columnPickerResolve) {
    verifyState.columnPickerResolve(idx);
    verifyState.columnPickerResolve = null;
  }
}

/* =========================
   NORMALIZATION HELPERS
========================= */

const VERIFY_DATE_REGEXES = [
  /\b\d{4}-\d{2}-\d{2}\b/,                          // 2026-09-10
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,                  // 10/09/2026 or 09/10/26
  /\b\d{1,2}-\d{1,2}-\d{2,4}\b/,                    // 10-09-2026
  /\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}\b/,          // 10 Sep 2026
  /\b[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4}\b/         // September 10, 2026
];

const MONTH_NAMES = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12"
};

function pad2(n) { return String(n).padStart(2, "0"); }

function extractDate(raw) {
  if (!raw) return null;
  const text = raw.trim();

  // Extract a time if present (HH:MM or HH:MM:SS)
  let time = null;
  const timeMatch = text.match(/\b(\d{1,2}):(\d{2})(:(\d{2}))?\b/);
  if (timeMatch) {
    const h = pad2(timeMatch[1]);
    const m = timeMatch[2];
    const s = timeMatch[4] || "00";
    time = `${h}:${m}:${s}`;
  }

  // YYYY-MM-DD
  let m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time };

  // "10 Sep 2026" / "September 10, 2026"
  m = text.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})\b/);
  if (m) {
    const mon = MONTH_NAMES[m[2].slice(0, 3).toLowerCase()];
    if (mon) return { date: `${normalizeYear(m[3])}-${mon}-${pad2(m[1])}`, time };
  }
  m = text.match(/\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})\b/);
  if (m) {
    const mon = MONTH_NAMES[m[1].slice(0, 3).toLowerCase()];
    if (mon) return { date: `${normalizeYear(m[3])}-${mon}-${pad2(m[2])}`, time };
  }

  // DD/MM/YYYY or DD-MM-YYYY (day-first default; swap only if first part > 12)
  m = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
  if (m) {
    let day = Number(m[1]), month = Number(m[2]);
    if (day > 12 && month <= 12) {
      // already day-first, fine
    } else if (month > 12 && day <= 12) {
      // actually month-first input — swap
      [day, month] = [month, day];
    }
    return { date: `${normalizeYear(m[3])}-${pad2(month)}-${pad2(day)}`, time };
  }

  return null;
}

function normalizeYear(y) {
  y = String(y);
  if (y.length === 2) return (Number(y) > 50 ? "19" : "20") + y;
  return y;
}

function extractAmount(raw) {
  if (!raw) return null;
  let text = raw.trim();
  if (!/\d/.test(text)) return null;

  // Strip currency symbols/codes
  text = text.replace(/₦|NGN|N|\$|USD|EUR|€|GBP|£/gi, "").trim();
  text = text.replace(/^amount:?\s*/i, "").trim();

  // Detect European format: 1.250,50  → thousands "." decimal ","
  const europeanStyle = /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(text);
  if (europeanStyle) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else {
    // Standard: 15,000.00 or 15000 → strip thousands commas
    text = text.replace(/,/g, "");
  }

  const num = parseFloat(text);
  return isNaN(num) ? null : Math.round(num * 100) / 100;
}

function normalizeName(s) {
  return (s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function namesAreSimilar(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;

  // token overlap — most tokens of the shorter name appear in the longer name
  const ta = na.split(" ").filter(Boolean);
  const tb = nb.split(" ").filter(Boolean);
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (!shorter.length) return false;
  const overlap = shorter.filter(tok => longer.includes(tok)).length;
  return overlap / shorter.length >= 0.6;
}

/* =========================
   OCR — PAYMENT IMAGE PROCESSING
========================= */

function extractCandidateNames(ocrText) {
  return ocrText
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length >= 2)
    .filter(l => !looksLikeDate(l))
    .filter(l => !looksLikeNumber(l))
    .filter(l => /[A-Za-z]/.test(l)) // must contain at least some letters
    .filter(l => !/^(amount|date|time|ref|reference|transaction|status|account|bank)\b/i.test(l));
}

function identifySenderFromOcr(ocrText, businessName) {
  const candidates = extractCandidateNames(ocrText);
  if (!candidates.length) return { sender: null, ambiguous: false, noCandidates: true };

  const receiverMatches = candidates.filter(c => namesAreSimilar(c, businessName));
  if (!receiverMatches.length) {
    // Can't find the receiving name among candidates — can't confidently
    // identify which remaining name is the sender either.
    return { sender: null, ambiguous: true };
  }

  const remaining = candidates.filter(c => !receiverMatches.includes(c));
  if (remaining.length === 0) return { sender: null, ambiguous: true };
  if (remaining.length === 1) return { sender: remaining[0], ambiguous: false };

  // More than one remaining candidate — pick the longest alphabetic one,
  // but flag as ambiguous if two are close in length (can't be confident).
  const sorted = [...remaining].sort((a, b) => b.length - a.length);
  if (sorted.length >= 2 && sorted[0].length - sorted[1].length < 3) {
    return { sender: null, ambiguous: true };
  }
  return { sender: sorted[0], ambiguous: false };
}

async function ocrPaymentImage(imageUrl) {
  const { data } = await Tesseract.recognize(imageUrl, "eng");
  const text = data.text || "";

  const nameResult = identifySenderFromOcr(text, verifyState.businessName);
  const amountMatch = text.match(/[₦$€]\s?[\d.,]+|NGN\s?[\d.,]+|EUR\s?[\d.,]+|\b\d{1,3}(,\d{3})*(\.\d{1,2})?\b/);
  const amount = amountMatch ? extractAmount(amountMatch[0]) : null;
  const dateInfo = (() => {
    for (const line of text.split("\n")) {
      const d = extractDate(line);
      if (d) return d;
    }
    return null;
  })();

  return {
    name: nameResult.sender || null,
    nameAmbiguous: !!nameResult.ambiguous,
    amount: amount,
    date: dateInfo ? dateInfo.date : null,
    time: dateInfo ? dateInfo.time : null
  };
}

/* =========================
   VERIFICATION ENGINE (deterministic)
========================= */

async function runPaymentVerification() {
  const body = document.getElementById("verifyBody");

  verifyState.pendingPayments = allOrders.filter(o =>
    o.status === "pending" && o.paymentProof
  );

  if (!verifyState.pendingPayments.length) {
    body.innerHTML = `
      <h2>Nothing to verify</h2>
      <p class="verify-sub">There are no unpaid orders with a payment proof image right now.</p>
      <button class="verify-btn-primary" onclick="closeVerifyOverlay()">Close</button>
    `;
    return;
  }

  body.innerHTML = `
    <h2>Verifying payments…</h2>
    <p class="verify-sub" id="verifyProgressLabel">Starting…</p>
    <div class="verify-results" id="verifyResultsList"></div>
  `;

  const resultsList = document.getElementById("verifyResultsList");
  const progressLabel = document.getElementById("verifyProgressLabel");
  const results = [];

  for (let i = 0; i < verifyState.pendingPayments.length; i++) {
    const order = verifyState.pendingPayments[i];
    progressLabel.textContent = `Checking payment ${i + 1} of ${verifyState.pendingPayments.length}…`;

    const imageUrl = `https://nyc.cloud.appwrite.io/v1/storage/buckets/${PRODUCT_IMAGES_BUCKET}/files/${order.paymentProof}/view?project=695981480033c7a4eb0d`;

    let extracted;
    try {
      extracted = await ocrPaymentImage(imageUrl);
    } catch (err) {
      console.error(err);
      extracted = { name: null, amount: null, date: null, time: null };
    }

    const verdict = matchPaymentToStatement(extracted, verifyState.statementTransactions);
    const result = { order, extracted, ...verdict };
    results.push(result);

    resultsList.insertAdjacentHTML("beforeend", renderVerifyResultCard(result));

    if (verdict.verdict === "VERIFIED") {
      try {
        await databases.updateDocument(DB_ID, ORDERS, order.$id, { status: "paid" });
      } catch (err) {
        console.error("Failed to auto-update order status:", err);
      }
    }
  }

  verifyState.results = results;
  renderVerifySummary(results);
  fetchOrders(); // single refresh at the end, not per-payment
}

function matchPaymentToStatement(extracted, transactions) {
  const checks = { sender: false, amount: false, date: false };
  let reason = "";

  if (extracted.name === null) {
    return {
      verdict: "NOT VERIFIED",
      checks,
      reason: extracted.nameAmbiguous
        ? "Could not confidently distinguish the sender's name from the receiving name."
        : "No sender name could be detected on the payment image."
    };
  }

  if (extracted.amount === null) {
    return { verdict: "NOT VERIFIED", checks, reason: "No payment amount could be detected." };
  }

  // Find statement rows matching on name — the required comparisons are
  // sender, amount, date; time only disambiguates between close matches.
  const nameMatches = transactions.filter(t => namesAreSimilar(t.name, extracted.name));
  if (!nameMatches.length) {
    return { verdict: "NOT VERIFIED", checks, reason: "No matching statement transaction was found." };
  }
  checks.sender = true;

  const amountMatches = nameMatches.filter(t =>
    extracted.amount !== null && Math.abs(t.credit - extracted.amount) < 0.01
  );
  if (!amountMatches.length) {
    return {
      verdict: "NOT VERIFIED",
      checks,
      reason: "Credit amount does not match the payment amount."
    };
  }
  checks.amount = true;

  if (extracted.date === null) {
    return { verdict: "NOT VERIFIED", checks, reason: "No payment date could be detected." };
  }

  const dateMatches = amountMatches.filter(t => t.date === extracted.date);
  if (!dateMatches.length) {
    return {
      verdict: "NOT VERIFIED",
      checks,
      reason: "Transaction date does not match the statement."
    };
  }
  checks.date = true;

  return { verdict: "VERIFIED", checks, reason: "" };
}

/* =========================
   RESULTS RENDERING
========================= */

function renderVerifyResultCard(result) {
  const title = getCardTitle(result.order);
  const isVerified = result.verdict === "VERIFIED";

  const line = (ok, label) =>
    `<div class="verify-check ${ok ? "ok" : "fail"}">${ok ? "&#10003;" : "&#10007;"} ${label}</div>`;

  return `
    <div class="verify-result-card ${isVerified ? "verified" : "not-verified"}">
      <div class="verify-result-head">
        <strong>${escapeHtml(title)}</strong>
        <span class="verify-verdict-tag">${result.verdict}</span>
      </div>
      ${line(result.checks.sender, "Sender matched")}
      ${line(result.checks.amount, "Amount matched")}
      ${line(result.checks.date, "Date matched")}
      ${!isVerified ? `<p class="verify-reason">Reason: ${escapeHtml(result.reason)}</p>` : ""}
    </div>
  `;
}

function renderVerifySummary(results) {
  const verified = results.filter(r => r.verdict === "VERIFIED").length;
  const notVerified = results.length - verified;

  const summary = document.createElement("div");
  summary.className = "verify-summary";
  summary.innerHTML = `
    <h3>Payment Verification Complete</h3>
    <p>Verified: <strong>${verified}</strong></p>
    <p>Not Verified: <strong>${notVerified}</strong></p>
    <p>Total examined: <strong>${results.length}</strong></p>
    <button class="verify-btn-primary" onclick="closeVerifyOverlay()">Done</button>
  `;
  document.getElementById("verifyBody").appendChild(summary);
  document.getElementById("verifyProgressLabel").textContent = "Done.";
}

/* =========================
   SMALL UTILITY
========================= */

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
