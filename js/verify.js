async function confirmVerification() {
  const params = new URLSearchParams(location.search);
  const userId = params.get("userId");
  const secret = params.get("secret");

  if (!userId || !secret) {
    showToast("Invalid verification link. Please request a new one.", "error");
    return;
  }

  try {
    await account.updateVerification(userId, secret);
    // User-profile, default form and trial are safely provisioned after the
    // verified user logs in. That also supports opening this link on another device.
    window.location.replace("login.html?verified=1");
  } catch (err) {
    console.error("EMAIL VERIFICATION ERROR:", err);
    showToast(err.message || "Verification failed or the link has expired.", "error");
  }
}

// Trigger the flow    
// Trigger verification only if URL has params
if (location.search.includes("userId") && location.search.includes("secret")) {
  confirmVerification();
}
