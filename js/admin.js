/* X-Redro manual subscription administration. Writes are performed by an Appwrite Function, not directly from the browser. */
const client = new Appwrite.Client()
  .setEndpoint("https://nyc.cloud.appwrite.io/v1")
  .setProject("695981480033c7a4eb0d");
const account = new Appwrite.Account(client);
const functions = new Appwrite.Functions(client);
const databases = new Appwrite.Databases(client);

// Replace this with the Function ID created in Appwrite Console.
const ADMIN_FUNCTION_ID = "6aca4fc1003185200a1c";
// Authorization is enforced by Appwrite Function Execute permissions (X-Redro Admins Team),
// not by a client-side email allowlist that can be edited in the browser.

function makeAdminError(message, diagnostics = {}) {
  const err = new Error(message);
  err.adminDiagnostics = diagnostics;
  return err;
}

function getAppwriteErrorDetails(err) {
  return {
    errorType: err?.type || err?.name || "UnknownError",
    errorCode: err?.code ?? null,
    message: err?.message || String(err),
    response: typeof err?.response === "string" ? err.response : undefined
  };
}

async function runAdminFunction(payload) {
  const action = String(payload?.action || "unknown");
  if (!ADMIN_FUNCTION_ID || ADMIN_FUNCTION_ID.startsWith("REPLACE_WITH_")) {
    throw makeAdminError("Admin Function ID has not been configured.", {
      stage: "Website configuration",
      action,
      likelyCause: "js/admin.js still contains the placeholder Function ID.",
      fix: "Open Appwrite Console → Functions → subscription-admin, copy its Function ID, and replace ADMIN_FUNCTION_ID in js/admin.js.",
      functionIdConfigured: false
    });
  }

  let execution;
  try {
    execution = await functions.createExecution(ADMIN_FUNCTION_ID, JSON.stringify(payload), false, "/", "POST");
  } catch (err) {
    const appwrite = getAppwriteErrorDetails(err);
    throw makeAdminError("Appwrite rejected the Function execution request.", {
      stage: "Calling Appwrite Function",
      action,
      functionId: ADMIN_FUNCTION_ID,
      likelyCause: "Check the Function ID, signed-in session, Function Execute permissions, deployment status, and Appwrite connectivity.",
      ...appwrite
    });
  }

  const statusCode = execution.responseStatusCode ?? execution.statusCode ?? null;
  const executionId = execution.$id || execution.id || null;
  let result;
  try {
    result = JSON.parse(execution.responseBody || "{}");
  } catch (_) {
    throw makeAdminError("The Function returned a response that was not valid JSON.", {
      stage: "Reading Function response",
      action,
      functionId: ADMIN_FUNCTION_ID,
      executionId,
      statusCode,
      executionStatus: execution.status || null,
      responseBody: String(execution.responseBody || "(empty response)").slice(0, 5000),
      likelyCause: "The Function may have crashed, returned a non-JSON response, or failed before its response handler completed. Check this execution in Appwrite Function logs."
    });
  }

  if (!result.ok || (statusCode !== null && Number(statusCode) >= 400)) {
    const serverDiag = result.diagnostic && typeof result.diagnostic === "object" ? result.diagnostic : {};
    throw makeAdminError(result.message || `The Function returned HTTP ${statusCode || "error"}.`, {
      stage: serverDiag.stage || "Appwrite Function response",
      action,
      functionId: ADMIN_FUNCTION_ID,
      executionId,
      statusCode,
      executionStatus: execution.status || null,
      serverDiagnostic: serverDiag,
      responseBody: JSON.stringify(result, null, 2).slice(0, 5000),
      likelyCause: serverDiag.likelyCause || "Use the stage and diagnostic information above, then inspect this execution's logs in Appwrite."
    });
  }
  return result;
}

