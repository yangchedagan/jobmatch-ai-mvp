import test from "node:test";
import assert from "node:assert/strict";

import {
  buildIntelligenceReport,
  generateSearchKeywords,
  isIntelligenceReportFresh,
  rankTopicCandidates,
} from "../src/domain/intelligenceRadar.js";
import { normalizeJob } from "../src/domain/jdParser.js";

const productJob = normalizeJob({
  id: "job_intel_product",
  job_title: "增长产品经理",
  company: "示例科技有限公司",
  department: "用户增长产品部",
  category: "产品",
  role_family: "product_manager",
  hard_skills: ["需求分析", "用户研究", "数据分析", "A/B 测试", "SQL"],
  soft_skills: ["跨部门推动", "业务理解"],
  experience_required: "2 年以上产品经验",
  education_required: "本科及以上",
  jd_raw_text: "负责用户增长、转化漏斗、需求分析、PRD、数据分析、A/B 测试和跨部门项目推进。",
});

test("generateSearchKeywords builds primary, expanded, and backup queries from JD", () => {
  const keywords = generateSearchKeywords(productJob);

  assert.equal(keywords.length, 3);
  assert.ok(keywords[0].includes("示例科技有限公司"));
  assert.ok(keywords.some((keyword) => keyword.includes("产品经理") && keyword.includes("面经")));
  assert.ok(keywords.some((keyword) => keyword.includes("数据分析")));
});

test("rankTopicCandidates prioritizes role-specific interview topics", () => {
  const topics = rankTopicCandidates(productJob);

  assert.ok(topics.length >= 5);
  assert.equal(topics[0].topic, "需求分析");
  assert.ok(topics.some((topic) => topic.topic === "增长实验"));
});

test("buildIntelligenceReport returns four radar sections and fresh cache metadata", () => {
  const report = buildIntelligenceReport(productJob, { now: "2026-05-17T10:00:00.000Z" });

  assert.equal(report.job_id, productJob.id);
  assert.ok(report.interview_topics.length > 0);
  assert.ok(report.company_background.summary.includes("示例科技"));
  assert.ok(report.industry_background.category);
  assert.ok(report.raw_sources.length >= 8);
  assert.equal(report.meta.sample_warning, true);
  assert.equal(report.meta.source_mode, "search-entry-fallback");
  assert.equal(report.meta.interview_post_count, 0);
  assert.equal(isIntelligenceReportFresh(report, new Date("2026-05-18T10:00:00.000Z")), true);
  assert.equal(isIntelligenceReportFresh(report, new Date("2026-05-25T10:00:01.000Z")), false);
});
