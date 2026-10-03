# X-Redro Payment Verification — v11 Update

## Main change

The statement parser is now rebuilt around a global 2-D coordinate/lane model instead of repeatedly guessing cell boundaries from header text width.

### New extraction pipeline

PDF -> PDF.js native text items -> real X/Y rectangles -> visual rows -> repeated-X histogram -> global vertical X lanes -> wrapped-row reconstruction -> seller-selected Date/Name-Credit columns -> Credit filtering -> OCR indexes -> statement matching.

## Coordinate-lane reconstruction

- Preserves PDF.js `transform`, `x`, `y`, `width`, `height`, `right`, `centerX`, and `centerY`.
- Groups text into physical rows using Y proximity.
- Uses repeated X starts across transaction rows as a structural identifier.
- Clusters X positions globally instead of treating every word as a new column.
- Strong repeated starts are selected for real table columns.
- Header geometry is used to name/order lanes and break ties, not as the sole source of cell widths.
- Long text cells remain in their current lane until a later repeated lane-start marker is encountered.
- This prevents Description words from jumping into Credit/Debit merely because they extend horizontally.
- Numeric columns retain right-edge evidence as well as left-edge evidence for right-aligned statement amounts.
- No synthetic `Column 2`, `Column 3`, etc. headers are created.

## Wrapped rows

- Wrapped continuation lines are detected and merged into the previous transaction row.
- Continuation lines are reconstructed independently from their own left-to-right lane starts.
- This prevents a wrapped Name/Description line from being forced into the last column of the previous visual line.
- Token order is preserved by visual line, then X position.

## PDF extraction confidence

- Native PDF.js item coordinates remain authoritative.
- When PDF.js exposes a multi-word TextItem, token positions are only estimated from that item's actual width.
- Estimated positions are marked internally as `estimated-token`.
- Global repeated-coordinate evidence is preferred over semantic guessing.
- Semantic clues remain validation/supporting evidence, not a replacement for physical table geometry.

## Statement handling

- Seller explicitly selects Date, Name / Description, and Credit.
- Seller receiving-account/business-name input remains removed.
- Every non-empty cell from valid statement rows is retained for supporting evidence.
- Rows with blank/zero/invalid Credit are skipped.
- Positive Credit normalization supports common NGN/currency formatting.
- Password-protected PDFs remain supported through the PDF.js password flow.

## Payment OCR / indexing

- Persistent Tesseract worker is retained where available.
- OCR progress reports current image, total, remaining, and OCR-engine progress.
- Amount, date, and token indexes are built before matching.
- Index progress now updates per image rather than waiting for large batches.

## Matching rules retained

- Statement row is the source of truth.
- Credit -> Date -> Name/Description narrows candidates.
- Date + Name/Description + Credit must all match in the same payment image.
- Supporting fields such as Reference, Channel, Balance, Time, and Description can strengthen a match but cannot repair a mandatory mismatch.
- A used statement row cannot be claimed again.
- More than two viable candidates -> REVIEW REQUIRED.
- Close/equally supported candidates -> REVIEW REQUIRED.
- No match -> NOT VERIFIED.
- Successful matches update the corresponding order to paid.

## Progress UI

Stages now remain explicit:

1. Loading bank statement
2. Detecting transaction table
3. Selecting statement columns
4. Filtering Credit rows
5. OCR processing payment images
6. Building searchable indexes
7. Matching transactions
8. Finalizing results

Filtering reports detected rows, valid positive Credit rows, and skipped rows.
Matching continues to show the current payment image, detected amount/date/time, candidate transactions, and progress.

## Validation performed

The coordinate reconstruction was tested against the synthetic statement fixtures, including:

- 8-column Apex Meridian baseline
- 7-column HarborTrust formatting-normalization statement
- 8-column Cedar National statement
- 4-column NorthStar collision-safe layout
- 7-column intentional three-way review layout
- 10-column Rivergate one-to-one/used-row layout

The HarborTrust fixture now reconstructs its seven physical columns correctly, including the wrapped Chukwuemeka Nwankwo row. The NorthStar four-column layout keeps Counterparty separate from the combined transaction-details/narration column.
