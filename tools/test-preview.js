// Run from the project root: node tools/test-preview.js
// Tests the builder preview frame: the generated document, safe data embedding, and the
// preview runtime that runs inside the iframe (cart maths, rendering).
const fs = require("fs"), vm = require("vm");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

/* ---- 1. buildPreviewDoc (extracted from builderF.js) ---- */
const src = fs.readFileSync("js/builderF.js", "utf8");
const grab = name => { const m = src.match(new RegExp("function " + name + "[\\s\\S]*?\\n}\\n")); if (!m) throw new Error("missing " + name); return m[0]; };
const ctx1 = { URL, JSON, String, document: { baseURI: "https://example.com/ng/indexF.html", querySelector: () => ({ href: "https://fonts.googleapis.com/css2?family=Orbitron&display=swap" }) } };
vm.createContext(ctx1);
vm.runInContext(grab("absUrl") + grab("buildPreviewDoc"), ctx1);
const HOSTILE = '</script><img src=x onerror=alert(1)>\u2028\u2029';
const data = { fields: [{ id: "p1", type: "product", label: "P", products: [{ name: HOSTILE, price: "100" }] }], formTitle: HOSTILE, formSubtitle: "S", themeClass: "theme-r8", storeConfig: { tagline: HOSTILE } };
const doc = ctx1.buildPreviewDoc(data);
ok(/^<!DOCTYPE html>/.test(doc), "starts with doctype");
ok((doc.match(/<\/script>/g) || []).length === 5, "exactly 5 closing script tags (hostile text cannot add one): " + (doc.match(/<\/script>/g) || []).length);
ok(!doc.includes("<img src=x"), "hostile markup not present raw");
const m = doc.match(/window\.__PREVIEW__ = (.*?);<\/script>/s);
const parsed = m ? vm.runInNewContext("(" + m[1] + ")") : null;
ok(parsed && parsed.formTitle === HOSTILE && parsed.fields[0].products[0].name === HOSTILE && parsed.storeConfig.tagline === HOSTILE, "data round-trips exactly through the embedded script");
ok(doc.includes("https://example.com/ng/css/theme-r8.css") && !doc.includes("theme-r1.css"), "loads only the selected theme css, with absolute urls");
ok(doc.includes("css/form.shared.css") && doc.includes("css/storefront-base.css") && !doc.includes("stylesF.css") && !doc.includes("gomart-visual.css"), "loads store css only, never the builder css");
ok(doc.includes("js/preview-runtime.js") && doc.includes("js/storefront-chrome.js") && doc.indexOf("storefront-render.js") < doc.indexOf("preview-runtime.js"), "scripts present and ordered");
ok(doc.includes("family=Orbitron"), "theme fonts linked");
const bad = ctx1.buildPreviewDoc(Object.assign({}, data, { themeClass: "theme-../../x" }));
const hrefs = [...bad.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(x => x[1]).join(" ");
ok(!hrefs.includes("..") && hrefs.includes("css/theme-x.css"), "theme id is sanitised in the stylesheet link");

/* ---- 2. preview runtime inside the frame (stub DOM) ---- */
function runtime(previewData) {
  const els = {};
  const el = id => els[id] = els[id] || { id, innerText: "", innerHTML: "", style: {}, classes: new Set(), classList: { toggle(c, f) { f ? els[id].classes.add(c) : els[id].classes.delete(c); } } };
  const toasts = []; const listeners = [];
  const context = { console, Number, Set, Array, Object, String, JSON, Math, RegExp, window: { __PREVIEW__: previewData, parent: {} }, showToast: (t) => toasts.push(t),
    document: { getElementById: id => id === "root" || els[id] ? el(id) : (id.startsWith("qty-") || id.startsWith("badge-") || ["itemCount", "totalCost", "cartBarCount", "cartBarTotal", "cartBar", "additionalFeeBox"].includes(id) ? el(id) : null),
      querySelector: () => null, querySelectorAll: () => [], addEventListener: (t, f) => listeners.push([t, f]) } };
  context.window.parent = { postMessage: (m) => toasts.push(m) };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync("js/storefront-render.js", "utf8") + fs.readFileSync("js/storefront-chrome.js", "utf8") + fs.readFileSync("js/preview-runtime.js", "utf8") + ";globalThis.__api={previewChangeQty,previewUpdateTotal,previewNoSubmit,get cart(){return previewCart}}", context);
  return { context, els, toasts, listeners, api: context.__api };
}
const pd = { fields: [{ id: "p1", type: "product", label: "Products", products: [{ name: "A", price: "12000" }, { name: "B", price: "8000" }] }, { id: "f1", type: "additional_fee", label: "Delivery", fees: [{ name: "Lagos", price: "2000" }] }], formTitle: "Store", formSubtitle: "S", themeClass: "theme-r6", storeConfig: null };
const rt = runtime(pd);
ok(rt.els.root.innerHTML.includes("sf-chrome") && rt.els.root.innerHTML.includes("sf-g-marketplace"), "runtime renders the chrome store into #root");
rt.api.previewChangeQty("p1", 0, 1); rt.api.previewChangeQty("p1", 1, 2); rt.api.previewChangeQty("p1", 1, 1);
ok(rt.els["qty-p1-1"].innerText === 3, "qty shown for product B is 3");
ok(rt.els.itemCount.innerText === 4, "item count 1 + 3 = 4");
ok(rt.els.totalCost.innerText === "₦" + (12000 + 3 * 8000).toLocaleString(), "total ₦36,000: " + rt.els.totalCost.innerText);
ok(rt.els.cartBarCount.innerText === "4 items" && rt.els.cartBar.classes.has("visible"), "cart bar shows 4 items and is visible");
rt.api.previewChangeQty("p1", 0, -5);
ok(rt.els["qty-p1-0"].innerText === 0 && rt.els.itemCount.innerText === 3, "quantity never goes below zero");
rt.api.previewNoSubmit(); ok(rt.toasts.length === 1 && /preview/i.test(rt.toasts[0]), "submit shows a preview-only message and sends nothing");
const esc = rt.listeners.find(l => l[0] === "keydown");
ok(!!esc, "Escape listener registered");
esc[1]({ key: "Escape" }); ok(rt.toasts.some(t => t && t.xredro === "closePreview"), "Escape asks the builder to close the preview");
const rt2 = runtime({}); ok(rt2.els.root.innerHTML.length >= 0, "runtime survives missing data");

/* ---- 3. builder file hygiene ---- */
ok(!/function previewChangeQty|function previewUpdateTotal|previewForm/.test(src), "old in-page preview code is gone from builderF.js");
ok(/function openPreview/.test(src) && /function closePreview/.test(src) && /function setPreviewDevice/.test(src), "open, close and size switch exist");
const html = fs.readFileSync("indexF.html", "utf8");
["previewOverlay", "previewFrame", "previewStage", "pvPhone", "pvFull"].forEach(id => ok(html.includes(`id="${id}"`), "indexF.html has #" + id));
ok(!html.includes('id="previewForm"'), "old previewForm container removed");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
