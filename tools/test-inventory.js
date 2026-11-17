// Phase 11: inventory tests for the design that was actually built: ONE "Sold out" switch per product, no counts,
// no reservations, no expiry (docs/INVENTORY.md). Run from the project root: node tools/test-inventory.js
const fs = require("fs"), vm = require("vm"), path = require("path");
let failed = 0;
const a = (c, m) => { if (!c) failed++; console.log(c ? "ok  " : "FAIL", m); };
const L = require("../js/order-logic.js");

function load(files, expose) {
  const ctx = { console, Number, Set, Array, Object, String, JSON, Math, RegExp, Map };
  vm.createContext(ctx);
  files.forEach(f => vm.runInContext(fs.readFileSync(f, "utf8") + "\n", ctx, { filename: f }));
  vm.runInContext("globalThis.__api={" + expose + "}", ctx);
  return ctx.__api;
}
const SF = load(["js/storefront-render.js", "js/storefront-chrome.js"], "buildStorefrontHTML");
const prod = (name, price, extra) => Object.assign({ name, price, imageId: "", imageUrl: "", category: "General", description: "" }, extra || {});
const field = products => ({ id: "p1", type: "product", label: "Products", products });
const OPTS = { live: true, cart: {}, qtyFn: "changeQty", totalFn: "updateTotal", submitFn: "submitOrder" };
const THEMES = ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"];
const html = (fields, t, opts) => SF.buildStorefrontHTML({ fields, formTitle: "Shop", formSubtitle: "S", themeClass: "theme-" + t, storeConfig: null, opts: opts || OPTS });
const count = (s, re) => (s.match(re) || []).length;

// ---- 1. storefront: every theme, three kinds of product ----
const mixed = [field([prod("Out", "100", { soldOut: true }), prod("Old store product", "200"), prod("Back in stock", "300", { soldOut: false })])];
for (const t of THEMES) {
  const s = html(mixed, t);
  a(count(s, /Sold out<\/span>/g) === 1 && count(s, /is-soldout/g) === 1, t + ": exactly one product shows Sold out");
  a(/class="sf-add" disabled>Sold out/.test(s) && count(s, /class="sf-add" onclick/g) === 2, t + ": sold-out Add is disabled, the other two still work");
  a(/<button type="button" disabled>-<\/button><span id="qty-p1-0">0<\/span><button type="button" disabled>\+<\/button>/.test(s), t + ": sold-out quantity buttons disabled");
  a(!/Only \d+ left|in stock:|units? left|\d+ left/i.test(s), t + ": no stock-count wording (there are no counts)");
}
// every product sold out, and a store with no flags at all (old stores)
for (const t of THEMES) {
  const all = html([field([prod("A", "100", { soldOut: true }), prod("B", "200", { soldOut: true })])], t);
  a(count(all, /class="sf-add" disabled>Sold out/g) === 2 && count(all, /class="sf-add" onclick/g) === 0, t + ": a fully sold-out store renders and nothing can be added");
  const legacy = html([field([prod("A", "100"), prod("B", "200")])], t);
  a(count(legacy, /Sold out/g) === 0 && count(legacy, /class="sf-add" onclick/g) === 2, t + ": products without any flag behave as before (always available)");
}
// the static (preview-less) rendering also respects it
a(count(html(mixed, "r3", Object.assign({}, OPTS, { live: false })), /is-soldout/g) === 1, "static rendering also shows the sold-out product");
a(count(html([field([prod("Str", "1", { soldOut: "true" })])], "r3"), /is-soldout/g) === 1 && count(html([field([prod("Str", "1", { soldOut: "false" })])], "r3"), /is-soldout/g) === 0, "text values 'true' / 'false' are read the same way everywhere");

