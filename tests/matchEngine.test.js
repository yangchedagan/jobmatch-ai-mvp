import test from "node:test";
import assert from "node:assert/strict";

import { normalizeJob } from "../src/domain/jdParser.js";
import { matchResumeToJob, rankJobsForResume } from "../src/domain/matchEngine.js";
import { parseResumeText } from "../src/domain/resumeParser.js";

test("matchResumeToJob returns weighted score and gap list", () => {
  const resume = parseResumeText(`
李雷
电话：13911112222
邮箱：lilei@example.com
北京大学 软件工程 本科 2016-2020
某科技公司 后端工程师 2020-2025
项目经验：订单系统，使用 Java、Spring Boot、MySQL、Redis、Kafka，支撑高并发流量。
技能：Java、Spring Boot、MySQL、Redis、Kafka、Docker、Linux、微服务、高并发
软素质：团队协作、问题分析
`);
  const job = normalizeJob({
    id: "job_test",
    job_title: "后端工程师",
    company: "测试公司",
    location: ["北京"],
    hard_skills: ["Java", "Spring Boot", "MySQL", "Redis", "Kafka", "分布式系统"],
    soft_skills: ["团队协作", "结果导向"],
    experience_required: "3 年以上后端开发经验",
    education_required: "本科及以上",
    jd_raw_text: "负责交易系统后端开发。",
  });

  const report = matchResumeToJob(resume, job);
  assert.ok(report.total_score >= 70);
  assert.equal(report.dimensions.length, 5);
  assert.ok(report.gap_skills.some((gap) => gap.keyword === "分布式系统"));
});

test("product-manager focus ranks product jobs before technical jobs", () => {
  const resume = parseResumeText(`
王芳
电话：13911112222
邮箱：pm@example.com
求职意向：产品经理
北京大学 信息管理 本科 2016-2020
某互联网公司 产品经理 2020-2025
项目经验：会员增长平台，负责用户研究、竞品分析、需求分析、PRD、原型设计、数据埋点、A/B 测试和指标体系。
技能：产品设计、需求分析、用户研究、竞品分析、数据分析、SQL、BI、数据埋点、A/B 测试、指标体系、用户增长、增长策略、项目管理
软素质：沟通能力、跨部门推动、业务理解、结果导向
`);
  const productJob = normalizeJob({
    id: "job_product",
    job_title: "增长产品经理",
    company: "测试产品公司",
    category: "产品",
    hard_skills: ["用户增长", "增长策略", "数据分析", "A/B 测试", "数据埋点", "指标体系"],
    soft_skills: ["业务理解", "跨部门推动"],
    experience_required: "2 年以上增长产品经验",
    education_required: "本科及以上",
    jd_raw_text: "负责增长产品和实验迭代。",
  });
  const techJob = normalizeJob({
    id: "job_algorithm",
    job_title: "推荐算法工程师",
    company: "测试技术公司",
    category: "技术",
    hard_skills: ["Python", "机器学习", "推荐系统", "算法"],
    soft_skills: ["问题分析"],
    experience_required: "不限",
    education_required: "本科及以上",
    jd_raw_text: "负责推荐算法策略。",
  });

  const [top] = rankJobsForResume(resume, [techJob, productJob], 2, { targetRole: "product_manager" });
  assert.equal(top.job_id, "job_product");
  assert.equal(top.role_focus, "产品经理");
});
