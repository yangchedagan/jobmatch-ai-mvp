import crypto from "node:crypto";

import { compactWhitespace, normalizeToken, unique } from "./textUtils.js";
import { searchWebSources, verifyUrls } from "./liveSourceSearch.js";

export const INTELLIGENCE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// 兜底检索入口只保留实测无登录墙、可直接看到结果的平台（脉脉搜索 404、知乎搜索有登录墙，已剔除）。
const EXPERIENCE_PLATFORMS = [
  { platform: "牛客", weight: 34, searchUrl: (query) => `https://www.nowcoder.com/search/all/?query=${encodeURIComponent(query)}` },
  { platform: "百度", weight: 26, searchUrl: (query) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}` },
];

const INFO_PLATFORMS = [
  { platform: "百度百科", type: "company", searchUrl: (query) => `https://baike.baidu.com/item/${encodeURIComponent(query)}` },
  { platform: "36氪", type: "news", searchUrl: (query) => `https://36kr.com/search/articles/${encodeURIComponent(query)}` },
  { platform: "虎嗅", type: "news", searchUrl: (query) => `https://www.huxiu.com/search.html?s=${encodeURIComponent(query)}` },
  { platform: "公司官网", type: "company", searchUrl: (query) => `https://www.baidu.com/s?wd=${encodeURIComponent(`${query} 官网 About`)}` },
];

const TOPIC_PRESETS = {
  product_manager: [
    topic("需求分析", ["需求", "PRD", "用户故事"], ["如何从业务目标拆解产品需求？", "遇到需求冲突时你如何排序？"], 9),
    topic("用户研究", ["用户研究", "用户访谈", "问卷", "洞察"], ["你做过哪些用户研究？结论如何落到产品方案？"], 8),
    topic("数据分析", ["数据分析", "SQL", "指标", "看板"], ["如何设计核心指标体系？", "如何定位转化率下降的原因？"], 8),
    topic("竞品分析", ["竞品", "市场分析", "差异化"], ["请讲一次竞品分析如何影响你的产品决策。"], 7),
    topic("增长实验", ["增长", "A/B", "转化", "留存"], ["如何设计一次 A/B 测试并判断结论可信？"], 7),
    topic("项目推进", ["跨部门", "推进", "排期", "里程碑"], ["研发资源不足时你如何推进上线？"], 6),
    topic("商业化判断", ["商业化", "收入", "定价", "变现"], ["如何评估一个功能的商业价值？"], 5),
  ],
  technology: [
    topic("数据结构与算法", ["算法", "数据结构", "复杂度", "LeetCode"], ["讲一道你印象最深的算法题及复杂度。"], 9),
    topic("系统设计", ["系统设计", "架构", "分布式", "高并发"], ["如何设计一个高并发订单系统？"], 8),
    topic("数据库与缓存", ["MySQL", "Redis", "索引", "事务", "缓存"], ["MySQL 索引失效有哪些场景？", "如何处理缓存击穿？"], 8),
    topic("项目深挖", ["项目", "难点", "优化", "复盘"], ["介绍一个最有技术挑战的项目。"], 7),
    topic("服务稳定性", ["限流", "降级", "监控", "容灾"], ["线上故障你会如何排查和止损？"], 6),
    topic("语言基础", ["Java", "Go", "Python", "JavaScript", "TypeScript"], ["讲讲你最熟悉语言的并发模型。"], 6),
  ],
  operations: [
    topic("用户增长", ["增长", "拉新", "留存", "转化"], ["如何设计一次拉新活动并复盘效果？"], 8),
    topic("活动运营", ["活动", "玩法", "激励", "复盘"], ["讲一个你主导的活动，从目标到结果。"], 7),
    topic("内容策略", ["内容", "社区", "达人", "创作者"], ["如何判断内容质量并提升供给？"], 6),
    topic("数据复盘", ["数据", "指标", "看板", "分析"], ["活动效果不及预期时你如何分析？"], 7),
  ],
  general: [
    topic("岗位动机", ["动机", "职业规划", "为什么"], ["为什么选择我们公司和这个岗位？"], 6),
    topic("项目复盘", ["项目", "复盘", "难点"], ["讲一个你最有代表性的项目。"], 7),
    topic("协作沟通", ["沟通", "协作", "冲突"], ["跨团队出现分歧时你如何处理？"], 6),
    topic("业务理解", ["业务", "行业", "用户"], ["你如何理解这个业务的增长机会？"], 6),
  ],
};

