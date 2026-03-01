/* ========================
   APPWRITE SETUP
========================= */
const DB_ID = "695c4fce0039f513dc83";
const PAYMENTS = "payments";
const SUBS = "subscriptions";

const client = new Appwrite.Client()
  .setEndpoint("https://nyc.cloud.appwrite.io/v1")
  .setProject("695981480033c7a4eb0d");

const account = new Appwrite.Account(client);
const databases = new Appwrite.Databases(client);
const Query = Appwrite.Query;

/* =========================
   VERIFY PAYMENT FLOW
========================= */
(async function verifyPayment() {
  try {
    /* -------------------------
       ORIGIN CHECK (SOFT)
    -------------------------- */
    const params = new URLSearchParams(window.location.search);
    const source = params.get("src");

    if (source !== "selar") {
      throw new Error("Invalid payment source");
    }

    /* -------------------------
       AUTH CHECK
    -------------------------- */
    const user = await account.get();
    if (!user) {
      throw new Error("User not authenticated");
    }

    /* -------------------------
       FETCH LATEST PENDING PAYMENT
       (DATABASE IS SOURCE OF TRUTH)
    -------------------------- */
    const res = await databases.listDocuments(DB_ID, PAYMENTS, [
      Query.equal("userId", user.$id),
      Query.equal("status", "pending"),
      Query.equal("used", false),
      Query.orderDesc("$createdAt"),
      Query.limit(1)
    ]);

    if (!res.documents.length) {
      throw new Error("No pending payment found");
    }

    const payment = res.documents[0];

    /* -------------------------
       PAYMENT VALIDATION
    -------------------------- */
    const now = new Date();

    if (payment.expiresAt && new Date(payment.expiresAt) < now) {
      throw new Error("Payment session expired");
    }

    const durationDays = Number(payment.durationDay);
    if (!durationDays || durationDays <= 0) {
      throw new Error("Invalid subscription duration");
    }

    /* -------------------------
       SUBSCRIPTION STACKING
    -------------------------- */
    let startsAt = now;
    let expiresAt = new Date(now);

    const subRes = await databases.listDocuments(DB_ID, SUBS, [
      Query.equal("userId", user.$id),
      Query.orderDesc("expiresAt"),
      Query.limit(1)
    ]);

    if (subRes.documents.length) {
      const lastExpiry = new Date(subRes.documents[0].expiresAt);
      if (lastExpiry > now) {
        startsAt = lastExpiry;
        expiresAt = new Date(lastExpiry);
      }
    }

    expiresAt.setDate(expiresAt.getDate() + durationDays);

    /* -------------------------
       CREATE SUBSCRIPTION
    -------------------------- */
    await databases.createDocument(
      DB_ID,
      SUBS,
      Appwrite.ID.unique(),
      {
        userId: user.$id,
        plan: payment.plan,
        durationDay: payment.durationDay,
        startsAt: startsAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        status: "active"
      }
    );

    /* -------------------------
       MARK PAYMENT AS USED
    -------------------------- */
    await databases.updateDocument(
      DB_ID,
      PAYMENTS,
      payment.$id,
      {
        status: "success",
        used: true
      }
    );

    /* -------------------------
       REDIRECT
    -------------------------- */
    window.location.replace("dashboard.html");

  } catch (err) {
    console.error("Payment verification failed:", err.message);

    const head2 = document.getElementById("heading");
    const label = document.getElementById("labeling");

    if (head2) {
      head2.innerText = "Payment verification failed";
    }

    if (label) {
      label.innerHTML =
        `${err.message}<br><a href="dashboard.html">Return to dashboard</a>`;
    }
  }
})();
