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
    

    const execution = await functions.createExecution( "69a293520034ade6659e",
     JSON.stringify({ userId: user.$id, src: src })
  );

    // Wait for function to finish and get result
    const resultRaw = await functions.getExecution(execution.$id); // fetch execution result
    if (!resultRaw.response) {
     console.error("Empty function response");
      alert("phase1");
      window.location.replace("dashboard.html");
      return;
    }

    let result;
    try {
      result = JSON.parse(resultRaw.response); // parse actual function output
    } catch (e) {
      console.error("Malformed function response:", resultRaw.response);
      alert("phase2");
      window.location.replace("dashboard.html");     
      return;
    }
  
    if (result.success) {
      window.location.replace("dashboard.html");
    } else {
      alert(result.message || "Payment verification failed");
      alert("phase3");
      window.location.replace("dashboard.html");
    }
 
  } catch (err) {
    console.error("Verification error:", err);
    alert("Verification failed. Try again.");
    alert(err);
    window.location.replace("dashboard.html");
  }
})();
