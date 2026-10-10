const { Client, Databases, Query, ID } = require('node-appwrite');

module.exports = async ({ req, res, log, error }) => {
  try {
    const endpoint = process.env.APPWRITE_FUNCTION_API_ENDPOINT;
    const projectId = process.env.APPWRITE_FUNCTION_PROJECT_ID;
    const apiKey = process.env.XREDRO_ADMIN_API_KEY;
    const databaseId = process.env.XREDRO_DATABASE_ID || '695c4fce0039f513dc83';
    const usersCollectionId = process.env.XREDRO_USERS_COLLECTION_ID || '695c501b001d24549b03';
    const subscriptionsCollectionId = process.env.XREDRO_SUBSCRIPTIONS_COLLECTION_ID || 'subscriptions';

    if (!endpoint || !projectId || !apiKey) {
      error('Missing required Appwrite Function environment configuration.');
      return res.json({ ok: false, message: 'Admin function is not configured. Contact the administrator.' }, 500);
    }

    const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
    const databases = new Databases(client);
    const body = req.bodyJson || {};
    const action = String(body.action || '');

    if (action === 'findUser') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.json({ ok: false, message: 'Enter a valid customer email.' }, 400);
      }
      const result = await databases.listDocuments(databaseId, usersCollectionId, [
        Query.equal('email', email), Query.limit(1)
      ]);
      if (!result.documents.length) return res.json({ ok: false, message: 'No X-Redro account was found with that email.' }, 404);
      const profile = result.documents[0];
      if (!profile.userId) return res.json({ ok: false, message: 'This account record has no user ID.' }, 422);
      return res.json({ ok: true, user: { userId: profile.userId, email: profile.email, username: profile.username || '' } });
    }

    if (action === 'activate') {
      const userId = String(body.userId || '').trim();
      const planName = String(body.plan || '');
      const durationDays = Number(body.days);
      const presets = { weekly: 7, monthly: 30, quarterly: 90 };
      const expectedDays = presets[planName];
      const validCustom = planName.startsWith('custom-') && Number.isInteger(durationDays) && durationDays >= 1 && durationDays <= 3650;
      if (!userId || !(expectedDays === durationDays || validCustom)) {
        return res.json({ ok: false, message: 'Invalid account or subscription duration.' }, 400);
      }

      let profile;
      try { profile = await databases.getDocument(databaseId, usersCollectionId, userId); }
      catch (_) {
        const result = await databases.listDocuments(databaseId, usersCollectionId, [Query.equal('userId', userId), Query.limit(1)]);
        profile = result.documents[0];
      }
      if (!profile || profile.userId !== userId) return res.json({ ok: false, message: 'The selected customer account could not be confirmed.' }, 404);

      const now = new Date();
      const expiry = new Date(now);
      expiry.setDate(expiry.getDate() + durationDays);
      const planLabel = presets[planName] ? planName : `custom-${durationDays}-days`;

      // Create first so a failed create never disables the customer's current plan.
      const created = await databases.createDocument(databaseId, subscriptionsCollectionId, ID.unique(), {
        userId, plan: planLabel, durationDay: durationDays,
        startsAt: now.toISOString(), expiresAt: expiry.toISOString(), status: 'active'
      });

      const existing = await databases.listDocuments(databaseId, subscriptionsCollectionId, [
        Query.equal('userId', userId), Query.equal('status', 'active'), Query.limit(100)
      ]);
      let retireFailures = 0;
      for (const sub of existing.documents) {
        if (sub.$id === created.$id) continue;
        try { await databases.updateDocument(databaseId, subscriptionsCollectionId, sub.$id, { status: 'expired' }); }
        catch (err) { retireFailures++; error(`Could not retire previous subscription ${sub.$id}: ${err.message}`); }
      }
      return res.json({
        ok: true,
        user: { email: profile.email, username: profile.username || '' },
        subscription: { id: created.$id, plan: planLabel, days: durationDays, expiresAt: expiry.toISOString() },
        warning: retireFailures ? 'The new subscription is active, but one or more older active records could not be retired. Check the Subscriptions collection.' : ''
      });
    }

    return res.json({ ok: false, message: 'Unknown admin action.' }, 400);
  } catch (err) {
    error(err && err.stack ? err.stack : String(err));
    return res.json({ ok: false, message: 'The admin operation failed. Check the Appwrite Function logs and permissions.' }, 500);
  }
};