const INDUSTRY_RULES = [
  industry("本地生活", ["美团", "到店", "外卖", "餐饮", "生活服务"], ["抖音生活服务", "饿了么", "快手本地生活", "高德地图"]),
  industry("电商零售", ["电商", "交易", "订单", "零售", "商城", "供应链"], ["淘宝天猫", "京东", "拼多多", "抖音电商"]),
  industry("人工智能", ["AI", "大模型", "算法", "机器学习", "推荐系统", "NLP"], ["百度智能云", "阿里云", "腾讯云", "字节火山引擎"]),
  industry("企业服务", ["SaaS", "B端", "企业服务", "中后台", "平台"], ["钉钉", "飞书", "企业微信", "纷享销客"]),
  industry("金融科技", ["支付", "风控", "信贷", "金融", "反欺诈"], ["蚂蚁集团", "腾讯金融科技", "京东科技", "度小满"]),
  industry("物流供应链", ["物流", "履约", "仓配", "运力", "供应链"], ["京东物流", "顺丰科技", "菜鸟", "满帮"]),
  industry("内容社区", ["内容", "社区", "直播", "短视频", "创作者"], ["小红书", "抖音", "快手", "B站"]),
  industry("游戏娱乐", ["游戏", "玩法", "玩家", "关卡"], ["腾讯游戏", "网易游戏", "米哈游", "莉莉丝"]),
];

export function generateSearchKeywords(job) {
  const company = cleanCompany(job.company);
  const roleType = inferRoleType(job);
  const skillText = (job.hard_skills || []).slice(0, 3).join(" ");
  return unique([
    `${job.company || company} ${job.job_title || roleType}`.trim(),
    `${company} ${roleType} 面经`.trim(),
    `${roleType} ${skillText} 面经`.trim(),
  ]).filter(Boolean);
}

export function buildIntelligenceReport(job, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const generatedAt = now.toISOString();
  const cacheExpiresAt = new Date(now.getTime() + INTELLIGENCE_CACHE_TTL_MS).toISOString();
  const searchKeywords = generateSearchKeywords(job);
  const topicCandidates = rankTopicCandidates(job);
  const interviewSources = buildInterviewSources(job, searchKeywords);
  const backgroundSources = buildBackgroundSources(job);
  const rawSources = dedupeSources([...interviewSources, ...backgroundSources]).sort((a, b) => b.quality_score - a.quality_score);
  const interviewTopics = buildInterviewTopics(topicCandidates, job);
  const industryBackground = buildIndustryBackground(job);
  const companyBackground = buildCompanyBackground(job, industryBackground);

  return {
    job_id: job.id,
    job_title: job.job_title,
    company: job.company,
    generated_at: generatedAt,
    cache_expires_at: cacheExpiresAt,
    search_keywords: searchKeywords,
    interview_topics: interviewTopics,
    company_background: companyBackground,
    industry_background: industryBackground,
    raw_sources: rawSources,
    meta: {
      total_sources: rawSources.length,
      interview_post_count: 0,
      sample_warning: true,
      source_mode: "search-entry-fallback",
    },
  };
}

/**
 * 实时搜索 + 逐链验证版情报雷达：
 * 1. 按「公司 + 岗位」粒度实时搜索公开面经与公司动态，拿到真实帖子 URL；
 * 2. 对每一条链接做存活校验，确定性死链一律剔除；
 * 3. 实时搜索不可用时回退到 buildIntelligenceReport 的诚实检索入口（不伪造帖子）。
 */
export async function buildVerifiedIntelligenceReport(job, options = {}) {
  const base = buildIntelligenceReport(job, options);
  let live;
  try {
    live = await collectLiveSources(job, options);
  } catch {
    live = null;
  }
  if (!live || !live.posts.length) return base;
  return mergeLiveSources(base, live, job);
}

