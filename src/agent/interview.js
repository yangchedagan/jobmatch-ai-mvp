import { isQwenConfigured, requestQwenJson } from "../llm/qwenClient.js";
import { summarizeJob, summarizeResume } from "../domain/llmAnalysis.js";
import { interviewClosingTone, interviewOpeningTone } from "./tone.js";

const QUESTION_COUNT = 5;

const QUESTIONS_JSON_EXAMPLE = {
  questions: [
    { text: "如果核心转化率下降 5%，你会如何归因并设计验证方案？", focus: "数据分析", type: "专业题" },
    { text: "请用 STAR 结构讲一个你推动跨团队落地的项目。", focus: "跨团队协同", type: "行为题" },
  ],
};

const EVALUATION_JSON_EXAMPLE = {
  score: 7,
  strengths: ["结论先行，有真实项目佐证"],
  improvements: ["缺少量化结果，建议补充数据"],
  follow_up: "面试官可能追问：这个方案上线后核心指标变化多少？",
};

export function isInterviewActive(session) {
  return Boolean(session.interview?.active);
}

export async function startMockInterview(job, resume, radar, runtime) {
  const questions = await buildQuestions(job, resume, radar);
  runtime.session.interview = {
    active: true,
    job_id: job.id,
    company: job.company,
    job_title: job.job_title,
    questions,
    index: 0,
    records: [],
    started_at: new Date().toISOString(),
  };
  return {
    reply: [
      `模拟面试开始：${job.company} · ${job.job_title}，共 ${questions.length} 题，题目来自该岗位的面经高频考点和你的简历缺口。`,
      `${interviewOpeningTone()}像真实面试一样直接输入回答即可，我会逐题点评。`,
      ``,
      formatQuestion(runtime.session.interview),
    ].join("\n"),
    actions: interviewControls(),
  };
}

export async function handleInterviewTurn(text, session, runtime) {
  const interview = session.interview;
  const normalized = String(text || "").trim();

  if (/结束面试|退出面试|停止面试|不面了/.test(normalized)) {
    return finishInterview(session, { aborted: true });
  }
  if (/^跳过|^下一题/.test(normalized)) {
    return advance(session, runtime, { skipped: true });
  }
  if (normalized.length < 5) {
    return {
      reply: `回答有点短，先别急——按「结论 → 依据 → 案例」展开说，你手里是有材料的。当前进度 ${interview.index + 1}/${interview.questions.length}，也可以说“跳过”或“结束面试”。`,
      actions: interviewControls(),
      route: "interview",
    };
  }

  const question = interview.questions[interview.index];
  const evaluation = await evaluateAnswer(question, normalized, interview, runtime);
  interview.records.push({
    question: question.text,
    focus: question.focus,
    answer: normalized.slice(0, 1500),
    score: evaluation.score,
    strengths: evaluation.strengths,
    improvements: evaluation.improvements,
  });

  const feedback = [
    `【第 ${interview.index + 1} 题点评 · ${evaluation.score}/10】`,
    evaluation.strengths.length ? `亮点：${evaluation.strengths.join("；")}` : "",
    evaluation.improvements.length ? `可提升：${evaluation.improvements.join("；")}` : "",
    evaluation.follow_up ? `追问预警：${evaluation.follow_up}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return advance(session, runtime, { feedback });
}

function advance(session, runtime, { feedback = "", skipped = false } = {}) {
  const interview = session.interview;
  if (skipped) {
    const question = interview.questions[interview.index];
    interview.records.push({ question: question.text, focus: question.focus, answer: null, score: null, skipped: true });
  }
  interview.index += 1;

  if (interview.index >= interview.questions.length) {
    const result = finishInterview(session, {});
    return feedback ? { ...result, reply: `${feedback}\n\n${result.reply}` } : result;
  }

  const next = formatQuestion(interview);
  return {
    reply: feedback ? `${feedback}\n\n${next}` : next,
    actions: interviewControls(),
    route: "interview",
  };
}

export function finishInterview(session, { aborted = false } = {}) {
  const interview = session.interview;
  session.interview = null;

  const answered = interview.records.filter((record) => Number.isFinite(record.score));
  const avgScore = answered.length ? Math.round((answered.reduce((sum, record) => sum + record.score, 0) / answered.length) * 10) : null;
  const weak = answered.filter((record) => record.score <= 6);

  const suggestions = weak.length
    ? weak.slice(0, 3).map((record) => `围绕「${record.focus || "该考点"}」补一个含数据结果的 STAR 案例：${(record.improvements || []).join("；") || "让回答经得起追问"}`)
    : ["整体表现稳定，重点把每个案例的量化结果和复盘再打磨一遍。"];

  const reply = aborted && !answered.length
    ? "模拟面试已结束，随时想练随时来——准备好了点击情报雷达卡片下方的“开始模拟面试”即可，不用有压力。"
    : `模拟面试结束：回答 ${answered.length} 题${avgScore !== null ? `，综合评分 ${avgScore}/100` : ""}。${interviewClosingTone(avgScore, answered.length)}完整点评和备战建议见上方报告卡。需要针对某个考点再练，直接告诉我。`;

  return {
    reply,
    cards: answered.length || interview.records.length
      ? [
          {
            type: "interview_report",
            title: `面试模拟报告 · ${interview.company}`,
            data: {
              company: interview.company,
              job_title: interview.job_title,
              total_score: avgScore,
              records: interview.records,
              suggestions,
            },
          },
        ]
      : [],
    actions: [
      { label: "再来一轮模拟面试", command: { skill: "mock_interview", args: { job_id: interview.job_id } } },
      { label: "推荐更多岗位", command: { skill: "recommend_jobs", args: { limit: 10 } } },
    ],
    route: "interview",
  };
}

function formatQuestion(interview) {
  const question = interview.questions[interview.index];
  return `第 ${interview.index + 1}/${interview.questions.length} 题 · ${question.type || "专业题"}（考察：${question.focus || "综合能力"}）\n${question.text}`;
}

function interviewControls() {
  return [
    { label: "跳过这题", command: { skill: "mock_interview_control", args: { op: "skip" } } },
    { label: "结束面试", command: { skill: "mock_interview_control", args: { op: "end" } } },
  ];
}

async function buildQuestions(job, resume, radar) {
  if (isQwenConfigured()) {
    try {
      const payload = await requestQwenJson({
        system:
          `You are a senior interviewer at ${job.company || "a top tech company"}. Design ${QUESTION_COUNT} mock interview questions in Simplified Chinese. Mix: 2 from the radar's high-frequency topics, 1-2 probing the resume gaps or projects, 1 behavioral (STAR). Each question must be specific to this job, answerable verbally in 2-3 minutes. Return compact valid json only. Example: ${JSON.stringify(QUESTIONS_JSON_EXAMPLE)}`,
        user: JSON.stringify({
          job: summarizeJob(job),
          resume: resume ? summarizeResume(resume) : null,
          radar_topics: (radar?.interview_topics || []).slice(0, 8).map((topic) => ({
            topic: topic.topic,
            frequency: topic.frequency,
            example_questions: (topic.example_questions || []).slice(0, 2),
          })),
        }),
        example: QUESTIONS_JSON_EXAMPLE,
        maxTokens: 1100,
      });
      const questions = (payload.questions || [])
        .map((item) => ({
          text: String(item.text || "").trim(),
          focus: String(item.focus || "").trim(),
          type: String(item.type || "专业题").trim(),
        }))
        .filter((item) => item.text.length > 5)
        .slice(0, QUESTION_COUNT);
      if (questions.length >= 3) return questions;
    } catch {
      // 千问不可用时走确定性兜底
    }
  }
  return buildFallbackQuestions(job, resume, radar);
}