function showAdminError(title, err, action) {
  console.error("X-Redro admin operation failed", { action, error: err, diagnostics: err?.adminDiagnostics });
  const modal = document.getElementById("adminErrorModal");
  if (!modal) {
    showToast(`${title}: ${err?.message || "Unknown error"}`, "error");
    return;
  }
  const diagnostics = err?.adminDiagnostics || {
    stage: "Browser-side operation",
    action,
    errorType: err?.name || "Error",
    message: err?.message || String(err),
    likelyCause: "Open the browser developer console and Appwrite Function execution logs for more information."
  };
  document.getElementById("adminErrorTitle").textContent = title;
  document.getElementById("adminErrorSummary").textContent = err?.message || "Unknown error";
  document.getElementById("adminErrorDetails").textContent = JSON.stringify({
    action,
    timestamp: new Date().toISOString(),
    page: window.location.href,
    ...diagnostics
  }, null, 2);
  modal.classList.remove("hidden");
  document.getElementById("closeAdminError").focus();
}

let currentAdmin = null;
let selectedUser = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[c]));
}

async function initAdmin() {
  const state = document.getElementById("adminAccessState");
  try {
    currentAdmin = await account.get();
  } catch (_) {
    window.location.replace("login.html");
    return;
  }

  // Show the admin UI to a signed-in user; the Appwrite Function itself must
  // be configured to allow execution only by the X-Redro Admins Team. This avoids
  // the previous placeholder email allowlist making every real admin see Access denied.
  state.innerHTML = `<strong>Signed in as ${escapeHtml(currentAdmin.email || "your Appwrite account")}</strong><p>Admin actions are protected by Appwrite Function permissions. Only accounts in the <b>X-Redro Admins</b> Team should be allowed to complete operations.</p>`;
  state.classList.remove("hidden");
  document.getElementById("adminPanel").classList.remove("hidden");
  document.getElementById("batchPanel").classList.remove("hidden");
}

async function findUser() {
  const email = document.getElementById("userEmail").value.trim().toLowerCase();
  const preview = document.getElementById("accountPreview");
  if (!email) return showToast("Enter a customer email.", "warning");

  selectedUser = null;
  preview.classList.add("hidden");
  const btn = document.getElementById("findUserBtn");
  btn.disabled = true;
  btn.textContent = "Searching…";

  try {
    const result = await runAdminFunction({ action: "findUser", email });
    selectedUser = result.user;
    const running = result.subscription ? ` · Current plan ends in ${escapeHtml(formatRemaining(new Date(result.subscription.expiresAt) - new Date()))} (that time will be kept)` : "";
    preview.innerHTML = `<strong>${escapeHtml(selectedUser.username || email)}</strong><span>${escapeHtml(email)} · User ID ${escapeHtml(selectedUser.userId)}${running}</span>`;
    preview.classList.remove("hidden");
  } catch (err) {
    showAdminError("Could not find customer account", err, "findUser");
  } finally {
    btn.disabled = false;
    btn.textContent = "Find account";
  }
}

function getPlan() {
  const value = document.getElementById("planSelect").value;
  const presets = {
    weekly: { label:"weekly", days:7 },
    monthly: { label:"monthly", days:30 },
    quarterly: { label:"quarterly", days:90 }
  };
  if (presets[value]) return presets[value];

  const days = Number(document.getElementById("customDays").value);
  if (value === "custom" && Number.isInteger(days) && days >= 1 && days <= 3650) {
    return { label:`custom-${days}-days`, days };
  }
  return null;
}

async function activateSubscription(event) {
  event.preventDefault();
  if (!selectedUser) return showToast("Find the customer account first.", "warning");

  const plan = getPlan();
  if (!plan) return showToast("Select a valid payment plan.", "warning");

  const btn = document.getElementById("activateBtn");
  btn.disabled = true;
  btn.textContent = "Updating…";

  try {
    const result = await runAdminFunction({ action: "activate", userId: selectedUser.userId, plan: plan.label, days: plan.days });
    const expiry = new Date(result.subscription.expiresAt);
    const resultEl = document.getElementById("adminResult");
    resultEl.innerHTML = `<strong>${result.extended ? "Subscription extended" : "Subscription activated"}</strong>${escapeHtml(result.user.email || selectedUser.email)} is now on <b>${escapeHtml(result.subscription.plan)}</b> until <b>${escapeHtml(expiry.toLocaleString("en-NG"))}</b>.${result.extended ? ` The ${escapeHtml(formatRemaining(result.remainingMs))} they still had was added to the new plan.` : ""}${result.warning ? `<p class="admin-warning">${escapeHtml(result.warning)}</p>` : ""}`;
    resultEl.classList.remove("hidden");
    showToast("Subscription updated successfully.", "success");
  } catch (err) {
    showAdminError("Subscription activation failed", err, "activate");
  } finally {
    btn.disabled = false;
    btn.textContent = "Activate subscription";
  }
}

