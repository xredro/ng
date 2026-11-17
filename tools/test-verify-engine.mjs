// Run from project root: node tools/test-verify-engine.mjs
// Real PDFs (made by tools/fixtures/make_statements.py) -> text boxes -> the engine. Checks every case in the test list.
import fs from "node:fs"; import { createRequire } from "node:module"; import { readPdf } from "./lib-pdf-items.mjs";
const V = createRequire(import.meta.url)("../js/verify-engine.js");
let failed = 0; const a = (c, m) => { if (!c) failed++; console.log(c ? "ok  " : "FAIL", m); };
const DIR = "tools/fixtures/statements"; const SC = JSON.parse(fs.readFileSync(DIR + "/scenarios.json", "utf8"));
const mkOrders = list => list.map(o => ({ $id: o.id, status: "pending", totalAmount: o.total, paymentProof: "proof-" + o.id, publicOrderID: "PUB" + o.id,
  formData: [JSON.stringify({ label: "Full name", type: "text", value: o.name + " (customer)" }), JSON.stringify({ label: "Name on payment", type: "payment_account_name", value: o.name }), JSON.stringify({ label: "Date paid", type: "payment_date", value: o.date })] }));
async function run(name, extra = {}) {
  const sc = SC[name]; const pages = await readPdf(`${DIR}/${sc.pdf}`);
  const ex = V.extractRows(pages, sc.layout); const orders = V.prepareOrders(mkOrders(sc.orders));
  const m = V.matchAll(ex.rows, orders, extra.opts);
  return { sc, pages, ex, orders, m, status: id => m.orderStatus.get(id).status, best: id => m.orderStatus.get(id).best, row: id => { const b = m.orderStatus.get(id).best; return b ? ex.rows.find(r => r.id === b.rowId) : null; } };
}
const expectAll = (r, label) => r.sc.orders.forEach(o => a(r.status(o.id) === o.expect, `${label} ${o.id} ${o.name} (${o.total}): expected ${o.expect}, got ${r.status(o.id)}  [${o.why}]`));

/* ===== A: clean text statement, 2 pages, debit and credit columns, wrapped text, similar names, identical amounts, duplicates ===== */
const A = await run("bankA_clean");
a(A.pages.length === 2 && V.checkExtractable(A.pages).ok, "A: text-based, multi-page, accepted as extractable");
a(A.ex.dateOrder === "dmy", "A: date order proven day-first from a day of 13 or more");
expectAll(A, "A");
const credits = A.ex.rows; a(credits.length > 25 && A.ex.nonCredit > 5, `A: ${credits.length} credits read, ${A.ex.nonCredit} debit/opening rows set aside`);
a(!credits.some(r => /POS PURCHASE/.test(r.description) && r.cents === 3000000), "A: the 30,000.00 debit is not a credit row");
a(!credits.some(r => r.cents === 123456700), "A: the 'Total credits' summary line is not a transaction");
const funmi = A.row("O13"); a(funmi && /FUNMI ALADE/.test(funmi.description) && funmi.date.iso === "2026-11-12", "A: closing balance 25,400.00 in the header does not interfere with the real credit");
const chin = A.row("O9"); a(chin && /CHINEDU EMMANUEL OBIORA/.test(chin.description) && /INTERBANK PAYMENT/.test(chin.description), "A: wrapped description was reassembled: " + (chin && chin.description));
a(chin.page >= 1 && chin.yTop > chin.yBottom && chin.x1 > chin.x0 && chin.pageWidth > 500, "A: row keeps page, coordinates and original text (" + chin.rawText.slice(0, 40) + "…)");
const john = A.m.orderStatus.get("O1").best; a(john.confident && john.name.tier === "strong" && john.date.state === "exact", "A: John Doe is confident with name and date");
a(A.m.orderStatus.get("O2").pairs.length >= 2 || A.m.orderStatus.get("O3").pairs.length >= 2, "A: similar names produce competing candidates");
const dup = A.ex.rows.filter(r => /AMINA BELLO/.test(r.description)); a(dup.length === 2 && dup.every(r => r.duplicateLooking) && dup[0].key !== dup[1].key, "A: two identical-looking rows are flagged and keep different keys");
const mary = A.row("O4"), peter = A.row("O5"); a(mary && peter && mary.id !== peter.id, "A: two orders with the same amount match different transactions");
const okRows = new Set(A.m.confidentPairs.map(p => p.rowId)); a(okRows.size === A.m.confidentPairs.length, "A: no transaction is used by two confident matches");
const sum = A.m.summary; a(sum.ordersChecked === 16 && sum.confident === A.sc.orders.filter(o => o.expect === "confident").length && sum.unusedTransactions > 10, "A: summary " + JSON.stringify(sum));
// date tolerance is configurable
const A0 = await run("bankA_clean", { opts: { dateTolerance: 0 } }); a(A0.status("O6") === "unmatched" || A0.status("O6") === "review", "A: with 0 days tolerance the 2-day gap is no longer a date signal");
const A3 = await run("bankA_clean", { opts: { dateTolerance: 3 } }); a(A3.best("O6").date.state === "near" && !A3.best("O6").confident, "A: near dates (within tolerance) are review, never confident");

