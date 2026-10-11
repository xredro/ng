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
