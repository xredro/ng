# X-Redro v9 — Header-Anchored 2D Statement Reconstruction

## Payment verification update

The statement parser now uses the physical geometry of detected table headers as the primary structural anchor.

### New column reconstruction behavior

1. PDF.js text fragments are retained as 2D rectangles with:
   - `x`, `y`
   - `width`, `height`
   - `right`, `top`
   - `centerX`, `centerY`

2. Each detected header cell retains its real bounding box:
   - `headerX`
   - `headerEnd`
   - `headerWidth`
   - `headerCenterX`
   - `headerCore`

3. The parser creates a wider data corridor around each header using neighbouring header centers. This accommodates:
   - right-aligned amounts
   - wider transaction values
   - headers whose text is much narrower than their actual column

4. Content below the detected header row is assigned using the header's physical X footprint first. If a data item overlaps the real header box, that header is preferred. Otherwise the item falls back to the header-derived data corridor.

5. A text item that spans more than one column is still split at estimated word/token positions rather than blindly assigning the entire item to one column.

6. Wrapped rows remain spatially reconstructed before normalization and payment matching.

### What this prevents

- Date/Time/Name/Description/Credit shifting into adjacent columns.
- Compact headers such as `Credit` being ignored because the data value is wider than the header text.
- PDF.js extraction order causing false column placement.
- Artificial `Column 2`, `Column 3`, etc. from arbitrary text fragments.

### Existing verification behavior retained

- Seller-selected Date, Name/Description, and Credit columns remain authoritative.
- Statement rows with no valid positive Credit remain excluded.
- Raw extraction, cleanup, normalization, and matching remain separate stages.
- Weak OCR numeric artifacts are not treated as trusted payment amounts.
- Statement transactions remain the source of truth.
- Multiple viable matches continue to produce `REVIEW REQUIRED` rather than an automatic match.
