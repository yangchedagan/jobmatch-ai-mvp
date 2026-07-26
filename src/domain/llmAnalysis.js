import { isQwenConfigured, qwenModelName, requestQwenJson } from "../llm/qwenClient.js";

const MATCH_JSON_EXAMPLE = {
  match_explanation: "候选人与岗位在产品设计和需求分析上匹配，主要缺口是用户研究证据不足。",
  interview_predictions: ["请讲一个你从用户反馈发现需求并推动上线的案例。"],
  preparation_tips: ["准备一个包含目标、动作、数据结果的 STAR 案例。"],
};

const RADAR_JSON_EXAMPLE = {
  radar_brief: "该岗位面试高频关注需求拆解、数据分析和跨部门推进。",
  interview_predictions: ["如果增长指标下滑，你会如何定位原因？"],
  preparation_tips: ["准备一个指标异常分析和复盘案例。"],
};

export function isLlmConfigured(options = {}) {
  return isQwenConfigured(options);
}

export async function enhanceMatchReportWithLlm(report, resume, job, options = {}) {
  const fallback = buildFallbackMatchAnalysis(report);
  if (!isLlmConfigured(options)) {
    return withAnalysis(report, {
      ...fallback,
      status: "skipped",
      reason: "QWEN_API_KEY is not configured.",
    });
  }

  try {
    const analysis = await requestQwenJson({
      system:
        `You are a precise career matching analyst. Return compact valid json only. Write in Simplified Chinese. Avoid inventing experience not supported by the resume or JD. Example json output: ${JSON.stringify(MATCH_JSON_EXAMPLE)}`,
      user: buildMatchPrompt(report, resume, job),
      example: MATCH_JSON_EXAMPLE,
      maxTokens: 900,
      timeoutMs: options.timeoutMs,
    });

    return withAnalysis(report, {
      ...fallback,
      ...normalizeMatchAnalysis(analysis),
      status: "generated",
    });
  } catch (error) {
    return withAnalysis(report, {
      ...fallback,
      status: "failed",
      reason: error.message,
    });
  }
}

export async function enhanceIntelligenceReportWithLlm(report, job, options = {}) {
  const fallback = buildFallbackRadarAnalysis(report, options.matchReport);
  if (!isLlmConfigured(options)) {
    return withAnalysis(report, {
      ...fallback,
      status: "skipped",
      reason: "QWEN_API_KEY is not configured.",
    });
  }

  try {
    const analysis = await requestQwenJson({
      system:
        `You are an interview intelligence analyst. Return compact valid json only. Write in Simplified Chinese. Keep predictions grounded in the JD, radar topics, and resume gaps when provided. Example json output: ${JSON.stringify(RADAR_JSON_EXAMPLE)}`,
      user: buildRadarPrompt(report, job, options.resume, options.matchReport),
      example: RADAR_JSON_EXAMPLE,
      maxTokens: 1000,
      timeoutMs: options.timeoutMs,
    });

    return withAnalysis(report, {
      ...fallback,
      ...normalizeRadarAnalysis(analysis),
      status: "generated",
    });
  } catch (error) {
    return withAnalysis(report, {
      ...fallback,
      status: "failed",
      reason: error.message,
    });
  }
}

function withAnalysis(target, analysis) {
  return {
    ...target,
    llm_analysis: {
      provider: "qwen",
      model: qwenModelName(),
      generated_at: new Date().toISOString(),
      ...analysis,
    },
  };
}

function buildMatchPrompt(report, resume, job) {
  return JSON.stringify({
    task:
      "Generate a match explanation and likely interview follow-up questions. Output JSON keys: match_explanation, interview_predictions, preparation_tips.",
    resume: summarizeResume(resume),
    job: summarizeJob(job),
    match_report: {
      total_score: report.total_score,
      grade: report.grade,
      role_focus: report.role_focus,
      dimensions: (report.dimensions || []).map((item) => ({
        key: item.key,
        score: item.score,
        hits: (item.hits || []).slice(0, 6),
        missing: (item.missing || []).slice(0, 6),
      })),
      gap_skills: (report.gap_skills || []).slice(0, 8),
      matched_highlights: (report.matched_highlights || []).slice(0, 12),
    },
  });
}

