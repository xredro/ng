/* =========================
FILE OVERVIEW
========================= */
// User settings and account management with Appwrite

/* =========================
GLOBAL CONSTANTS / CONFIG
========================= */
const DB_ID = "695c4fce0039f513dc83";
const USERS = "695c501b001d24549b03";
const FORMS = "form";
const SUBS = "subscriptions";
const PAYMENTS = "payments";

/* =========================
EXTERNAL SERVICE SETUP
========================= */
const client = new Appwrite.Client()
  .setEndpoint('https://nyc.cloud.appwrite.io/v1')
  .setProject('695981480033c7a4eb0d');

const account = new Appwrite.Account(client);
const databases = new Appwrite.Databases(client);
const Query = Appwrite.Query;

/* =========================
GLOBAL STATE VARIABLES
========================= */
let profileDocId = null;
let user;
let res;
let formDoc = null;
let loadedProfile = { username: "", email: "" }; // what is saved, used to detect changes and to cancel an edit

/* =========================
CORE BUSINESS LOGIC
========================= */
async function requireAuth() {
  try {
    return await account.get();
  } catch {
    window.location.replace("login.html");
    return null;
  }
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function showSubscription(sub, daysLeft) {
  setText("subPlan", sub ? sub.plan : "None");
  const badge = document.getElementById("subStatus");
  const expires = document.getElementById("subExpires");
  if (!sub || daysLeft <= 0) {
    setText("subStatus", "Expired");
    if (badge) badge.className = "xr-badge xr-badge--unpaid xr-badge--dot";
    if (expires) expires.textContent = "Expired";
    return;
  }
  const soon = daysLeft <= 3;
  setText("subStatus", soon ? "Ending soon" : "Active");
  if (badge) badge.className = `xr-badge xr-badge--${soon ? "attention" : "paid"} xr-badge--dot`;
  if (expires) expires.textContent = typeof xrTimeLeft === "function" && sub.expiresAt ? xrTimeLeft(new Date(sub.expiresAt) - new Date()).text : `${daysLeft} ${daysLeft === 1 ? "day" : "days"}`;
}

async function loadUser() {
  user = await requireAuth();
  if (!user) return;

  try {
    res = await databases.listDocuments(
      DB_ID,
      USERS,
      [
        Query.equal("userId", user.$id),
        Query.orderDesc("$createdAt"),
        Query.limit(1)
      ]
    );

    if (!res.documents.length) return;

    const profile = res.documents[0];
    profileDocId = profile.$id;

    username.value = profile.username || "";
    email.value = profile.email || user.email || "";
    loadedProfile = { username: username.value, email: email.value };

    // WhatsApp-style profile avatar: initials, no photo
    const avatarEl = document.getElementById("profileAvatar");
    const nameDisplayEl = document.getElementById("profileNameDisplay");
    const displayName = profile.username || user.email || "Your account";
    if (avatarEl) avatarEl.textContent = displayName.trim().charAt(0).toUpperCase();
    if (nameDisplayEl) nameDisplayEl.textContent = displayName;

    //Theme Application
    const savedTheme = profile.theme || "light";
    applyTheme(savedTheme);

    //Subscription Check (the real plan and expiry are shown, not a fixed label)
    const subRes = await databases.listDocuments(DB_ID, SUBS, [
      Query.equal("userId", user.$id),
      Query.equal("status", "active"),
      Query.orderDesc("expiresAt"),
      Query.limit(1)
    ]);

    if (!subRes.documents.length) {
      showSubscription(null, 0);
      document.getElementById("subscriptionModal")?.classList.remove("hidden");
      return;
    }
    const sub = subRes.documents[0];
    const daysLeft = Math.ceil(
      (new Date(sub.expiresAt) - new Date()) / 86400000
    );

    showSubscription(sub, daysLeft);
    if (daysLeft <= 0) {
      document.getElementById("subscriptionModal").classList.remove("hidden");
    }
  } catch (err) {
    console.error(err);
    document.getElementById("settingsError")?.classList.remove("hidden");
  }
}

async function changePassword() {
  const current = document.getElementById("currentPassword").value;
  const next = document.getElementById("newPassword").value;

  if (!current || !next) {
    showToast("Please fill all fields", "warning");
    return;
  }

  if (next.length < 8) {
    showToast("New password must be at least 8 characters", "warning");
    return;
  }

  if (current === next) {
    showToast("New password must be different from current password", "warning");
    return;
  }

  try {
    await account.updatePassword(next, current);

    document.getElementById("currentPassword").value = "";
    document.getElementById("newPassword").value = "";

    closePasswordModal();
    showToast("Password updated successfully", "success");
  } catch (err) {
    console.error(err);

    if (err.code === 401) {
      showToast("Current password is incorrect", "warning");
    } else {
      showToast(err.message || "Password update failed", "warning");
    }
  }
}

async function logout() {
  await account.deleteSession("current");
  window.location.href = "login.html";
}

/* =========================================================
   PAYMENT SYSTEM DISABLED — kept for reference, not deleted.
   The Selar-based buySubscription() flow below is commented
   out. Selling/trial-renewal now goes through
   goToPaymentUpload() instead, which sends the seller to an
   external page to upload proof of payment manually.
   To re-enable Selar checkout, uncomment the block below and
   swap the button handlers back to buySubscription(days).
========================================================= */
/*
ORIGINAL_BUY_SUBSCRIPTION_START
async function buySubscription(days) {
  const btn = document.activeElement;
  if (btn) {
    btn.disabled = true;
    btn.innerText = "Redirecting…";
  }
  try {
    const plan = days === 7 ? "7 days" : "30 days";
    const amount = days === 7 ? 1000 : 3000;

    // Check for existing pending payments
    const existing = await databases.listDocuments(DB_ID, PAYMENTS, [
      Query.equal("userId", user.$id),
      Query.equal("status", "pending"),
      Query.equal("used", false),
      Query.limit(1)
    ]);

    if (existing.documents.length) {
      const oldPayment = existing.documents[0];
      const now = new Date();
      const expiresAt = new Date(oldPayment.expiresAt);

      if (expiresAt > now) {
        // Payment is still valid
        showToast("You already have a pending payment. Please complete it.", "warning");

        await databases.updateDocument(DB_ID, PAYMENTS, oldPayment.$id, {
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() });
        
        // Optional: redirect user directly to Selar with old reference
        const selarLink =
          oldPayment.durationDay === 7
            ? `https://selar.com/9g7elg0071`
            : `https://selar.com/07s670b9vg`;

        // Small delay before redirecting so user sees the toast
        setTimeout(() => window.location.href = selarLink, 1500);
        return;
      } else {
        // Old payment expired → allow new payment
        await databases.updateDocument(DB_ID, PAYMENTS, oldPayment.$id, {
          status: "expired"
        });
      }
    }

    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 30); // token valid for 30 mins

    const payment = await databases.createDocument(
      DB_ID,
      PAYMENTS,
      Appwrite.ID.unique(),
      {
        userId: user.$id,
        plan,
        durationDay: days,
        amount,
        expiresAt: expiresAt.toISOString(),
        used: false,
        status: "pending"
      }
    );

    // Redirect to Selar with new payment reference
    const selarLink =
      days === 7
        ? `https://selar.com/9g7elg0071`
        : `https://selar.com/07s670b9vg`;

    window.location.href = selarLink;

  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.innerText = "Subscribe";
    }
    console.error(err);
    showToast("Unable to start payment", "error");
  }
}
ORIGINAL_BUY_SUBSCRIPTION_END
*/

// Replaces the old buySubscription(days) flow: sends the seller to
// an external page where they upload their payment proof manually.
// TODO: replace this placeholder URL with your real payment/upload page.
const PAYMENT_UPLOAD_URL = "https://xredro.pages.dev/form?fid=697c34ab17039e5fc78f";

function goToPaymentUpload() {
  window.location.href = PAYMENT_UPLOAD_URL;
}

/* =========================
STOREFRONT WHATSAPP SETTINGS
========================= */
async function loadWhatsAppSettings() {
  try {
    const found = await databases.listDocuments(DB_ID, FORMS, [
      Query.equal("userId", user.$id),
      Query.limit(1)
    ]);
    formDoc = found.documents[0] || null;
    const numberInput = document.getElementById("whatsappNumber");
    const toggle = document.getElementById("whatsappOrderRedirectEnabled");
    if (numberInput) numberInput.value = formDoc?.whatsappNumber || "";
    if (toggle) toggle.checked = formDoc?.whatsappOrderRedirectEnabled === true;
    const updatesToggle = document.getElementById("customerOrderUpdatesEnabled");
    if (updatesToggle) updatesToggle.checked = formDoc?.customerOrderUpdatesEnabled !== false; // missing field = on
  } catch (err) {
    console.error("Failed to load WhatsApp settings:", err);
  }
}

function normalizeSettingsWhatsAppNumber(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) digits = "234" + digits.slice(1);
  return digits;
}

