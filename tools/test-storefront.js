// Run from the project root:  node tools/test-storefront.js
// Optional golden comparison: node tools/test-storefront.js /path/to/original/storefront-render.js
//
// What this covers: HTML generation and the pure logic. What it cannot cover:
// how the page LOOKS in a browser, and the DOM wrapper functions (search, sort,
// cart refresh). Those need a manual check on a phone; see docs/STOREFRONT-ARCHITECTURE.md.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

function load(files) {
  const ctx = { console, Number, Set, Array, Object, String, JSON, Math, RegExp };
  vm.createContext(ctx);
  files.forEach(f => vm.runInContext(fs.readFileSync(f, "utf8") + "\n;globalThis.__x=1;", ctx, { filename: f }));
  // top-level const/let are not on globalThis inside vm; expose what tests need
  vm.runInContext("globalThis.__api={buildStorefrontHTML, storefrontEscape, storefrontNormalizeConfig: typeof storefrontNormalizeConfig!=='undefined'?storefrontNormalizeConfig:null, storefrontContactLinks: typeof storefrontContactLinks!=='undefined'?storefrontContactLinks:null, storefrontCartLines: typeof storefrontCartLines!=='undefined'?storefrontCartLines:null, storefrontMatchesQuery: typeof storefrontMatchesQuery!=='undefined'?storefrontMatchesQuery:null, storefrontSortCards: typeof storefrontSortCards!=='undefined'?storefrontSortCards:null, storefrontSafeUrl: typeof storefrontSafeUrl!=='undefined'?storefrontSafeUrl:null, storefrontHandle: typeof storefrontHandle!=='undefined'?storefrontHandle:null, chrome: typeof STOREFRONT_CHROME!=='undefined'?STOREFRONT_CHROME:{}}", ctx);
  return ctx.__api;
}

const root = process.cwd();
const NEW = load([path.join(root, "js/storefront-render.js"), path.join(root, "js/storefront-chrome.js")]);
const ORIG_PATH = process.argv[2];
const ORIG = ORIG_PATH ? load([ORIG_PATH]) : null;

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log("FAIL:", msg); } }

/* ---------- html helpers ---------- */
const VOID = new Set(["input", "img", "br", "hr", "meta", "link"]);
function tagBalance(html) {
  const stack = []; const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?>/g; let m;
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<svg[\s\S]*?<\/svg>/g, "<svg></svg>");
  while ((m = re.exec(clean))) {
    const name = m[1].toLowerCase(), full = m[0];
    if (VOID.has(name) || full.endsWith("/>")) continue;
    if (full.startsWith("</")) { const top = stack.pop(); if (top !== name) return `mismatch: expected </${top}> got </${name}>`; }
    else stack.push(name);
  }
  return stack.length ? "unclosed: " + stack.join(",") : "";
}
function ids(html) { return [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]); }
function dupes(html) { const a = ids(html); return a.filter((x, i) => a.indexOf(x) !== i); }

/* ---------- datasets ---------- */
const prod = (name, price, extra) => Object.assign({ name, price, imageId: "", imageUrl: "", category: "General", description: "" }, extra || {});
const productField = (id, products, label) => ({ id, type: "product", label: label || "Products", products });
const many = Array.from({ length: 12 }, (_, i) => prod(`Item ${i + 1} with a rather long product name to test wrapping`, String(1000 * (i + 1)), {
  category: ["Bags", "Shoes", "Watches"][i % 3], description: i % 2 ? "A nice description" : "", imageUrl: i % 4 === 0 ? "https://example.com/a.jpg?x=1&y=2" : "", featured: i === 1 || i === 5
}));
const feeField = { id: "fee1", type: "additional_fee", label: "Delivery", fees: [{ name: "Lagos", price: "2000" }] };
const textField = { id: "t1", type: "text", label: "Full name" };

