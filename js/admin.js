/* X-Redro manual subscription administration. Writes are performed by an Appwrite Function, not directly from the browser. */
const client = new Appwrite.Client()
  .setEndpoint("https://nyc.cloud.appwrite.io/v1")
  .setProject("695981480033c7a4eb0d");
const account = new Appwrite.Account(client);
const functions = new Appwrite.Functions(client);

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
    preview.innerHTML = `<strong>${escapeHtml(selectedUser.username || email)}</strong><span>${escapeHtml(email)} · User ID ${escapeHtml(selectedUser.userId)}</span>`;
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
    resultEl.innerHTML = `<strong>Subscription activated</strong>${escapeHtml(result.user.email || selectedUser.email)} is now on <b>${escapeHtml(result.subscription.plan)}</b> until <b>${escapeHtml(expiry.toLocaleString("en-NG"))}</b>.${result.warning ? `<p class="admin-warning">${escapeHtml(result.warning)}</p>` : ""}`;
    resultEl.classList.remove("hidden");
    showToast("Subscription updated successfully.", "success");
  } catch (err) {
    showAdminError("Subscription activation failed", err, "activate");
  } finally {
    btn.disabled = false;
    btn.textContent = "Activate subscription";
  }
}

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
