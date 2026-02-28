const client = new Appwrite.Client()
  .setEndpoint("https://nyc.cloud.appwrite.io/v1")
  .setProject("695981480033c7a4eb0d");

const account = new Appwrite.Account(client);

(async function verifyPaymentFrontend() {
  try {
    const params = new URLSearchParams(window.location.search);
    const src = params.get("src");

    const user = await account.get();
    if (!user) {
      alert("You must be logged in.");
      return;
    }

    // Create Functions instance
    const functions = new Appwrite.Functions(client);

    const execution = await functions.createExecution(
      "69a293520034ade6659e",
      JSON.stringify({
        userId: user.$id,
        src: src
      })
    );

    if (!execution.responseBody) {
      throw new Error("Empty function response");
    }

    
    const result = JSON.parse(execution.responseBody);

    if (result.success) {
      window.location.replace("dashboard.html");
    } else {
      alert(result.message);
      window.location.replace("dashboard.html");
    }

  } catch (err) {
    console.error("Verification error:", err);
    alert("Verification failed. Try again.");
    alert(err);
    alert(req.payload);
    alert(process.env.DB_ID);
    alert(execution.status);
    alert(execution.logs);
    
    window.location.replace("dashboard.html");
  }
})();