/* ===== time helpers ===== */
function formatRemaining(ms) {
  if (!(ms > 0)) return "no time";
  const DAY = 86400000, HOUR = 3600000;
  if (ms >= DAY) { const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / HOUR); return `${d} day${d === 1 ? "" : "s"}${h ? ` ${h} hour${h === 1 ? "" : "s"}` : ""}`; }
  const h = Math.ceil(ms / HOUR);
  return ms < HOUR ? "less than an hour" : `${h} hour${h === 1 ? "" : "s"}`;
}

/* ===== batch mode =====
   Reads the orders in YOUR store that you marked Paid (these are the subscription payments customers sent), works out the
   customer's email and the plan they picked (7 or 30 days) from each order, checks the account, and then activates or
   extends every selected one through the same Function as the single form. Finished orders are set to Delivered so they
   are never processed twice.
   The detection below is based on the labels and product names in your subscription store. If yours differ, change these. */
const BATCH_DB_ID = "695c4fce0039f513dc83";
const BATCH_ORDERS = "orders";
const BATCH_EMAIL_LABEL = /e-?mail/i;                       // a field whose label contains "email"
const BATCH_PLANS = [                                        // first match wins; tested against product names and descriptions
  { label: "weekly", days: 7, test: /\b7\b|week/i },
  { label: "monthly", days: 30, test: /\b30\b|month/i }
];
const BATCH_DONE_KEY = "xr-batch-done";
let batchRows = [];
let batchBusy = false;

const doneSet = () => { try { return new Set(JSON.parse(localStorage.getItem(BATCH_DONE_KEY) || "[]")); } catch (_) { return new Set(); } };
const rememberDone = id => { try { const s = doneSet(); s.add(id); localStorage.setItem(BATCH_DONE_KEY, JSON.stringify([...s].slice(-500))); } catch (_) { /* ignore */ } };

function parseOrderFields(raw) {
  return (Array.isArray(raw) ? raw : []).map(v => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch (_) { return null; } }).filter(e => e && typeof e === "object");
}
function detectEmail(fields) {
  const byLabel = fields.find(f => f.type !== "product" && BATCH_EMAIL_LABEL.test(String(f.label || "")) && /@/.test(String(f.value || "")));
  const any = byLabel || fields.find(f => f.type !== "product" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(f.value || "").trim()));
  return any ? String(any.value).trim().toLowerCase() : "";
}
function detectPlan(fields) {
  const texts = [];
  fields.forEach(f => { if (f.type === "product" && Array.isArray(f.value)) f.value.forEach(p => texts.push(`${p.name || ""} ${p.description || ""}`)); });
  for (const plan of BATCH_PLANS) if (texts.some(t => plan.test.test(t))) return plan.label;
  return "";
}
function setBatchStatus(text) { document.getElementById("batchStatus").textContent = text || ""; }

async function loadBatch() {
  if (batchBusy) return;
  batchBusy = true;
  const btn = document.getElementById("batchLoadBtn");
  btn.disabled = true; btn.textContent = "Loading…";
  document.getElementById("batchSummary").classList.add("hidden");
  try {
    const all = [];
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const q = [Appwrite.Query.equal("userId", currentAdmin.$id), Appwrite.Query.equal("status", "paid"), Appwrite.Query.orderAsc("$createdAt"), Appwrite.Query.limit(100)];
      if (cursor) q.push(Appwrite.Query.cursorAfter(cursor));
      const r = await databases.listDocuments(BATCH_DB_ID, BATCH_ORDERS, q);
      all.push(...r.documents);
      if (r.documents.length < 100) break;
      cursor = r.documents[r.documents.length - 1].$id;
    }
    const done = doneSet();
    batchRows = all.filter(o => !done.has(o.$id)).map(o => {
      const fields = parseOrderFields(o.formData);
      const email = detectEmail(fields), plan = detectPlan(fields);
      return { order: o, email, plan, user: null, running: null, state: email ? "checking" : "needs-email", message: "", selected: false };
    });
    renderBatch();
    setBatchStatus(batchRows.length ? `${batchRows.length} paid order${batchRows.length === 1 ? "" : "s"} waiting. Checking accounts…` : "No paid orders are waiting.");
    for (const row of batchRows) { if (row.email) await lookupBatchRow(row); }
    setBatchStatus(batchRows.length ? "Check each row, fix anything marked, then press Process selected." : "No paid orders are waiting.");
  } catch (err) {
    console.error("Could not load paid orders:", err);
    showAdminError("Could not load paid orders", err, "loadBatch");
  } finally { batchBusy = false; btn.disabled = false; btn.textContent = "Load paid orders"; }
}