function buildRadarPrompt(report, job, resume, matchReport) {
  return JSON.stringify({
    task:
      "Generate a radar brief and interview predictions. Output JSON keys: radar_brief, interview_predictions, preparation_tips.",
    job: summarizeJob(job),
    resume: resume ? summarizeResume(resume) : null,
    match_report: matchReport
      ? {
          total_score: matchReport.total_score,
          gap_skills: (matchReport.gap_skills || []).slice(0, 8),
          matched_highlights: (matchReport.matched_highlights || []).slice(0, 12),
        }
      : null,
    radar: {
      search_keywords: report.search_keywords || [],
      interview_topics: (report.interview_topics || []).slice(0, 8).map((item) => ({
        topic: item.topic,
        frequency: item.frequency,
        example_questions: item.example_questions || [],
      })),
      company_background: report.company_background?.summary || "",
      industry_background: report.industry_background?.summary || "",
    },
  });
}

export function summarizeResume(resume = {}) {
  return {
    target_roles: resume.job_intention?.target_roles || [],
    total_years: resume.total_years || 0,
    highest_degree: resume.highest_degree || "",
    skills: (resume.skills || []).slice(0, 40),
    soft_skills: (resume.soft_skills || []).slice(0, 20),
    projects: (resume.projects || []).slice(0, 5).map((project) => ({
      name: project.name || "",
      technologies: project.technologies || [],
      contribution: project.contribution || [],
      summary: cleanText(project.raw || "").slice(0, 600),
    })),
  };
}

export function summarizeJob(job = {}) {
  return {
    company: job.company,
    job_title: job.job_title,
    category: job.category,
    department: job.department,
    min_years: job.min_years,
    hard_skills: job.hard_skills || [],
    soft_skills: job.soft_skills || [],
    jd_summary: cleanText(job.jd_raw_text || "").slice(0, 1800),
  };
}

function normalizeMatchAnalysis(value = {}) {
  return {
    match_explanation: cleanText(value.match_explanation).slice(0, 500),
    interview_predictions: normalizeList(value.interview_predictions, 6),
    preparation_tips: normalizeList(value.preparation_tips, 6),
  };
}

function normalizeRadarAnalysis(value = {}) {
  return {
    radar_brief: cleanText(value.radar_brief).slice(0, 600),
    interview_predictions: normalizeList(value.interview_predictions, 8),
    preparation_tips: normalizeList(value.preparation_tips, 6),
  };
}

function buildFallbackMatchAnalysis(report) {
  const gaps = (report.gap_skills || []).slice(0, 3).map((gap) => gap.keyword).filter(Boolean);
  const highlights = (report.matched_highlights || []).slice(0, 4).filter(Boolean);
  return {
    match_explanation: highlights.length
      ? `当前匹配优势集中在 ${highlights.join("、")}；${gaps.length ? `主要缺口是 ${gaps.join("、")}。` : "暂未发现明显关键缺口。"}`
      : report.recommendation || "当前报告基于技能、经历、项目和学历维度生成。",
    interview_predictions: gaps.map((gap) => `你在 ${gap} 方面有哪些可量化项目证据？`).slice(0, 5),
    preparation_tips: gaps.map((gap) => `补充一段能证明 ${gap} 的 STAR 项目案例。`).slice(0, 5),
  };
}

function buildFallbackRadarAnalysis(report, matchReport) {
  const topics = (report.interview_topics || []).slice(0, 4).map((item) => item.topic).filter(Boolean);
  const gaps = (matchReport?.gap_skills || []).slice(0, 3).map((gap) => gap.keyword).filter(Boolean);
  return {
    radar_brief: topics.length ? `情报雷达显示高频考点集中在 ${topics.join("、")}。` : "情报雷达已生成公司、行业和面试资料线索。",
    interview_predictions: [
      ...topics.map((topic) => `请结合过往经历说明你如何处理 ${topic}。`),
      ...gaps.map((gap) => `岗位要求 ${gap}，你有哪些补足计划或相关迁移经验？`),
    ].slice(0, 8),
    preparation_tips: topics.map((topic) => `准备一个 ${topic} 的项目复盘案例。`).slice(0, 6),
  };
}

function normalizeList(value, limit) {
  const list = Array.isArray(value) ? value : String(value || "").split(/\n+/);
  return list.map(cleanText).filter(Boolean).slice(0, limit);
}

function cleanText(value) {
  return String(value || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?:\+?86[\s-]?)?1[3-9]\d{9}/g, "[phone]")
    .replace(/\s+/g, " ")
    .trim();
}
