/* =========================
FILE OVERVIEW
========================= */
// Authentication and user management with Appwrite

/* =========================
GLOBAL CONSTANTS / CONFIG
========================= */
const DB_ID = "695c4fce0039f513dc83";
const USERS = "695c501b001d24549b03";
const FORMS = "form";
const SUBS = "subscriptions";
const VERIFY_COOLDOWN = 60; 
let verifyTimer = null;
let verifyRemaining = 0;

/* =========================
EXTERNAL SERVICE SETUP
========================= */
const client = new Appwrite.Client()  
  .setEndpoint('https://nyc.cloud.appwrite.io/v1')  
  .setProject('695981480033c7a4eb0d');  
  
const account = new Appwrite.Account(client);  
const databases = new Appwrite.Databases(client);

/* =========================
UTILITY / HELPER FUNCTIONS
========================= */
/* Toggle Password */
function togglePassword(inputId, el) {  
  const input = document.getElementById(inputId);  
  const img = el.querySelector('img');  
  
  if (input.type === "password") {  
    input.type = "text";  
    img.src = "assets/eye-off.svg";  
  } else {  
    input.type = "password";  
    img.src = "assets/eye.svg";  
  }  
    
  if (!input.value) return;  
}

function getUsernameFromEmail(email) {  
  return email.split("@")[0]  
    .replace(/[^a-zA-Z0-9._]/g, "")  
    .toLowerCase();  
}

/* =========================
CORE BUSINESS LOGIC
========================= */
/* LOGIN */
async function login() {  
  const email = loginEmail.value.trim();  
  const password = loginPassword.value.trim();  
    
  if (!email || !password) {  
    showToast("Please enter email and password", "error");  
    return;  
  }  

  try {
    // A session already exists: this login page should never trap an
    // authenticated user. The dedicated login-page bootstrap below handles
    // this before the form is used; this guard also covers manual login calls.
    try {
      await account.get();
      window.location.replace("dashboard.html");
      return;
    } catch (_) {}

    // Create the new session. Do not delete all sessions first; that made
    // an already-authenticated browser unnecessarily destructive.
    await account.createEmailSession(email, password);

    const user = await account.get();  

    window.location.href = "dashboard.html";  

  } catch (err) {  
    console.error("LOGIN ERROR:", err.message);  
    showToast(err.message, "error");  
  }  
}

/* SIGNUP + AUTO SETUP */
async function signup() {  
  try {  

    try {  
      await account.deleteSessions();  
    } catch (e) {}  
      
    const email = signupEmail.value.trim();  
    const password = signupPassword.value.trim();  

    const username = getUsernameFromEmail(email);  
      
    if (!email || !password) {  
      showToast("All fields are required", "warning");  
      return;  
    }  

    if (password.length < 8) {  
      showToast("Password must be at least 8 characters", "warning");  
      return;  
    }  

    await account.create(  
      Appwrite.ID.unique(),  
      email,  
      password,  
      username  
    );  

    await account.createEmailSession(email, password);  

    await account.createVerification(  
      `${location.origin}/ng/verify.html`  
    );  
      
    window.location.href = "verifyInfo.html";  

  } catch (err) {  
    showToast(err.message, "error");  
  }  
}

async function sendReset() {  
  const email = document.getElementById("resetEmail").value.trim();  

  if (!email) {  
    showToast("Please enter your email", "warning");   
    return;  
  }  

  try {  
    await account.createRecovery(  
      email,  
      `${location.origin}/ng/reset-password.html`  
    );  

    showToast("Password reset link sent", "success");  
    closeResetModal();  
  } catch (err) {  
    showToast(err.message || "Failed to send email", "error");  
  }  
}