const DATASETS = {
  empty: [],
  zeroProducts: [productField("p1", [])],
  onePlain: [productField("p1", [prod("Black handbag", "12000")]), textField],
  many: [productField("p1", many), textField, feeField],
  multiField: [productField("p1", [prod("A", "100")], "Bags"), productField("p2", [prod("B", "200")], "Shoes")],
  stock: [productField("p1", [prod("Out", "100", { soldOut: true }), prod("In", "200", {}), prod("Flagged false", "300", { soldOut: false })])],
  badPrice: [productField("p1", [prod("No price", ""), prod("Text price", "abc"), prod("Neg", "-5")])]
};
const CFG_FULL = { tagline: "Handmade bags", about: "We make bags in Lagos.", policy: "Delivery 2 to 4 days", heroCta: "Browse", logoUrl: "https://example.com/l.png", bannerUrl: "https://example.com/b.jpg", phone: "08012345678", email: "shop@example.com", whatsapp: "08012345678", instagram: "@my.shop", tiktok: "myshop", facebook: "myshop" };
const OPTS_LIVE = { live: true, cart: {}, qtyFn: "changeQty", totalFn: "updateTotal", submitFn: "submitOrder" };
const OPTS_STATIC = { live: false, cart: {}, qtyFn: "changeQty", totalFn: "updateTotal", submitFn: "submitOrder" };

/* ============ 1. every theme still renders; non-chrome themes unchanged ============ */
const THEMES = ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"];
let compared = 0;
for (const t of THEMES) for (const [dn, f] of Object.entries(DATASETS)) {
  for (const [on, o] of [["live", OPTS_LIVE], ["static", OPTS_STATIC]]) {
    const args = { fields: f, formTitle: "My Store", formSubtitle: "Pick your order", themeClass: "theme-" + t, opts: o };
    let html = "";
    try { html = NEW.buildStorefrontHTML(args); } catch (e) { ok(false, `${t}/${dn}/${on} threw ${e.message}`); continue; }
    ok(html.length > 100, `${t}/${dn}/${on} produced html`);
    const hasProd = f.some(x => x.type === "product");
    if (ORIG && (!NEW.chrome[t] || !hasProd)) {
      compared++;
      ok(html === ORIG.buildStorefrontHTML(args), `GOLDEN ${t}/${dn}/${on}: output changed for a case that must stay identical`);
    }
  }
}
if (ORIG) console.log(`golden comparisons: ${compared}`);

