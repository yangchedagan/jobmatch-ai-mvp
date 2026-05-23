import { HARD_SKILLS, SOFT_SKILLS } from "./taxonomy.js";
import { createId, extractKeywordLabels, unique } from "./textUtils.js";

const DEFAULT_USER_AGENT = "JobMatchAI-MVP-Crawler/0.2 (+local MVP; respects robots.txt)";
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MIN_INTERVAL_MS = 3000;
const ROLE_HINTS = [
  {
    title: "产品经理",
    category: "产品",
    role_family: "product_manager",
    skills: ["产品设计", "需求分析", "用户研究", "数据分析", "PRD", "项目管理"],
  },
  {
    title: "后端开发工程师",
    category: "技术",
    role_family: "technology",
    skills: ["Java", "Go", "MySQL", "Redis", "微服务", "分布式系统"],
  },
  {
    title: "前端开发工程师",
    category: "技术",
    role_family: "technology",
    skills: ["JavaScript", "TypeScript", "React", "Vue", "Node.js", "性能优化"],
  },
  {
    title: "算法工程师",
    category: "技术",
    role_family: "technology",
    skills: ["Python", "机器学习", "深度学习", "算法", "数据结构"],
  },
  {
    title: "数据分析师",
    category: "数据",
    role_family: "technology",
    skills: ["SQL", "Python", "数据分析", "指标体系", "BI"],
  },
  {
    title: "数据开发工程师",
    category: "数据",
    role_family: "technology",
    skills: ["SQL", "Python", "Hive", "Spark", "Flink"],
  },
  {
    title: "运营",
    category: "运营",
    role_family: "operations",
    skills: ["用户增长", "运营策略", "活动运营", "内容运营", "数据分析"],
  },
];

export async function crawlOfficialSources(sources, options = {}) {
  const limitSources = Number(options.limitSources || options.limit_sources || 6);
  const maxPagesPerSource = Number(options.maxPagesPerSource || options.max_pages_per_source || 2);
  const minIntervalMs = Number(options.minIntervalMs || options.min_interval_ms || DEFAULT_MIN_INTERVAL_MS);
  const timeoutMs = Number(options.timeoutMs || options.timeout_ms || DEFAULT_TIMEOUT_MS);
  const userAgent = options.userAgent || DEFAULT_USER_AGENT;
  const startedAt = Date.now();
  const state = {
    lastFetchAtByOrigin: new Map(),
    robotsByOrigin: new Map(),
  };
  const jobs = [];
  const sourceReports = [];

  for (const source of sources.slice(0, limitSources)) {
    const urls = unique([...(source.list_urls || []), source.official_url]).slice(0, maxPagesPerSource);
    const report = {
      source: source.key || source.company,
      company: source.company,
      pages_checked: 0,
      pages_fetched: 0,
      robots_blocked: 0,
      candidates_found: 0,
      errors: [],
    };

    for (const pageUrl of urls) {
      report.pages_checked += 1;
      try {
        const allowed = await isAllowedByRobots(pageUrl, userAgent, state, timeoutMs);
        if (!allowed) {
          report.robots_blocked += 1;
          continue;
        }
        await waitForOrigin(pageUrl, state, minIntervalMs);
        const html = await fetchText(pageUrl, { timeoutMs, userAgent });
        report.pages_fetched += 1;
        const extracted = extractJobsFromHtml(html, source, pageUrl);
        report.candidates_found += extracted.length;
        jobs.push(...extracted);
      } catch (error) {
        report.errors.push({ url: pageUrl, message: error.message });
      }
    }

    sourceReports.push(report);
  }

  return {
    jobs: dedupeJobs(jobs),
    summary: {
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      sources_requested: Math.min(limitSources, sources.length),
      sources_checked: sourceReports.length,
      pages_checked: sourceReports.reduce((sum, item) => sum + item.pages_checked, 0),
      pages_fetched: sourceReports.reduce((sum, item) => sum + item.pages_fetched, 0),
      robots_blocked: sourceReports.reduce((sum, item) => sum + item.robots_blocked, 0),
      candidates_found: jobs.length,
      jobs_after_dedupe: dedupeJobs(jobs).length,
      source_reports: sourceReports,
    },
  };
}

