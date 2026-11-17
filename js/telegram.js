/* Telegram client helpers shared by the storefront, the customer order page and the seller pages.
   xrTelegramNotify() tells the Worker that something happened to an order. It carries only an event name and ids,
   never a chat id or any message text, and it can never delay or break the order: it is not awaited and swallows every error. */
function xrTelegramConfigured() {
  const c = window.XR_TELEGRAM || {};
  return /^https:\/\//.test(c.workerUrl || "") && !/REPLACE/i.test(c.workerUrl);
}
function xrTelegramNotify(event, orderId, refId) {
  try {
    if (!xrTelegramConfigured() || !event || !orderId) return;
    const body = { event: String(event), orderId: String(orderId) };
    if (refId) body.refId = String(refId);
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 6000) : null;
    fetch(window.XR_TELEGRAM.workerUrl.replace(/\/+$/, "") + "/api/notify", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true, signal: ctl ? ctl.signal : undefined
    }).catch(err => console.warn("Telegram notification could not be sent:", err && err.message)).finally(() => { if (timer) clearTimeout(timer); });
  } catch (err) {
    console.warn("Telegram notification skipped:", err && err.message);
  }
}
