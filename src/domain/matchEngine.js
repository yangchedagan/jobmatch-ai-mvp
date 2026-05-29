import { DEGREE_RANK, HARD_SKILLS, ROLE_FAMILIES } from "./taxonomy.js";
import { extractKeywordLabels, highestDegreeRank, normalizeToken, unique } from "./textUtils.js";
import { blendKeywordAndSemanticCoverage } from "./semanticMatcher.js";

const WEIGHT_PRESETS = {
  default: {
    hard_skill: 0.5,
    experience: 0.2,
    project: 0.2,
    education: 0.05,
    soft_skill: 0.05,
  },
  product_manager: {
    role_fit: 0.18,
    scenario_fit: 0.2,
    hard_skill: 0.3,
    project: 0.18,
    experience: 0.07,
    soft_skill: 0.05,
    education: 0.02,
  },
};

const CONTEXT_KEYWORDS = [
  { label: "电商", aliases: ["电商", "交易", "订单", "商家", "购物", "零售", "特卖", "潮流电商"] },
  { label: "增长", aliases: ["增长", "拉新", "促活", "留存", "转化", "会员"] },
  { label: "内容社区", aliases: ["内容", "社区", "创作者", "短视频", "直播", "互动"] },
  { label: "出行", aliases: ["出行", "打车", "司机", "运力"] },
  { label: "旅行", aliases: ["旅行", "酒店", "机票", "旅游"] },
  { label: "供应链", aliases: ["供应链", "履约", "库存", "采购", "物流", "仓配"] },
  { label: "B端平台", aliases: ["b端", "B端", "平台", "企业服务", "中后台", "SaaS"] },
  { label: "AI", aliases: ["ai", "AI", "大模型", "智能体", "算法"] },
  { label: "智能硬件", aliases: ["硬件", "IoT", "智能终端", "智能设备", "无人机", "影像"] },
  { label: "智能汽车", aliases: ["汽车", "智能驾驶", "座舱", "自动驾驶"] },
  { label: "游戏", aliases: ["游戏", "玩法", "玩家"] },
  { label: "金融风控", aliases: ["支付", "风控", "信贷", "反欺诈"] },
];

export function matchResumeToJob(resume, job, options = {}) {
  const roleFocus = resolveRoleFocus(resume, options.targetRole || options.roleFocus);
  const weights = WEIGHT_PRESETS[roleFocus] || WEIGHT_PRESETS.default;
  const requiredSkills = roleFocus === "product_manager" ? productAwareRequiredSkills(job) : job.hard_skills || [];
  const semanticSignals = options.semanticSignals || null;
  const hasSemanticSignals = Boolean(semanticSignals?.hard || semanticSignals?.soft || semanticSignals?.project);
  const hard = blendKeywordAndSemanticCoverage(keywordCoverage(resume.skills || [], job.hard_skills || []), semanticSignals?.hard);
  const experience = scoreExperience(Number(resume.total_years || 0), Number(job.min_years || 0));
  const project = scoreProject(resume, { ...job, hard_skills: requiredSkills }, semanticSignals?.project);
  const education = scoreEducation(resume, job);
  const soft = blendKeywordAndSemanticCoverage(keywordCoverage(resume.soft_skills || [], job.soft_skills || []), semanticSignals?.soft);
  const role = scoreRoleFit(roleFocus, job);
  const scenario = scoreScenarioFit(roleFocus, resume, job);

  const dimensions = [];
  if (weights.role_fit) dimensions.push(buildDimension("role_fit", "岗位方向", role.score, weights.role_fit, role));
  if (weights.scenario_fit) dimensions.push(buildDimension("scenario_fit", "场景贴合度", scenario.score, weights.scenario_fit, scenario));
  dimensions.push(
    buildDimension("hard_skill", roleFocus === "product_manager" ? "产品能力匹配" : "硬技能匹配", hard.score, weights.hard_skill, hard),
    buildDimension("experience", "工作年限", experience.score, weights.experience, experience),
    buildDimension("project", "项目相关度", project.score, weights.project, project),
    buildDimension("education", "学历匹配", education.score, weights.education, education),
    buildDimension("soft_skill", "软素质匹配", soft.score, weights.soft_skill, soft),
  );

  const rawTotalScore = Math.round(dimensions.reduce((sum, item) => sum + item.weighted_score, 0));
  const calibratedScore = calibrateScore(rawTotalScore, dimensions);
  const totalScore = applyRolePriorityCap(calibratedScore, roleFocus, job);
  const gapSkills = buildGapSkills(hard.missing, soft.missing, roleFocus);
  const matchedHighlights = unique([...role.hits, ...hard.hits, ...project.hits, ...soft.hits]).slice(0, 16);
  const redundantItems = unique((resume.skills || []).filter((skill) => !hard.required_normalized.has(normalizeToken(skill)))).slice(0, 12);

  return {
    id: `${resume.id}:${job.id}`,
    created_at: new Date().toISOString(),
    resume_id: resume.id,
    job_id: job.id,
    job_title: job.job_title,
    company: job.company,
    raw_score: rawTotalScore,
    total_score: totalScore,
    grade: grade(totalScore),
    role_focus: roleFocus ? ROLE_FAMILIES[roleFocus]?.label || roleFocus : null,
    dimensions,
    matched_highlights: matchedHighlights,
    gap_skills: gapSkills,
    redundant_items: redundantItems,
    recommendation: buildRecommendation(totalScore, gapSkills),
    scoring_mode: hasSemanticSignals ? "keyword_semantic_blend" : "keyword",
    semantic_match: semanticSignals
      ? {
          model: semanticSignals.model || null,
          error: semanticSignals.error || null,
          blend: semanticSignals.blend || { keyword: 0.4, semantic: 0.6 },
        }
      : null,
    disclaimer: hasSemanticSignals ? "关键词 + 语义匹配版，仅作为求职准备参考。" : "关键词匹配版，仅作为求职准备参考。",
  };
}