async function collectLiveSources(job, options = {}) {
  const company = cleanCompany(job.company) || String(job.company || "");
  const roleType = inferRoleType(job);
  const jobTitle = String(job.job_title || roleType);
  const queries = unique([
    `${job.company || company} ${jobTitle} 面经`,
    `${company} ${roleType} 面试 经验`,
    `${job.company || company} 最新 动态`,
  ]);

  const batches = await Promise.all(
    queries.map((query, index) =>
      searchWebSources(query, { limit: index === queries.length - 1 ? 5 : 8, timeoutMs: options.searchTimeoutMs }).catch(() => []),
    ),
  );

  const seen = new Set();
  const candidates = [];
  batches.forEach((items, batchIndex) => {
    for (const item of items) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      const text = `${item.title} ${item.snippet}`;
      const isInterview = /面经|面试|笔试|offer|一面|二面|三面/i.test(text);
      const mentionsCompany = company && text.includes(company);
      // 相关性闸门：必须命中公司名，或同时命中岗位类型与面试语境，否则视为无关结果丢弃。
      if (!mentionsCompany && !(isInterview && text.includes(roleType))) continue;
      candidates.push({
        ...item,
        source_type: batchIndex === queries.length - 1 && !isInterview ? "news" : "interview",
        relevance: (mentionsCompany ? 2 : 0) + (text.includes(jobTitle) ? 2 : 0) + (isInterview ? 1 : 0),
      });
    }
  });

  const { passed, dropped } = await verifyUrls(candidates, { timeoutMs: options.verifyTimeoutMs });
  return {
    posts: passed,
    linkCheck: { checked: candidates.length, passed: passed.length, dropped: dropped.length },
  };
}

function mergeLiveSources(base, live, job) {
  const interviewPosts = live.posts.filter((post) => post.source_type === "interview");
  const newsPosts = live.posts.filter((post) => post.source_type === "news");

  const liveSources = live.posts.map((post, index) => ({
    id: hashSource(`${post.platform}:${post.url}`),
    platform: post.platform,
    source_type: post.source_type,
    topic: null,
    title: post.title,
    url: post.url,
    published_at: post.published_at,
    snippet: post.snippet,
    quality_score: Math.min(98, 58 + post.relevance * 6 + platformBonus(post.platform) - Math.floor(index / 4)),
    is_expired: false,
    verified: true,
  }));

  const searchEntries = base.raw_sources.filter((source) => source.source_type === "search_entry").slice(0, 2);
  const rawSources = dedupeSources([...liveSources, ...searchEntries]).sort((a, b) => b.quality_score - a.quality_score);

  const interviewTopics = base.interview_topics.map((topic) => {
    const aliasList = [topic.topic, ...(findTopicAliases(job, topic.topic) || [])];
    const matched = interviewPosts
      .filter((post) => aliasList.some((alias) => alias && `${post.title} ${post.snippet}`.includes(alias)))
      .slice(0, 3)
      .map(sourceRef);
    return matched.length ? { ...topic, sources: matched } : topic;
  });

  const recentNews = newsPosts.slice(0, 3).map((post) => ({
    title: post.title,
    url: post.url,
    published_at: post.published_at,
    summary: post.snippet || `来自 ${post.platform} 的公开报道。`,
  }));

  return {
    ...base,
    interview_topics: interviewTopics,
    company_background: recentNews.length ? { ...base.company_background, recent_news: recentNews } : base.company_background,
    raw_sources: rawSources,
    meta: {
      ...base.meta,
      total_sources: rawSources.length,
      interview_post_count: interviewPosts.length,
      sample_warning: interviewPosts.length < 5,
      source_mode: "live-web-verified",
      link_check: live.linkCheck,
    },
  };
}

function platformBonus(platform) {
  if (platform === "牛客") return 20;
  if (platform === "知乎") return 15;
  if (platform === "CSDN" || platform === "脉脉") return 10;
  if (platform === "36氪" || platform === "虎嗅") return 8;
  return 4;
}

function findTopicAliases(job, topicName) {
  const presets = [...(TOPIC_PRESETS[inferRoleFamily(job)] || []), ...TOPIC_PRESETS.general];
  return presets.find((item) => item.topic === topicName)?.aliases;
}

export function isIntelligenceReportFresh(report, now = new Date()) {
  if (!report?.cache_expires_at) return false;
  const expiresAt = new Date(report.cache_expires_at).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

export function rankTopicCandidates(job) {
  const roleFamily = inferRoleFamily(job);
  const presets = [...(TOPIC_PRESETS[roleFamily] || []), ...TOPIC_PRESETS.general];
  const rawText = compactWhitespace(
    [
      job.job_title,
      job.category,
      job.department,
      job.jd_raw_text,
      ...(job.hard_skills || []),
      ...(job.soft_skills || []),
    ].join(" "),
  );
  const normalizedText = normalizeToken(rawText);

  return presets
    .map((item, index) => {
      const aliasHits = item.aliases.reduce((sum, alias) => sum + countToken(normalizedText, alias), 0);
      const titleHit = countToken(normalizedText, item.topic);
      return {
        ...item,
        frequency: Math.max(1, item.baseFrequency + aliasHits + titleHit - Math.floor(index / 4)),
      };
    })
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 10);
}