function validSettingsWhatsAppNumber(value) {
  return /^234\d{10}$/.test(normalizeSettingsWhatsAppNumber(value));
}
async function saveWhatsAppSettings() {
  const numberInput = document.getElementById("whatsappNumber");
  const toggle = document.getElementById("whatsappOrderRedirectEnabled");
  const number = String(numberInput?.value || "").trim();
  const enabled = !!toggle?.checked;

  if (enabled) {
    const digits = number.replace(/\D/g, "");
    if (!validSettingsWhatsAppNumber(number)) {
      showToast("Enter a valid Nigerian WhatsApp mobile number, e.g. 08012345678 or +2348012345678.", "warning");
      toggle.checked = false;
      return;
    }
  }

  try {
    if (!formDoc) {
      const found = await databases.listDocuments(DB_ID, FORMS, [
        Query.equal("userId", user.$id),
        Query.limit(1)
      ]);
      formDoc = found.documents[0] || null;
    }
    if (!formDoc) throw new Error("No storefront form exists for this account.");

    await databases.updateDocument(DB_ID, FORMS, formDoc.$id, {
      whatsappNumber: number,
      whatsappOrderRedirectEnabled: enabled
    });

    formDoc.whatsappNumber = number;
    formDoc.whatsappOrderRedirectEnabled = enabled;

    showToast(
      enabled
        ? "WhatsApp order handoff enabled"
        : "WhatsApp order handoff turned off",
      "success"
    );
  } catch (err) {
    console.error("Failed to save WhatsApp settings:", err);
    showToast(
      "Could not save WhatsApp settings. Make sure the two WhatsApp attributes exist on the form collection.",
      "error"
    );
  }
}