export function rankJobsForResume(resume, jobs, limit = 10, options = {}) {
  return jobs
    .map((job) => matchResumeToJob(resume, job, options))
    .sort((a, b) => b.total_score - a.total_score)
    .slice(0, limit);
}

function buildDimension(key, label, score, weight, detail) {
  return {
    key,
    label,
    weight,
    score: Math.round(score),
    weighted_score: Math.round(score * weight * 10) / 10,
    hits: detail.hits || [],
    missing: detail.missing || [],
    note: detail.note || "",
  };
}

function resolveRoleFocus(resume, explicitFocus) {
  if (explicitFocus && ROLE_FAMILIES[explicitFocus]) return explicitFocus;
  if (explicitFocus === "product" || explicitFocus === "产品经理") return "product_manager";
  const intention = resume?.job_intention || {};
  if (intention.role_family && ROLE_FAMILIES[intention.role_family]) return intention.role_family;
  const text = [resume?.raw_text, ...(intention.target_roles || []), ...(resume?.skills || [])].join(" ");
  if (ROLE_FAMILIES.product_manager.title_keywords.some((keyword) => text.includes(keyword))) return "product_manager";
  return null;
}

function productAwareRequiredSkills(job) {
  if (job.role_family === "product_manager" || job.category === "产品" || String(job.job_title || "").includes("产品")) {
    return job.hard_skills || [];
  }
  return job.hard_skills || [];
}

function scoreRoleFit(roleFocus, job) {
  if (!roleFocus) return { score: 100, hits: [], missing: [] };
  const family = ROLE_FAMILIES[roleFocus];
  if (!family) return { score: 100, hits: [], missing: [] };
  const text = [job.job_title, job.category, job.department, job.jd_raw_text].join(" ");
  if (job.role_family === roleFocus || (family.categories || []).includes(job.category) || family.title_keywords.some((keyword) => text.includes(keyword))) {
    return { score: 100, hits: [`${family.label}方向`], missing: [], note: "岗位方向与目标角色一致。" };
  }
  if (["运营", "数据"].includes(job.category)) {
    return { score: 35, hits: [], missing: [`${family.label}岗位方向`], note: "岗位方向相邻，但不是产品经理主线。" };
  }
  return { score: 5, hits: [], missing: [`${family.label}岗位方向`], note: "岗位方向与目标角色差异较大，推荐排序会降低。" };
}

function scoreScenarioFit(roleFocus, resume, job) {
  if (roleFocus !== "product_manager") return { score: 100, hits: [], missing: [] };
  const resumeContext = extractContextKeywords(
    [resume?.raw_text, ...(resume?.skills || []), ...(resume?.projects || []).map((project) => project.raw || project.name || "")].join(" "),
  );
  const jobContext = extractContextKeywords([job?.job_title, job?.department, job?.category, job?.jd_raw_text, ...(job?.hard_skills || [])].join(" "));

  if (!jobContext.length) {
    return { score: 72, hits: [], missing: [], note: "岗位场景信息较少，按中性处理。" };
  }
  if (!resumeContext.length) {
    return { score: 70, hits: [], missing: jobContext.slice(0, 3), note: "简历未识别到明显业务场景。" };
  }

  const resumeSet = new Set(resumeContext);
  const hits = jobContext.filter((item) => resumeSet.has(item));
  if (hits.length) {
    return {
      score: Math.min(100, 76 + hits.length * 12),
      hits: hits.map((item) => `${item}场景`),
      missing: jobContext.filter((item) => !resumeSet.has(item)).slice(0, 4),
      note: "简历业务场景与岗位要求存在交集。",
    };
  }

  return {
    score: 56,
    hits: [],
    missing: jobContext.slice(0, 4),
    note: "岗位业务场景与简历经历差异较大。",
  };
}

function applyRolePriorityCap(score, roleFocus, job) {
  if (roleFocus !== "product_manager") return score;
  if (job.role_family === "product_manager" || job.category === "产品" || String(job.job_title || "").includes("产品")) return Math.min(90, Math.max(60, score));
  if (["运营", "数据"].includes(job.category)) return Math.min(score, 74);
  return Math.min(score, 62);
}

