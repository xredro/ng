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
/* =========================
TELEGRAM NOTIFICATIONS
=========================
   Talks to the Cloudflare Worker with a short-lived Appwrite JWT. The Worker, not this page, holds the bot token, finds the
   seller from that JWT and keeps the chat id. This page never sees or sends a chat id. */
const TG_ICON = `<svg class="tg-icon" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="12" fill="#2AABEE"/><path fill="#fff" d="M17.9 7.1 15.8 17c-.15.7-.57.87-1.15.54l-3.2-2.36-1.54 1.49c-.17.17-.31.31-.64.31l.23-3.26 5.93-5.36c.26-.23-.06-.36-.4-.13l-7.33 4.62-3.16-.99c-.69-.21-.7-.69.14-1.02l12.35-4.76c.57-.21 1.07.14.88 1z"/></svg>`;
const tg = { state: "loading", deepLink: "", expires: 0, timer: null, message: "", retry: "status", busy: false };

function tgEscape(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
async function tgCall(path) {
  const jwt = await account.createJWT();
  const res = await fetch(window.XR_TELEGRAM.workerUrl.replace(/\/+$/, "") + path, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + jwt.jwt }, body: "{}"
  });
  let data = null; try { data = await res.json(); } catch (e) { /* no body */ }
  if (!data) throw new Error("The notification service did not answer properly.");
  return data;
}
function tgSet(state, message) { tg.state = state; tg.message = message || ""; renderTelegram(); }
function renderTelegram() {
  const el = document.getElementById("tgBody");
  if (!el) return;
  const head = (cls, label) => `<div class="tg-status">${TG_ICON}<span class="tg-dot tg-dot--${cls}" aria-hidden="true"></span><strong>${label}</strong></div>`;
  const dis = tg.busy ? "disabled" : "";
  let html = "";
  if (tg.state === "loading") html = head("off", "Checking…");
  else if (tg.state === "unconfigured") html = `${head("off", "Not set up yet")}<p class="xr-hint">The Telegram notification service has not been switched on for this site yet. See docs/TELEGRAM.md.</p>`;
  else if (tg.state === "disconnected") html = `${head("off", "Not connected")}<div class="tg-actions"><button type="button" class="xr-btn xr-btn--primary" ${dis} onclick="tgConnect()">Connect Telegram</button></div>`;
  else if (tg.state === "connecting") html = `${head("wait", "Waiting for you in Telegram…")}
      <ol class="tg-steps"><li>Tap <b>Open Telegram</b> below.</li><li>In Telegram, press <b>Start</b>.</li><li>Come back here. This page updates by itself.</li></ol>
      <div class="tg-actions"><a class="xr-btn xr-btn--primary" href="${tgEscape(tg.deepLink)}" target="_blank" rel="noopener">Open Telegram</a>
      <button type="button" class="xr-btn xr-btn--secondary" onclick="tgCancel()">Cancel</button></div>
      <p class="xr-hint">This link is just for you, works once, and expires in 10 minutes.</p>`;
  else if (tg.state === "connected") html = `${head("on", "Connected")}<p class="xr-hint">You'll get a message here for new orders, order updates, cancellations and additional payments.</p>
      <div class="tg-actions"><button type="button" class="xr-btn xr-btn--secondary" ${dis} onclick="tgTest()">Send Test Notification</button>
      <button type="button" class="xr-btn xr-btn--danger" ${dis} onclick="tgDisconnect()">Disconnect Telegram</button></div>`;
  else html = `${head("err", "Something went wrong")}<div class="xr-alert xr-alert--error" role="alert"><div>${tgEscape(tg.message || "Telegram could not be reached.")}</div></div>
      <div class="tg-actions"><button type="button" class="xr-btn xr-btn--primary" onclick="tgRetry()">Try again</button></div>`;
  if (tg.message && tg.state !== "error") html += `<p class="tg-note" role="status">${tgEscape(tg.message)}</p>`;
  el.innerHTML = html;
}
function tgStopPolling() { if (tg.timer) { clearInterval(tg.timer); tg.timer = null; } }
async function tgLoadStatus() {
  if (!xrTelegramConfigured()) return tgSet("unconfigured");
  try {
    const r = await tgCall("/api/telegram/status");
    if (!r.ok) throw new Error(r.message || "The notification service reported a problem.");
    tgSet(r.connected ? "connected" : "disconnected");
  }
  catch (e) { console.error("Telegram status failed:", e); tg.retry = "status"; tgSet("error", "Could not check Telegram right now. Check your connection and try again."); }
}
async function tgConnect() {
  tg.busy = true; renderTelegram();
  try {
    const r = await tgCall("/api/telegram/connect");
    if (!r.ok) throw new Error(r.message || "Could not start the connection.");
    tg.deepLink = r.deepLink; tg.expires = Date.now() + (r.expiresInSec || 600) * 1000;
    tg.busy = false; tgSet("connecting");
    window.open(tg.deepLink, "_blank", "noopener");           // may be blocked on phones: the Open Telegram button always works
    tgStopPolling();
    tg.timer = setInterval(async () => {
      if (Date.now() > tg.expires) { tgStopPolling(); tg.retry = "connect"; return tgSet("error", "The connection link expired. Press Try again for a new one."); }
      try { const s = await tgCall("/api/telegram/status"); if (s.ok && s.connected) { tgStopPolling(); tgSet("connected"); showToast("Telegram connected", "success"); } } catch (e) { /* keep waiting */ }
    }, 3000);
  } catch (e) {
    console.error("Telegram connect failed:", e); tg.busy = false; tg.retry = "connect";
    tgSet("error", e.message || "Could not start the connection.");
  }
}
function tgCancel() { tgStopPolling(); tgSet("disconnected"); }
function tgRetry() { return tg.retry === "connect" ? tgConnect() : (tgSet("loading"), tgLoadStatus()); }
async function tgTest() {
  tg.busy = true; renderTelegram();
  try {
    const r = await tgCall("/api/telegram/test");
    tg.busy = false;
    if (r.ok) { tg.state = "connected"; tg.message = ""; renderTelegram(); showToast("Test notification sent. Check Telegram.", "success"); }
    else if (r.code === "blocked") { tg.retry = "connect"; tgSet("error", r.message); }
    else { tg.state = "connected"; tg.message = ""; renderTelegram(); showToast(r.message || "Could not send the test.", "error"); }
  } catch (e) { console.error(e); tg.busy = false; tg.state = "connected"; renderTelegram(); showToast("Could not send the test. Try again.", "error"); }
}
async function tgDisconnect() {
  if (!confirm("Stop Telegram notifications for your store?")) return;
  tg.busy = true; renderTelegram();
  try {
    const r = await tgCall("/api/telegram/disconnect");
    tg.busy = false;
    if (!r.ok) throw new Error(r.message || "Could not disconnect.");
    tgSet("disconnected"); showToast("Telegram disconnected", "success");
  } catch (e) { console.error(e); tg.busy = false; tg.state = "connected"; renderTelegram(); showToast("Could not disconnect. Try again.", "error"); }
}

loadUser().then(() => { loadWhatsAppSettings(); renderTelegram(); tgLoadStatus(); });