function buildInterviewTopics(topicCandidates, job) {
  const roleType = inferRoleType(job);
  const company = cleanCompany(job.company) || String(job.company || "");
  const entryPlatform = EXPERIENCE_PLATFORMS[0];

  return topicCandidates.map((item) => {
    const query = compactWhitespace(`${company} ${roleType} ${item.topic} 面经`);
    return {
      topic: item.topic,
      frequency: item.frequency,
      example_questions: item.example_questions.slice(0, 2),
      // 兜底来源指向真实检索页（打开即是该考点的最新公开结果），实时搜到真实帖子后会被覆盖。
      sources: [
        {
          title: `${query}｜${entryPlatform.platform}实时检索`,
          url: entryPlatform.searchUrl(query),
          platform: entryPlatform.platform,
          published_at: null,
        },
      ],
    };
  });
}

function buildInterviewSources(job, searchKeywords) {
  const roleType = inferRoleType(job);
  const company = cleanCompany(job.company);
  const keywords = searchKeywords.length ? searchKeywords : [compactWhitespace(`${company} ${roleType} 面经`)];

  const output = [];
  keywords.forEach((keyword, keywordIndex) => {
    for (const platform of EXPERIENCE_PLATFORMS) {
      output.push({
        id: hashSource(`${platform.platform}:entry:${keyword}`),
        platform: platform.platform,
        source_type: "search_entry",
        topic: null,
        title: `${keyword}｜${platform.platform}实时检索`,
        url: platform.searchUrl(keyword),
        published_at: null,
        snippet: `实时搜索入口：打开即是「${keyword}」的最新公开检索结果。`,
        quality_score: platform.weight + 22 - keywordIndex * 4,
        is_expired: false,
      });
    }
  });
  return output;
}

function buildBackgroundSources(job) {
  const company = cleanCompany(job.company);
  const industry = detectIndustry(job);
  const queries = [
    { query: company || job.company, title: `${company || job.company} 百科词条`, platform: INFO_PLATFORMS[0] },
    { query: company || job.company, title: `${company || job.company} 近期报道检索`, platform: INFO_PLATFORMS[1] },
    { query: industry.category, title: `${industry.category} 行业报道检索`, platform: INFO_PLATFORMS[2] },
    { query: company || job.company, title: `${company || job.company} 官网检索`, platform: INFO_PLATFORMS[3] },
  ];

  return queries
    .filter((item) => item.query)
    .map((item, index) => ({
      id: hashSource(`${item.platform.platform}:${item.query}`),
      platform: item.platform.platform,
      source_type: item.platform.type,
      title: item.title,
      url: item.platform.searchUrl(item.query),
      published_at: null,
      snippet: index === 2 ? `实时检索入口：${industry.category} 的公开行业报道。` : `实时检索入口：${company || job.company} 的公开资料与报道。`,
      quality_score: 72 - index * 4,
      is_expired: false,
    }));
}

function buildCompanyBackground(job, industryBackground) {
  const company = job.company || cleanCompany(job.company) || "目标公司";
  const department = job.department || "目标部门";
  const role = job.job_title || inferRoleType(job);
  const skillSummary = (job.hard_skills || []).slice(0, 4).join("、");
  return {
    summary: truncate(`${company} 的 ${role} 岗位与 ${department} 相关，JD 重点落在 ${skillSummary || "业务理解、项目经验和岗位通用能力"}。建议重点核验公司官网、百科与近期媒体报道。`, 120),
    core_products: unique([industryBackground.category, ...(job.hard_skills || []).slice(0, 4)]).slice(0, 6),
    parent_company: "未识别",
    department_positioning: truncate(`${department} 通常承担 ${role} 的需求落地、跨团队协作和业务指标推进；当前版本以 JD 字段作为定位依据。`, 120),
    recent_news: [
      news(`${company} 近期报道检索`, `${company} 近期动态`, "36氪"),
      news(`${company} 产品与组织报道检索`, `${company} 产品 组织`, "虎嗅"),
      news(`${company} 官网与业务介绍检索`, company, "公司官网"),
    ],
  };
}