function calibrateScore(rawScore, dimensions) {
  const raw = Math.max(0, Math.min(100, Number(rawScore) || 0));
  const dimensionByKey = Object.fromEntries(dimensions.map((item) => [item.key, item]));
  let score = 48 + raw * 0.42;

  if (dimensionByKey.scenario_fit) score += (dimensionByKey.scenario_fit.score - 70) * 0.14;
  if (dimensionByKey.hard_skill) score += (dimensionByKey.hard_skill.score - 70) * 0.03;
  if (dimensionByKey.project) score += (dimensionByKey.project.score - 70) * 0.02;

  return Math.round(Math.max(54, Math.min(92, score)));
}

function extractContextKeywords(text) {
  const source = String(text || "").toLowerCase();
  const output = [];
  for (const item of CONTEXT_KEYWORDS) {
    if (item.aliases.some((alias) => source.includes(String(alias).toLowerCase()))) output.push(item.label);
  }
  return unique(output);
}

function keywordCoverage(available, required) {
  const requiredClean = unique(required);
  const availableClean = unique(available);
  if (!requiredClean.length) {
    return {
      score: 100,
      hits: [],
      missing: [],
      required_normalized: new Set(),
      note: "岗位未明确要求，默认满分。",
    };
  }

  const availableSet = new Set(availableClean.map(normalizeToken));
  const requiredNormalized = new Set(requiredClean.map(normalizeToken));
  const hits = requiredClean.filter((item) => availableSet.has(normalizeToken(item)));
  const missing = requiredClean.filter((item) => !availableSet.has(normalizeToken(item)));
  return {
    score: (hits.length / requiredClean.length) * 100,
    hits,
    missing,
    required_normalized: requiredNormalized,
  };
}

function scoreExperience(candidateYears, requiredYears) {
  if (!requiredYears) {
    return { score: 100, hits: [], missing: [], note: "岗位未明确年限要求。" };
  }
  if (!candidateYears) {
    return { score: 0, hits: [], missing: [`${requiredYears} 年经验`], note: "简历未识别到工作年限。" };
  }
  return {
    score: Math.min(100, (candidateYears / requiredYears) * 100),
    hits: candidateYears >= requiredYears ? [`${candidateYears} 年经验`] : [],
    missing: candidateYears >= requiredYears ? [] : [`还差约 ${Math.round((requiredYears - candidateYears) * 10) / 10} 年经验`],
    note: `识别年限 ${candidateYears} 年，岗位要求 ${requiredYears} 年。`,
  };
}

function scoreProject(resume, job, semanticProject = null) {
  const projectText = (resume.projects || [])
    .map((project) => [project.name, project.raw, ...(project.technologies || []), ...(project.contribution || [])].join(" "))
    .join("\n");
  const projectSkills = extractKeywordLabels(projectText, HARD_SKILLS);
  if (!projectText.trim()) {
    return { score: 0, hits: [], missing: job.hard_skills || [], note: "简历未识别到项目经验。" };
  }
  return blendKeywordAndSemanticCoverage(keywordCoverage(projectSkills, job.hard_skills || []), semanticProject);
}

function scoreEducation(resume, job) {
  const candidateRank = Number(resume.highest_degree_rank || highestDegreeRank(JSON.stringify(resume.education || []), DEGREE_RANK).rank || 0);
  const requiredRank = Number(job.education_rank || 0);
  if (!requiredRank) return { score: 100, hits: [], missing: [], note: "岗位未明确学历要求。" };
  if (candidateRank >= requiredRank) {
    return { score: 100, hits: [resume.highest_degree || "学历达标"], missing: [] };
  }
  if (candidateRank === requiredRank - 1) {
    return { score: 70, hits: [], missing: [job.education_label || "更高学历"], note: "学历层级略低，建议用项目/经历弥补。" };
  }
  return { score: 30, hits: [], missing: [job.education_label || "更高学历"] };
}

function buildGapSkills(hardMissing, softMissing, roleFocus) {
  const hardDimension = roleFocus === "product_manager" ? "产品能力" : "硬技能";
  return [
    ...hardMissing.map((skill) => ({
      keyword: skill,
      priority: "P0",
      dimension: hardDimension,
      action: `补充 ${skill} 相关项目、实践或关键词。`,
    })),
    ...softMissing.map((skill) => ({
      keyword: skill,
      priority: "P2",
      dimension: "软素质",
      action: `在经历描述中体现 ${skill} 的具体场景。`,
    })),
  ];
}

function grade(score) {
  if (score >= 85) return "优秀";
  if (score >= 70) return "良好";
  return "待提升";
}

function buildRecommendation(score, gaps) {
  if (score >= 85) return "简历与岗位要求高度贴合，可优先投递并准备面试追问。";
  if (score >= 70) return "匹配度较好，建议先补强高权重缺口后投递。";
  const firstGap = gaps[0]?.keyword;
  return firstGap ? `当前缺口集中在 ${firstGap} 等要求，建议先补项目证据。` : "建议补充更多技能、项目和经历细节后再匹配。";
}
