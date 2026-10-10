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
  const email = document.getElementById("loginEmail").value.trim().toLowerCase();
  const password = document.getElementById("loginPassword").value;
  if (!email || !password) { showToast("Please enter email and password", "error"); return; }

  const loginBtn = document.querySelector('.primary-btn[onclick="login()"]');
  if (window.__xredroLoginInFlight) return;
  window.__xredroLoginInFlight = true;
  if (loginBtn) { loginBtn.disabled = true; loginBtn.dataset.originalText ||= loginBtn.textContent; loginBtn.textContent = "Logging in…"; }

  try {
    let user = null;
    try { user = await account.get(); } catch (_) {}

    if (!user) {
      await account.createEmailSession(email, password);
      user = await account.get();
    }

    if (!user.emailVerification) {
      showToast("Please verify your email first. Check your inbox for the verification link.", "warning");
      window.location.href = "verifyInfo.html";
      return;
    }

    await ensureUserProvisioned(user);
    window.location.replace("dashboard.html");
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    const message = err?.code === 401 ? "Incorrect email or password. Please try again." : (err.message || "Login failed. Please try again.");
    showToast(message, "error");
  } finally {
    window.__xredroLoginInFlight = false;
    if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = loginBtn.dataset.originalText || "Log in"; }
  }
}

/* SIGNUP + AUTO SETUP */
async function signup() {
  const email = document.getElementById("signupEmail").value.trim().toLowerCase();
  const password = document.getElementById("signupPassword").value;
  const signupBtn = document.querySelector('.primary-btn[onclick="signup()"]');
  if (window.__xredroSignupInFlight) return;

  if (!email || !password) { showToast("Enter your email and password.", "warning"); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showToast("Enter a valid email address.", "warning"); return; }
  if (password.length < 8) { showToast("Password must be at least 8 characters", "warning"); return; }

  window.__xredroSignupInFlight = true;
  if (signupBtn) { signupBtn.disabled = true; signupBtn.dataset.originalText ||= signupBtn.textContent; signupBtn.textContent = "Creating account…"; }
  try {
    const username = getUsernameFromEmail(email);  

    await account.create(  
      Appwrite.ID.unique(),  
      email,  
      password,  
      username  
    );  

    await account.createEmailSession(email, password);  

    await account.createVerification(
      new URL("verify.html", window.location.href).href
    );  
      
    window.location.href = "verifyInfo.html";  

  } catch (err) {
    console.error("SIGNUP ERROR:", err);
    showToast(err.message || "Could not create your account. Please try again.", "error");
  } finally {
    window.__xredroSignupInFlight = false;
    if (signupBtn) { signupBtn.disabled = false; signupBtn.textContent = signupBtn.dataset.originalText || "Create account"; }
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
      new URL("reset-password.html", window.location.href).href
    );

    showToast("If an account exists for that email, a password reset link has been sent.", "success");
    closeResetModal();  
  } catch (err) {
    // Do not disclose whether a particular email has an account.
    console.error("PASSWORD RECOVERY REQUEST ERROR:", err);
    showToast("If an account exists for that email, a password reset link has been sent.", "success");
    closeResetModal();
  }
}

async function resetPassword() {
  const params = new URLSearchParams(window.location.search);

  const userId = params.get("userId");
  const secret = params.get("secret");

  const password = document.getElementById("newPassword").value;
  const confirm = document.getElementById("confirmPassword").value;

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

    // Revoke existing sessions after a successful password reset where possible.
    try { await account.deleteSessions(); } catch (_) {}
    window.location.replace("login.html?reset=1");

  } catch (err) {
    console.error(err);
    showToast(err.message || "Reset failed", "error");
  }
}

/* =========================
POST-VERIFICATION ACCOUNT PROVISIONING
========================= */
async function ensureUserProvisioned(user) {
  if (!user || !user.$id || !user.emailVerification) return;

  const now = new Date();
  let profileExists = false;
  try { await databases.getDocument(DB_ID, USERS, user.$id); profileExists = true; } catch (_) {}

  if (!profileExists) {
    try {
      await databases.createDocument(DB_ID, USERS, user.$id, {
        userId: user.$id, email: user.email, username: user.name || user.email.split("@")[0],
        theme: "light", accountStatus: "active"
      });
    } catch (err) {
      // A parallel login/verification tab may have created it already.
      try { await databases.getDocument(DB_ID, USERS, user.$id); } catch (_) { throw err; }
    }
  }

  let formExists = false;
  try { await databases.getDocument(DB_ID, FORMS, user.$id); formExists = true; } catch (_) {}
  if (!formExists) {
    const defaultFields = [
      { id: crypto.randomUUID(), type: "text", label: "Full Name", options: [], products: [] },
      { id: crypto.randomUUID(), type: "text", label: "Phone Number", options: [], products: [] },
      { id: crypto.randomUUID(), type: "textarea", label: "Delivery Address or Drop-Off Point", options: [], products: [] },
      { id: crypto.randomUUID(), type: "text", label: "City / State", options: [], products: [] },
      { id: crypto.randomUUID(), type: "textarea", label: "Additional Notes / Requests", options: [], products: [] },
      { id: crypto.randomUUID(), type: "product", label: "Products", options: [], products: [{ name: "Sample Product", price: "0", imageId: "", imageUrl: "" }] }
    ];
    try {
      await databases.createDocument(DB_ID, FORMS, user.$id, {
        userId: user.$id, title: "My Business Name", subtitle: "Welcome to X-Redro, place your order",
        fields: defaultFields.map(f => JSON.stringify(f)), isActive: true, whatsappNumber: "", whatsappOrderRedirectEnabled: false
      });
    } catch (err) {
      try { await databases.getDocument(DB_ID, FORMS, user.$id); } catch (_) { throw err; }
    }
  }

  const subs = await databases.listDocuments(DB_ID, SUBS, [Appwrite.Query.equal("userId", user.$id), Appwrite.Query.limit(100)]);
  if (!subs.documents.length) {
    const expiry = new Date(now); expiry.setDate(expiry.getDate() + 7);
    await databases.createDocument(DB_ID, SUBS, Appwrite.ID.unique(), {
      userId: user.$id, plan: "trial", durationDay: 7, startsAt: now.toISOString(),
      expiresAt: expiry.toISOString(), status: "active"
    });
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
      new URL("verify.html", window.location.href).href
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
  if (new URLSearchParams(window.location.search).get("reset") === "1") {
    showToast("Password reset successful. Please log in with your new password.", "success");
  }

  // Never show the login form to a browser that already has an Appwrite session.
  try {
    const existingUser = await account.get();
    if (!existingUser.emailVerification) {
      window.location.replace("verifyInfo.html");
      return;
    }
    await ensureUserProvisioned(existingUser);
    window.location.replace("dashboard.html");
    return;
  } catch (_) {
    // No active session or account provisioning needs a normal login attempt.
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
    const password = String(passwordEl.value || "");
    if (email && password) {
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