async function resetPassword() {
  const params = new URLSearchParams(window.location.search);

  const userId = params.get("userId");
  const secret = params.get("secret");

  const password = document.getElementById("newPassword").value.trim();
  const confirm = document.getElementById("confirmPassword").value.trim();

  if (!userId || !secret) {
    showToast("Invalid or expired reset link");
    return;
  }

  if (!password || !confirm) {
    showToast("All fields are required", "warning");
    return;
  }

  if (password.length < 8) {
    showToast("Password must be at least 8 characters", "warning");
    return;
  }

  if (password !== confirm) {
    showToast("Passwords do not match", "warning");
    return;
  }

  try {
    await account.updateRecovery(
      userId,
      secret,
      password,
      confirm
    );

    showToast("Password reset successful. Please login.", "success");
    window.location.href = "login.html";

  } catch (err) {
    console.error(err);
    showToast(err.message || "Reset failed", "error");
  }
}

/* =========================
UI INTERACTION LOGIC
========================= */
function openResetModal() {  
  document.getElementById("resetModal").classList.remove("hidden");  
}  

function closeResetModal(e) {  
  if (e && e.target !== e.currentTarget) return;  
  document.getElementById("resetModal").classList.add("hidden");  
}

async function resendVerification() {
  const btn = document.getElementById("resendVerifyBtn");
  const countdownEl = document.getElementById("resendCountdown");

  try {
    btn.disabled = true;
    btn.classList.add("hidden");

    await account.createVerification(
      `${location.origin}/ng/verify.html`
    );

    showToast("Verification email sent", "success");

    startVerifyCountdown(btn, countdownEl);

  } catch (err) {
    btn.disabled = false;
    btn.classList.remove("hidden");
    showToast(err.message || "Failed to resend email", "error");
  }
}

function startVerifyCountdown(btn, countdownEl) {
  // FORCE HIDE button
  btn.classList.add("hidden");
  btn.disabled = true;

  let remaining = VERIFY_COOLDOWN;

  countdownEl.classList.remove("hidden");
  countdownEl.innerText = `Resend available in ${remaining}s`;

  if (verifyTimer) clearInterval(verifyTimer);

  verifyTimer = setInterval(() => {
    remaining--;
    countdownEl.innerText = `Resend available in ${remaining}s`;

    if (remaining <= 0) {
      clearInterval(verifyTimer);
      verifyTimer = null;

      countdownEl.classList.add("hidden");
      btn.classList.remove("hidden");
      btn.disabled = false;
    }
  }, 1000);
  }

document.addEventListener("DOMContentLoaded", () => {
  const resendBtn = document.getElementById("resendVerifyBtn");
  const countdownEl = document.getElementById("resendCountdown");

  // Not on verify info page → do nothing
  if (!resendBtn || !countdownEl) return;

  // Hide button initially
  resendBtn.disabled = true;
  resendBtn.classList.add("hidden");

  // Start initial cooldown automatically
  startVerifyCountdown(resendBtn, countdownEl);
});

/* =========================
LOGIN PAGE SESSION / AUTOFILL BOOTSTRAP
========================= */
async function initLoginPage() {
  const emailEl = document.getElementById("loginEmail");
  const passwordEl = document.getElementById("loginPassword");
  const loginBtn = document.querySelector('.primary-btn[onclick="login()"]');
  if (!emailEl || !passwordEl) return;

  // Never show the login form to a browser that already has an Appwrite session.
  try {
    await account.get();
    window.location.replace("dashboard.html");
    return;
  } catch (_) {
    // No active session: stay on login page.
  }

  // Browser password managers / Android credential prompts can fill the fields
  // without firing normal input/change events. Poll briefly so "Use this account"
  // completes the actual Appwrite login instead of stopping after autofill.
  let attempts = 0;
  const maxAttempts = 40;
  const tryAutofillLogin = async () => {
    attempts++;
    if (document.visibilityState === "hidden") return;
    const email = String(emailEl.value || "").trim();
    const password = String(passwordEl.value || "").trim();
    if (email && password) {
      if (loginBtn) loginBtn.disabled = true;
      await login();
      return;
    }
    if (attempts < maxAttempts) setTimeout(tryAutofillLogin, 250);
  };
  setTimeout(tryAutofillLogin, 250);
}

document.addEventListener("DOMContentLoaded", initLoginPage);

/* =========================
UNUSED / EXPERIMENTAL / FUTURE CODE
========================= */
// clear old sessions
//await account.deleteSessions();
