/* X-Redro manual subscription administration. Writes are performed by an Appwrite Function, not directly from the browser. */
const client = new Appwrite.Client()
  .setEndpoint("https://nyc.cloud.appwrite.io/v1")
  .setProject("695981480033c7a4eb0d");
const account = new Appwrite.Account(client);
const functions = new Appwrite.Functions(client);

// Replace this with the Function ID created in Appwrite Console.
const ADMIN_FUNCTION_ID = "REPLACE_WITH_APPWRITE_FUNCTION_ID";
// Authorization is enforced by Appwrite Function Execute permissions (X-Redro Admins Team),
// not by a client-side email allowlist that can be edited in the browser.

async function runAdminFunction(payload) {
  if (!ADMIN_FUNCTION_ID || ADMIN_FUNCTION_ID.startsWith("REPLACE_WITH_")) {
    throw new Error("Admin setup is incomplete: add your Appwrite Function ID in js/admin.js.");
  }
  const execution = await functions.createExecution(ADMIN_FUNCTION_ID, JSON.stringify(payload), false, "/", "POST");
  let result;
  try { result = JSON.parse(execution.responseBody || "{}"); }
  catch (_) { throw new Error("The admin function returned an unreadable response. Check its Appwrite logs."); }
  if (!result.ok) throw new Error(result.message || "Admin operation failed.");
  return result;
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
    console.error(err);
    showToast(err.message || "Could not find that account.", "error");
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
    console.error(err);
    showToast(err.message || "Subscription update failed.", "error");
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
