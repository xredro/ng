# X-Redro v7 update notes

## WhatsApp handover
- Removed payment-image URL from the prefilled WhatsApp message.
- Removed automatic WhatsApp navigation after order submission.
- Success page now presents WhatsApp as an optional final handoff.
- Customer is told to attach the same payment screenshot they just uploaded, then press Send.
- Order remains successfully submitted even if the customer never opens WhatsApp.
- Order ID is included in the prefilled message when available.

## Order cards
- Long product/customer values can wrap instead of being clipped by nowrap/overflow rules.
- Expanded order cards now show complete product names, quantities, descriptions and unit prices.
- Mobile expanded cards use a single flexible column.
- Dashboard summaries no longer intentionally limit the collapsed product list to two items.

## Login/session handling
- Login page checks for an existing Appwrite session and redirects to the dashboard.
- Manual login no longer deletes all existing sessions before creating a new one.
- Added a short autofill/credential-provider detection loop so Android/browser "Use this account" autofill can continue into the real Appwrite login instead of stopping at filled fields.

## Payment verification extraction
- PDF header detection no longer merges adjacent legitimate columns such as Date + Time or Name + Description.
- Composite headers such as Transaction Time and Reference Code are merged only from an explicit composite-header allowlist.
- Column boundaries use header left-edge anchors, which better correspond to the actual data start positions in bank statements.
- PDF text items that genuinely span multiple columns are reconstructed word-by-word instead of being assigned wholesale to one column.
- Wrapped transaction continuation lines can be merged into the preceding transaction when they contain no independent date/credit evidence and clearly belong to the name/description area.
- Currency/reference extraction removes narrowly defined font/extraction artifacts without globally stripping legitimate letters.
- Credit parsing prioritizes explicit currency amounts and handles grouped/spaced OCR such as `N 18 500.00`.
- OCR uses additional sparse/block segmentation passes when the first pass is weak.
- Conservative leading-digit OCR repair is only admitted as lower-confidence evidence when the repaired value exists in the uploaded statement; exact OCR evidence remains primary.
- Amount/date/name matching continues to require the three primary fields in the same payment image.
