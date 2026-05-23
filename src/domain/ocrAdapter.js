export async function ocrImageBuffer(imageBuffer, options = {}) {
  const { lang = "chi_sim+eng" } = options;
  const { text, warnings } = await runTesseract(imageBuffer, lang);
  return { text, warnings };
}

export async function ocrPdfBuffer(pdfBuffer, options = {}) {
  const { lang = "chi_sim+eng", scale = 2.0, onProgress } = options;
  const pdfjs = await loadPdfjs();
  const { createCanvas } = await loadCanvas();
  const warnings = [];
  const pageTexts = [];

  const uint8 = new Uint8Array(pdfBuffer.buffer, pdfBuffer.byteOffset, pdfBuffer.byteLength);
  const loadingTask = pdfjs.getDocument({ data: uint8, disableWorker: true });
  const pdf = await loadingTask.promise;

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    if (onProgress) onProgress(pageNumber, pdf.numPages);

    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");

    await page.render({ canvasContext: context, viewport }).promise;

    const { text, warnings: pageWarnings } = await runTesseract(canvas.toBuffer("image/png"), lang);
    warnings.push(...pageWarnings);
    if (text.trim()) pageTexts.push(text.trim());
  }

  const text = pageTexts.join("\n\n").trim();
  if (!text) warnings.push("OCR 未识别到有效文字，请检查图片清晰度（建议 >= 150 DPI）。");
  else warnings.push(`OCR 已完成，共识别 ${pdf.numPages} 页。`);

  return { text, warnings: [...new Set(warnings)] };
}

async function runTesseract(imageSource, lang) {
  const Tesseract = await loadTesseract();
  let worker;

  try {
    worker = await Tesseract.createWorker(lang);
  } catch {
    worker = await Tesseract.createWorker();
    await worker.loadLanguage(lang);
    await worker.initialize(lang);
  }

  try {
    const result = await worker.recognize(imageSource);
    const text = result?.data?.text || "";
    const warnings = text.trim() ? [] : ["该页 OCR 未识别到文字，可能是空白页或图片质量过低。"];
    return { text, warnings };
  } finally {
    await worker.terminate().catch(() => {});
  }
}

async function loadTesseract() {
  try {
    return await import("tesseract.js");
  } catch {
    throw makeDepError("tesseract.js", "图片 OCR 识别", "npm install tesseract.js");
  }
}

async function loadPdfjs() {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    if (pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = "";
    return pdfjs;
  } catch {
    try {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.js");
      if (pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = "";
      return pdfjs;
    } catch {
      throw makeDepError("pdfjs-dist", "PDF 页面渲染", "npm install pdfjs-dist");
    }
  }
}

async function loadCanvas() {
  try {
    return await import("canvas");
  } catch {
    throw makeDepError("canvas", "PDF 渲染为图片", "npm install canvas");
  }
}

function makeDepError(pkg, feature, installCmd) {
  const error = new Error(`OCR 功能（${feature}）需要安装 ${pkg}：${installCmd}`);
  error.statusCode = 501;
  error.payload = {
    error: "OCR_DEPENDENCY_MISSING",
    message: `服务端缺少 OCR 依赖 "${pkg}"，请先安装后重试。`,
    install: installCmd,
  };
  return error;
}
