// Run from project root: node tools/test-no-ocr.mjs
// Guards the "text-based PDFs only, no OCR, no fallback" rule: no OCR library, service or image-to-text code anywhere in the shipped files,
// and the unsupported-statement notice and refusal are present.
import fs from "node:fs"; import path from "node:path";
let failed = 0; const a = (c, m) => { if (!c) failed++; console.log(c ? "ok  " : "FAIL", m); };
const files = []; (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { if (["node_modules", ".git", "docs", "tools", "assets"].includes(f.name)) continue; const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(js|mjs|html|css|toml|json)$/.test(f.name)) files.push(p); } })(".");
const code = f => fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");   // comments may explain the rule; code may not break it
const BAD = [/tesseract/i, /\bcreateWorker\b/, /\.recognize\s*\(/, /textract/i, /vision\.googleapis/i, /cloudvision/i, /ocr\.space/i, /\bocr[A-Z_a-z]*\s*[(:=]/i, /renderForOcr|XrVerifyOcr/];
const hits = []; files.forEach(f => { const c = code(f); BAD.forEach(r => { const m = r.exec(c); if (m) hits.push(`${f}: ${m[0]}`); }); });
a(hits.length === 0, "no OCR library, service or call in any shipped file" + (hits.length ? ": " + hits.join("; ") : ""));
a(!fs.existsSync("js/verify-ocr.js"), "the OCR module is gone");
const ui = fs.readFileSync("js/paymentVerify.js", "utf8");
a(ui.includes("Only text-based PDF bank statements are supported. Your statement must contain selectable, extractable text. Scanned documents, photographs saved as PDFs and image-only PDFs are not supported."), "the exact unsupported-documents notice is in the upload screen");
a(/checkExtractable/.test(ui) && /rejectUnsupported/.test(ui), "a PDF without extractable text is refused before any processing");
a(!/getImageData|toDataURL|toBlob|createImageBitmap/.test(fs.readFileSync("js/verify-viewer.js", "utf8") + fs.readFileSync("js/verify-engine.js", "utf8") + ui), "no page is converted to an image for reading");
const orders = fs.readFileSync("orders.html", "utf8"); a(!/tesseract/i.test(orders) && /pdf\.min\.js/.test(orders), "Orders page loads PDF.js and no OCR library");
console.log(failed ? `\n${failed} FAILED` : "\nall passed"); process.exit(failed ? 1 : 0);
