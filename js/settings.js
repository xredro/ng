/* =========================
FILE OVERVIEW
========================= */
// User settings and account management with Appwrite

/* =========================
GLOBAL CONSTANTS / CONFIG
========================= */
const DB_ID = "695c4fce0039f513dc83";
const USERS = "695c501b001d24549b03";
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

/* =========================
CORE BUSINESS LOGIC
========================= */
async function requireAuth() {
  try {
    return await account.get();
  } catch {
    window.location.href = "login.html";
  }
}

async function loadUser() {
  user = await requireAuth();

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
     
  //Theme Application    
  profileDocId = res.documents[0].$id;

  const savedTheme = res.documents[0].theme || "light";
  applyTheme(savedTheme);
  
  //Quick Subscription Check
  const subRes = await databases.listDocuments(DB_ID, SUBS, [
    Query.equal("userId", user.$id),
    Query.orderDesc("expiresAt"),
    Query.limit(1)
  ]);

  const sub = subRes.documents[0];
  const daysLeft = Math.ceil(
    (new Date(sub.expiresAt) - new Date()) / 86400000
  );

  if (daysLeft <= 0) {
    document.getElementById("subscriptionModal").classList.remove("hidden");
    return;
  }
}

async function changePassword() {
  const current = document.getElementById("currentPassword").value.trim();
  const next = document.getElementById("newPassword").value.trim();

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

/* =========================
UI INTERACTION LOGIC
========================= */
document.getElementById("updateAccount").onclick = async () => {
  const nameVal = username.value.trim();

  await account.updateName(nameVal);

  await databases.updateDocument(DB_ID, USERS, profileDocId, {
    username: nameVal
  });

  showToast("Updated", "success");
};

document.getElementById("userUpdate").onclick = () => {
  document.getElementById("username").disabled = false;
  document.getElementById("email").disabled = false;
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
loadUser();
