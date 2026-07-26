import { parseResumeText } from "../domain/resumeParser.js";
import { buildIntelligenceReport, buildVerifiedIntelligenceReport } from "../domain/intelligenceRadar.js";
import { enhanceIntelligenceReportWithLlm } from "../domain/llmAnalysis.js";
import { getJob, listJobs, runJobSync, runLiveJobCrawl } from "../storage.js";
import { finishInterview, startMockInterview } from "./interview.js";
import { batchTone, emptySearchTone, matchTone, radarTone, resumeTone } from "./tone.js";

const DEFAULT_JOB_LIMIT = 8;

export const skills = [
  {
    name: "parse_resume",
    description: "解析用户提供的简历文本或上传的简历文件，输出结构化简历。用户说\u201c解析简历\u201d\u201c看看我的简历\u201d或直接粘贴大段简历内容时调用。",
    parameters: {
      type: "object",
      properties: {
        resume_text: { type: "string", description: "用户粘贴的简历正文。如果用户上传了附件则可以留空。" },
      },
    },
    async execute(args, runtime) {
      const text = String(args.resume_text || "").trim() || String(runtime.attachmentText || "").trim();
      if (!text) {
        return {
          reply: "我还没有收到简历内容。你可以直接把简历正文粘贴到输入框，或拖拽上传 PDF / TXT / 图片文件。",
        };
      }
      const warnings = [...(runtime.attachmentWarnings || [])];
      const resume = parseResumeText(text, {
        source: runtime.attachmentSource || "chat",
        fileMeta: runtime.attachmentMeta || null,
        warnings,
      });
      await runtime.saveResume(resume);
      runtime.session.resumeId = resume.id;
      const skillCount = resume.skills?.length || 0;
      return {
        reply: `简历解析完成：识别到 ${skillCount} 项技能、${resume.projects?.length || 0} 个项目、${resume.experiences?.length || 0} 段经历${warnings.length ? `（${warnings.length} 条提醒）` : ""}。${resumeTone(skillCount, resume.projects?.length)}接下来可以说“推荐岗位”或“匹配某某公司的岗位”。`,
        card: { type: "resume", title: "结构化简历", data: runtime.publicResume(resume) },
      };
    },
  },
  {
    name: "update_resume",
    description: "修正当前简历的字段，例如补充技能、软素质或目标岗位。用户说\u201c帮我把 SQL 加进技能\u201d\u201c目标岗位改成产品经理\u201d时调用。",
    parameters: {
      type: "object",
      properties: {
        skills: { type: "array", items: { type: "string" }, description: "完整的技能列表（增量修改时先合并再传入）" },
        soft_skills: { type: "array", items: { type: "string" }, description: "完整的软素质列表" },
        add_skills: { type: "array", items: { type: "string" }, description: "要追加的技能" },
        target_roles: { type: "array", items: { type: "string" }, description: "目标岗位方向" },
      },
    },
    async execute(args, runtime) {
      const resume = await requireResume(runtime);
      if (!resume) return missingResumeReply();
      const patch = {};
      if (Array.isArray(args.skills) && args.skills.length) patch.skills = args.skills;
      if (Array.isArray(args.add_skills) && args.add_skills.length) {
        patch.skills = [...new Set([...(patch.skills || resume.skills || []), ...args.add_skills])];
      }
      if (Array.isArray(args.soft_skills) && args.soft_skills.length) patch.soft_skills = args.soft_skills;
      if (Array.isArray(args.target_roles) && args.target_roles.length) {
        patch.job_intention = { ...(resume.job_intention || {}), target_roles: args.target_roles };
      }
      if (!Object.keys(patch).length) {
        return { reply: "没有识别到需要修改的字段。可以说\u201c把 SQL、A/B 测试加进技能\u201d或\u201c目标岗位改成策略产品经理\u201d。" };
      }
      const updated = await runtime.updateResume(resume.id, patch);
      return {
        reply: `简历已更新：技能 ${updated.skills?.length || 0} 项，软素质 ${updated.soft_skills?.length || 0} 项。`,
        card: { type: "resume", title: "更新后的简历", data: runtime.publicResume(updated) },
      };
    },
  },
  {
    name: "search_jobs",
    description: "在岗位库中筛选岗位。支持关键词、公司、类型（如产品、运营）、岗位性质（校招/社招/实习）。用户说\u201c找找阿里的产品岗\u201d\u201c有哪些校招岗位\u201d时调用。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词，如技能、岗位名" },
        company: { type: "string", description: "公司名" },
        category: { type: "string", description: "岗位类型，如产品、运营、算法" },
        recruitment_type: { type: "string", description: "岗位性质：校招、社招或实习" },
        limit: { type: "number", description: "返回数量，默认 8" },
      },
    },
    async execute(args, runtime) {
      const jobs = await listJobs({
        query: args.query || "",
        company: args.company || "",
        category: args.category || "",
        recruitment_type: args.recruitment_type || "",
      });
      const limit = Math.min(Math.max(Number(args.limit) || DEFAULT_JOB_LIMIT, 1), 20);
      const selected = jobs.slice(0, limit);
      runtime.session.lastJobIds = selected.map((job) => job.id);
      if (!selected.length) {
        return { reply: `岗位库里没有找到符合条件的岗位。${emptySearchTone()}可以换个关键词，或者说“同步岗位库”获取最新数据。` };
      }
      return {
        reply: `找到 ${jobs.length} 个岗位，展示前 ${selected.length} 个。点击卡片里的岗位可以勾选，选好后点“生成匹配报告”；也可以直接告诉我匹配哪个。`,
        card: { type: "job_list", title: `岗位筛选结果（${jobs.length}）`, data: selected },
      };
    },
  },
  {
    name: "sync_jobs",
    description: "同步本地种子岗位库，刷新岗位数据。用户说\u201c同步岗位\u201d\u201c刷新岗位库\u201d时调用。",
    parameters: { type: "object", properties: {} },
    adminOnly: true,
    async execute(args, runtime) {
      const result = await runJobSync();
      return {
        reply: `岗位库同步完成：更新 ${result.inserted_or_updated} 个岗位（来源：${result.source}）。`,
        card: { type: "info", title: "岗位同步", data: result },
      };
    },
  },
  {
    name: "crawl_jobs",
    description: "抓取官方招聘入口的实时岗位（遵守 robots 协议并限速）。用户说\u201c抓取岗位\u201d\u201c爬一下最新岗位\u201d时调用。",
    parameters: { type: "object", properties: {} },
    adminOnly: true,
    async execute(args, runtime) {
      const result = await runLiveJobCrawl({});
      return {
        reply: `抓取完成：检查 ${result.sources_checked} 个来源，抓取 ${result.pages_fetched} 页，新增实时岗位 ${result.live_jobs} 个，合并后共 ${result.merged_jobs} 个。`,
        card: { type: "info", title: "官方入口抓取", data: result },
      };
    },
  },
  {
    name: "match_job",
    description: "把当前简历与一个或多个岗位进行匹配，输出 0-100 分匹配报告。用户说“匹配一下字节的产品岗”“看看我和这几个岗位合不合适”时调用。",
    parameters: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "单个岗位 ID（若已知）" },
        job_ids: { type: "array", items: { type: "string" }, description: "多个岗位 ID，批量生成匹配报告（最多 5 个）" },
        job_query: { type: "string", description: "岗位描述关键词，如公司名+岗位名，用于模糊定位" },
        target_role: { type: "string", description: "目标方向，如 product_manager" },
      },
    },
    async execute(args, runtime) {
      const resume = await requireResume(runtime);
      if (!resume) return missingResumeReply();

      // 批量匹配：卡片多选或 LLM 传入 job_ids
      const ids = Array.isArray(args.job_ids) ? args.job_ids.filter(Boolean).slice(0, 5) : [];
      if (ids.length) {
        const matched = [];
        for (const id of ids) {
          const job = await getJob(id);
          if (!job) continue;
          const report = await runtime.matchWithCache(resume, job, args.target_role || null);
          matched.push({ job, report });
        }
        if (!matched.length) return { reply: "选中的岗位没有定位到，请重新选择一次。" };

        const best = matched.reduce((left, right) => (right.report.total_score > left.report.total_score ? right : left));
        runtime.session.lastJobId = best.job.id;
        runtime.session.lastJobIds = matched.map(({ job }) => job.id);
        runtime.session.lastReportSummary = buildReportSummary(best.job, best.report);
        const summary = matched.map(({ job, report }) => `${job.company}·${job.job_title} ${report.total_score} 分（${report.grade}）`).join("，");
        return {
          reply: `已生成 ${matched.length} 份匹配报告：${summary}。${batchTone(best.report.total_score, matched.length)}要不要开启岗位情报雷达，看看面试高频考点和预测题？`,
          cards: matched.map(({ job, report }) => ({ type: "match_report", title: `${job.company} · ${job.job_title}`, data: report })),
          actions: [
            ...matched.map(({ job }) => ({
              label: `开启 ${job.company} 情报雷达`,
              command: { skill: "intelligence_radar", args: { job_id: job.id } },
            })),
            { label: "推荐更多岗位", command: { skill: "recommend_jobs", args: { limit: 10 } } },
          ],
        };
      }

      const job = await resolveJob(args, runtime);
      if (!job) {
        return { reply: `没有定位到岗位「${args.job_query || args.job_id || ""}」。可以先说“找找相关岗位”看看岗位库里有哪些。` };
      }
      const report = await runtime.matchWithCache(resume, job, args.target_role || null);
      runtime.session.lastJobId = job.id;
      runtime.session.lastReportSummary = buildReportSummary(job, report);
      return {
        reply: `「${job.company} · ${job.job_title}」匹配完成：${report.total_score} 分（${report.grade}）。${matchTone(report.total_score)}${report.recommendation || ""} 要不要开启岗位情报雷达，看看这个岗位面试考什么？`,
        card: { type: "match_report", title: `${job.company} · ${job.job_title}`, data: report },
        actions: [
          { label: "开启情报雷达", command: { skill: "intelligence_radar", args: { job_id: job.id } } },
          { label: "推荐更多岗位", command: { skill: "recommend_jobs", args: { limit: 10 } } },
        ],
      };
    },
  },
  {
    name: "recommend_jobs",
    description: "用当前简历批量匹配全部岗位并推荐 Top 岗位。用户说\u201c推荐岗位\u201d\u201c哪些岗位最适合我\u201d时调用。",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "推荐数量，默认 10" },
        target_role: { type: "string", description: "目标方向，如 product_manager" },
      },
    },
    async execute(args, runtime) {
      const resume = await requireResume(runtime);
      if (!resume) return missingResumeReply();
      const jobs = await listJobs({});
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
      const reports = await runtime.rankJobs(resume, jobs, limit, args.target_role || null);
      if (!reports.length) return { reply: "岗位库为空，先说\u201c同步岗位库\u201d再试。" };
      runtime.session.lastJobIds = reports.map((report) => report.job_id).filter(Boolean);
      const top = reports[0];
      return {
        reply: `已为你在 ${jobs.length} 个岗位中完成批量匹配，最高分是「${top.company} · ${top.job_title}」（${top.total_score} 分）。${batchTone(top.total_score, reports.length)}点击卡片里的岗位可以勾选一个或多个，选好后点“生成匹配报告”看详细分析。`,
        card: { type: "job_ranking", title: `Top ${reports.length} 推荐`, data: reports },
      };
    },
  },
  {
    name: "intelligence_radar",
    description: "对某个岗位生成面试情报雷达：高频考点、面试预测题、准备建议。用户说\u201c这个岗位面试考什么\u201d\u201c启动情报雷达\u201d时调用。",
    parameters: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "岗位 ID（默认使用最近匹配的岗位）" },
        job_query: { type: "string", description: "岗位描述关键词，用于模糊定位" },
      },
    },
    async execute(args, runtime) {
      const job = await resolveJob(args, runtime, { fallbackToLastJob: true });
      if (!job) {
        return { reply: "还没有目标岗位。先说\u201c匹配某某岗位\u201d，或告诉我公司和岗位名。" };
      }
      const resume = runtime.session.resumeId ? await runtime.resolveResume(runtime.session.resumeId) : null;
      const baseReport = await buildVerifiedIntelligenceReport(job);
      const report = await enhanceIntelligenceReportWithLlm(baseReport, job, { resume, matchReport: null });
      return {
        reply: `「${job.company} · ${job.job_title}」情报雷达已生成，共 ${report.meta?.total_sources || 0} 条资料线索（${report.meta?.source_mode === "live-web-verified" ? `其中 ${report.meta?.interview_post_count || 0} 篇真实面经已逐条验证可打开` : "实时搜索暂不可用，已提供可直接打开的实时检索入口"}）、${(report.interview_topics || []).length} 个高频考点。${radarTone(report.meta?.interview_post_count)}`,
        card: { type: "radar", title: `情报雷达 · ${job.company} · ${job.job_title}`, data: report },
        actions: [
          { label: "开始模拟面试", command: { skill: "mock_interview", args: { job_id: job.id } } },
          { label: "推荐更多岗位", command: { skill: "recommend_jobs", args: { limit: 10 } } },
        ],
      };
    },
  },
  {
    name: "mock_interview",
    description: "基于岗位面经高频考点和候选人简历启动模拟面试，逐题提问并点评。用户说“模拟面试”“帮我练练这个岗位的面试”时调用。",
    parameters: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "岗位 ID（默认用最近匹配或雷达的岗位）" },
        job_query: { type: "string", description: "岗位描述关键词，用于模糊定位" },
      },
    },
    async execute(args, runtime) {
      const job = await resolveJob(args, runtime, { fallbackToLastJob: true });
      if (!job) {
        return { reply: "还没有目标岗位。先匹配或选定一个岗位，再开始模拟面试。" };
      }
      const resume = runtime.session.resumeId ? await runtime.resolveResume(runtime.session.resumeId) : null;
      const radar = buildIntelligenceReport(job);
      return startMockInterview(job, resume, radar, runtime);
    },
  },
  {
    name: "mock_interview_control",
    description: "模拟面试过程控制：跳过当前题目或提前结束。",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", description: "skip 或 end" },
      },
    },
    exposeToLlm: false,
    async execute(args, runtime) {
      const session = runtime.session;
      if (!session.interview?.active) {
        return { reply: "当前没有进行中的模拟面试。可以先匹配一个岗位，再点“开始模拟面试”。" };
      }
      if (args.op === "end") return finishInterview(session, { aborted: true });
      const { handleInterviewTurn } = await import("./interview.js");
      return handleInterviewTurn("跳过", session, runtime);
    },
  },
  {
    name: "answer_question",
    description: "基于当前简历和最近匹配结果回答自由问题。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "用户的问题" },
      },
    },
    exposeToLlm: false,
    async execute(args, runtime) {
      if (typeof runtime.answerWithContext === "function") {
        const reply = await runtime.answerWithContext(args.question || "", runtime.session);
        if (reply) return { reply };
      }
      return {
        reply: "我可以帮你：解析简历、筛选岗位、单岗匹配、批量推荐 Top10、生成面试情报雷达。试试说\u201c解析简历\u201d或\u201c推荐岗位\u201d。",
      };
    },
  },
];

