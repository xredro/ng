(async function verifyPaymentFrontend() {
  const params = new URLSearchParams(window.location.search);
  const src = params.get("src");

  // Assume user is authenticated via Appwrite SDK
  const user = await account.get();
  if (!user) {
    alert("You must be logged in.");
    return;
  }

  try {
    const response = await fetch("https://[https://nyc.cloud.appwrite.io/v1]/functions/[69a293520034ade6659e]/executions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.$id, src })
    });

    const result = await response.json();
    if (result.success) {
      window.location.replace("dashboard.html");
    } else {
      alert(result.message);
      window.location.replace("dashboard.html");
    }

  } catch (err) {
    console.error(err);
    alert("Verification failed. Try again.");
  }
})();
