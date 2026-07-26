import { handleInterviewTurn, isInterviewActive } from "./interview.js";
import { appendHistory } from "./session.js";
import { executeSkill, toQwenTools } from "./skills.js";
import {
  chatCompletion,
  extractAssistantContent,
  extractToolCalls,
  isQwenConfigured,
} from "../llm/qwenClient.js";

const MAX_TOOL_CALLS = 4;

export function matchRule(message, options = {}) {
  const text = String(message || "").trim();
  const compact = text.replace(/\s+/g, "");
  const attachmentText = String(options.attachmentText || "").trim();

  if (attachmentText || looksLikeResume(text)) {
    return { skill: "parse_resume", args: { resume_text: attachmentText ? "" : text } };
  }

  if (/结束面试|退出面试|停止面试|不面了/.test(text)) {
    return { skill: "mock_interview_control", args: { op: "end" } };
  }
  if (/^(跳过|下一题)/.test(text)) {
    return { skill: "mock_interview_control", args: { op: "skip" } };
  }
  if (/模拟面试|面试模拟|面试练习|练.{0,3}面试/.test(text)) {
    return { skill: "mock_interview", args: extractJobArgs(text) };
  }
  if (/情报雷达|面试考什么|面试考点|面经|预测题|面试题/.test(text)) {
    return { skill: "intelligence_radar", args: extractJobArgs(text) };
  }
  if (/同步.{0,4}岗位|刷新.{0,4}岗位库/.test(text)) {
    return { skill: "sync_jobs", args: {} };
  }
  if (/抓取|爬取|爬一下|最新岗位/.test(text) && /岗位|招聘/.test(text)) {
    return { skill: "crawl_jobs", args: {} };
  }
  if (/推荐|Top\s*\d+|最适合|最匹配/.test(text) && /岗位|职位|工作|Top/i.test(text)) {
    const limit = Number(text.match(/(?:Top|前)\s*(\d+)/i)?.[1] || 10);
    return { skill: "recommend_jobs", args: { limit: Math.min(Math.max(limit, 1), 20) } };
  }
  if (/匹配|合适|适合度|契合/.test(text) && /岗位|职位|岗|公司|简历/.test(text)) {
    return { skill: "match_job", args: extractJobArgs(text) };
  }
  if (/加进技能|添加技能|补充技能|目标岗位改成|目标方向改成/.test(text)) {
    return { skill: "update_resume", args: extractResumeUpdates(text) };
  }
  if (/找找|查找|搜索|筛选|有哪些|岗位库/.test(text) && /岗位|职位|工作|招聘/.test(text)) {
    return { skill: "search_jobs", args: extractSearchArgs(text) };
  }
  if (/解析.{0,6}简历|看看.{0,6}简历|分析.{0,6}简历/.test(text)) {
    return { skill: "parse_resume", args: { resume_text: "" } };
  }

  return { skill: "answer_question", args: { question: text || compact } };
}

export async function routeAgentMessage({ message, session, runtime }) {
  const text = String(message || "").trim();
  appendHistory(session, "user", text || (runtime.attachmentText ? "[上传简历附件]" : ""));

  if (isInterviewActive(session)) {
    const outcome = await handleInterviewTurn(text, session, runtime);
    return finalizeOutcome(outcome, {
      session,
      route: "interview",
      skillCalls: [{ skill: "mock_interview", args: { answer: text } }],
    });
  }

  if (isQwenConfigured()) {
    try {
      const llmResult = await routeWithQwen(text, session, runtime);
      if (llmResult) return llmResult;
    } catch {
      // Network, model, or malformed tool-call failures use the deterministic router.
    }
  }

  const call = matchRule(text, { attachmentText: runtime.attachmentText });
  const outcome = await executeSkill(call.skill, call.args, runtime);
  return finalizeOutcome(outcome, { session, route: "rules", skillCalls: [call] });
}

export function collectOutcome(outcome, cards = [], actions = []) {
  if (!outcome || typeof outcome !== "object") return { cards, actions };
  if (outcome.card) cards.push(outcome.card);
  if (Array.isArray(outcome.cards)) cards.push(...outcome.cards.filter(Boolean));
  if (Array.isArray(outcome.actions)) actions.push(...outcome.actions.filter(Boolean));
  return { cards, actions };
}