export function getSkill(name) {
  return skills.find((skill) => skill.name === name) || null;
}

export function toQwenTools() {
  return skills
    .filter((skill) => skill.exposeToLlm !== false)
    .map((skill) => ({
      type: "function",
      function: {
        name: skill.name,
        description: skill.description,
        parameters: skill.parameters,
      },
    }));
}

export async function executeSkill(name, args, runtime) {
  const skill = getSkill(name);
  if (!skill) return { reply: `未知技能：${name}` };
  if (skill.adminOnly && !runtime.isAdmin) {
    return { reply: "这个操作（岗位同步/抓取）在当前模式下需要管理员权限，请在后台页携带管理员令牌操作。" };
  }
  try {
    return await skill.execute(args || {}, runtime);
  } catch (error) {
    return { reply: `执行「${name}」时出错：${error.message}`, error: error.message };
  }
}

async function requireResume(runtime) {
  if (!runtime.session.resumeId) return null;
  return runtime.resolveResume(runtime.session.resumeId);
}

function missingResumeReply() {
  return { reply: "我还没有你的简历。先把简历正文粘贴进来，或上传 PDF / TXT 文件，我来解析。" };
}

function buildReportSummary(job, report) {
  return {
    job_id: job.id,
    company: job.company,
    job_title: job.job_title,
    total_score: report.total_score,
    grade: report.grade,
    gap_skills: (report.gap_skills || []).slice(0, 5),
  };
}

