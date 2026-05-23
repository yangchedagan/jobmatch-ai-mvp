import test from "node:test";
import assert from "node:assert/strict";

import { parseResumeText } from "../src/domain/resumeParser.js";

test("parseResumeText extracts core structured fields", () => {
  const resume = parseResumeText(`
张明
电话：13812345678
邮箱：zhangming@example.com
浙江大学 计算机科学与技术 本科 2017-2021
杭州某科技公司 后端开发工程师 2021-2025
负责 Java、Spring Boot、MySQL、Redis、高并发系统研发。
项目经验：交易履约微服务平台，使用 Kafka、Docker 和 Linux。
软素质：团队协作、问题分析、结果导向
`);

  assert.equal(resume.name, "张明");
  assert.equal(resume.email, "zhangming@example.com");
  assert.ok(resume.skills.includes("Java"));
  assert.ok(resume.skills.includes("Spring Boot"));
  assert.ok(resume.soft_skills.includes("团队协作"));
  assert.ok(resume.highest_degree_rank >= 3);
});