function buildFallbackQuestions(job, resume, radar) {
  const questions = [];
  for (const topic of radar?.interview_topics || []) {
    for (const example of topic.example_questions || []) {
      if (questions.length >= 3) break;
      questions.push({ text: example, focus: topic.topic, type: "专业题" });
    }
    if (questions.length >= 3) break;
  }
  const project = resume?.projects?.[0];
  if (project?.name) {
    questions.push({
      text: `请深挖你简历里的「${project.name}」项目：目标是什么、你的关键决策是什么、最终数据结果如何？`,
      focus: "项目深挖",
      type: "项目题",
    });
  }
  questions.push({
    text: `请用 STAR 结构讲一次你推动跨团队协作、把有分歧的方案落地的经历，重点说你的动作和结果。`,
    focus: "跨团队协同",
    type: "行为题",
  });
  return questions.slice(0, QUESTION_COUNT);
}

async function evaluateAnswer(question, answer, interview, runtime) {
  if (isQwenConfigured()) {
    try {
      const payload = await requestQwenJson({
        system:
          `You are a strict but constructive interviewer at ${interview.company || "a top tech company"}. Evaluate the candidate's answer in Simplified Chinese: score 1-10, 1-2 strengths, 1-2 improvements, and one likely follow-up question. Judge structure (conclusion first), evidence (real project + data), and depth. Return compact valid json only. Example: ${JSON.stringify(EVALUATION_JSON_EXAMPLE)}`,
        user: JSON.stringify({ question: question.text, focus: question.focus, answer }),
        example: EVALUATION_JSON_EXAMPLE,
        maxTokens: 500,
      });
      const score = Math.min(10, Math.max(1, Math.round(Number(payload.score) || 5)));
      return {
        score,
        strengths: normalizeList(payload.strengths, 2),
        improvements: normalizeList(payload.improvements, 2),
        follow_up: String(payload.follow_up || "").trim().slice(0, 200),
      };
    } catch {
      // 兜底启发式点评
    }
  }
  return evaluateAnswerFallback(answer);
}

function evaluateAnswerFallback(answer) {
  const hasNumbers = /\d/.test(answer);
  const isLong = answer.length >= 80;
  const score = 5 + (hasNumbers ? 2 : 0) + (isLong ? 1 : 0);
  return {
    score,
    strengths: [isLong ? "回答有一定展开" : "作答简洁"],
    improvements: [
      hasNumbers ? "建议按「结论→动作→结果」重排结构，让重点更靠前" : "缺少量化结果，补充具体数据（转化率、覆盖率、耗时等）",
    ],
    follow_up: "面试官大概率会追问：这件事里哪个决策是你个人拍板的？依据是什么？",
  };
}

function normalizeList(value, limit) {
  const list = Array.isArray(value) ? value : String(value || "").split(/\n+/);
  return list.map((item) => String(item || "").trim()).filter(Boolean).slice(0, limit);
}
