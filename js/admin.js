/* X-Redro manual subscription administration */
const DB_ID = "695c4fce0039f513dc83";
const USERS = "695c501b001d24549b03";
const SUBS = "subscriptions";

const client = new Appwrite.Client()
  .setEndpoint("https://nyc.cloud.appwrite.io/v1")
  .setProject("695981480033c7a4eb0d");
const account = new Appwrite.Account(client);
const databases = new Appwrite.Databases(client);
const Query = Appwrite.Query;

/*
  Admin access:
  Put the email(s) of the Appwrite account(s) that you have authorised for
  this page here. This is an additional UI gate; the Appwrite database
  permissions should remain the real security boundary for subscription writes.
*/
const ADMIN_EMAILS = [
  // Add the Appwrite account email that you have authorised for admin use.
  "REPLACE_WITH_YOUR_ADMIN_EMAIL@example.com"
].filter(v => !v.startsWith("REPLACE_WITH_")).map(v => v.toLowerCase());

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

  const allowed = ADMIN_EMAILS.includes(String(currentAdmin.email || "").toLowerCase());
  if (!allowed) {
    state.innerHTML = `<strong>Access denied</strong><p>This account is not authorised to use subscription administration.</p>`;
    return;
  }

  state.classList.add("hidden");
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
    const result = await databases.listDocuments(DB_ID, USERS, [
      Query.equal("email", email),
      Query.limit(1)
    ]);

    if (!result.documents.length) {
      showToast("No X-Redro account was found with that email.", "warning");
      return;
    }

    const profile = result.documents[0];
    if (!profile.userId) {
      showToast("This account record has no user ID.", "error");
      return;
    }

    selectedUser = profile;
    preview.innerHTML = `<strong>${escapeHtml(profile.username || email)}</strong><span>${escapeHtml(email)} · User ID ${escapeHtml(profile.userId)}</span>`;
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
    const now = new Date();
    const expiry = new Date(now);
    expiry.setDate(expiry.getDate() + plan.days);

    // Retire previous active subscriptions so the new manual payment becomes
    // the single subscription used by the seller dashboard.
    const existing = await databases.listDocuments(DB_ID, SUBS, [
      Query.equal("userId", selectedUser.userId),
      Query.equal("status", "active"),
      Query.limit(100)
    ]);

    for (const sub of existing.documents) {
      await databases.updateDocument(DB_ID, SUBS, sub.$id, {
        status: "expired"
      });
    }

    const created = await databases.createDocument(DB_ID, SUBS, Appwrite.ID.unique(), {
      userId: selectedUser.userId,
      plan: plan.label,
      durationDay: plan.days,
      startsAt: now.toISOString(),
      expiresAt: expiry.toISOString(),
      status: "active"
    });

    const result = document.getElementById("adminResult");
    result.innerHTML = `<strong>Subscription activated</strong>${escapeHtml(selectedUser.email || "Customer")} is now on <b>${escapeHtml(plan.label)}</b> until <b>${escapeHtml(expiry.toLocaleString("en-NG"))}</b>.`;
    result.classList.remove("hidden");
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
