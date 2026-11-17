// Stand-in for the Appwrite web SDK, used only by the browser checks. It serves one user, an active
// subscription and 130 orders (the first has a hostile customer name) so paging, counts and escaping can be tested.
(function () {
  // answer after a short delay, like a real network, so pages finish loading their other scripts first
  const later = v => new Promise(r => setTimeout(() => r(v), 40));
  const Query = new Proxy({}, { get: (t, k) => (...a) => ({ m: k, a }) });
  const ORDERS = Array.from({ length: 130 }, (_, i) => ({
    $id: "o" + i, userId: "u1", status: i === 4 ? "cancelled" : ["pending", "paid", "delivered"][i % 3], totalAmount: String(10000 + i * 500),
    paymentProof: i === 0 ? "abc123" : "", $createdAt: new Date(Date.now() - i * 3600e3).toISOString(),
    formData: [JSON.stringify({ label: "Full name", value: i === 0 ? "<img src=x onerror=window.__xss=1>" : "Customer " + i })]
  }));
  const FORM = { $id: "u1", title: "Amaka Bags", subtitle: "Quality bags", storeTheme: window.__THEME_ID || "r3", storeConfig: window.__STORE_CONFIG || "{}", isActive: true,
    fields: [JSON.stringify({ id: "p1", type: "product", label: "Products", products: [{ name: "Black handbag", price: "12000", imageId: window.__PRODUCT_IMG ? "oldimg" : "", imageUrl: window.__PRODUCT_IMG ? "https://img.test/oldimg" : "", category: "Bags", description: "Nice" }] })] };
  class Client { setEndpoint() { return this; } setProject() { return this; } }
  class Account { get() { return later({ $id: "u1", email: "a@b.c", name: "A" }); } }
  class Databases {
    listDocuments(db, col, queries) {
      if (col === "subscriptions") return later({ documents: [{ $id: "s", plan: "30 days", status: "active", expiresAt: new Date(Date.now() + 20 * 864e5).toISOString() }], total: 1 });
      if (col === "695c501b001d24549b03") return later({ documents: [{ $id: "prof", theme: window.__THEME || "light" }], total: 1 });
      if (col === "orders") {
        if (window.__FAIL_ORDERS) return Promise.reject(new Error("network"));
        const cur = (queries || []).find(q => q && q.m === "cursorAfter");
        const start = cur ? ORDERS.findIndex(o => o.$id === cur.a[0]) + 1 : 0;
        return later({ documents: ORDERS.slice(start, start + 100), total: ORDERS.length });
      }
      return later({ documents: [], total: 0 });
    }
    getDocument() {
      // tests can set window.__FORM_FIELDS (the store's fields) and window.__FLIP (a different store returned from the 2nd read on,
      // to act out the seller editing the store while a customer is shopping); window.__FLIP_FAIL makes later reads fail
      const n = (window.__gets = (window.__gets || 0) + 1);
      if (n > 1 && window.__FLIP_FAIL) return Promise.reject(new Error("network"));
      if (n > 1 && window.__FLIP) return later(Object.assign({}, FORM, { fields: window.__FLIP.map(x => JSON.stringify(x)) }));
      return later(window.__FORM_FIELDS ? Object.assign({}, FORM, { fields: window.__FORM_FIELDS.map(x => JSON.stringify(x)) }) : FORM);
    }
    createDocument(db, col, id, data) { (window.__created = window.__created || []).push({ col, data }); return later(FORM); }
    updateDocument(db, col, id, data) { (window.__saves = window.__saves || []).push(data); return window.__FAIL_SAVE ? Promise.reject(new Error("network")) : later(FORM); }
  }
  class Storage { createFile() { return later({ $id: "newimg" }); } getFileView(b, id) { return { href: "https://img.test/" + id }; } deleteFile(b, id) { (window.__deletes = window.__deletes || []).push(id); return later(); } }
  window.Appwrite = { Client, Account, Databases, Storage, Query, ID: { unique: () => "id" + Math.random().toString(36).slice(2) },
    Permission: new Proxy({}, { get: () => () => "p" }), Role: new Proxy({}, { get: () => () => "r" }) };
})();
