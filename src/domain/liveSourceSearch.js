import { compactWhitespace } from "./textUtils.js";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const SEARCH_TIMEOUT_MS = 12000;
const VERIFY_TIMEOUT_MS = 6000;
const VERIFY_CONCURRENCY = 5;

const PLATFORM_RULES = [
  { pattern: /nowcoder\.com/i, platform: "牛客" },
  { pattern: /zhihu\.com/i, platform: "知乎" },
  { pattern: /csdn\.net/i, platform: "CSDN" },
  { pattern: /maimai\.cn/i, platform: "脉脉" },
  { pattern: /xiaohongshu\.com/i, platform: "小红书" },
  { pattern: /bilibili\.com/i, platform: "B站" },
  { pattern: /36kr\.com/i, platform: "36氪" },
  { pattern: /huxiu\.com/i, platform: "虎嗅" },
  { pattern: /wenku\.baidu\.com/i, platform: "百度文库" },
  { pattern: /zhipin\.com/i, platform: "Boss直聘" },
  { pattern: /jianshu\.com/i, platform: "简书" },
  { pattern: /sohu\.com/i, platform: "搜狐" },
  { pattern: /163\.com/i, platform: "网易" },
  { pattern: /qq\.com/i, platform: "腾讯" },
  { pattern: /sina\.com/i, platform: "新浪" },
  { pattern: /offershow|kanzhun|职级对标/i, platform: "职场社区" },
];

/**
 * 实时网页搜索（双引擎容灾：百度优先，触发风控验证码时自动切 360 搜索）。
 * 解析结果标题、摘要、发布时间，并还原成最终真实 URL。
 * 返回的每一条都来自搜索引擎实时索引，不做任何模板拼造。
 */
export async function searchWebSources(query, options = {}) {
  const limit = Number(options.limit || 8);
  const timeoutMs = Number(options.timeoutMs || SEARCH_TIMEOUT_MS);

  let lastError = null;
  for (const engine of [searchBaidu, searchSo360]) {
    try {
      const items = await engine(query, { limit, timeoutMs });
      if (items.length) return items;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return [];
}

async function searchBaidu(query, { limit, timeoutMs }) {
  const searchUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${Math.min(20, limit * 2)}`;
  const response = await fetchWithTimeout(searchUrl, {
    timeoutMs,
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "zh-CN,zh;q=0.9" },
  });
  if (!response.ok) throw new Error(`Baidu search failed with status ${response.status}`);
  const cookie = readSetCookies(response);
  const html = await response.text();
  if (html.includes("安全验证") || html.includes("wappass.baidu.com")) {
    throw new Error("Baidu search is captcha-locked");
  }

  const candidates = [];
  const chunks = html.split(/<h3[^>]*>/).slice(1);
  for (const chunk of chunks) {
    const linkMatch = chunk.match(/^[\s\S]{0,240}?<a[^>]*href="(https?:\/\/www\.baidu\.com\/link\?url=[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;
    const title = stripTags(linkMatch[2]);
    if (!title) continue;
    const tail = stripTags(chunk.slice(linkMatch[0].length, linkMatch[0].length + 2600));
    candidates.push({
      redirect: linkMatch[1],
      title,
      snippet: cleanSnippet(tail),
      published_at: extractDate(tail),
    });
    if (candidates.length >= limit * 2) break;
  }

  const resolved = await mapWithLimit(candidates, VERIFY_CONCURRENCY, async (item) => {
    const url = await resolveBaiduRedirect(item.redirect, { cookie, referer: searchUrl });
    if (!url) return null;
    return {
      title: item.title,
      url,
      platform: detectPlatform(url),
      snippet: item.snippet,
      published_at: item.published_at,
    };
  });

  return dedupeByUrl(resolved, limit);
}

async function searchSo360(query, { limit, timeoutMs }) {
  const searchUrl = `https://www.so.com/s?q=${encodeURIComponent(query)}`;
  const response = await fetchWithTimeout(searchUrl, {
    timeoutMs,
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "zh-CN,zh;q=0.9" },
  });
  if (!response.ok) throw new Error(`360 search failed with status ${response.status}`);
  const html = await response.text();

  const items = [];
  const chunks = html.split(/<h3[^>]*>/).slice(1);
  for (const chunk of chunks) {
    const head = chunk.slice(0, 900);
    const linkMatch = head.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;
    const title = stripTags(linkMatch[2]);
    if (!title) continue;
    // 360 在 data-mdurl/data-url 中直接暴露真实目标地址；无该属性的是站内聊合入口，丢弃。
    const realMatch = head.match(/data-mdurl="(https?:\/\/[^"]+)"/) || head.match(/data-url="(https?:\/\/[^"]+)"/);
    const url = realMatch ? realMatch[1] : /^https?:\/\//.test(linkMatch[1]) && !/so\.com|360\.cn/.test(linkMatch[1]) ? linkMatch[1] : null;
    if (!url) continue;
    const tail = stripTags(chunk.slice(linkMatch.index + linkMatch[0].length, linkMatch.index + linkMatch[0].length + 2600));
    items.push({
      title,
      url,
      platform: detectPlatform(url),
      snippet: cleanSnippet(tail),
      published_at: extractDate(tail),
    });
    if (items.length >= limit * 2) break;
  }

  return dedupeByUrl(items, limit);
}

function dedupeByUrl(items, limit) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    if (!item || seen.has(item.url)) continue;
    seen.add(item.url);
    output.push(item);
    if (output.length >= limit) break;
  }
  return output;
}

