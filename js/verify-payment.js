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
      window.location.replace("login.html");
      return;
    }

    // Create Functions instance
    const functions = new Appwrite.Functions(client);

     const execution = await functions.createExecution(
       "69a293520034ade6659e",
       JSON.stringify({ userId: user.$id, src: src }),
       true
     );

     // The "response" is now directly in execution
     if (!execution.response) {
       console.error("Empty function response");
       alert("Payment verification failed. Try again.");
       alert("phase1");
       window.location.replace("dashboard.html");
       return;
     }

     let result;
     try {
       result = JSON.parse(execution.response);
     } catch (e) {
       console.error("Malformed function response:", execution.response);
       alert("Payment verification failed. Try again.");
       window.location.replace("dashboard.html");
       return;
    }

    if (result.success) {
      window.location.replace("dashboard.html");
    } else {
      alert(result.message || "Payment verification failed");
      window.location.replace("dashboard.html");
    }
    
  } catch (err) {
    console.error("Verification error:", err);
    alert("Verification failed. Try again.");
    alert(err);
    window.location.replace("dashboard.html");
  }
})();
