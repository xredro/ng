// Test helper: read a PDF with the local pdfjs-dist and return pages in the engine's format { pageNo, width, height, items:[{text,x,y,w,h}] }.
import fs from "node:fs";
const PDFJS = "/opt/npm-tools/node_modules/pdfjs-dist/legacy/build/pdf.mjs";
export async function readPdf(file) {
  const pdfjs = await import(PDFJS);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: false, verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n); const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    pages.push({ pageNo: n, width: vp.width, height: vp.height, items: tc.items.filter(i => String(i.str).trim()).map(i => ({ text: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: Math.abs(i.transform[3]) || i.height })) });
  }
  return pages;
}