export function extractJobsFromHtml(html, source, pageUrl) {
  const text = decodeHtml(stripHtml(html)).replace(/\s+/g, " ").trim();
  const recruitmentType = inferRecruitmentType(`${pageUrl} ${text}`, source.channels || []);
  const jobs = [];

  for (const hint of ROLE_HINTS) {
    if (!text.includes(hint.title)) continue;
    const context = sliceAround(text, hint.title, 260);
    const hardSkills = unique([...hint.skills, ...extractKeywordLabels(context, HARD_SKILLS)]);
    const softSkills = extractKeywordLabels(context, SOFT_SKILLS);
    jobs.push({
      id: `crawl_${source.key || createId("source")}_${slugify(hint.title)}_${slugify(recruitmentType)}`,
      job_title: withRecruitmentSuffix(hint.title, recruitmentType),
      company: source.company,
      department: guessDepartment(hint, source),
      location: source.locations || [],
      job_level: recruitmentType === "校招" ? "校招" : recruitmentType === "实习" ? "实习" : "社招",
      category: hint.category,
      role_family: hint.role_family,
      recruitment_type: recruitmentType,
      hard_skills: hardSkills,
      experience_required: recruitmentType === "社招" ? "2 年以上相关经验" : recruitmentType === "实习" ? "在校生，可实习 3 个月以上" : "不限，面向应届毕业生",
      education_required: "本科及以上",
      soft_skills: softSkills.length ? softSkills : ["学习能力", "沟通能力"],
      publish_date: new Date().toISOString().slice(0, 10),
      source_url: pageUrl,
      source_channel: "live-crawl",
      jd_raw_text: context || text.slice(0, 500),
    });
  }

  return jobs;
}

export function parseRobotsTxt(robotsText, targetUserAgent = DEFAULT_USER_AGENT) {
  const groups = [];
  let current = null;

  for (const rawLine of String(robotsText || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();

    if (key === "user-agent") {
      current = { agents: [value.toLowerCase()], rules: [] };
      groups.push(current);
    } else if ((key === "allow" || key === "disallow") && current) {
      current.rules.push({ type: key, path: value });
    }
  }

  const agent = targetUserAgent.toLowerCase();
  const matchingGroups = groups.filter((group) => group.agents.some((item) => item === "*" || agent.includes(item)));
  return matchingGroups.flatMap((group) => group.rules);
}

export function isPathAllowed(pathname, rules) {
  let winner = null;
  for (const rule of rules || []) {
    if (!rule.path) {
      if (rule.type === "disallow") continue;
      if (rule.type === "allow") winner = chooseWinner(winner, rule);
      continue;
    }
    if (!pathname.startsWith(rule.path)) continue;
    winner = chooseWinner(winner, rule);
  }
  return winner?.type !== "disallow";
}

async function isAllowedByRobots(pageUrl, userAgent, state, timeoutMs) {
  const url = new URL(pageUrl);
  const origin = url.origin;
  if (!state.robotsByOrigin.has(origin)) {
    try {
      const robotsText = await fetchText(`${origin}/robots.txt`, { timeoutMs, userAgent, tolerate404: true });
      state.robotsByOrigin.set(origin, parseRobotsTxt(robotsText, userAgent));
    } catch {
      state.robotsByOrigin.set(origin, []);
    }
  }
  return isPathAllowed(url.pathname || "/", state.robotsByOrigin.get(origin));
}

async function waitForOrigin(pageUrl, state, minIntervalMs) {
  const origin = new URL(pageUrl).origin;
  const lastFetchAt = state.lastFetchAtByOrigin.get(origin) || 0;
  const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastFetchAt));
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  state.lastFetchAtByOrigin.set(origin, Date.now());
}

async function fetchText(url, { timeoutMs, userAgent, tolerate404 = false }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      },
    });
    if (!response.ok && !(tolerate404 && response.status === 404)) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function dedupeJobs(jobs) {
  const byKey = new Map();
  for (const job of jobs) {
    const key = [job.company, job.job_title, job.recruitment_type].join("|");
    if (!byKey.has(key)) byKey.set(key, job);
  }
  return [...byKey.values()];
}

function inferRecruitmentType(text, channels) {
  if (/intern|实习|日常实习/i.test(text) && (!channels.length || channels.includes("实习"))) return "实习";
  if (/campus|校招|校园招聘|应届|毕业生/i.test(text) && (!channels.length || channels.includes("校招"))) return "校招";
  if (channels.includes("校招") && !channels.includes("社招")) return "校招";
  return "社招";
}

function withRecruitmentSuffix(title, recruitmentType) {
  if (recruitmentType === "校招" && !title.includes("校招生")) return `${title}校招生`;
  if (recruitmentType === "实习" && !title.includes("实习")) return `${title}实习生`;
  return title;
}

function guessDepartment(hint, source) {
  const focus = source.focus || source.company;
  if (hint.category === "产品") return `${focus}产品部`;
  if (hint.category === "运营") return `${focus}运营部`;
  if (hint.category === "数据") return `${focus}数据团队`;
  return `${focus}技术部`;
}

function sliceAround(text, keyword, radius) {
  const index = text.indexOf(keyword);
  if (index < 0) return "";
  return text.slice(Math.max(0, index - radius), Math.min(text.length, index + keyword.length + radius));
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s/\\]+/g, "_")
    .replace(/[^\w\u4e00-\u9fa5]+/g, "")
    .slice(0, 48);
}

function chooseWinner(current, next) {
  if (!current) return next;
  if (next.path.length > current.path.length) return next;
  if (next.path.length === current.path.length && next.type === "allow") return next;
  return current;
}
