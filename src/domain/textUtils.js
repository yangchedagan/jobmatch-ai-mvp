import crypto from "node:crypto";

export function createId(prefix) {
  const random = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
  return `${prefix}_${random.slice(0, 8)}${Date.now().toString(36).slice(-4)}`;
}

export function compactWhitespace(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitLines(text) {
  return compactWhitespace(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function unique(values) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const normalized = normalizeToken(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(String(value).trim());
  }
  return output;
}

export function normalizeToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[·•,，。；;:：/\\|()[\]{}<>【】"'“”‘’`~!！?？]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function containsAlias(text, alias) {
  const normalizedText = ` ${normalizeToken(text)} `;
  const normalizedAlias = normalizeToken(alias);
  if (!normalizedAlias) return false;
  if (/^[a-z0-9.+#\-\s]+$/i.test(normalizedAlias)) {
    const escaped = normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(normalizedText);
  }
  return normalizedText.includes(normalizedAlias);
}

export function extractKeywordLabels(text, dictionary) {
  const output = [];
  for (const item of dictionary) {
    if ([item.label, ...(item.aliases || [])].some((alias) => containsAlias(text, alias))) {
      output.push(item.label.trim());
    }
  }
  return unique(output);
}

export function findEmails(text) {
  return unique(String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []);
}

export function findPhones(text) {
  return unique(
    String(text || "").match(/(?:\+?86[- ]?)?(?:1[3-9]\d{9}|\d{3,4}[- ]?\d{7,8})/g) || [],
  );
}

export function parseYearCount(text) {
  const values = [];
  const patterns = [
    /(\d+(?:\.\d+)?)\s*(?:年|years?)\s*(?:以上)?(?:工作|开发|产品|运营|数据)?经验/gi,
    /经验\s*(\d+(?:\.\d+)?)\s*(?:年|years?)/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) values.push(Number(match[1]));
  }
  if (values.length) return Math.max(...values);

  const ranges = [...String(text || "").matchAll(/(20\d{2}|19\d{2})[./年-]\s*(?:(20\d{2}|19\d{2})|至今|现在|present)/gi)];
  const currentYear = new Date().getFullYear();
  let total = 0;
  for (const range of ranges) {
    const start = Number(range[1]);
    const end = /至今|现在|present/i.test(range[2] || "") ? currentYear : Number(range[2]);
    if (start && end && end >= start) total += Math.min(10, end - start);
  }
  return Math.round(total * 10) / 10;
}

export function highestDegreeRank(text, rankMap) {
  let best = 0;
  let label = "";
  for (const [degree, rank] of Object.entries(rankMap)) {
    if (String(text || "").includes(degree) && rank > best) {
      best = rank;
      label = degree;
    }
  }
  if (/bachelor/i.test(text) && best < 3) return { label: "本科", rank: 3 };
  if (/master/i.test(text) && best < 4) return { label: "硕士", rank: 4 };
  if (/phd|doctor/i.test(text) && best < 5) return { label: "博士", rank: 5 };
  return { label, rank: best };
}