// ---- 2. builder: the flag survives edit, save and reload; stores without it are untouched ----
const bsrc = fs.readFileSync("js/builderF.js", "utf8");
const norm = bsrc.match(/function normalizeProducts[\s\S]*?\n}\n/)[0];
const B = { Array, Object, JSON, String };
vm.createContext(B);
vm.runInContext(norm + ";globalThis.np=normalizeProducts", B);
const f1 = { products: [{ name: "Ring", price: "900", soldOut: true, featured: true }, { name: "Cap", price: "50" }, { name: "Hat", price: "70", soldOut: false }] };
B.np(f1); const again = JSON.parse(JSON.stringify(f1)); B.np(again);
a(f1.products[0].soldOut === true && f1.products[0].featured === true && again.products[0].soldOut === true, "normalizing keeps soldOut (and other extra properties), also after a save/reload round trip");
a(!("soldOut" in f1.products[1]) && f1.products[2].soldOut === false, "a product without the flag does not get one added; a false flag stays false");
a(/toggleSoldOut/.test(bsrc) && /updateProduct\('\$\{field\.id\}', \$\{i\}, 'soldOut'/.test(bsrc), "builder has both switches (tile button and editor switch)");

// ---- 3. cart: sold-out products can't be added, and a product that sells out while the customer shops is removed ----
const fsrc = fs.readFileSync("js/form.js", "utf8");
const mkCart = (latestFields, fail) => {
  const ctx = { cart: {}, fields: [{ id: "p1", type: "product", products: [{ name: "A" }, { name: "B" }, { name: "C" }] }], toasts: [], rendered: 0, totals: 0,
    databases: { getDocument: async () => { if (fail) throw new Error("offline"); return { fields: latestFields.map(f => JSON.stringify(f)) }; } },
    DB_ID: "d", FORMS: "form", CURRENT_FORM_ID: "f1", console: { warn() {}, log() {} }, JSON, Array, Object, String };
  ctx.renderForm = () => { ctx.rendered++; }; ctx.updateTotal = () => { ctx.totals++; }; ctx.showToast = m => ctx.toasts.push(m);
  vm.createContext(ctx);
  vm.runInContext(fsrc.match(/async function removeSoldOutFromCart[\s\S]*?\n}\n/)[0] + ";globalThis.run=removeSoldOutFromCart", ctx);
  return ctx;
};
(async () => {
  let c = mkCart([{ id: "p1", type: "product", products: [{ name: "A" }, { name: "B", soldOut: true }, { name: "C" }] }]);
  c.cart = { p1_0: 1, p1_1: 2 };
  let ok = await c.run();
  a(ok === false && !("p1_1" in c.cart) && c.cart.p1_0 === 1 && /B just sold out/.test(c.toasts[0]) && c.rendered === 1, "sold out during shopping: only that product leaves the cart, the rest stays, customer told, nothing sent");
  c = mkCart([{ id: "p1", type: "product", products: [{ name: "C" }, { name: "B", soldOut: true }, { name: "A" }] }]); c.cart = { p1_0: 3, p1_2: 1 };
  ok = await c.run(); a(ok === true && c.cart.p1_0 === 3 && c.cart.p1_2 === 1, "store reordered meanwhile: products matched by name, no quantity moves onto another product");
  c = mkCart([{ id: "p1", type: "product", products: [{ name: "A", soldOut: true }] }]); c.cart = { p1_1: 1 };
  ok = await c.run(); a(ok === true && c.cart.p1_1 === 1 && c.toasts.length === 0, "a sold-out product that is not in the cart changes nothing");
  c = mkCart([], true); c.cart = { p1_0: 1 }; ok = await c.run();
  a(ok === true && c.cart.p1_0 === 1, "re-check fails (no network): the order goes ahead as before");
  c = mkCart([{ id: "p1", type: "product", products: [{ name: "A", soldOut: "true" }] }]); c.cart = { p1_0: 1 }; ok = await c.run();
  a(ok === false && !("p1_0" in c.cart), "re-check also understands the text value 'true'");

  // ---- 4. customer order page and seller change: sold-out products can't be added or increased; reducing and removing still work ----
  const fields = [{ label: "Items", type: "product", products: [{ name: "Bag", price: 10000 }, { name: "Ring", price: 900, soldOut: true }, { name: "Cap", price: 2000 }] }];
  const cat = L.catalogOf(fields);
  const raw = [{ label: "Items", type: "product", value: [{ name: "Bag", qty: 2, price: 10000 }, { name: "Ring", qty: 2, price: 900 }] }].map(JSON.stringify);
  const order = { $id: "o1", userId: "s1", formData: raw, totalAmount: 21800, status: "pending" };
  const eff = L.replay(order, [], [], cat, fields);
  const plan = req => L.planUpdate(order, eff, cat, fields, { items: req });
  a(!plan([{ label: "Items", name: "Ring", qty: 3 }]).ok, "customer can't increase an item that is now sold out");
  a(plan([{ label: "Items", name: "Ring", qty: 1 }]).ok, "customer can still reduce a sold-out item they already ordered");
  a(plan([{ label: "Items", name: "Ring", qty: 0 }]).ok, "customer can still remove a sold-out item");
  a(plan([{ label: "Items", name: "Ring", qty: 2 }, { label: "Items", name: "Bag", qty: 3 }]).ok, "an unchanged sold-out line does not block other changes");
  a(!L.planUpdate(order, eff, cat, fields, { items: [{ label: "Items", name: "Nope", qty: 1 }] }).ok, "unknown products are refused");
  const catIn = L.catalogOf([{ label: "Items", type: "product", products: [{ name: "Ring", price: 900 }] }]);
  const eff2 = L.replay(order, [], [], catIn, fields);
  a(L.planUpdate(order, eff2, catIn, fields, { items: [{ label: "Items", name: "Ring", qty: 5 }] }).ok, "back in stock: it can be increased again (the seller's switch is the only control)");
  a(L.replay(order, [], [], cat, fields).items.find(i => i.name === "Ring").qty === 2, "an existing order keeps a product that later sold out (the original order is never rewritten)");

  // ---- 5. the things this design deliberately does not do ----
  const osrc = fs.readFileSync("js/orders.js", "utf8"), usrc = fs.readFileSync("js/orders-updates.js", "utf8");
  const upd = osrc.match(/async function updateStatus[\s\S]*?\n}\n/)[0];
  a(!/FORMS|"form"|\bsoldOut\b/.test(upd), "changing or cancelling an order never touches the store's products (cancelling does not change availability)");
  a(!/stockQuantity|stockTracking|lowStockThreshold|\breserv(e|ation)/i.test([fsrc, bsrc, osrc, usrc, fs.readFileSync("js/order.js", "utf8"), fs.readFileSync("js/storefront-render.js", "utf8"), fs.readFileSync("js/storefront-chrome.js", "utf8")].join("\n")), "no stock-count, reservation or expiry code exists (by design)");

  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
})();
