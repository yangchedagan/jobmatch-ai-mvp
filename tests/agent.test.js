import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { matchRule } from "../src/agent/router.js";
import { getSkill, skills, toQwenTools } from "../src/agent/skills.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DATA_DIR = path.join(ROOT_DIR, "data");
const SEED_FILES = ["jobs.seed.json", "jobs.expanded.seed.json", "jobs.generated.seed.json", "crawler.sources.json"];

const SAMPLE_RESUME = [
  "张明",
  "求职意向：产品经理，北京 / 杭州",
  "教育背景",
  "浙江大学 信息管理与信息系统 本科 2017-2021",
  "工作经历",
  "杭州某科技公司 产品经理 2021-2025",
  "负责电商交易链路和会员增长产品，完成用户研究、竞品分析、需求分析、PRD、原型设计、数据埋点和 A/B 测试。",
  "项目经验",
  "会员增长与优惠券策略平台：基于用户分层、增长策略、数据分析优化领取、核销、复购链路。",
  "技能栈",
  "产品设计 / 需求分析 / 用户研究 / 数据分析 / SQL / A/B 测试 / 指标体系 / 用户增长 / 项目管理",
].join("\n");

test("skill registry exposes valid tool definitions", () => {
  assert.equal(skills.length, 11);
  const tools = toQwenTools();
  assert.ok(tools.length >= 8);
  for (const tool of tools) {
    assert.equal(tool.type, "function");
    assert.ok(tool.function.name);
    assert.ok(tool.function.description.length > 10);
    assert.equal(tool.function.parameters.type, "object");
  }
  const hidden = tools.find((tool) => tool.function.name === "answer_question");
  assert.equal(hidden, undefined);
  const hiddenControl = tools.find((tool) => tool.function.name === "mock_interview_control");
  assert.equal(hiddenControl, undefined);
  assert.ok(getSkill("answer_question"));
  assert.ok(getSkill("mock_interview"));
  assert.equal(getSkill("sync_jobs").adminOnly, true);
  assert.equal(getSkill("crawl_jobs").adminOnly, true);
});

test("rule router maps natural language to skills", () => {
  assert.equal(matchRule("解析一下我的简历").skill, "parse_resume");
  assert.equal(matchRule(SAMPLE_RESUME).skill, "parse_resume");
  assert.equal(matchRule(SAMPLE_RESUME).args.resume_text, SAMPLE_RESUME);
  assert.equal(matchRule("推荐 Top10 岗位").skill, "recommend_jobs");
  assert.equal(matchRule("匹配一下字节跳动的产品岗").skill, "match_job");
  assert.equal(matchRule("这个岗位面试考什么").skill, "intelligence_radar");
  assert.equal(matchRule("同步岗位库").skill, "sync_jobs");
  assert.equal(matchRule("抓取最新岗位").skill, "crawl_jobs");
  assert.equal(matchRule("模拟面试").skill, "mock_interview");
  const search = matchRule("找找产品经理的校招岗位");
  assert.equal(search.skill, "search_jobs");
  assert.equal(search.args.recruitment_type, "校招");
  assert.equal(matchRule("你好呀").skill, "answer_question");
});