/* Customer order changes on/off. Saved immediately; the store and the Retrieve My Order page read it from the form document. */
async function saveOrderUpdatesSetting(box) {
  const enabled = !!box.checked;
  box.disabled = true;
  try {
    if (!formDoc) {
      const found = await databases.listDocuments(DB_ID, FORMS, [Query.equal("userId", user.$id), Query.limit(1)]);
      formDoc = found.documents[0] || null;
    }
    if (!formDoc) throw new Error("No storefront form exists for this account.");
    await databases.updateDocument(DB_ID, FORMS, formDoc.$id, { customerOrderUpdatesEnabled: enabled });
    formDoc.customerOrderUpdatesEnabled = enabled;
    showToast(enabled ? "Customers can retrieve and update their orders" : "Customer order changes are off", "success");
  } catch (err) {
    console.error("Failed to save the order changes setting:", err);
    box.checked = !enabled; // put the switch back: nothing was saved
    showToast("Could not save. Make sure the customerOrderUpdatesEnabled (boolean) attribute exists on the form collection.", "error");
  } finally { box.disabled = false; }
}

/* =========================
UI INTERACTION LOGIC
========================= */
// The profile fields stay locked until Edit is pressed; Save is only available while editing.
function setEditing(on) {
  document.getElementById("username").disabled = !on;
  document.getElementById("email").disabled = !on;
  document.getElementById("updateAccount").disabled = !on;
  const btn = document.getElementById("userUpdate");
  btn.textContent = on ? "Cancel" : "Edit";
  if (on) document.getElementById("username").focus();
}

document.getElementById("updateAccount").onclick = async () => {
  const btn = document.getElementById("updateAccount");
  try {
    const nameVal = username.value.trim();
    const emailVal = email.value.trim();
    const emailChanged = emailVal !== (user.email || "");
    const nameChanged = nameVal !== loadedProfile.username;

    if (!nameVal) { showToast("Enter a username", "warning"); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) { showToast("Enter a valid email address", "warning"); return; }
    if (!emailChanged && !nameChanged) { showToast("Nothing to update", "info"); setEditing(false); return; }

    // Only an email change needs the password
    let passwordVal = null;
    if (emailChanged) {
      passwordVal = prompt("Enter your password to confirm your new email");
      if (!passwordVal) {
        showToast("Password required to change your email", "warning");
        return;
      }
    }

    btn.disabled = true;
    btn.classList.add("xr-btn--loading");

    if (nameChanged) await account.updateName(nameVal);
    if (emailChanged) await account.updateEmail(emailVal, passwordVal);

    // Update profile collection
    await databases.updateDocument(DB_ID, USERS, profileDocId, {
      username: nameVal,
      email: emailVal
    });

    user.name = nameVal;
    user.email = emailVal;
    loadedProfile = { username: nameVal, email: emailVal };
    const avatarEl = document.getElementById("profileAvatar");
    const nameDisplayEl = document.getElementById("profileNameDisplay");
    if (avatarEl) avatarEl.textContent = nameVal.charAt(0).toUpperCase();
    if (nameDisplayEl) nameDisplayEl.textContent = nameVal;

    setEditing(false);
    showToast("Account updated successfully", "success");

  } catch (err) {
    console.error(err);
    showToast(err.message || "Update failed", "error");
    btn.disabled = false;
  } finally {
    btn.classList.remove("xr-btn--loading");
  }
};

document.getElementById("userUpdate").onclick = () => {
  const editing = !document.getElementById("updateAccount").disabled;
  if (editing) {                        // Cancel: put the saved values back
    username.value = loadedProfile.username;
    email.value = loadedProfile.email;
  }
  setEditing(!editing);
};

function openPasswordModal() {
  document.getElementById("passwordModal").classList.remove("hidden");
}

function closePasswordModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById("passwordModal").classList.add("hidden");
}

/* =========================
INITIALIZATION / BOOTSTRAP LOGIC
========================= */
loadUser().then(() => { loadWhatsAppSettings(); });
