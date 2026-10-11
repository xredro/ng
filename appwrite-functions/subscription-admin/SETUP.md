# X-Redro Subscription Admin Function

This function is the trusted server-side component for `admin.html`. Do not put its API key in the website or any JavaScript served to the browser.

## Appwrite Console setup

1. Create a Team named **X-Redro Admins** and add only the account(s) allowed to manage subscriptions.
2. Create a Function named **X-Redro Subscription Admin** using the Node.js runtime supported by your Appwrite project. Upload this folder as the function source (or deploy it with the Appwrite CLI). The entry point is `src/main.js`; install dependencies from `package.json`.
3. In the Function's **Execute access** settings, allow only the **admin role** of the `X-Redro Admins` team. Do not leave execution available to `Any` or all authenticated users. This is the server-side access boundary. The website does not use a client-side email allowlist as its security boundary.
4. Create an Appwrite API key with only the database scopes needed to read and write documents (`databases.read` and `databases.write`). In Function → Settings → Environment variables, add `XREDRO_ADMIN_API_KEY` and paste the API key as its value. Mark it secret if Appwrite offers that option. Never put this key in `admin.js`, HTML, GitHub Pages, or a public repository. Save the variable and create a new deployment so the deployed code can read it.
5. The following three variables are optional because the function source already supplies fallback values, but you may add them under Function → Settings → Environment variables if you want to make IDs explicit:
   - `XREDRO_DATABASE_ID=695c4fce0039f513dc83`
   - `XREDRO_USERS_COLLECTION_ID=695c501b001d24549b03`
   - `XREDRO_SUBSCRIPTIONS_COLLECTION_ID=subscriptions`
   `APPWRITE_FUNCTION_API_ENDPOINT` and `APPWRITE_FUNCTION_PROJECT_ID` are supplied by the Appwrite Function runtime.
6. Deploy the Function and copy its Function ID.
7. In `js/admin.js`, replace `REPLACE_WITH_APPWRITE_FUNCTION_ID` with that Function ID. The browser no longer uses an email allowlist as an access boundary; the Function Execute permission must be restricted to the `X-Redro Admins` Team. Add your own Appwrite account to that Team.
8. In the Appwrite project, ensure the website's Web platform includes the production hostname (for this project, `xredro.github.io`).
9. Test with a non-admin account: it must be unable to execute the Function even if it manually opens `admin.html`. Test `findUser` and subscription activation with the admin account.

The function expects the `Users` profile documents to contain `email`, `userId`, and optionally `username`, and subscription documents to use `userId`, `plan`, `durationDay`, `startsAt`, `expiresAt`, and `status` fields.

## Important subscription-permission caution

This Function protects the **admin page's** subscription write path. The current website still has a client-side trial-creation path in `js/authE.js` and a legacy client-side Selar-return handler in `js/verify-payment.js`. Therefore, do not assume subscription records are fully protected merely because the admin page calls this Function. Before removing client-side write permissions from the `subscriptions` collection, migrate trial creation and any still-used renewal/payment activation path to trusted server-side logic; otherwise first-time signup and that old payment flow can stop working. Also review the collection's current read permissions: filtering a client query by `userId` is not a security boundary on its own.


## Diagnosing admin failures

The admin page now opens a detailed diagnostic popup when a customer lookup or subscription activation fails. It identifies the failing stage, action, HTTP status (when available), Appwrite execution ID, server diagnostic message, and likely causes. Use **Copy diagnostics** to copy the report. The report deliberately does not include API key values.

- **Website configuration**: check `ADMIN_FUNCTION_ID` in `js/admin.js`.
- **Calling Appwrite Function**: check Function ID, signed-in session, Execute access for the `X-Redro Admins` Team, deployment state, and network connectivity.
- **Function environment configuration**: add any explicitly named missing variables under Function → Settings → Environment variables, then redeploy. `XREDRO_ADMIN_API_KEY` is the manually configured secret; `APPWRITE_FUNCTION_API_ENDPOINT` and `APPWRITE_FUNCTION_PROJECT_ID` are normally injected by Appwrite.
- **Function server/database operation**: inspect the matching execution in Appwrite Console → Functions → `subscription-admin` → Executions. Check API key scopes, database/collection IDs, attributes, and collection permissions.