test("agent chat completes the loop with rule fallback in demo mode", async (t) => {
  const dataDir = await prepareDataDir();
  const server = await startServer(dataDir, { DEMO_MODE: "true", QWEN_API_KEY: "" });
  t.after(async () => {
    await stopServer(server.child);
    await rm(dataDir, { recursive: true, force: true });
  });

  // 1. 空消息被拒绝
  const empty = await postChat(server.baseUrl, { message: "" });
  assert.equal(empty.status, 422);

  // 2. 粘贴简历 → parse_resume，demo 模式脱敏
  const parsed = await postChat(server.baseUrl, { message: SAMPLE_RESUME });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.body.route, "rules");
  assert.equal(parsed.body.skill_calls[0].skill, "parse_resume");
  const resumeCard = parsed.body.cards.find((card) => card.type === "resume");
  assert.ok(resumeCard);
  assert.equal(resumeCard.data.pii_redacted, true);
  assert.equal(resumeCard.data.raw_text, undefined);
  const sessionId = parsed.body.sessionId;
  assert.ok(sessionId);

  // 3. 同会话推荐岗位 → recommend_jobs 带排行卡片
  const recommend = await postChat(server.baseUrl, { sessionId, message: "推荐 Top10 岗位" });
  assert.equal(recommend.status, 200);
  assert.equal(recommend.body.sessionId, sessionId);
  assert.equal(recommend.body.skill_calls[0].skill, "recommend_jobs");
  const rankingCard = recommend.body.cards.find((card) => card.type === "job_ranking");
  assert.ok(rankingCard);
  assert.ok(rankingCard.data.length > 0);
  assert.ok(rankingCard.data[0].total_score >= rankingCard.data[rankingCard.data.length - 1].total_score);

  // 4. 岗位筛选 → search_jobs
  const search = await postChat(server.baseUrl, { sessionId, message: "找找产品经理的校招岗位" });
  assert.equal(search.status, 200);
  assert.equal(search.body.skill_calls[0].skill, "search_jobs");
  const jobListCard = search.body.cards.find((card) => card.type === "job_list");
  assert.ok(jobListCard);
  assert.ok(jobListCard.data.every((job) => job.recruitment_type.includes("校招")));

  // 5. demo 模式下管理员技能被拦截
  const sync = await postChat(server.baseUrl, { sessionId, message: "同步岗位库" });
  assert.equal(sync.status, 200);
  assert.equal(sync.body.skill_calls[0].skill, "sync_jobs");
  assert.ok(sync.body.reply.includes("管理员"));
  assert.equal(sync.body.cards.length, 0);

  // 6. demo 模式下简历不落盘
  const persistedResumes = JSON.parse(await readFile(path.join(dataDir, "resumes.json"), "utf8"));
  assert.deepEqual(persistedResumes, []);

  // 7. 没有简历的新会话直接匹配 → 引导上传
  const guarded = await postChat(server.baseUrl, { message: "匹配一下字节跳动的产品岗" });
  assert.equal(guarded.status, 200);
  assert.ok(guarded.body.reply.includes("简历"));

  // 8. 命令通道：卡片多选岗位 → 批量匹配报告 + 情报雷达建议动作
  const pickedIds = jobListCard.data.slice(0, 2).map((job) => job.id);
  const batch = await postChat(server.baseUrl, {
    sessionId,
    command: { skill: "match_job", args: { job_ids: pickedIds }, label: "生成匹配报告（2 个岗位）" },
  });
  assert.equal(batch.status, 200);
  assert.equal(batch.body.route, "command");
  const reportCards = batch.body.cards.filter((card) => card.type === "match_report");
  assert.equal(reportCards.length, 2);
  assert.ok(batch.body.reply.includes("情报雷达"));
  const radarActions = (batch.body.actions || []).filter((action) => action.command?.skill === "intelligence_radar");
  assert.equal(radarActions.length, 2);

  // 9. 命令通道：点击建议动作开启情报雷达
  const radar = await postChat(server.baseUrl, {
    sessionId,
    command: radarActions[0].command ? { ...radarActions[0].command, label: radarActions[0].label } : null,
  });
  assert.equal(radar.status, 200);
  assert.equal(radar.body.route, "command");
  assert.ok(radar.body.cards.some((card) => card.type === "radar"));

  // 10. 命令通道也受管理员技能拦截
  const guardedCommand = await postChat(server.baseUrl, {
    sessionId,
    command: { skill: "crawl_jobs", args: {}, label: "抓取岗位" },
  });
  assert.equal(guardedCommand.status, 200);
  assert.ok(guardedCommand.body.reply.includes("管理员"));

  // 11. 模拟面试：启动 → 答题 → 跳过 → 结束，产出面试报告卡
  const radarJobId = radarActions[0].command.args.job_id;
  const interviewStart = await postChat(server.baseUrl, {
    sessionId,
    command: { skill: "mock_interview", args: { job_id: radarJobId }, label: "开始模拟面试" },
  });
  assert.equal(interviewStart.status, 200);
  assert.ok(interviewStart.body.reply.includes("第 1/"));
  assert.ok((interviewStart.body.actions || []).some((action) => action.label === "结束面试"));

  const answer1 = await postChat(server.baseUrl, {
    sessionId,
    message: "我会先拆解漏斗定位问题环节，再用 A/B 测试验证假设，此前项目中核心转化率提升了 18%。",
  });
  assert.equal(answer1.status, 200);
  assert.ok(answer1.body.reply.includes("点评"));
  assert.ok(answer1.body.reply.includes("第 2/"));

  const skip = await postChat(server.baseUrl, {
    sessionId,
    command: { skill: "mock_interview_control", args: { op: "skip" }, label: "跳过这题" },
  });
  assert.equal(skip.status, 200);
  assert.ok(skip.body.reply.includes("第 3/"));

  const end = await postChat(server.baseUrl, { sessionId, message: "结束面试" });
  assert.equal(end.status, 200);
  const interviewReport = end.body.cards.find((card) => card.type === "interview_report");
  assert.ok(interviewReport);
  assert.equal(interviewReport.data.records.length, 2);
  assert.ok((end.body.actions || []).some((action) => action.command?.skill === "mock_interview"));

  // 12. 面试结束后会话恢复正常路由
  const backToNormal = await postChat(server.baseUrl, { sessionId, message: "推荐 Top10 岗位" });
  assert.equal(backToNormal.status, 200);
  assert.equal(backToNormal.body.skill_calls[0].skill, "recommend_jobs");
});

async function postChat(baseUrl, payload) {
  const response = await fetch(`${baseUrl}/api/agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function prepareDataDir() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "jobmatch-agent-"));
  await Promise.all(SEED_FILES.map((file) => cp(path.join(SOURCE_DATA_DIR, file), path.join(dataDir, file))));
  return dataDir;
}

async function startServer(dataDir, extraEnv = {}) {
  const port = 56000 + Math.floor(Math.random() * 5000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      JOBMATCH_DATA_DIR: dataDir,
      SEMANTIC_MATCH_ENABLED: "false",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { child, baseUrl };
    } catch {
      // Wait for the listener to be ready.
    }
    await sleep(100);
  }

  await stopServer(child);
  throw new Error(`Server did not start:\n${output}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
