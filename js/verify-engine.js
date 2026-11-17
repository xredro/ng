/* X-Redro payment verification engine. Pure functions: no DOM, no network, no PDF library.
   It turns the text boxes PDF.js reads from a text-based PDF plus the seller's column regions into structured credit transactions,
   then matches them against unpaid orders. It never decides that anything is paid: it only classifies.

   Coordinates: PDF user space (origin bottom-left, y grows upward), in PDF units. Column regions are stored as fractions
   of the page width (0 to 1), so one layout fits every page size, every zoom level and every screen. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.XrVerify = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ======================= text, names ======================= */
  const normText = s => String(s == null ? "" : s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const TITLES = new Set(["mr", "mrs", "miss", "ms", "dr", "chief", "alhaji", "alhaja", "engr", "prof", "sir", "madam", "mal", "pastor", "rev"]);
  // words banks add to a description that are not part of a person's name
  const NOISE = new Set(["transfer", "trf", "from", "to", "nip", "nibss", "inward", "outward", "credit", "cr", "debit", "dr", "bank", "plc", "mobile", "mob", "pos", "web", "ussd", "ft", "ref",
    "reference", "payment", "pymt", "pay", "atm", "via", "by", "for", "and", "the", "of", "inter", "intra", "ibank", "internet", "banking", "app", "online", "teller", "deposit", "cash", "chq", "cheque",
    "nigeria", "limited", "ltd", "account", "acct", "acc", "no", "num", "number", "sent", "send", "received", "naira", "ngn", "fbn", "gtb", "gtbank", "uba", "zenith", "access", "opay", "palmpay", "kuda", "moniepoint", "wema", "sterling", "stanbic", "fcmb", "fidelity", "union", "ecobank", "polaris", "keystone"]);
  function lev(a, b) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > 2) return 3;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }
  const nameTokens = s => normText(s).split(" ").filter(t => t.length > 1 && !TITLES.has(t) && !/^\d+$/.test(t));
  const descTokens = s => normText(s).split(" ").filter(t => t.length > 1 && !NOISE.has(t) && !/^\d+$/.test(t) && !/\d{4,}/.test(t));
  function tokenMatches(a, b) {         // equal, one typo in a longer word, or a bank-truncated word
    if (a === b) return 1;
    if (a.length >= 5 && b.length >= 5) {
      if (lev(a, b) <= 1) return 0.85;
      const n = Math.min(a.length, b.length);
      if (n >= 5 && (a.startsWith(b) || b.startsWith(a))) return 0.8;
    }
    return 0;
  }
  /* How well does the bank's description contain the customer's payment name?
     tier: strong (every name word found, 2+ words) | good (most words) | single (one-word name found exactly) | weak (one word of several) | none */
  function nameMatch(customerName, description) {
    const want = nameTokens(customerName);
    const have = descTokens(description);
    if (!want.length) return { tier: "none", score: 0, hits: 0, of: 0, missing: [] };
    let hits = 0, quality = 0; const missing = [];
    want.forEach(t => {
      let best = 0; for (const h of have) { best = Math.max(best, tokenMatches(t, h)); if (best === 1) break; }
      if (best > 0) { hits++; quality += best; } else missing.push(t);
    });
    let tier = "none";
    if (want.length === 1) tier = hits === 1 && quality === 1 && want[0].length >= 4 ? "single" : (hits === 1 ? "weak" : "none");
    else if (hits === want.length) tier = "strong";
    else if (hits >= 2 && hits / want.length >= 0.6) tier = "good";
    else if (hits >= 1) tier = "weak";
    const score = { strong: 60, good: 45, single: 40, weak: 15, none: 0 }[tier];
    return { tier, score, hits, of: want.length, missing };
  }

  /* ======================= money ======================= */
  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
  function parseMoney(value) {                         // for order totals and plain numbers
    if (typeof value === "number") return Number.isFinite(value) ? round2(value) : null;
    const s = String(value == null ? "" : value).replace(/,/g, "").replace(/[^\d.()-]/g, "").replace(/[()]/g, "");
    const n = Number(s); return Number.isFinite(n) && s !== "" ? round2(n) : null;
  }
  /* every amount-looking token in a bank cell, with its direction. Account and reference numbers (long digit runs) are not amounts. */
  function findAmounts(text) {
    const out = []; const s = String(text == null ? "" : text);
    const re = /(NGN|₦)?\s*([(\-+]?)\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)\s*(\)?)\s*(CR|DR|C|D)?(?![A-Za-z0-9])/gi;
    let m;
    while ((m = re.exec(s)) !== null) {
      const digits = m[3].replace(/[,.]/g, "");
      if (!m[3].includes(",") && !m[3].includes(".") && digits.length > 9) continue;       // a reference number, not money
      if (/^\d{4}$/.test(m[3]) && /^(19|20)\d\d$/.test(m[3]) && !m[2] && !m[1]) continue;   // a bare year
      const value = round2(Number(m[3].replace(/,/g, "")));
      if (!(value > 0)) continue;
      let direction = "unknown";
      const mark = String(m[5] || "").toUpperCase();
      if (m[2] === "-" || (m[2] === "(" && m[4] === ")") || mark === "DR" || mark === "D") direction = "debit";
      else if (mark === "CR" || mark === "C" || m[2] === "+") direction = "credit";
      out.push({ value, direction, raw: m[0].trim() });
    }
    return out;
  }

  /* ======================= dates ======================= */
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
    january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  const iso = (y, m, d) => y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  function validYMD(y, m, d) {
    if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
    const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }
  const fullYear = y => (y < 100 ? 2000 + y : y);
  /* every date written in a text, left to right. Numeric d/m/y dates keep both readings until the order is known. */
  function findDates(text) {
    const s = String(text == null ? "" : text); const out = []; let m;
    const patterns = [
      { re: /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g, kind: "ymd" },
      { re: /\b(\d{1,2})[\s.-]?([A-Za-z]{3,9})[\s.,-]*(\d{2,4})\b/g, kind: "dMy" },
      { re: /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})\b/g, kind: "Mdy" },
      { re: /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/g, kind: "num" }
    ];
    const taken = [];
    patterns.forEach(p => {
      p.re.lastIndex = 0;
      while ((m = p.re.exec(s)) !== null) {
        const start = m.index, end = start + m[0].length;
        if (taken.some(t => start < t[1] && end > t[0])) continue;
        let rec = null;
        if (p.kind === "ymd") { const y = +m[1], mo = +m[2], d = +m[3]; if (validYMD(y, mo, d)) rec = { raw: m[0], a: { y, m: mo, d }, b: null }; }
        else if (p.kind === "dMy") { const mo = MONTHS[m[2].toLowerCase()]; const y = fullYear(+m[3]), d = +m[1]; if (mo && validYMD(y, mo, d)) rec = { raw: m[0], a: { y, m: mo, d }, b: null }; }
        else if (p.kind === "Mdy") { const mo = MONTHS[m[1].toLowerCase()]; const y = fullYear(+m[3]), d = +m[2]; if (mo && validYMD(y, mo, d)) rec = { raw: m[0], a: { y, m: mo, d }, b: null }; }
        else {
          const x = +m[1], z = +m[2], y = fullYear(+m[3]);
          const dmy = validYMD(y, z, x) ? { y, m: z, d: x } : null;        // day first
          const mdy = validYMD(y, x, z) ? { y, m: x, d: z } : null;        // month first
          if (dmy || mdy) rec = { raw: m[0], numeric: true, dmy, mdy };
        }
        if (rec) { rec.start = start; taken.push([start, end]); out.push(rec); }
      }
    });
    return out.sort((p, q) => p.start - q.start);
  }
  /* The statement's date order from all its numeric dates: one 13+ in the first slot proves day first, in the second slot month first. */
  function detectDateOrder(texts) {
    let dmy = 0, mdy = 0;
    texts.forEach(t => findDates(t).forEach(d => { if (d.numeric) { if (d.dmy && !d.mdy) dmy++; else if (d.mdy && !d.dmy) mdy++; } }));
    if (dmy && !mdy) return "dmy"; if (mdy && !dmy) return "mdy"; return dmy && mdy ? "mixed" : "unknown";
  }
  /* A found date as { iso, ambiguous, altIso }. "ambiguous" means two readings exist and the statement does not settle which. */
  function resolveDate(rec, order) {
    if (!rec) return null;
    if (!rec.numeric) return { iso: iso(rec.a.y, rec.a.m, rec.a.d), ambiguous: false, altIso: null };
    const A = rec.dmy, B = rec.mdy;
    if (A && !B) return { iso: iso(A.y, A.m, A.d), ambiguous: false, altIso: null };
    if (B && !A) return { iso: iso(B.y, B.m, B.d), ambiguous: false, altIso: null };
    if (order === "dmy") return { iso: iso(A.y, A.m, A.d), ambiguous: false, altIso: null };
    if (order === "mdy") return { iso: iso(B.y, B.m, B.d), ambiguous: false, altIso: null };
    const same = A.m === B.m && A.d === B.d;                 // 05/05/2026 reads the same either way
    return { iso: iso(A.y, A.m, A.d), ambiguous: !same, altIso: same ? null : iso(B.y, B.m, B.d) };   // day first is the Nigerian norm, but not assumed silently
  }
  const dayNumber = isoStr => { const p = String(isoStr).split("-").map(Number); return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 86400000); };
  const dayDiff = (a, b) => Math.abs(dayNumber(a) - dayNumber(b));

  /* ======================= layout ======================= */
  const REGION_KEYS = { three: ["date", "desc", "credit"], two: ["namedate", "credit"] };
  const MIN_REGION = 0.03;     // a column can't be narrower than 3% of the page
  function sanitizeLayout(layout) {
    const mode = layout && layout.mode === "two" ? "two" : "three";
    const out = { mode, regions: {} };
    REGION_KEYS[mode].forEach(k => {
      const r = layout && layout.regions && layout.regions[k] || {};
      let x0 = Math.min(1, Math.max(0, Number(r.x0))), x1 = Math.min(1, Math.max(0, Number(r.x1)));
      if (!Number.isFinite(x0)) x0 = 0; if (!Number.isFinite(x1)) x1 = 1;
      if (x1 - x0 < MIN_REGION) x1 = Math.min(1, x0 + MIN_REGION), x0 = Math.max(0, x1 - MIN_REGION);
      out.regions[k] = { x0: Math.round(x0 * 10000) / 10000, x1: Math.round(x1 * 10000) / 10000 };
    });
    return out;
  }
  const DEFAULT_LAYOUTS = {
    three: { mode: "three", regions: { date: { x0: 0.05, x1: 0.2 }, desc: { x0: 0.22, x1: 0.58 }, credit: { x0: 0.7, x1: 0.84 } } },
    two: { mode: "two", regions: { namedate: { x0: 0.05, x1: 0.6 }, credit: { x0: 0.68, x1: 0.84 } } }
  };
  /* An intelligent first guess. The headings (DATE, DESCRIPTION, CREDIT ...) say WHICH columns are which; where the text actually sits
     says how WIDE each one is: columns are the stretches of the page body that contain text, separated by empty gaps.
     The seller can still adjust every guide. */
  function guessLayout(pages) {
    const HEAD = {
      date: /^(trans(action)?\.?\s*)?(date|posting date|value date)$/i,
      desc: /^(description|narration|narrative|details|transaction details|transaction description|particulars|remarks|beneficiary)$/i,
      credit: /^(credit|credits|cr|deposit|deposits|money in|amount in|lodgement|lodgements|amount)$/i,
      other: /^(debit|debits|dr|withdrawal|withdrawals|money out|balance|running balance|closing balance|ref|reference|value date|channel|type)$/i
    };
    for (const pg of pages.slice(0, 3)) {
      const found = [];
      (pg.items || []).forEach(it => {
        const t = String(it.text || "").trim(); if (!t || t.length > 40) return;
        for (const key of ["credit", "date", "desc", "other"]) if (HEAD[key].test(t)) { found.push({ key, x0: it.x, x1: it.x + (it.w || t.length * 5), y: it.y }); break; }
      });
      if (found.length < 2) continue;
      const rowsOf = []; found.slice().sort((a, b) => b.y - a.y).forEach(f => { const r = rowsOf.find(x => Math.abs(x.y - f.y) <= 7); if (r) r.items.push(f); else rowsOf.push({ y: f.y, items: [f] }); });   // baselines can differ by a few units
      const best = rowsOf.sort((a, b) => b.items.length - a.items.length)[0].items.sort((a, b) => a.x0 - b.x0);
      if (best.length < 2) continue;
      const W = pg.width, headY = Math.min.apply(null, best.map(b => b.y));
      // 1. where does text sit below the heading row? merge overlapping stretches; the gaps between them separate columns
      const spans = [];
      (pg.items || []).forEach(it => { if (it.y < headY - 3) spans.push([it.x, it.x + Math.max(1, it.w || String(it.text).length * 4)]); });
      const cols = [];
      spans.sort((a, b) => a[0] - b[0]).forEach(sp => { const last = cols[cols.length - 1]; if (last && sp[0] <= last[1] + 5) last[1] = Math.max(last[1], sp[1]); else cols.push([sp[0], sp[1]]); });
      const colFor = h => { let bi = -1, bo = 0; cols.forEach((c, i) => { const o = Math.min(c[1], h.x1) - Math.max(c[0], h.x0); if (o > bo) { bo = o; bi = i; } }); return bi; };
      const pick = key => { const h = best.find(b => b.key === key); return h ? { h, ci: colFor(h) } : null; };
      const d = pick("date"), n = pick("desc"), c = pick("credit");
      const usable = x => x && x.ci >= 0;
      const region = ci => ({ x0: ((ci > 0 ? (cols[ci - 1][1] + cols[ci][0]) / 2 : cols[ci][0] - 6) ) / W, x1: ((ci < cols.length - 1 ? (cols[ci][1] + cols[ci + 1][0]) / 2 : cols[ci][1] + 6)) / W });
      // a column's guide spans from the middle of the gap before it to the middle of the gap after it
      if (usable(d) && usable(n) && usable(c) && new Set([d.ci, n.ci, c.ci]).size === 3) return { found: true, layout: sanitizeLayout({ mode: "three", regions: { date: region(d.ci), desc: region(n.ci), credit: region(c.ci) } }) };
      if (usable(n) && usable(c) && !d && n.ci !== c.ci) return { found: true, layout: sanitizeLayout({ mode: "two", regions: { namedate: region(n.ci), credit: region(c.ci) } }) };
    }
    return { found: false, layout: sanitizeLayout(DEFAULT_LAYOUTS.three) };
  }

  /* ======================= is there readable text at all? =======================
     X-Redro reads TEXT-BASED PDFs only. There is no OCR and no fallback: if PDF.js finds too little embedded text, processing stops
     and the seller is told the file is not supported. This never guesses and never converts pictures into text. */
  const MIN_WORDS = 12, MIN_FIGURES = 3;
  function checkExtractable(pages) {
    const tokens = [].concat.apply([], (pages || []).map(p => [].concat.apply([], (p.items || []).map(i => String(i.text || "").split(/\s+/)))).filter(Boolean)).filter(w => /[A-Za-z0-9]/.test(w));
    const words = tokens.length, figures = tokens.filter(w => /\d/.test(w)).length;
    if (!pages || !pages.length) return { ok: false, words: 0, figures: 0, reason: "empty" };
    if (words === 0) return { ok: false, words, figures, reason: "no-text" };
    if (words < MIN_WORDS) return { ok: false, words, figures, reason: "too-little-text" };
    if (figures < MIN_FIGURES) return { ok: false, words, figures, reason: "no-figures" };
    return { ok: true, words, figures, reason: "" };
  }

  /* ======================= rows from regions ======================= */
  const median = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const itemH = it => Math.max(4, it.h || 8);

  /* assign each text box to the column its middle falls in. A box that straddles two columns is split word by word. */
  function assignColumns(items, regionsPdf) {
    const keys = Object.keys(regionsPdf); const cols = {}; keys.forEach(k => { cols[k] = []; });
    const inRegion = (k, x) => x >= regionsPdf[k].x0 && x <= regionsPdf[k].x1;
    items.forEach(it => {
      const w = it.w > 0 ? it.w : String(it.text).length * itemH(it) * 0.5;
      const touched = keys.filter(k => it.x < regionsPdf[k].x1 && it.x + w > regionsPdf[k].x0);
      if (touched.length <= 1) {
        const cx = it.x + w / 2; const k = keys.find(kk => inRegion(kk, cx)) || touched[0];
        if (k) cols[k].push(Object.assign({}, it, { w, col: k }));
        return;
      }
      const words = String(it.text).split(/(\s+)/); const total = Math.max(1, String(it.text).length); let pos = 0;
      let cur = null;
      words.forEach(tok => {
        const len = tok.length; if (/^\s*$/.test(tok)) { pos += len; return; }
        const cx = it.x + ((pos + len / 2) / total) * w; const k = keys.find(kk => inRegion(kk, cx)) || null; pos += len;
        if (!k) { cur = null; return; }
        if (cur && cur.col === k) { cur.text += " " + tok; cur.w += (len / total) * w; }
        else { cur = Object.assign({}, it, { text: tok, x: it.x + ((pos - len) / total) * w, w: (len / total) * w, col: k }); cols[k].push(cur); }
      });
    });
    return cols;
  }

  /* text in reading order: lines top to bottom, words left to right inside a line. Boxes on one printed line can differ a little in
     height, so lines are found with a tolerance instead of sorting by exact y. */
  function readingOrder(list, tol) {
    const lines = [];
    list.slice().sort((a, b) => b.y - a.y).forEach(it => { const l = lines.find(L => Math.abs(L.y - it.y) <= tol); if (l) l.items.push(it); else lines.push({ y: it.y, items: [it] }); });
    return lines.flatMap(L => L.items.sort((a, b) => a.x - b.x));
  }
  function extractRows(pages, layoutIn, opts) {
    opts = opts || {};
    const layout = sanitizeLayout(layoutIn);
    const warnings = [];
    const allRows = []; let nonCredit = 0;
    // the statement's date order is decided once, from every date in the date column(s)
    const dateTexts = [];
    const perPage = pages.map(pg => {
      const W = pg.width, H = pg.height;
      const regionsPdf = {}; Object.keys(layout.regions).forEach(k => { regionsPdf[k] = { x0: layout.regions[k].x0 * W, x1: layout.regions[k].x1 * W }; });
      const cols = assignColumns((pg.items || []).filter(i => String(i.text || "").trim()), regionsPdf);
      (cols.date || cols.namedate || []).forEach(i => dateTexts.push(i.text));
      return { pg, regionsPdf, cols };
    });
    const dateOrder = opts.dateOrder || detectDateOrder(dateTexts);

    perPage.forEach(({ pg, regionsPdf, cols }) => {
      const dateCol = layout.mode === "two" ? cols.namedate : cols.date;
      const descCol = layout.mode === "two" ? cols.namedate : cols.desc;
      const creditCol = cols.credit || [];
      const allItems = [].concat(cols.date || [], cols.desc || [], cols.namedate || [], creditCol);
      if (!allItems.length) return;
      const lineH = median(allItems.map(itemH)) || 8;
      const yTol = Math.max(2, lineH * 0.55);

      // 1. anchors: where each transaction starts
      let anchors = [];
      const dateItems = (dateCol || []).filter(i => findDates(i.text).length);
      const clusters = [];
      dateItems.slice().sort((a, b) => b.y - a.y).forEach(i => { const c = clusters.find(k => Math.abs(k.y - i.y) <= yTol); if (c) c.items.push(i); else clusters.push({ y: i.y, items: [i] }); });
      anchors = clusters.map(c => ({ y: c.y, kind: "date", items: c.items.sort((a, b) => a.x - b.x) }));
      let fallback = false;
      if (!anchors.length) {      // no dates in the date column: every amount in the credit column starts a row
        const seen = [];
        creditCol.filter(i => findAmounts(i.text).length).sort((a, b) => b.y - a.y).forEach(i => { if (!seen.some(y => Math.abs(y - i.y) <= yTol)) { seen.push(i.y); anchors.push({ y: i.y, kind: "amount", items: [i] }); } });
        fallback = anchors.length > 0;
        if (fallback) warnings.push(`Page ${pg.pageNo}: no dates were found in the date column, so rows were found from the amounts only.`);
      }
      if (!anchors.length) return;
      anchors.sort((a, b) => b.y - a.y);

      // 2. every other box belongs to the nearest anchor; a wrapped line sits below its row, so look upward first
      const maxBelow = lineH * 4.6, maxAbove = lineH * 1.3;
      const members = anchors.map(a => ({ anchor: a, items: a.items.slice() }));
      const anchorSet = new Set(anchors.flatMap(a => a.items));
      allItems.forEach(it => {
        if (anchorSet.has(it)) return;
        let up = null, down = null;                               // the anchor above (higher y) and below
        for (let i = 0; i < anchors.length; i++) { if (anchors[i].y + yTol >= it.y) up = i; else { down = i; break; } }
        let target = -1;
        if (up !== null && down !== null) {
          const dUp = anchors[up].y - it.y, dDown = it.y - anchors[down].y;
          target = dUp <= dDown * 1.6 ? up : down;
          const d = target === up ? dUp : dDown; if (d > Math.max(maxBelow, 1)) target = -1;
        } else if (up !== null) { if (anchors[up].y - it.y <= maxBelow) target = up; }
        else if (down !== null) { if (it.y - anchors[down].y <= maxAbove) target = down; }
        if (target >= 0) members[target].items.push(it);
      });

      // 3. build one row per anchor
      members.forEach((mem, idx) => {
        const items = mem.items;
        const byCol = k => readingOrder(items.filter(i => i.col === k), yTol);
        const credit = byCol("credit");
        const amounts = credit.flatMap(i => findAmounts(i.text).map(a => Object.assign({ item: i }, a)));
        const dateTexts = (layout.mode === "two" ? byCol("namedate") : byCol("date")).map(i => i.text).join(" ");
        const descRaw = (layout.mode === "two" ? byCol("namedate") : byCol("desc")).map(i => i.text).join(" ").replace(/\s+/g, " ").trim();
        const credits = amounts.filter(a => a.direction !== "debit");
        if (!amounts.length || !credits.length) { nonCredit++; return; }
        const rec = findDates(dateTexts)[0] || null;
        const date = rec ? resolveDate(rec, dateOrder) : null;
        let desc = descRaw;
        if (layout.mode === "two") { findDates(desc).slice().reverse().forEach(d => { desc = desc.slice(0, d.start) + " " + desc.slice(d.start + d.raw.length); }); desc = desc.replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?\b/gi, " ").replace(/\s+/g, " ").trim(); }
        const raw = items.map(i => i.text).join(" ");
        const refMatch = /\b[A-Za-z]{0,6}[/-]?\d{9,}[A-Za-z0-9/-]*\b/.exec(raw.replace(/\d{1,3}(,\d{3})+(\.\d+)?/g, " "));
        const flags = [];
        let confidence = 1;
        if (!date) { confidence -= 0.45; flags.push("no date"); }
        if (credits.length > 1) { confidence -= 0.25; flags.push("more than one amount in the credit column"); }
        if (!desc) { confidence -= 0.25; flags.push("no description"); }
        if (fallback) confidence -= 0.15;
        const xs = items.flatMap(i => [i.x, i.x + i.w]); const tops = items.map(i => i.y + itemH(i) * 0.85), bottoms = items.map(i => i.y - itemH(i) * 0.25);
        const regionXs = Object.values(regionsPdf);
        allRows.push({
          id: `p${pg.pageNo}r${idx + 1}`, page: pg.pageNo, pageWidth: pg.width, pageHeight: pg.height,
          x0: Math.min.apply(null, regionXs.map(r => r.x0)), x1: Math.max.apply(null, regionXs.map(r => r.x1)),
          yTop: Math.max.apply(null, tops) + 1.5, yBottom: Math.min.apply(null, bottoms) - 1.5,
          dateText: dateTexts.replace(/\s+/g, " ").trim(), descText: descRaw, amountText: credits[0].raw, rawText: raw,
          date: date, amount: credits[0].value, cents: Math.round(credits[0].value * 100), direction: credits[0].direction,
          description: desc, descNorm: normText(desc), reference: refMatch ? refMatch[0].toUpperCase() : "",
          confidence: Math.max(0.05, Math.round(confidence * 100) / 100), flags, edited: false
        });
      });
    });

    finalizeRows(allRows);
    if (!allRows.length) warnings.push("No credited transactions were found with these columns. Check that the credit column covers the credited amounts.");
    return { rows: allRows, nonCredit, warnings, dateOrder, layout };
  }

  /* stable keys and duplicate flags. Keys do not depend on page layout, so the same transaction is recognised in a later statement. */
  function finalizeRows(rows) {
    const baseOf = r => r.reference ? `ref:${r.reference}|${r.cents}` : `${r.date ? r.date.iso : "?"}|${r.cents}|${r.descNorm}`;
    const counts = new Map(); const refCounts = new Map();
    rows.forEach(r => { r.base = baseOf(r); counts.set(r.base, (counts.get(r.base) || 0) + 1); if (r.reference) refCounts.set(r.reference, (refCounts.get(r.reference) || 0) + 1); });
    const seen = new Map();
    rows.forEach(r => {
      const n = (seen.get(r.base) || 0) + 1; seen.set(r.base, n);
      r.key = r.base + "#" + n;
      r.duplicateLooking = counts.get(r.base) > 1 || (r.reference && refCounts.get(r.reference) > 1);
    });
  }
  /* the seller corrected what was read (a wrongly read figure, a wrong date): rebuild that row's derived fields */
  function editRow(row, patch, dateOrder) {
    const r = Object.assign({}, row);
    if (patch.description != null) { r.description = String(patch.description).trim(); r.descNorm = normText(r.description); }
    if (patch.amount != null) { const a = parseMoney(patch.amount); if (a && a > 0) { r.amount = a; r.cents = Math.round(a * 100); r.amountText = String(patch.amount); } }
    if (patch.date != null) { const rec = findDates(String(patch.date))[0]; const d = rec ? resolveDate(rec, dateOrder || "dmy") : null; if (d) { r.date = d; r.dateText = String(patch.date); r.flags = (r.flags || []).filter(f => f !== "no date"); } }
    r.edited = true; r.confidence = Math.max(r.confidence, 0.85);
    return r;
  }

  /* ======================= orders ======================= */
  function parseFormData(raw) { return (Array.isArray(raw) ? raw : []).map(v => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch (e) { return null; } }).filter(Boolean); }
  function paymentFields(order) {
    const data = parseFormData(order.formData);
    const get = (types, labels) => (data.find(x => types.includes(String(x.type || "").toLowerCase()) || (labels || []).includes(String(x.label || "").toLowerCase())) || {}).value;
    return {
      name: String(get(["payment_account_name", "paymentaccountname"], ["name on payment", "account name used for payment"]) || "").trim(),
      date: String(get(["payment_date", "date_paid", "paymentdate"], ["date paid", "payment date"]) || "").trim()
    };
  }
  function customerName(order) {
    const f = parseFormData(order.formData).find(x => x.type !== "product" && x.type !== "additional_fee" && x.type !== "payment_account_name" && x.type !== "payment_date" && typeof x.value === "string" && x.value.trim());
    return f ? f.value : "Customer";
  }
  function prepareOrders(orders) {
    return orders.map(o => {
      const f = paymentFields(o); const total = parseMoney(o.totalAmount);
      const rec = findDates(f.date)[0]; const d = rec ? resolveDate(rec, "dmy") : null;     // customers pick dates in a date box: ISO, so normally unambiguous
      return { id: o.$id, order: o, name: f.name, customer: customerName(o), dateText: f.date, date: d, total, cents: total == null ? null : Math.round(total * 100), proof: o.paymentProof || "", ref: o.publicOrderID || "" };
    });
  }

  /* ======================= matching ======================= */
  const DEFAULTS = { dateTolerance: 2, margin: 15, minConfidence: 0.6 };
  const pairKey = (orderId, rowId) => orderId + "::" + rowId;
  function dateState(row, order, tol) {
    if (!row.date || !order.date) return { state: "unknown", diff: null, label: !row.date ? "The statement row has no readable date." : "The customer gave no date." };
    const diff = dayDiff(row.date.iso, order.date.iso);
    if (row.date.ambiguous) {
      const alt = dayDiff(row.date.altIso, order.date.iso);
      if (Math.min(diff, alt) <= tol) return { state: "ambiguous", diff: Math.min(diff, alt), label: `The statement date ${row.dateText} could be ${row.date.iso} or ${row.date.altIso}; it is not clear which.` };
      return { state: "far", diff, label: `The statement date is ${diff} days from the date the customer gave.` };
    }
    if (diff === 0) return { state: "exact", diff, label: "Same date." };
    if (diff <= tol) return { state: "near", diff, label: `The bank date is ${diff} day${diff === 1 ? "" : "s"} from the date the customer gave.` };
    return { state: "far", diff, label: `The bank date is ${diff} days from the date the customer gave.` };
  }
  function scorePair(row, order, opts) {
    const nm = nameMatch(order.name, row.description + " " + row.descText);
    const dt = dateState(row, order, opts.dateTolerance);
    const dateScore = dt.state === "exact" ? 25 : dt.state === "near" ? Math.max(5, 25 - 6 * dt.diff) : dt.state === "ambiguous" ? 10 : 0;
    const total = 30 + nm.score + dateScore;                           // 30 for the amount, which is required to be equal
    return { name: nm, date: dt, score: total, plausible: nm.score >= 15 || ["exact", "near", "ambiguous"].includes(dt.state) };
  }

  /* orders: prepareOrders() output (unpaid only). rows: extractRows().rows.
     opts: { dateTolerance, margin, minConfidence, verifiedKeys:Set, usedKeys:Set, rejected:Set(pairKey), forcedReview:Set(pairKey), manual:[{orderId,rowId}] } */
  function matchAll(rows, orders, optsIn) {
    const opts = Object.assign({}, DEFAULTS, optsIn || {});
    const verified = opts.verifiedKeys = opts.verifiedKeys || new Set(), used = opts.usedKeys = opts.usedKeys || new Set();
    const rejected = opts.rejected = opts.rejected || new Set(), forced = opts.forcedReview = opts.forcedReview || new Set();
    const rowById = new Map(rows.map(r => [r.id, r]));
    const free = rows.filter(r => !verified.has(r.key) && !used.has(r.key));
    const byCents = new Map(); free.forEach(r => { if (!byCents.has(r.cents)) byCents.set(r.cents, []); byCents.get(r.cents).push(r); });

    let pairs = [];
    orders.forEach(o => {
      if (o.cents == null) return;
      (byCents.get(o.cents) || []).forEach(r => {
        if (rejected.has(pairKey(o.id, r.id))) return;
        const s = scorePair(r, o, opts);
        if (s.plausible) pairs.push({ orderId: o.id, rowId: r.id, score: s.score, name: s.name, date: s.date, manual: false });
      });
    });
    (opts.manual || []).forEach(m => {
      const o = orders.find(x => x.id === m.orderId), r = rowById.get(m.rowId);
      if (!o || !r || used.has(r.key) || verified.has(r.key) || rejected.has(pairKey(o.id, r.id)) || pairs.some(p => p.orderId === o.id && p.rowId === r.id)) return;
      const s = scorePair(r, o, opts); pairs.push({ orderId: o.id, rowId: r.id, score: s.score, name: s.name, date: s.date, manual: true });
    });

    const byOrder = new Map(), byRow = new Map();
    pairs.forEach(p => { (byOrder.get(p.orderId) || byOrder.set(p.orderId, []).get(p.orderId)).push(p); (byRow.get(p.rowId) || byRow.set(p.rowId, []).get(p.rowId)).push(p); });
    pairs.forEach(p => {
      const row = rowById.get(p.rowId); const reasons = []; const problems = [];
      const rivalsRow = (byRow.get(p.rowId) || []).filter(q => q !== p && q.score >= p.score - opts.margin);
      const rivalsOrder = (byOrder.get(p.orderId) || []).filter(q => q !== p && q.score >= p.score - opts.margin);
      reasons.push("The credited amount equals the order total.");
      if (p.name.tier === "strong") reasons.push("The payment name matches the description."); else if (p.name.tier === "good") reasons.push("Most of the payment name appears in the description."); else if (p.name.tier === "single") reasons.push("The payment name appears in the description."); else if (p.name.tier === "weak") problems.push("Only part of the payment name appears in the description."); else problems.push("The payment name does not appear in the description.");
      if (p.date.state === "exact") reasons.push("The date is the same."); else problems.push(p.date.label);
      if (rivalsRow.length) problems.push(rivalsRow.length === 1 ? "Another order could also match this transaction." : `${rivalsRow.length} other orders could also match this transaction.`);
      if (rivalsOrder.length) problems.push(rivalsOrder.length === 1 ? "This order could also match another transaction." : `This order could also match ${rivalsOrder.length} other transactions.`);
      if (row.duplicateLooking) problems.push("The statement has another transaction that looks identical.");
      if (row.confidence < opts.minConfidence) problems.push("The transaction was not read clearly.");
      if (row.flags && row.flags.length) row.flags.forEach(f => { if (f !== "no date") problems.push("Reading note: " + f + "."); });
      if (p.manual) problems.push("You chose this order yourself.");
      if (forced.has(pairKey(p.orderId, p.rowId))) problems.push("You marked this for manual review.");
      const strongName = ["strong", "good", "single"].includes(p.name.tier);
      p.confident = strongName && p.date.state === "exact" && !rivalsRow.length && !rivalsOrder.length && !row.duplicateLooking && row.confidence >= opts.minConfidence && !p.manual && !forced.has(pairKey(p.orderId, p.rowId));
      p.status = p.confident ? "confident" : "review";
      p.reasons = reasons; p.problems = problems;
      p.rivals = { rows: rivalsOrder.map(q => q.rowId), orders: rivalsRow.map(q => q.orderId) };
    });
    // one transaction can confirm one order only: if the same row or order sits in two confident pairs, both fall back to review
    {
      const rowUse = new Map(), ordUse = new Map();
      pairs.filter(p => p.status === "confident").forEach(p => { rowUse.set(p.rowId, (rowUse.get(p.rowId) || 0) + 1); ordUse.set(p.orderId, (ordUse.get(p.orderId) || 0) + 1); });
      pairs.forEach(p => { if (p.status === "confident" && (rowUse.get(p.rowId) > 1 || ordUse.get(p.orderId) > 1)) { p.status = "review"; p.confident = false; p.problems.push("Two possible matches overlap."); } });
    }
    // a transaction already confidently matched to one order is not also offered to others, and a confidently matched order needs no other candidates
    {
      const takenRows = new Set(pairs.filter(p => p.status === "confident").map(p => p.rowId)), takenOrders = new Set(pairs.filter(p => p.status === "confident").map(p => p.orderId));
      pairs = pairs.filter(p => p.status === "confident" || (!takenRows.has(p.rowId) && !takenOrders.has(p.orderId)));
      byOrder.clear(); byRow.clear();
      pairs.forEach(p => { (byOrder.get(p.orderId) || byOrder.set(p.orderId, []).get(p.orderId)).push(p); (byRow.get(p.rowId) || byRow.set(p.rowId, []).get(p.rowId)).push(p); });
    }
    pairs.sort((a, b) => b.score - a.score);

    const rowStatus = new Map(), orderStatus = new Map();
    rows.forEach(r => {
      if (verified.has(r.key)) return rowStatus.set(r.id, { status: "used", reason: "This transaction was already used to verify an order.", pairs: [] });
      if (used.has(r.key)) return rowStatus.set(r.id, { status: "used", reason: "You verified this transaction in this session.", pairs: [] });
      const ps = (byRow.get(r.id) || []).slice().sort((a, b) => b.score - a.score);
      rowStatus.set(r.id, { status: ps.length ? (ps.some(p => p.status === "confident") ? "confident" : "review") : "unmatched", pairs: ps, best: ps[0] || null });
    });
    orders.forEach(o => {
      const ps = (byOrder.get(o.id) || []).slice().sort((a, b) => b.score - a.score);
      orderStatus.set(o.id, { status: ps.length ? (ps.some(p => p.status === "confident") ? "confident" : "review") : "unmatched", pairs: ps, best: ps[0] || null });
    });

    const confidentPairs = pairs.filter(p => p.status === "confident");
    const confOrders = new Set(confidentPairs.map(p => p.orderId)), confRows = new Set(confidentPairs.map(p => p.rowId));
    [rowStatus, orderStatus].forEach(map => map.forEach((v, id) => { if (v.status !== "used") { const ps = v.pairs; v.status = ps.length ? (ps.some(p => p.status === "confident") ? "confident" : "review") : "unmatched"; v.best = ps[0] || null; } }));
    const reviewOrders = orders.filter(o => orderStatus.get(o.id).status === "review");
    const unmatchedOrders = orders.filter(o => orderStatus.get(o.id).status === "unmatched");
    const unusedRows = free.filter(r => rowStatus.get(r.id).status === "unmatched");
    return {
      pairs, confidentPairs, rowStatus, orderStatus, opts,
      summary: {
        ordersChecked: orders.length, transactions: rows.length, alreadyUsedTransactions: rows.length - free.length,
        confident: confidentPairs.length, review: reviewOrders.length, unmatchedOrders: unmatchedOrders.length, unusedTransactions: unusedRows.length,
        reviewRows: rows.filter(r => rowStatus.get(r.id).status === "review").length
      }
    };
  }

  /* what "Verify all" may touch: confident, one-to-one pairs only */
  function verifyAllPlan(match) {
    return match.confidentPairs.filter(p => !match.opts.rejected.has(pairKey(p.orderId, p.rowId)));
  }

  return {
    normText, nameTokens, descTokens, tokenMatches, nameMatch, parseMoney, findAmounts, findDates, detectDateOrder, resolveDate, dayDiff,
    sanitizeLayout, DEFAULT_LAYOUTS, REGION_KEYS, MIN_REGION, guessLayout, checkExtractable, MIN_WORDS, MIN_FIGURES, extractRows, editRow, finalizeRows,
    parseFormData, paymentFields, customerName, prepareOrders, DEFAULTS, pairKey, scorePair, matchAll, verifyAllPlan
  };
});
