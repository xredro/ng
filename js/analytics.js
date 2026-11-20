/* Meta Pixel, loaded ONLY when js/site-config.js has a metaPixelId. Without one this file does nothing.
   Use data-track="Lead" on a link or button to send that event when it is clicked.
   xrTrack(name, params) is always safe to call (it does nothing when there is no Pixel). */
(function () {
  "use strict";
  var id = String((window.XR_SITE && window.XR_SITE.metaPixelId) || "").trim();
  window.xrTrack = function (name, params) { try { if (window.fbq) window.fbq("track", name, params || {}); } catch (e) { /* tracking must never break a page */ } };
  if (!/^\d{8,20}$/.test(id)) return;
  /* standard Meta Pixel loader */
  !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0"; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v;
    s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
  window.fbq("init", id); window.fbq("track", "PageView");
  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("[data-track]") : null;
    if (el) window.xrTrack(el.getAttribute("data-track"));
  });
})();
