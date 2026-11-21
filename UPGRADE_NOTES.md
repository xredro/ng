# X-Redro verification update

## Payment OCR amount reliability
The payment verification OCR now preserves multiple amount candidates instead of allowing one weak OCR parse to overwrite a stronger interpretation. Currency-labelled amounts are parsed before generic numbers, grouped amounts are reconstructed only from digits actually present in OCR, and a secondary Tesseract segmentation pass is triggered when the first pass produces a suspicious small currency amount.

This is intended to prevent cases such as a visible `₦18,500.00` being reduced to `₦18.00` and incorrectly eliminating the matching statement transaction.

## Important
OCR is still not proof of what was physically printed on an image. The verifier should only match values actually present in OCR evidence; the secondary pass does not invent missing digits.

## OCR amount normalization fix

The payment amount normalizer no longer removes arbitrary whitespace from numeric OCR fragments. This previously allowed stray digits from adjacent OCR content, such as `4 18,500` or `8 25,000`, to be concatenated into false amounts such as `418,500` or `825,000`.

Whitespace is now removed only when the complete candidate has a valid grouped-number structure. Suspicious short-leading-fragment patterns are rejected instead of converted into a new amount.


2026-10-08 — Orders/customer/admin UI update: removed CSV export, added paid-order product delivery summary, responsive order controls and back-to-top button, enlarged clickable home logo, responsive customer confirmation/WhatsApp handoff, Product Listing (New) builder label, and admin subscription management page.


2026-11-13 — Phases 8 and 9 (Public Order ID, order card, Retrieve My Order, customer updates via order_updates and order_reviews, no Appwrite Function),
seller recovery (Phase 10), Settings switch for customer order changes, admin batch mode with remaining-time extension, hours on dashboard and Settings,
Telegram notifications (Cloudflare Worker). See docs/ORDER-RETRIEVAL.md, docs/DATABASE-CHANGES.md, docs/ADMIN-BATCH-MODE.md, docs/TELEGRAM.md.
Redeploy appwrite-functions/subscription-admin. New collections and fields are listed in docs/DATABASE-CHANGES.md.

2026-11-13 — Payment verification workspace: original-PDF viewer with draggable column guides, coordinate-based row extraction, safer matching (confident / review / unmatched, one transaction per order), highlights on the PDF, bulk verify, saved column layouts. TEXT-BASED PDFs ONLY: no OCR, no fallback; unsupported files are refused. The unused Tesseract.js script tag was removed from orders.html. See docs/PAYMENT-VERIFICATION.md.

2026-11-17 — Phase 10 completed (seller recovery and support). Recovery by Public Order ID search, two-check verification, card reissue and ID replacement were already in place; this adds **Change order for customer** (seller-made updates, same rules as customer updates, auto-approved with the checks recorded, recognised by the seller's own permission role). No database changes. See docs/ORDER-RETRIEVAL.md. Tests: node tools/test-order-logic.js, python3 tools/browser/check_order_flow.py.

2026-11-17 — Phase 11 (complete testing). New tools/test-inventory.js tests the built "Sold out" switch design (no counts, reservations or expiry, by decision). Fixed: the sold-out flag is now read the same way (true or the text "true") in the storefront, cart, submit re-check and update rules. Full results, limits and a manual checklist: docs/TESTING-REPORT.md. Note: assets/favicon.png is linked by index.html and guides/*.html but is not in this zip.

2026-11-21 — Meta Pixel removed completely (js/analytics.js deleted, tracking attributes and sign-up marker removed, site-config now only holds the support number). The public pages carry no tracking.
