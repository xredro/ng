/* =========================
FILE OVERVIEW
========================= */
// Password reset functionality with Appwrite

/* =========================
EXTERNAL SERVICE SETUP
========================= */
const client = new Appwrite.Client()
  .setEndpoint('https://nyc.cloud.appwrite.io/v1')
  .setProject('695981480033c7a4eb0d');

const account = new Appwrite.Account(client);
const databases = new Appwrite.Databases(client);

/* =========================
CORE BUSINESS LOGIC
========================= */
async function confirmReset() {
  const params = new URLSearchParams(location.search);
  const userId = params.get("userId");
  const secret = params.get("secret");
  const password = newPassword.value.trim();

  if (!password || password.length < 8) {
    showToast("Password must be at least 8 characters", "warning");
    return;
  }

  await account.updateRecovery(userId, secret, password);
  showToast("Password updated", "sucsess");
  window.location.href = "login.html";
}