/**
 * 链接存活校验：只有确定性死链（404/410/域名不存在）判为不可用；
 * 反爬 403/429、超时等无法证伪的情况保留（URL 本身来自实时搜索索引）。
 */
export async function verifyUrl(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs || VERIFY_TIMEOUT_MS);
  try {
    const response = await fetchWithTimeout(url, {
      timeoutMs,
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "zh-CN,zh;q=0.9" },
    });
    return response.status !== 404 && response.status !== 410;
  } catch (error) {
    const code = error?.cause?.code || error?.code || "";
    if (code === "ENOTFOUND" || code === "ERR_INVALID_URL") return false;
    return true;
  }
}

export async function verifyUrls(items, options = {}) {
  const getUrl = options.getUrl || ((item) => item.url);
  const flags = await mapWithLimit(items, VERIFY_CONCURRENCY, (item) => verifyUrl(getUrl(item), options));
  const passed = [];
  const dropped = [];
  items.forEach((item, index) => {
    if (flags[index]) passed.push(item);
    else dropped.push(item);
  });
  return { passed, dropped };
}

export function detectPlatform(url) {
  for (const rule of PLATFORM_RULES) {
    if (rule.pattern.test(url)) return rule.platform;
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "网页";
  }
}

async function resolveBaiduRedirect(redirectUrl, { cookie, referer }) {
  try {
    const response = await fetchWithTimeout(redirectUrl, {
      timeoutMs: VERIFY_TIMEOUT_MS,
      redirect: "manual",
      headers: { "User-Agent": BROWSER_UA, Referer: referer, Cookie: cookie },
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location && /^https?:\/\//.test(location)) {
      return location;
    }
    return null;
  } catch {
    return null;
  }
}

function readSetCookies(response) {
  const raw = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  return raw.map((item) => item.split(";")[0]).join("; ");
}

function stripTags(value) {
  return compactWhitespace(
    String(value || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&(?:amp|#38);/g, "&")
      .replace(/&(?:nbsp|#160|ensp|emsp);/g, " ")
      .replace(/&(?:#0?183|middot);/g, "·")
      .replace(/&(?:quot|#34);/g, '"')
      .replace(/&(?:lt|#60);/g, "<")
      .replace(/&(?:gt|#62);/g, ">"),
  );
}

function cleanSnippet(text) {
  const cleaned = compactWhitespace(
    String(text || "")
      .replace(/^\s*(?:\d{4}年\d{1,2}月\d{1,2}日|\d{4}-\d{1,2}-\d{1,2})\s*·?\s*/, "")
      .replace(/播报|暂停|百度快照|广告/g, " "),
  );
  return cleaned.length > 140 ? `${cleaned.slice(0, 139)}…` : cleaned;
}

function extractDate(text) {
  const cn = String(text || "").match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const iso = String(text || "").match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  const parts = cn || iso;
  if (!parts) return null;
  const date = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])));
  if (Number.isNaN(date.getTime()) || date.getTime() > Date.now()) return null;
  return date.toISOString();
}

async function fetchWithTimeout(url, { timeoutMs, headers, redirect } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || SEARCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, redirect: redirect || "follow", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index).catch(() => null);
    }
  });
  await Promise.all(workers);
  return results;
}