/* ============ 2. chrome theme: structure, ids, contract ============ */
const CONTRACT = ["itemCount", "totalCost", "additionalFeeBox", "paymentProof", "paymentProofPreview", "cartBar", "cartBarCount", "cartBarTotal", "checkoutToggle", "paymentAccountName", "datePaid"];
for (const T of THEMES) for (const [dn, f] of Object.entries(DATASETS)) for (const cfg of [null, CFG_FULL, "{not json", {}]) for (const [on, o] of [["live", OPTS_LIVE], ["static", OPTS_STATIC]]) {
  const label = `${T}/${dn}/${on}/${cfg && cfg.tagline ? "cfg" : (typeof cfg === "string" ? "badjson" : cfg === null ? "null" : "emptyobj")}`;
  const html = NEW.buildStorefrontHTML({ fields: f, formTitle: "My Store", formSubtitle: "Pick", themeClass: "theme-" + T, storeConfig: cfg, opts: o });
  const hasProducts = f.some(x => x.type === "product");
  ok(!tagBalance(html), `${label} tags balanced: ${tagBalance(html)}`);
  ok(dupes(html).length === 0, `${label} duplicate ids: ${dupes(html).slice(0, 3)}`);
  ok(!/undefined|NaN|\[object|>null</.test(html), `${label} contains undefined/NaN/null text`);
  if (hasProducts) {
    ok(html.includes("sf-chrome"), `${label} uses chrome`);
    ["sf-header", "sf-hero", "sf-footer", "sf-drawer", "checkout-overlay", "cart-bar"].forEach(c => ok(html.includes(c), `${label} has ${c}`));
    CONTRACT.forEach(id => { if (!o.live && (id === "paymentAccountName" || id === "datePaid")) return; /* live-only inputs, same in the original renderer */ ok(ids(html).includes(id), `${label} contract id ${id}`); });
    ok(!html.includes("<div class=\"store-simple-header\">\n            <h1></h1>"), `${label} header present`);
  } else {
    ok(!html.includes("sf-chrome"), `${label} no products uses the plain form path`);
  }
}

/* ============ 3. conditional content ============ */
{
  const h = NEW.buildStorefrontHTML({ fields: DATASETS.onePlain, formTitle: "Shop", formSubtitle: "", themeClass: "theme-r3", storeConfig: null, opts: OPTS_LIVE });
  ok(!h.includes("sf-card-desc"), "no empty description area when product has none");
  ok(!h.includes(">About<") && !h.includes('id="sfAbout"'), "no About without text");
  ok(!h.includes(">Contact<"), "no Contact link without contact details");
  ok(!h.includes("sf-tagline"), "no tagline without text");
  ok(!h.includes("sf-featured"), "no Featured row without flagged products");
  ok(!h.includes('id="sfCats"'), "no categories anchor with one category");
  ok(!/<p>\s*<\/p>/.test(h), "no empty subtitle paragraph");
  const m = NEW.buildStorefrontHTML({ fields: DATASETS.many, formTitle: "Shop", formSubtitle: "S", themeClass: "theme-r3", storeConfig: CFG_FULL, opts: OPTS_LIVE });
  ok(m.includes('id="sfCats"') && m.includes("Categories"), "categories shown with 3 categories");
  ok(m.includes("sf-featured") && (m.match(/class="sf-feat-card"/g) || []).length === 2, "featured shows exactly the 2 flagged products");
  ok(m.includes("id=\"sfAbout\"") && m.includes("href=\"tel:08012345678\""), "about + phone link");
  ok(m.includes("https://wa.me/2348012345678"), "whatsapp 0801... converted to 234");
  ok(m.includes("https://instagram.com/my.shop") && m.includes("https://www.tiktok.com/@myshop"), "social links built from handles");
  ok(m.includes(">Browse<"), "custom hero button text");
  ok((m.match(/class="product-card sf-card/g) || []).length === 12, "12 cards rendered");
  ok(m.includes("x=1&amp;y=2"), "image url ampersand escaped");
  const z = NEW.buildStorefrontHTML({ fields: DATASETS.zeroProducts, formTitle: "Shop", formSubtitle: "S", themeClass: "theme-r3", storeConfig: null, opts: OPTS_LIVE });
  ok(z.includes("Products coming soon") && !z.includes("sf-search"), "empty store shows friendly state without search");
  const s = NEW.buildStorefrontHTML({ fields: DATASETS.stock, formTitle: "Shop", formSubtitle: "S", themeClass: "theme-r3", storeConfig: null, opts: OPTS_LIVE });
  ok((s.match(/Sold out<\/span>/g) || []).length === 1 && (s.match(/is-soldout/g) || []).length === 1, "exactly the one product marked sold out shows Sold out");
  ok(/class="sf-add" disabled>Sold out/.test(s), "sold out add button disabled");
  ok(/<button type="button" disabled>-<\/button><span id="qty-p1-0">0<\/span><button type="button" disabled>\+<\/button>/.test(s), "sold out product popup quantity buttons disabled");
  ok((s.match(/class="sf-add" onclick/g) || []).length === 2, "the other two products can still be added");
  ok(!/Only \d+ left/.test(s), "no stock-count wording anywhere");
  const st = NEW.buildStorefrontHTML({ fields: DATASETS.many, formTitle: "Shop", formSubtitle: "S", themeClass: "theme-r3", storeConfig: null, opts: OPTS_STATIC });
  ok(!/onclick="changeQty/.test(st), "static render has no live qty handlers");
  const bp = NEW.buildStorefrontHTML({ fields: DATASETS.badPrice, formTitle: "Shop", formSubtitle: "S", themeClass: "theme-r3", storeConfig: null, opts: OPTS_LIVE });
  ok(!bp.includes("NaN"), "bad prices never print NaN");
}


/* ============ 3b. per-theme variants ============ */
for (const T of THEMES) {
  const c = NEW.chrome[T];
  ok(!!c, `${T} is a full-store theme`);
  const render = (fields, cfg) => NEW.buildStorefrontHTML({ fields, formTitle: "Men's Store", formSubtitle: "S", themeClass: "theme-" + T, storeConfig: cfg, opts: OPTS_LIVE });
  const h = render(DATASETS.many, CFG_FULL);
  ok(h.includes(`sf-hdr-${c.header}`) && h.includes(`sf-hero-${c.hero}`) && h.includes(`sf-ft-${c.footer}`), `${T} header/hero/footer variant classes`);
  // each variant class must sit on its OWN element (a previous bug put hero and footer classes on the page root)
  ok(/<div class="preview-theme [^"]*sf-chrome sf-hdr-\w+" id="sfTop">/.test(h) && !/id="sfTop"[^>]*sf-hero-/.test(h), `${T} root carries only the header variant`);
  ok(new RegExp(`<section class="sf-hero sf-hero-${c.hero} `).test(h), `${T} hero variant is on the hero section`);
  ok(new RegExp(`<footer class="sf-footer sf-ft-${c.footer}"`).test(h), `${T} footer variant is on the footer`);
  ok(h.includes(`sf-g-${c.grid}`), `${T} grid layout class sf-g-${c.grid}`);
  ok(!/class="product-grid layout-/.test(h), `${T} does not use the legacy layout-* grid classes`);
  ok(c.cats === "cards" ? (h.match(/sf-cat-card/g) || []).length >= 4 : !h.includes("sf-cat-card"), `${T} category ${c.cats}`);
  if (c.cats === "cards") ok(/sf-cat-count">12</.test(h), `${T} All card shows the real product count`);
  if (c.counts) ok(/sf-chip-count">4</.test(h), `${T} chips show counts`);
  ok(/class="sf-hero sf-hero-\w+ sf-has-banner"/.test(h) && /class="sf-hero sf-hero-\w+ sf-no-banner"/.test(render(DATASETS.many, {})), `${T} hero banner state`);
  ok((c.header === "bold") === h.includes("sf-announce"), `${T} announcement bar only on the bold header`);
  ok(!render(DATASETS.many, {}).includes("sf-announce"), `${T} no announcement bar without a tagline`);
  ok(h.includes("sf-card-cat"), `${T} cards carry a category badge element`);
  // apostrophes in category names must not break the inline handler
  const ap = render([productField("p1", [prod("A", "1", { category: "Men's" }), prod("B", "2", { category: "Women" })])], null);
  // decode the attribute the way a browser does, then the JS must be valid
  const m = ap.match(/onclick="(filterStorefrontCategory\(this, '[^"]*Men[^"]*'\))"/);
  const decoded = m ? m[1].replace(/&#39;/g, "'").replace(/&amp;/g, "&") : "";
  let valid = false, arg = null;
  try { new Function("filterStorefrontCategory", "this_", decoded.replace("(this,", "(this_,"))((el, c) => { arg = c; }, {}); valid = true; } catch (e) {}
  ok(valid && arg === "Men's", `${T} apostrophe category gives valid JS and the right value (got ${arg})`);
  ok(!tagBalance(ap), `${T} apostrophe case balanced`);
}

/* ============ 4. hostile input is escaped ============ */
{
  const X = '"><img src=x onerror=alert(1)>';
  const evil = [productField("p1", [prod(X, "100", { category: X, description: X, imageUrl: 'javascript:alert(1)' }), prod("ok", "5", { imageUrl: 'https://a.com/x.jpg"onerror="alert(2)' })]), { id: "t2", type: "text", label: X }];
  for (const T of THEMES) { const h = NEW.buildStorefrontHTML({ fields: evil, formTitle: X, formSubtitle: X, themeClass: "theme-" + T, storeConfig: { tagline: X, about: X, policy: X, heroCta: X, phone: X, email: X, whatsapp: X, instagram: X, tiktok: X, facebook: X, logoUrl: "javascript:alert(3)", bannerUrl: 'https://a.com/b.jpg"onerror="alert(4)' }, opts: OPTS_LIVE });
  ok(!h.includes(X), T + " raw hostile string never appears");
  ok(!/<img[^>]*onerror/i.test(h), "no img with onerror");
  ok(!/(href|src)="javascript:/i.test(h), "no javascript: urls");
  ok(!tagBalance(h), T + " hostile output still balanced: " + tagBalance(h)); }
}

/* ============ 5. pure logic ============ */
{
  const fields = [productField("p1", [prod("A", "12000"), prod("B", "8000"), prod("C", "5000")])];
  const lines = NEW.storefrontCartLines(fields, { p1_0: 1, p1_1: 1, p1_2: 1 });
  ok(lines.reduce((s, l) => s + l.subtotal, 0) === 25000, "cart total 12000+8000+5000 = 25000");
  ok(NEW.storefrontCartLines(fields, { p1_0: 0 }).length === 0, "zero qty not in cart");
  ok(NEW.storefrontCartLines(fields, { p1_1: 3 })[0].subtotal === 24000, "qty 3 x 8000 = 24000");
  ok(NEW.storefrontCartLines(fields, { p1_9: 2 }).length === 0, "unknown product index ignored");
  ok(NEW.storefrontCartLines([{ id: "p9", type: "product" }], { p9_0: 1 }).length === 0, "malformed field without products tolerated");
  ok(NEW.storefrontMatchesQuery("Black Handbag", "hand") && NEW.storefrontMatchesQuery("x", "") && !NEW.storefrontMatchesQuery("Shoe", "bag"), "search matching");
  const cards = [{ name: "b", price: 20, idx: 0 }, { name: "a", price: 10, idx: 1 }, { name: "c", price: 20, idx: 2 }];
  ok(NEW.storefrontSortCards(cards, "price-asc").map(c => c.name).join("") === "abc", "sort price asc stable");
  ok(NEW.storefrontSortCards(cards, "price-desc").map(c => c.name).join("") === "bca", "sort price desc stable");
  ok(NEW.storefrontSortCards(cards, "name").map(c => c.name).join("") === "abc", "sort by name");
  ok(NEW.storefrontSortCards(cards, "default").map(c => c.name).join("") === "bac", "default restores original order");
  const cfg = NEW.storefrontNormalizeConfig('{"tagline":"  hi  ","about":' + JSON.stringify("x".repeat(900)) + "}");
  ok(cfg.tagline === "hi" && cfg.about.length === 600, "config trimmed and capped");
  ok(NEW.storefrontNormalizeConfig(null).tagline === "" && NEW.storefrontNormalizeConfig("garbage").tagline === "", "bad config falls back to empty");
  ok(NEW.storefrontHandle("https://instagram.com/my.shop/") === "my.shop" && NEW.storefrontHandle("@a b/c") === "abc", "handle cleaning");
  ok(NEW.storefrontContactLinks({ phone: "abc", email: "no", whatsapp: "12" }).length === 0, "invalid contacts dropped");
  ok(NEW.storefrontSafeUrl("http://a.com/x") !== "" && NEW.storefrontSafeUrl("ftp://a") === "" && NEW.storefrontSafeUrl("//a.com") === "", "only http(s) urls allowed");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
