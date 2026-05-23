import test from "node:test";
import assert from "node:assert/strict";

import { extractJobsFromHtml, isPathAllowed, parseRobotsTxt } from "../src/domain/jobCrawler.js";

test("robots parser blocks disallowed paths and honors specific allow rules", () => {
  const rules = parseRobotsTxt(`
User-agent: *
Disallow: /private
Allow: /private/public
`);

  assert.equal(isPathAllowed("/jobs", rules), true);
  assert.equal(isPathAllowed("/private/jobs", rules), false);
  assert.equal(isPathAllowed("/private/public/jobs", rules), true);
});

test("crawler extracts role candidates from official page html", () => {
  const jobs = extractJobsFromHtml(
    `
    <html><body>
      <h2>2026 校园招聘</h2>
      <article>产品经理：负责用户研究、需求分析、PRD、数据分析。</article>
      <article>后端开发工程师：熟悉 Java、Go、MySQL、Redis。</article>
    </body></html>
    `,
    { key: "demo", company: "示例公司", channels: ["校招"], locations: ["北京"] },
    "https://example.com/campus",
  );

  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((job) => job.recruitment_type === "校招"));
  assert.ok(jobs.some((job) => job.job_title.includes("产品经理")));
  assert.ok(jobs.some((job) => job.hard_skills.includes("Java")));
});