export function buildContextAnswerPrompt(session, resume) {
  const context = {
    resume: resume
      ? {
          target_roles: resume.job_intention?.target_roles || [],
          skills: (resume.skills || []).slice(0, 30),
          soft_skills: (resume.soft_skills || []).slice(0, 15),
          projects: (resume.projects || []).slice(0, 4).map((item) => item.name || item.title).filter(Boolean),
        }
      : null,
    recent_jobs: session.lastJobIds || [],
    recent_match: session.lastReportSummary || null,
  };
  return `只基于下面已知上下文回答；缺失的信息要明确说明，不要编造。\n当前会话上下文：${JSON.stringify(context)}`;
}

async function routeWithQwen(text, session, runtime) {
  const payload = await chatCompletion({
    messages: [
      {
        role: "system",
        content:
          "你是 JobMatch AI 的技能路由器。优先调用最合适的一个工具；只有普通求职问答才直接回答。不要虚构岗位、简历或匹配结果。",
      },
      ...session.history.slice(-10).map(({ role, content }) => ({ role, content })),
    ],
    tools: toQwenTools(),
    toolChoice: "auto",
    maxTokens: 900,
  });

  const toolCalls = extractToolCalls(payload).slice(0, MAX_TOOL_CALLS);
  const directReply = extractAssistantContent(payload);
  if (!toolCalls.length) {
    if (!directReply) return null;
    appendHistory(session, "assistant", directReply);
    return { reply: directReply, cards: [], actions: [], skill_calls: [], route: "qwen" };
  }

  const cards = [];
  const actions = [];
  const skillCalls = [];
  const replies = [];
  for (const toolCall of toolCalls) {
    const skill = String(toolCall?.function?.name || "").trim();
    if (!skill) continue;
    const args = parseArguments(toolCall?.function?.arguments);
    const outcome = await executeSkill(skill, args, runtime);
    collectOutcome(outcome, cards, actions);
    skillCalls.push({ skill, args });
    if (outcome?.reply) replies.push(outcome.reply);
  }
  if (!skillCalls.length) return null;

  const reply = replies.join("\n\n") || directReply || "操作已完成。";
  appendHistory(session, "assistant", reply);
  return { reply, cards, actions, skill_calls: skillCalls, route: "qwen" };
}

function finalizeOutcome(outcome, { session, route, skillCalls }) {
  const cards = [];
  const actions = [];
  collectOutcome(outcome, cards, actions);
  const reply = String(outcome?.reply || "操作已完成。");
  appendHistory(session, "assistant", reply);
  return {
    reply,
    cards,
    actions,
    skill_calls: skillCalls,
    route: outcome?.route || route,
  };
}

function parseArguments(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || "{}"));
  } catch {
    return {};
  }
}

function looksLikeResume(text) {
  if (text.length < 120) return false;
  const signals = [
    /教育背景|教育经历/,
    /工作经历|实习经历/,
    /项目经验|项目经历/,
    /技能栈|专业技能|个人技能/,
    /求职意向/,
  ];
  return signals.filter((pattern) => pattern.test(text)).length >= 2;
}

function extractSearchArgs(text) {
  const args = {};
  const recruitment = text.match(/校招|社招|实习/);
  if (recruitment) args.recruitment_type = recruitment[0];
  const category = text.match(/产品|运营|算法|开发|设计|市场|销售|数据|测试/);
  if (category) args.category = category[0];
  const company = extractCompany(text);
  if (company) args.company = company;
  const query = text
    .replace(/找找|查找|搜索|筛选|有哪些|岗位库里|岗位库|的?校招|的?社招|的?实习|岗位|职位|工作|招聘|一下|帮我/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (query && query !== args.category && query !== args.company) args.query = query;
  return args;
}

function extractJobArgs(text) {
  const cleaned = text
    .replace(/帮我|给我|看(看)?|一下|这个|那个|开启|启动|生成|匹配|模拟面试|面试模拟|情报雷达|面试考什么|面试考点|面经|预测题/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? { job_query: cleaned } : {};
}

function extractCompany(text) {
  const match = text.match(/([\u4e00-\u9fa5A-Za-z0-9·]{2,16})的(?:产品|运营|算法|开发|设计|市场|销售|数据|测试)(?:经理|工程师)?岗/);
  return String(match?.[1] || "").replace(/^(?:找找|查找|搜索|筛选|匹配|帮我)/, "");
}

function extractResumeUpdates(text) {
  const args = {};
  const target = text.match(/目标(?:岗位|方向)改成([^，。；]+)/);
  if (target) args.target_roles = target[1].split(/[、,，/]/).map((item) => item.trim()).filter(Boolean);
  const add = text.match(/(?:把|将)?([^，。；]+?)(?:加进|添加到|补充到?)(?:我的)?技能/);
  if (add) {
    args.add_skills = add[1]
      .replace(/^帮我/, "")
      .split(/[、,，/]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return args;
}