/* ===== B: combined date+description column, CR/DR suffix, Letter, 2 pages ===== */
const B = await run("bankB_combined"); expectAll(B, "B");
a(B.ex.rows.every(r => r.direction !== "debit") && !B.ex.rows.some(r => /ATM WITHDRAWAL|TRANSFER TO LANDLORD|AIRTIME/.test(r.description)), "B: DR rows are never read as credits");
const ib = B.row("B1"); a(ib && ib.date.iso === "2026-11-10" && !/Nov 2026/.test(ib.description) && /IBRAHIM MUSA/.test(ib.description), "B: date removed from the description in the combined column: " + (ib && ib.description));
const fk = B.row("B2"); a(fk && /INTERBANK TRANSFER FOR ORDER/.test(fk.description), "B: wrapped details in the combined column");
a(B.m.orderStatus.get("B5").status === "unmatched", "B: the DR of 9,500.00 cannot satisfy an order, only the CR can (B6)");

/* ===== C: ISO dates, one signed amount column ===== */
const C = await run("bankC_iso"); expectAll(C, "C");
a(C.ex.rows.every(r => r.date && /^\d{4}-\d\d-\d\d$/.test(r.date.iso)), "C: ISO dates parsed");
a(!C.ex.rows.some(r => r.cents === 450000), "C: -4,500.00 is a debit");

/* ===== D: dd/mm with every day <= 12 ===== */
const D = await run("bankD_ambiguous"); expectAll(D, "D");
const d1 = D.best("D1"); a(d1.date.state === "ambiguous" && !d1.confident && d1.problems.some(p => /could be/.test(p)), "D: ambiguous date is explained and never treated as exact: " + (d1 && d1.problems.join(" | ")));
a(D.ex.dateOrder === "unknown", "D: statement date order is not guessed silently");
// once the seller says day-first, the same statement can be confident
const pagesD = D.pages; const exD = V.extractRows(pagesD, D.sc.layout, { dateOrder: "dmy" }); const mD = V.matchAll(exD.rows, D.orders);
a(mD.orderStatus.get("D1").status === "confident", "D: when the order is settled (seller confirms day-first) the unique match becomes confident");

/* ===== already-paid / already-used / rejected / manual ===== */
const used = new Set([A.row("O1").key]); const Au = V.matchAll(A.ex.rows, A.orders, { verifiedKeys: used });
a(Au.orderStatus.get("O1").status === "unmatched" && Au.rowStatus.get(A.row("O1").id).status === "used" && Au.summary.alreadyUsedTransactions === 1, "a transaction verified before cannot match again");
const Ar = V.matchAll(A.ex.rows, A.orders, { rejected: new Set([V.pairKey("O1", A.row("O1").id)]) });
a(Ar.orderStatus.get("O1").status === "unmatched", "a rejected pair is not suggested again");
const Af = V.matchAll(A.ex.rows, A.orders, { forcedReview: new Set([V.pairKey("O4", A.row("O4").id)]) });
a(Af.orderStatus.get("O4").status === "review" && !V.verifyAllPlan(Af).some(p => p.orderId === "O4"), "marked for manual review: excluded from Verify all");
const fresh = A.orders.filter(o => o.id !== "O1"); const Ap = V.matchAll(A.ex.rows, fresh);
a(!Ap.orderStatus.has("O1") && Ap.summary.ordersChecked === 15, "orders already marked paid are simply not in the list to match");
const unmatchedRow = A.ex.rows.find(r => A.m.rowStatus.get(r.id).status === "unmatched" && r.cents === 550000); 
const Am = V.matchAll(A.ex.rows, A.orders, { manual: [{ orderId: "O8", rowId: A.row("O13").id }] });
a(Am.confidentPairs.every(p => !(p.orderId === "O8")), "a manual choice is never confident");
// one transaction can't confirm two orders, even if both are confident on their own
const twin = A.orders.filter(o => o.id === "O1").concat([Object.assign({}, A.orders.find(o => o.id === "O1"), { id: "O1b" })]);
const Aw = V.matchAll(A.ex.rows, twin); a(Aw.confidentPairs.length === 0 && Aw.orderStatus.get("O1").status === "review", "two identical orders on one transaction: neither is confident");
// amount alone never confirms
const lone = V.prepareOrders(mkOrders([{ id: "X", name: "Nobody Atall", date: "2020-01-01", total: 7000 }])); const Al = V.matchAll(A.ex.rows, lone);
a(Al.orderStatus.get("X").status === "unmatched", "amount alone (name and date unrelated) never suggests a match");

