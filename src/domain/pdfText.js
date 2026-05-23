let pdfjsLibPromise = null;

export async function extractPdfText(buffer) {
  const warnings = [];
  const pdfjsLib = await loadPdfjs(warnings);
  if (!pdfjsLib) {
    return {
      text: "",
      warnings,
      isImagePdf: looksLikeImagePdf(buffer),
    };
  }

  const pdf = await loadPdfDocument(pdfjsLib, buffer, warnings);
  if (!pdf) {
    return {
      text: "",
      warnings,
      isImagePdf: looksLikeImagePdf(buffer),
    };
  }

  const pageTexts = [];
  let emptyPageCount = 0;

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    try {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent({
        disableNormalization: false,
        includeMarkedContent: true,
      });
      const pageText = normalizeTextContent(content.items);

      if (pageText) pageTexts.push(pageText);
      else emptyPageCount += 1;
    } catch (error) {
      warnings.push(`第 ${pageNumber} 页提取失败：${error.message}`);
    }
  }

  const text = pageTexts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  const isImagePdf = !text && (emptyPageCount > 0 || looksLikeImagePdf(buffer));

  if (!text) {
    warnings.push(
      isImagePdf
        ? "检测到图片型 / 扫描件 PDF，需要 OCR 识别才能提取文字。"
        : "未从 PDF 中抽取到可解析文本，请检查文件是否损坏或是否受保护。",
    );
  }

  return { text, warnings: [...new Set(warnings)], isImagePdf };
}

export async function extractPdfTextWithOcr(buffer, options = {}) {
  const { ocrPdfBuffer } = await import("./ocrAdapter.js");
  return ocrPdfBuffer(toBuffer(buffer), options);
}

async function loadPdfjs(warnings) {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import("pdfjs-dist/legacy/build/pdf.mjs")
      .catch(() => import("pdfjs-dist/legacy/build/pdf.js"))
      .then((pdfjsLib) => {
        if (pdfjsLib.GlobalWorkerOptions) pdfjsLib.GlobalWorkerOptions.workerSrc = resolvePdfWorkerSrc();
        return pdfjsLib;
      })
      .catch((error) => {
        error.statusCode = 501;
        throw error;
      });
  }

  try {
    return await pdfjsLibPromise;
  } catch {
    pdfjsLibPromise = null;
    warnings.push("缺少 PDF.js 依赖 pdfjs-dist，请运行：npm install pdfjs-dist。");
    return null;
  }
}

function resolvePdfWorkerSrc() {
  try {
    return import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  } catch {
    return new URL("../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).href;
  }
}

async function loadPdfDocument(pdfjsLib, buffer, warnings) {
  try {
    return await pdfjsLib.getDocument({
      data: toUint8Array(buffer),
      disableFontFace: true,
      disableWorker: true,
      useSystemFonts: true,
      verbosity: 0,
    }).promise;
  } catch (error) {
    warnings.push(`PDF 加载失败：${error.message}`);
    return null;
  }
}

function normalizeTextContent(items) {
  const lines = [];
  let currentLine = "";
  let previousY = null;

  for (const item of items) {
    if (!item || typeof item.str !== "string") continue;
    const value = item.str.replace(/\s+/g, " ").trim();
    if (!value) continue;

    const y = Array.isArray(item.transform) ? Math.round(item.transform[5]) : null;
    if (previousY !== null && y !== null && Math.abs(y - previousY) > 4 && currentLine.trim()) {
      lines.push(currentLine.trim());
      currentLine = "";
    }

    currentLine += needsSpace(currentLine, value) ? ` ${value}` : value;
    if (y !== null) previousY = y;
  }

  if (currentLine.trim()) lines.push(currentLine.trim());
  return lines.join("\n").trim();
}

function needsSpace(left, right) {
  if (!left) return false;
  const last = left.at(-1);
  const first = right.at(0);
  return /[A-Za-z0-9)]/.test(last) && /[A-Za-z0-9(]/.test(first);
}

function looksLikeImagePdf(buffer) {
  const raw = toBuffer(buffer).toString("latin1");
  const imageMarkers = (raw.match(/\/Subtype\s*\/Image|\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode|\/JBIG2Decode/gi) || []).length;
  const textMarkers = (raw.match(/\bT[Jj]\b|\/ActualText|\/ToUnicode|\/AcroForm/gi) || []).length;
  return imageMarkers > 0 && textMarkers === 0;
}

function toUint8Array(value) {
  const buffer = toBuffer(value);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(value);
}
