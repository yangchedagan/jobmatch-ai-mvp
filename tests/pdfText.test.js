import test from "node:test";
import assert from "node:assert/strict";

import { extractPdfText } from "../src/domain/pdfText.js";

const hasPdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  .then(() => true)
  .catch(() => false);

test("extractPdfText extracts text through PDF.js when dependency is installed", { skip: !hasPdfjs }, async () => {
  const result = await extractPdfText(createSimplePdf("Product Manager Resume"));

  assert.match(result.text, /Product Manager Resume/);
  assert.equal(result.isImagePdf, false);
});

test("extractPdfText returns a clear warning when PDF.js is missing", { skip: hasPdfjs }, async () => {
  const result = await extractPdfText(createSimplePdf("Product Manager Resume"));

  assert.equal(result.text, "");
  assert.ok(result.warnings.some((warning) => warning.includes("pdfjs-dist")));
});

test("extractPdfText detects image-only pdf without PDF.js", async () => {
  const result = await extractPdfText(createImageOnlyPdf());

  if (hasPdfjs) {
    assert.equal(result.text, "");
  }
  assert.equal(result.isImagePdf, true);
  assert.ok(result.warnings.some((warning) => warning.includes("图片型") || warning.includes("OCR") || warning.includes("pdfjs-dist")));
});

function createSimplePdf(text) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream(`BT /F1 24 Tf 72 720 Td (${escapePdfString(text)}) Tj ET`),
  ];
  return buildPdf(objects);
}

function createImageOnlyPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length 4 >>\nstream\nfake\nendstream",
    stream("q 10 0 0 10 72 720 cm /Im1 Do Q"),
  ];
  return buildPdf(objects);
}

function buildPdf(objectBodies) {
  const chunks = ["%PDF-1.7\n"];
  const offsets = [0];

  objectBodies.forEach((body, index) => {
    offsets.push(Buffer.byteLength(chunks.join(""), "latin1"));
    chunks.push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });

  const xrefOffset = Buffer.byteLength(chunks.join(""), "latin1");
  chunks.push(`xref\n0 ${objectBodies.length + 1}\n`);
  chunks.push("0000000000 65535 f \n");
  for (let index = 1; index < offsets.length; index += 1) {
    chunks.push(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`);
  }
  chunks.push(`trailer\n<< /Size ${objectBodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  return Buffer.from(chunks.join(""), "latin1");
}

function stream(content) {
  return `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
}

function escapePdfString(value) {
  return value.replace(/[\\()]/g, "\\$&");
}