async function lookupBatchRow(row) {
  row.state = "checking"; row.message = ""; renderBatch();
  try {
    const r = await runAdminFunction({ action: "findUser", email: row.email });
    row.user = r.user; row.running = r.subscription || null; row.state = "ready";
    row.selected = !!row.plan;
  } catch (err) {
    row.user = null; row.state = "no-account"; row.message = err.message || "Account lookup failed"; row.selected = false;
  }
  renderBatch();
}

function batchRowHTML(row, i) {
  const o = row.order;
  const amount = Number(o.totalAmount || 0).toLocaleString("en-NG");
  const when = new Date(o.$createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const planDays = (BATCH_PLANS.find(p => p.label === row.plan) || {}).days;
  let action = "";
  if (row.state === "ready" && planDays) {
    action = row.running ? `Extend: keeps ${escapeHtml(formatRemaining(new Date(row.running.expiresAt) - new Date()))}, then adds ${planDays} days`
                         : `Activate ${planDays} days`;
  }
  const stateText = {
    checking: "Checking account…", "needs-email": "No email found on this order. Type it below.", "no-account": row.message || "No X-Redro account with that email.",
    ready: action || "Choose a plan", working: "Working…", done: row.message, failed: row.message
  }[row.state] || "";
  const locked = row.state === "working" || row.state === "done";
  return `<div class="batch-row batch-row--${row.state}" data-i="${i}">
    <label class="batch-pick"><input type="checkbox" data-pick="${i}" ${row.selected ? "checked" : ""} ${row.state !== "ready" || !planDays || locked ? "disabled" : ""} aria-label="Select order from ${escapeHtml(row.email || "unknown")}"></label>
    <div class="batch-main">
      <strong>${escapeHtml(row.email || "No email")}</strong>
      <span class="batch-meta">${escapeHtml(when)} · ₦${amount} · order ${escapeHtml(String(o.$id).slice(-6))}</span>
      ${row.state === "needs-email" ? `<input type="email" class="batch-email" data-email="${i}" placeholder="customer@example.com">` : ""}
      <span class="batch-state">${escapeHtml(stateText)}</span>
    </div>
    <div class="batch-plan"><select data-plan="${i}" ${locked ? "disabled" : ""} aria-label="Plan">
      <option value="" ${row.plan ? "" : "selected"}>Plan?</option>
      ${BATCH_PLANS.map(p => `<option value="${p.label}" ${row.plan === p.label ? "selected" : ""}>${p.days} days</option>`).join("")}</select></div>
  </div>`;
}
function renderBatch() {
  const list = document.getElementById("batchList");
  list.innerHTML = batchRows.map(batchRowHTML).join("");
  const n = batchRows.filter(r => r.selected && r.state === "ready").length;
  const run = document.getElementById("batchRunBtn");
  run.disabled = batchBusy || !n;
  run.textContent = n ? `Process ${n} selected` : "Process selected";
  document.getElementById("batchAll").checked = batchRows.some(r => r.state === "ready") && batchRows.filter(r => r.state === "ready").every(r => r.selected);
}

async function runBatch() {
  if (batchBusy) return;
  const rows = batchRows.filter(r => r.selected && r.state === "ready" && r.user && r.plan);
  if (!rows.length) return;
  if (!confirm(`Activate or extend ${rows.length} subscription${rows.length === 1 ? "" : "s"}? Each finished order will be set to Delivered.`)) return;
  batchBusy = true; renderBatch();
  const ok = [], failed = [];
  for (const row of rows) {
    const plan = BATCH_PLANS.find(p => p.label === row.plan);
    row.state = "working"; row.message = ""; renderBatch();
    try {
      const r = await runAdminFunction({ action: "activate", userId: row.user.userId, plan: plan.label, days: plan.days });
      const until = new Date(r.subscription.expiresAt).toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short" });
      row.message = (r.extended ? `Extended: kept ${formatRemaining(r.remainingMs)} and added ${plan.days} days. ` : `Activated ${plan.days} days. `) + `Ends ${until}.`;
      rememberDone(row.order.$id);   // even if the next step fails, this order is never run twice from this browser
      try {
        await databases.updateDocument(BATCH_DB_ID, BATCH_ORDERS, row.order.$id, { status: "delivered" });
      } catch (e) {
        console.error("Subscription done, but the order could not be marked Delivered:", e);
        row.message += " (Could not mark the order Delivered. Do that on the Orders page so it is not repeated.)";
      }
      row.state = "done"; ok.push(row);
    } catch (err) {
      row.state = "failed"; row.message = "Not changed: " + (err.message || "failed");
      failed.push(row);
    }
    renderBatch();
  }
  batchBusy = false; renderBatch();
  const box = document.getElementById("batchSummary");
  box.innerHTML = `<strong>${ok.length} done${failed.length ? `, ${failed.length} not done` : ""}</strong>${
    ok.map(r => `<div>✓ ${escapeHtml(r.email)}: ${escapeHtml(r.message)}</div>`).join("")}${
    failed.map(r => `<div>✗ ${escapeHtml(r.email)}: ${escapeHtml(r.message)}</div>`).join("")}`;
  box.classList.remove("hidden");
  showToast(failed.length ? "Batch finished with some problems." : "Batch finished.", failed.length ? "warning" : "success");
}

document.addEventListener("change", e => {
  const t = e.target;
  if (t.hasAttribute && t.hasAttribute("data-pick")) { batchRows[Number(t.getAttribute("data-pick"))].selected = t.checked; renderBatch(); }
  else if (t.hasAttribute && t.hasAttribute("data-plan")) { const r = batchRows[Number(t.getAttribute("data-plan"))]; r.plan = t.value; r.selected = r.state === "ready" && !!r.plan; renderBatch(); }
  else if (t.id === "batchAll") { batchRows.forEach(r => { if (r.state === "ready" && r.plan) r.selected = t.checked; }); renderBatch(); }
  else if (t.hasAttribute && t.hasAttribute("data-email")) {
    const r = batchRows[Number(t.getAttribute("data-email"))]; const v = t.value.trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { r.email = v; lookupBatchRow(r); } else showToast("Enter a valid email.", "warning");
  }
});
document.getElementById("batchLoadBtn").addEventListener("click", loadBatch);
document.getElementById("batchRunBtn").addEventListener("click", runBatch);

document.getElementById("findUserBtn").addEventListener("click", findUser);
document.getElementById("userEmail").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); findUser(); } });
document.getElementById("planSelect").addEventListener("change", e => {
  document.getElementById("customDaysWrap").classList.toggle("hidden", e.target.value !== "custom");
});
document.getElementById("subscriptionForm").addEventListener("submit", activateSubscription);

initAdmin();

// Detailed diagnostic popup helpers.
function closeAdminErrorModal() { document.getElementById("adminErrorModal").classList.add("hidden"); }
document.getElementById("closeAdminError").addEventListener("click", closeAdminErrorModal);
document.getElementById("closeAdminErrorBottom").addEventListener("click", closeAdminErrorModal);
document.getElementById("copyAdminError").addEventListener("click", async () => {
  const text = document.getElementById("adminErrorDetails").textContent;
  const button = document.getElementById("copyAdminError");
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch (_) {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("adminErrorDetails"));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    button.textContent = "Select and copy";
  }
  setTimeout(() => { button.textContent = "Copy diagnostics"; }, 1800);
});
document.getElementById("adminErrorModal").addEventListener("click", event => {
  if (event.target.id === "adminErrorModal") event.currentTarget.classList.add("hidden");
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") document.getElementById("adminErrorModal").classList.add("hidden");
});
