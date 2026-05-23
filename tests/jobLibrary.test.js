import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { normalizeJob } from "../src/domain/jdParser.js";
import { expandGeneratedSeeds } from "../src/domain/jobSeedGenerator.js";

test("expanded job library includes campus jobs and more companies", async () => {
  const base = JSON.parse(await readFile(new URL("../data/jobs.seed.json", import.meta.url), "utf8"));
  const expanded = JSON.parse(await readFile(new URL("../data/jobs.expanded.seed.json", import.meta.url), "utf8"));
  const generatedConfig = JSON.parse(await readFile(new URL("../data/jobs.generated.seed.json", import.meta.url), "utf8"));
  const generated = expandGeneratedSeeds(generatedConfig);
  const jobs = [...base, ...expanded, ...generated].map(normalizeJob);

  assert.ok(jobs.length >= 120);
  assert.ok(new Set(jobs.map((job) => job.company)).size >= 25);
  assert.ok(jobs.filter((job) => job.recruitment_type === "校招").length >= 60);
  assert.ok(jobs.filter((job) => job.recruitment_type === "实习").length >= 10);
  assert.ok(jobs.some((job) => job.company === "百度" && job.recruitment_type === "校招"));
  assert.ok(jobs.some((job) => job.company === "华为" && job.recruitment_type === "校招"));
  assert.ok(jobs.some((job) => job.company === "滴滴" && job.recruitment_type === "校招"));
});