/* ===== editing a misread row, auto layout guess, scanned detection ===== */
const sameRows = (pages, a, b) => { const x = V.extractRows(pages, a).rows.map(r => r.key + "|" + r.description).join("\n"), y = V.extractRows(pages, b).rows.map(r => r.key + "|" + r.description).join("\n"); return x === y && x.length > 0; };
for (const name of ["bankA_clean", "bankB_combined", "bankC_iso", "bankD_ambiguous"]) {
  const r = name === "bankA_clean" ? A : await run(name); const g = V.guessLayout(r.pages);
  a(g.found && g.layout.mode === r.sc.layout.mode, `${name}: columns guessed from the headings and the text (${g.layout.mode})`);
  a(sameRows(r.pages, g.layout, r.sc.layout), `${name}: the guessed columns read exactly the same transactions as hand-placed ones`);
}
const bad = A.ex.rows.find(r => /HALIMA SANI/.test(r.description) && r.cents === 600000); const fixed = V.editRow(bad, { amount: "6,100.00", description: "TRF FROM HALIMA SANI" }, "dmy");
a(fixed.cents === 610000 && fixed.edited && fixed.confidence >= 0.85, "a corrected row is rebuilt");
// unsupported documents: stop, never guess
for (const u of SC._unsupported) { const pages = await readPdf(`${DIR}/${u.pdf}`); const c = V.checkExtractable(pages); a(!c.ok && c.reason, `${u.pdf} (${u.why}) is refused: ${c.reason}, ${c.words} words, ${c.figures} figures`); }
const img = await readPdf(`${DIR}/image_only.pdf`); a(img.length === 1 && img[0].items.length === 0, "an image-only PDF has no embedded text for PDF.js to read");
for (const nm of ["bankA_clean", "bankB_combined", "bankC_iso", "bankD_ambiguous"]) { const pages = await readPdf(`${DIR}/${SC[nm].pdf}`); const c = V.checkExtractable(pages); a(c.ok, `${nm} is accepted as extractable (${c.words} words, ${c.figures} figures)`); }
a(!V.checkExtractable([]).ok && V.checkExtractable([]).reason === "empty", "an empty document is refused");
a(V.sanitizeLayout({ mode: "three", regions: { date: { x0: 0.1, x1: 0.1 }, desc: { x0: -3, x1: 9 }, credit: {} } }).regions.date.x1 - 0.1 >= V.MIN_REGION - 0.0001, "columns can't shrink below the minimum width");

/* ===== performance ===== */
const big = []; for (let i = 0; i < 4000; i++) { const base = A.ex.rows[i % A.ex.rows.length]; big.push(Object.assign({}, base, { id: "b" + i, key: base.key + "x" + i, cents: base.cents + (i % 300) * 100 })); }
const manyOrders = V.prepareOrders(mkOrders(Array.from({ length: 800 }, (_, i) => ({ id: "L" + i, name: "Customer " + i + " Name", date: "2026-11-10", total: 1000 + (i % 400) * 50 }))));
const t0 = Date.now(); V.matchAll(big, manyOrders); const ms = Date.now() - t0; a(ms < 1500, `4000 transactions x 800 orders matched in ${ms} ms`);
console.log(failed ? `\n${failed} FAILED` : "\nall passed"); process.exit(failed ? 1 : 0);
