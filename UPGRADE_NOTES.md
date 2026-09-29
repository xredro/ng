# X-Redro verification update

## Payment OCR amount reliability
The payment verification OCR now preserves multiple amount candidates instead of allowing one weak OCR parse to overwrite a stronger interpretation. Currency-labelled amounts are parsed before generic numbers, grouped amounts are reconstructed only from digits actually present in OCR, and a secondary Tesseract segmentation pass is triggered when the first pass produces a suspicious small currency amount.

This is intended to prevent cases such as a visible `₦18,500.00` being reduced to `₦18.00` and incorrectly eliminating the matching statement transaction.

## Important
OCR is still not proof of what was physically printed on an image. The verifier should only match values actually present in OCR evidence; the secondary pass does not invent missing digits.
