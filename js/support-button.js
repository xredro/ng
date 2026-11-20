/* Floating "WhatsApp support" button. Shows only when js/site-config.js has a valid supportWhatsApp number.
   Add data-support-offset="84" to <body> on pages that have their own bottom bar (e.g. a cart bar). */
(function () {
  "use strict";
  var raw = String((window.XR_SITE && window.XR_SITE.supportWhatsApp) || "").replace(/\D/g, "");
  if (/^0\d{10}$/.test(raw)) raw = "234" + raw.slice(1);
  if (!/^\d{10,15}$/.test(raw)) return;
  function add() {
    var a = document.createElement("a");
    a.className = "xr-support"; a.target = "_blank"; a.rel = "noopener";
    a.href = "https://wa.me/" + raw + "?text=" + encodeURIComponent("Hi, I have a question about X Redro.");
    a.setAttribute("aria-label", "Chat with X Redro support on WhatsApp");
    a.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18a8 8 0 0 1-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8 8 0 1 1 12 20zm4.4-5.9c-.2-.1-1.4-.7-1.6-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.5 6.5 0 0 1-3.2-2.8c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.5l-.7-1.7c-.2-.4-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .2-1.3c-.1-.1-.2-.2-.5-.3z"/></svg><span>Help</span>';
    var off = parseInt(document.body.getAttribute("data-support-offset") || "0", 10);
    if (off > 0) a.style.bottom = "calc(" + off + "px + env(safe-area-inset-bottom, 0px) + 16px)";
    document.body.appendChild(a);
  }
  if (document.body) add(); else document.addEventListener("DOMContentLoaded", add);
})();
