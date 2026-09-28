# X-Redro update notes

## 1. Product quantity badge
Every storefront product card now has a small top-right quantity badge. It starts at `0` and updates with the existing `+` / `-` controls in both the live customer form and builder preview.

## 2. Product descriptions
Products now support an optional `description` field. The builder saves it and the customer storefront shows it only when it contains text. No empty description label/placeholder is rendered.

Existing products without `description` continue to work.

## 3. Payment verification PDF parser
The verifier now:
- asks PDF.js not to merge adjacent text fragments (`disableCombineTextItems`);
- detects real semantic table headers instead of treating every PDF text fragment as a column;
- handles multi-word headers such as `Reference / Code`, `Posting Date`, and `Running Balance`;
- uses the first valid transaction table as the canonical schema for continuation pages;
- ignores page furniture/repeated headers/non-transaction rows;
- never manufactures `Column 2`, `Column 3`, etc. from arbitrary text fragments;
- retains the seller's manual Date, Name/Description, and Credit column choices as authoritative;
- keeps the existing password-protected PDF flow and statement-first matching logic.

## 4. Customer -> seller WhatsApp handoff

The seller settings page now has:
- WhatsApp number
- `Send customers to WhatsApp after they submit an order` switch
- switch OFF by default

The customer is redirected to the seller's `wa.me` URL only when:
1. the seller enabled the setting;
2. a payment-proof image was submitted;
3. a valid WhatsApp number is stored.

The prefilled WhatsApp message contains the ordered products, quantities, optional product descriptions, total, and the direct payment-image URL. The payment-image URL is placed on its own line so WhatsApp can fetch/render its image preview when previews are supported.

### Required Appwrite Form collection attributes

Add these two attributes to the existing `form` collection:

| Attribute | Type | Required | Default |
|---|---|---:|---|
| `whatsappNumber` | String | No | empty |
| `whatsappOrderRedirectEnabled` | Boolean | No | `false` |

The existing public read permission for the `form` collection must remain available because customers already load their storefront form from it.

### Payment image preview requirement

The payment proof storage file must be publicly readable for the customer/WhatsApp preview to fetch it. The app uses the existing Appwrite Storage `view` URL; it does not upload the image to another service.

WhatsApp controls whether a link preview is displayed on the recipient's device, so the application can provide a preview-compatible public image URL but cannot force a preview if WhatsApp/user settings suppress previews.