function buildIndustryBackground(job) {
  const industry = detectIndustry(job);
  return {
    category: industry.category,
    summary: truncate(`${industry.category} 的岗位竞争通常同时考察行业理解、业务指标和岗位专业能力。建议结合近半年融资、产品迭代、监管政策与头部公司动态，准备可落到目标公司的观点。`, 210),
    recent_events: [
      event(`${industry.category} 投融资与产品动态检索`, `${industry.category} 投融资 产品 动态`, 1),
      event(`${industry.category} 竞争格局报道检索`, `${industry.category} 竞争格局`, 2),
      event(`${industry.category} 增长与商业化报道检索`, `${industry.category} 增长 商业化`, 3),
      event(`${industry.category} 政策与合规报道检索`, `${industry.category} 政策 合规`, 4),
    ],
    competitors: industry.competitors,
  };
}

function detectIndustry(job) {
  const text = [job.company, job.job_title, job.department, job.category, job.jd_raw_text, ...(job.hard_skills || [])].join(" ");
  for (const rule of INDUSTRY_RULES) {
    if (rule.keywords.some((keyword) => text.includes(keyword))) return rule;
  }
  if (inferRoleFamily(job) === "technology") return INDUSTRY_RULES.find((item) => item.category === "人工智能");
  if (inferRoleFamily(job) === "product_manager") return INDUSTRY_RULES.find((item) => item.category === "企业服务");
  return industry("互联网科技", ["互联网", "科技"], ["腾讯", "阿里巴巴", "百度", "字节跳动", "美团"]);
}

function inferRoleFamily(job) {
  const text = [job.role_family, job.category, job.job_title, job.jd_raw_text].join(" ");
  if (job.role_family === "product_manager" || includesAny(text, ["产品", "浜у搧"])) return "product_manager";
  if (job.role_family === "operations" || includesAny(text, ["运营", "杩愯惀"])) return "operations";
  if (job.role_family === "technology" || includesAny(text, ["工程师", "开发", "算法", "数据", "鎶€鏈", "宸ョ▼", "寮€鍙", "绠楁硶", "鏁版嵁"])) return "technology";
  return "general";
}

function inferRoleType(job) {
  const family = inferRoleFamily(job);
  if (family === "product_manager") return "产品经理";
  if (family === "operations") return "运营";
  if (family === "technology") {
    const title = String(job.job_title || "");
    if (includesAny(title, ["算法", "推荐", "机器学习", "绠楁硶"])) return "算法工程师";
    if (includesAny(title, ["前端", "React", "Vue", "鍓嶇"])) return "前端工程师";
    if (includesAny(title, ["数据", "SQL", "鏁版嵁"])) return "数据岗位";
    return "后端工程师";
  }
  return job.job_title || "目标岗位";
}

function cleanCompany(company) {
  return String(company || "")
    .replace(/(有限责任公司|股份有限公司|科技有限公司|信息技术有限公司|集团|公司)$/g, "")
    .trim();
}

function sourceRef(source) {
  return {
    title: source.title,
    url: source.url,
    platform: source.platform,
    published_at: source.published_at,
  };
}

function dedupeSources(sources) {
  const byHash = new Map();
  for (const source of sources) {
    const key = hashSource(`${source.title}:${source.snippet}`);
    const existing = byHash.get(key);
    if (!existing || source.quality_score > existing.quality_score) byHash.set(key, { ...source, id: source.id || key });
  }
  return [...byHash.values()];
}

function countToken(text, token) {
  const normalized = normalizeToken(token);
  if (!normalized) return 0;
  let count = 0;
  let index = text.indexOf(normalized);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(normalized, index + normalized.length);
  }
  return count;
}

function topic(topicName, aliases, exampleQuestions, baseFrequency) {
  return { topic: topicName, aliases, example_questions: exampleQuestions, baseFrequency };
}

function industry(category, keywords, competitors) {
  return { category, keywords, competitors };
}

function news(title, query, platform) {
  return {
    title,
    url: searchUrl(platform, query),
    published_at: null,
    summary: `实时检索入口：打开即是该主题的最新公开报道。`,
  };
}

function event(title, query, index) {
  return {
    title,
    url: searchUrl(index % 2 ? "36氪" : "虎嗅", query),
    date: null,
    summary: `实时检索入口：用于补充 ${title.replace(/检索$/, "")}素材。`,
  };
}

function searchUrl(platform, query) {
  const source = INFO_PLATFORMS.find((item) => item.platform === platform) || INFO_PLATFORMS[1];
  return source.searchUrl(query);
}

function truncate(value, maxLength) {
  const text = compactWhitespace(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function includesAny(text, keywords) {
  return keywords.some((keyword) => String(text || "").includes(keyword));
}

function hashSource(value) {
  return crypto.createHash("md5").update(normalizeToken(value)).digest("hex").slice(0, 16);
}
