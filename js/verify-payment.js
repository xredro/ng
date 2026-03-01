// Appwrite client setup
const client = new Appwrite.Client()
  .setEndpoint("https://nyc.cloud.appwrite.io/v1")
  .setProject("695981480033c7a4eb0d");

const account = new Appwrite.Account(client);

(async function verifyPaymentFrontend() {
  try {
    // Get the "src" query parameter
    const params = new URLSearchParams(window.location.search);
    const src = params.get("src");

    // Get current logged-in user
    const user = await account.get();
    if (!user) {
      alert("You must be logged in.");
      window.location.replace("login.html");
      return;
    }

    // Call Appwrite function
    const functions = new Appwrite.Functions(client);
    const execution = await functions.createExecution(
      "69a293520034ade6659e", // Your verify-payment function ID
      JSON.stringify({ userId: user.$id, src: src }),
      true // Wait for the response
    );

    // Parse server response
    if (!execution.responseBody) {
      throw new Error("Empty function response");
    }

    const result = JSON.parse(execution.responseBody);

    if (result.success) {
      // Redirect to dashboard
      window.location.replace("dashboard.html");
    } else {
      alert(result.message || "Payment verification failed");
      window.location.replace("dashboard.html");
    }
  } catch (err) {
    console.error("Payment verification error:", err);
    alert("Payment verification failed. Try again.");
    window.location.replace("dashboard.html");
  }
})();
