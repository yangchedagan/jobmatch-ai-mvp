import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DATA_DIR = path.join(ROOT_DIR, "data");
const SEED_FILES = ["jobs.seed.json", "jobs.expanded.seed.json", "jobs.generated.seed.json", "crawler.sources.json"];

test("demo mode protects admin APIs, redacts resume responses, and avoids persistence", async (t) => {
  const dataDir = await prepareDataDir();
  const server = await startDemoServer(dataDir);
  t.after(async () => {
    await stopServer(server.child);
    await rm(dataDir, { recursive: true, force: true });
  });

  const admin = await fetch(`${server.baseUrl}/api/admin`);
  assert.equal(admin.status, 404);

  const resumeList = await fetch(`${server.baseUrl}/api/resumes`);
  assert.equal(resumeList.status, 404);

  const crawl = await fetch(`${server.baseUrl}/api/jobs/crawl`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(crawl.status, 404);

  const blockedCors = await fetch(`${server.baseUrl}/api/resumes/parse`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://example.invalid",
      "Access-Control-Request-Method": "POST",
    },
  });
  assert.equal(blockedCors.status, 403);

  const allowedCors = await fetch(`${server.baseUrl}/api/resumes/parse`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://allowed.example",
      "Access-Control-Request-Method": "POST",
    },
  });
  assert.equal(allowedCors.status, 204);
  assert.equal(allowedCors.headers.get("access-control-allow-origin"), "http://allowed.example");

  const resumeText = [
    "张明",
    "电话：13812345678",
    "邮箱：zhangming@example.com",
    "求职意向：产品经理",
    "技能：产品设计 / 需求分析 / SQL / 数据分析 / PRD",
    "项目经验：负责增长实验、A/B 测试和指标体系建设。",
  ].join("\n");

  const parsedResponse = await fetch(`${server.baseUrl}/api/resumes/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resumeText }),
  });
  assert.equal(parsedResponse.status, 201);
  const parsed = await parsedResponse.json();
  assert.ok(parsed.resume.id);
  assert.equal(parsed.resume.raw_text, undefined);
  assert.equal(parsed.resume.email, null);
  assert.equal(parsed.resume.contact, null);
  assert.equal(parsed.resume.pii_redacted, true);

  const persistedResumes = JSON.parse(await readFile(path.join(dataDir, "resumes.json"), "utf8"));
  assert.deepEqual(persistedResumes, []);

  const jobsResponse = await fetch(`${server.baseUrl}/api/jobs`);
  assert.equal(jobsResponse.status, 200);
  const { jobs } = await jobsResponse.json();
  assert.ok(jobs.length > 0);

  const matchResponse = await fetch(`${server.baseUrl}/api/match`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resumeId: parsed.resume.id, jobId: jobs[0].id, targetRole: "product_manager" }),
  });
  assert.equal(matchResponse.status, 200);
  const { report } = await matchResponse.json();
  assert.equal(report.resume_id, parsed.resume.id);

  const persistedReports = JSON.parse(await readFile(path.join(dataDir, "report-cache.json"), "utf8"));
  assert.deepEqual(persistedReports, {});

  const logText = await readFile(path.join(dataDir, "admin-log.json"), "utf8");
  assert.equal(logText.includes("zhangming@example.com"), false);
  assert.equal(logText.includes("13812345678"), false);
  assert.equal(logText.includes(resumeText), false);
});

async function prepareDataDir() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "jobmatch-security-"));
  await Promise.all(SEED_FILES.map((file) => cp(path.join(SOURCE_DATA_DIR, file), path.join(dataDir, file))));
  return dataDir;
}

async function startDemoServer(dataDir) {
  const port = 56000 + Math.floor(Math.random() * 5000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      NODE_ENV: "production",
      DEMO_MODE: "true",
      HOST: "127.0.0.1",
      PORT: String(port),
      CORS_ORIGIN: "http://allowed.example",
      JOBMATCH_DATA_DIR: dataDir,
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