async function resolveJob(args, runtime, options = {}) {
  if (args.job_id) {
    const job = await getJob(args.job_id);
    if (job) return job;
  }
  const query = String(args.job_query || "").trim();
  if (query) {
    const jobs = await listJobs({ query });
    if (jobs.length) return jobs[0];
    const relaxed = await listJobs({ company: query });
    if (relaxed.length) return relaxed[0];
    const fuzzy = await fuzzyFindJob(query);
    if (fuzzy) return fuzzy;
  }
  if (options.fallbackToLastJob && runtime.session.lastJobId) {
    return getJob(runtime.session.lastJobId);
  }
  return null;
}

async function fuzzyFindJob(query) {
  const normalizedQuery = query.toLowerCase().replace(/\s+/g, "");
  if (normalizedQuery.length < 2) return null;
  const jobs = await listJobs({});
  let best = null;
  let bestScore = 0;
  for (const job of jobs) {
    const company = String(job.company || "").toLowerCase();
    const title = String(job.job_title || "").toLowerCase();
    let score = 0;
    if (company && normalizedQuery.includes(company)) score += 1;
    score += bigramOverlap(normalizedQuery, title) * 2;
    if (score > bestScore) {
      bestScore = score;
      best = job;
    }
  }
  return bestScore >= 0.8 ? best : null;
}

function bigramOverlap(haystack, needle) {
  if (!needle || needle.length < 2) return 0;
  const grams = new Set();
  for (let index = 0; index < haystack.length - 1; index += 1) grams.add(haystack.slice(index, index + 2));
  let hits = 0;
  let total = 0;
  for (let index = 0; index < needle.length - 1; index += 1) {
    total += 1;
    if (grams.has(needle.slice(index, index + 2))) hits += 1;
  }
  return total ? hits / total : 0;
}
