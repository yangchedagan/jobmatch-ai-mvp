import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractPdfText } from "./src/domain/pdfText.js";
import { ocrImageBuffer, ocrPdfBuffer } from "./src/domain/ocrAdapter.js";
import { parseResumeText } from "./src/domain/resumeParser.js";
import { buildIntelligenceReport } from "./src/domain/intelligenceRadar.js";
import {
  appendAdminEvent as appendAdminEventToStore,
  cacheReport,
  deleteIntelligenceReport,
  ensureDataStore,
  getAdminDashboard,
  getCachedReport,
  getIntelligenceReport,
  getJob,
  getResume,
  getStats,
  listJobs,
  listResumes,
  runLiveJobCrawl,
  runJobSync,
  saveIntelligenceReport,
  saveResume,
  updateResume,
} from "./src/storage.js";
import { matchResumeToJob, rankJobsForResume } from "./src/domain/matchEngine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = normalizePort(process.env.PORT, 5173);
const HOST = process.env.HOST || "0.0.0.0";
const PORT_RETRY_LIMIT = Number(process.env.PORT_RETRY_LIMIT || 10);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_JSON_BYTES = 512 * 1024;
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const DEMO_MODE = parseBoolean(process.env.DEMO_MODE, IS_PRODUCTION);
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "");
const ALLOWED_CORS_ORIGINS = String(process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const SENSITIVE_ROUTES_REQUIRE_ADMIN = IS_PRODUCTION || DEMO_MODE || Boolean(ADMIN_TOKEN);
const DEMO_TTL_MS = Number(process.env.DEMO_TTL_MS || 30 * 60 * 1000);
const RUN_ID = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const MATCH_ENGINE_VERSION = "score-v2";
const intelligenceTasks = new Map();
const demoResumes = new Map();
const demoReportCache = new Map();
const rateLimitBuckets = new Map();
const TASK_TTL_MS = 60 * 60 * 1000;

async function appendAdminEvent(event) {
  return appendAdminEventToStore(sanitizeAdminEvent(event));
}

const initialJobSync = await ensureDataStore();
await appendAdminEvent({
  type: "job_sync",
  level: "info",
  message: "Job library synchronized on startup",
  run_id: RUN_ID,
  detail: {
    inserted_or_updated: initialJobSync.inserted_or_updated,
    source: initialJobSync.source,
  },
});
const server = createServer(async (req, res) => {
  const startedAt = Date.now();
  const requestPath = safeRequestPath(req);
  const corsAllowed = applyResponseHeaders(req, res);
  try {
    await handleRequest(req, res, { corsAllowed });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error(error);
    await appendAdminEvent({
      type: "error",
      level: "error",
      message: error.message || "Unhandled request error",
      run_id: RUN_ID,
      detail: {
        method: req.method,
        path: requestPath,
        status,
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
        payload: sanitizeForLog(error.payload || null),
      },
    });
    sendJson(
      res,
      status,
      error.payload || {
        error: "INTERNAL_ERROR",
        message: "服务暂时不可用，请稍后重试。",
        detail: process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    );
  } finally {
    if (requestPath.startsWith("/api/")) {
      await appendAdminEvent({
        type: "request",
        level: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
        message: `${req.method} ${requestPath} ${res.statusCode}`,
        run_id: RUN_ID,
        detail: {
          method: req.method,
          path: requestPath,
          status: res.statusCode,
          duration_ms: Date.now() - startedAt,
        },
      });
    }
  }
});

const ACTIVE_PORT = await listenWithPortRetry(server, PORT, PORT_RETRY_LIMIT);
console.log(`JobMatch AI MVP running at http://localhost:${ACTIVE_PORT}`);
await appendAdminEvent({
  type: "server_start",
  level: "info",
  message: "Server started",
  run_id: RUN_ID,
  detail: {
    requested_port: PORT,
    port: ACTIVE_PORT,
    host: HOST,
    node: process.version,
    pid: process.pid,
    demo_mode: DEMO_MODE,
  },
});

async function listenWithPortRetry(serverInstance, requestedPort, retryLimit) {
  let currentPort = normalizePort(requestedPort, 5173);
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    try {
      await listenOnce(serverInstance, currentPort);
      const address = serverInstance.address();
      return typeof address === "object" && address?.port ? address.port : currentPort;
    } catch (error) {
      if (currentPort === 0 || error.code !== "EADDRINUSE" || attempt === retryLimit) throw error;
      const nextPort = currentPort + 1;
      console.warn(`Port ${currentPort} is already in use, trying ${nextPort}...`);
      currentPort = nextPort;
    }
  }
  return currentPort;
}

function listenOnce(serverInstance, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      serverInstance.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      serverInstance.off("error", onError);
      resolve();
    };
    serverInstance.once("error", onError);
    serverInstance.once("listening", onListening);
    serverInstance.listen(port, HOST);
  });
}

async function handleRequest(req, res, context = {}) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);

  if (!context.corsAllowed && req.headers.origin) {
    sendJson(res, 403, { error: "CORS_ORIGIN_DENIED", message: "Origin is not allowed." });
    return;
  }

  if (req.method === "OPTIONS") {
    if (!context.corsAllowed) {
      sendJson(res, 403, { error: "CORS_ORIGIN_DENIED", message: "Origin is not allowed." });
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      mode: {
        demo: DEMO_MODE,
        admin: Boolean(ADMIN_TOKEN),
        protected_admin: SENSITIVE_ROUTES_REQUIRE_ADMIN,
      },
      stats: publicStats(await getStats()),
    });
    return;
  }

  if (pathname === "/api/admin" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const limit = Number(url.searchParams.get("limit") || 80);
    sendJson(res, 200, { dashboard: publicDashboard(await getAdminDashboard(limit)) });
    return;
  }

  if (pathname === "/api/jobs" && req.method === "GET") {
    const filters = Object.fromEntries(url.searchParams.entries());
    sendJson(res, 200, { jobs: await listJobs(filters) });
    return;
  }

  if (pathname === "/api/jobs/sync" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    const result = await runJobSync();
    await appendAdminEvent({
      type: "job_sync",
      level: "info",
      message: "Job library synchronized",
      run_id: RUN_ID,
      detail: {
        inserted_or_updated: result.inserted_or_updated,
        source: result.source,
      },
    });
    sendJson(res, 200, result);
    return;
  }

  if (pathname === "/api/jobs/crawl" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    enforceRateLimit(req, "jobs-crawl", { max: 3, windowMs: 10 * 60 * 1000 });
    const payload = await readJsonBody(req, 128 * 1024);
    const result = await runLiveJobCrawl(payload);
    await appendAdminEvent({
      type: "job_crawl",
      level: result.live_jobs ? "info" : "warn",
      message: "Official source crawler finished",
      run_id: RUN_ID,
      detail: {
        sources_checked: result.sources_checked,
        pages_fetched: result.pages_fetched,
        robots_blocked: result.robots_blocked,
        candidates_found: result.candidates_found,
        live_jobs: result.live_jobs,
        merged_jobs: result.merged_jobs,
      },
    });
    sendJson(res, 200, result);
    return;
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch && req.method === "GET") {
    const job = await getJob(jobMatch[1]);
    if (!job) return sendJson(res, 404, { error: "JOB_NOT_FOUND" });
    sendJson(res, 200, { job });
    return;
  }

  if (pathname === "/api/intelligence/start" && req.method === "POST") {
    enforceRateLimit(req, "intelligence-start", { max: 20, windowMs: 10 * 60 * 1000 });
    const payload = await readJsonBody(req, 128 * 1024);
    const jobId = payload.jobId || payload.job_id;
    if (!jobId) return sendJson(res, 400, { error: "JOB_ID_REQUIRED", message: "jobId is required" });
    const job = await getJob(jobId);
    if (!job) return sendJson(res, 404, { error: "JOB_NOT_FOUND" });

    const task = createIntelligenceTask(job.id);
    await appendAdminEvent({
      type: "intelligence_start",
      level: "info",
      message: "Intelligence radar started",
      run_id: RUN_ID,
      detail: {
        task_id: task.task_id,
        job_id: job.id,
        company: job.company,
        job_title: job.job_title,
        refresh: Boolean(payload.refresh),
      },
    });
    runIntelligenceTask(task.task_id, job, { refresh: Boolean(payload.refresh) });
    sendJson(res, 202, { taskId: task.task_id, estimatedSeconds: payload.refresh ? 6 : 3 });
    return;
  }

  const intelligenceStatusMatch = pathname.match(/^\/api\/intelligence\/status\/([^/]+)$/);
  if (intelligenceStatusMatch && req.method === "GET") {
    const task = intelligenceTasks.get(intelligenceStatusMatch[1]);
    if (!task) return sendJson(res, 404, { error: "TASK_NOT_FOUND" });
    sendJson(res, 200, task);
    return;
  }

  const intelligenceMatch = pathname.match(/^\/api\/intelligence\/([^/]+)$/);
  if (intelligenceMatch && req.method === "GET") {
    const report = await getIntelligenceReport(intelligenceMatch[1]);
    sendJson(res, 200, { report });
    return;
  }

  if (intelligenceMatch && req.method === "DELETE") {
    if (!requireAdmin(req, res)) return;
    const existed = await deleteIntelligenceReport(intelligenceMatch[1]);
    await appendAdminEvent({
      type: "intelligence_delete",
      level: "info",
      message: "Intelligence report deleted",
      run_id: RUN_ID,
      detail: { job_id: intelligenceMatch[1], existed },
    });
    sendJson(res, 200, { ok: true, existed });
    return;
  }

  if (pathname === "/api/resumes" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const resumes = DEMO_MODE ? listDemoResumes() : await listResumes();
    sendJson(res, 200, { resumes: resumes.map(publicResume) });
    return;
  }

  if (pathname === "/api/resumes/latest" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const resumes = DEMO_MODE ? listDemoResumes() : await listResumes();
    sendJson(res, 200, { resume: resumes[0] ? publicResume(resumes[0]) : null });
    return;
  }

  if (pathname === "/api/resumes/parse" && req.method === "POST") {
    enforceRateLimit(req, "resume-parse", { max: 10, windowMs: 60 * 1000 });
    const resume = await parseResumeRequest(req);
    if (DEMO_MODE) saveDemoResume(resume);
    else await saveResume(resume);
    await appendAdminEvent({
      type: "resume_parse",
      level: resume.warnings?.length ? "warn" : "info",
      message: "Resume parsed",
      run_id: RUN_ID,
      detail: {
        resume_id: resume.id,
        source: resume.source,
        confidence: resume.confidence,
        skill_count: resume.skills?.length || 0,
        warning_count: resume.warnings?.length || 0,
      },
    });
    sendJson(res, 201, { resume: publicResume(resume) });
    return;
  }

  const resumeMatch = pathname.match(/^\/api\/resumes\/([^/]+)$/);
  if (resumeMatch && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const resume = DEMO_MODE ? getDemoResume(resumeMatch[1]) : await getResume(resumeMatch[1]);
    if (!resume) return sendJson(res, 404, { error: "RESUME_NOT_FOUND" });
    sendJson(res, 200, { resume: publicResume(resume) });
    return;
  }

  if (resumeMatch && req.method === "PUT") {
    if (!DEMO_MODE && SENSITIVE_ROUTES_REQUIRE_ADMIN && !requireAdmin(req, res)) return;
    const payload = await readJsonBody(req, MAX_JSON_BYTES);
    const resume = DEMO_MODE ? updateDemoResume(resumeMatch[1], payload.resume || payload) : await updateResume(resumeMatch[1], payload.resume || payload);
    if (!resume) return sendJson(res, 404, { error: "RESUME_NOT_FOUND" });
    await appendAdminEvent({
      type: "resume_update",
      level: "info",
      message: "Resume updated",
      run_id: RUN_ID,
      detail: {
        resume_id: resume.id,
        skill_count: resume.skills?.length || 0,
        soft_skill_count: resume.soft_skills?.length || 0,
      },
    });
    sendJson(res, 200, { resume: publicResume(resume) });
    return;
  }

  if (pathname === "/api/match" && req.method === "POST") {
    enforceRateLimit(req, "match", { max: 60, windowMs: 60 * 1000 });
    const payload = await readJsonBody(req, MAX_JSON_BYTES);
    const { resumeId, jobId, refresh = false, targetRole = null } = payload;
    const resume = await resolveResume(resumeId);
    const job = await getJob(jobId);
    if (!resume) return sendJson(res, 404, { error: "RESUME_NOT_FOUND" });
    if (!job) return sendJson(res, 404, { error: "JOB_NOT_FOUND" });

    const cacheKey = `${MATCH_ENGINE_VERSION}:${resume.id}:${job.id}:${targetRole || "auto"}:${job.updated_at || job.publish_date || "seed"}`;
    let report = refresh ? null : await getReportFromCache(cacheKey);
    const cacheHit = Boolean(report);
    if (!report) {
      report = matchResumeToJob(resume, job, { targetRole });
      await saveReportToCache(cacheKey, report);
    }

    await appendAdminEvent({
      type: "match",
      level: "info",
      message: "Single match generated",
      run_id: RUN_ID,
      detail: {
        resume_id: resume.id,
        job_id: job.id,
        company: job.company,
        job_title: job.job_title,
        total_score: report.total_score,
        grade: report.grade,
        cached: cacheHit,
        target_role: targetRole,
      },
    });

    sendJson(res, 200, { report });
    return;
  }

  if (pathname === "/api/match/batch" && req.method === "POST") {
    enforceRateLimit(req, "match-batch", { max: 60, windowMs: 60 * 1000 });
    const { resumeId, jobIds = [], limit = 10, targetRole = null } = await readJsonBody(req, MAX_JSON_BYTES);
    const resume = await resolveResume(resumeId);
    if (!resume) return sendJson(res, 404, { error: "RESUME_NOT_FOUND" });
    const jobs = await listJobs({});
    const selectedJobs = jobIds.length ? jobs.filter((job) => jobIds.includes(job.id)) : jobs;
    const reports = rankJobsForResume(resume, selectedJobs, Number(limit) || 10, { targetRole });
    await appendAdminEvent({
      type: "match_batch",
      level: "info",
      message: "Batch match generated",
      run_id: RUN_ID,
      detail: {
        resume_id: resume.id,
        requested_jobs: jobIds.length || selectedJobs.length,
        returned_reports: reports.length,
        top_score: reports[0]?.total_score ?? null,
        top_job: reports[0] ? `${reports[0].company} / ${reports[0].job_title}` : null,
        target_role: targetRole,
      },
    });
    sendJson(res, 200, { reports });
    return;
  }

  await serveStatic(pathname, res);
}

function createIntelligenceTask(jobId) {
  cleanupIntelligenceTasks();
  const task = {
    task_id: `intel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    job_id: jobId,
    status: "running",
    stage: "queued",
    progress: 1,
    message: "情报任务已创建",
    report: null,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  intelligenceTasks.set(task.task_id, task);
  return task;
}

function updateIntelligenceTask(taskId, patch) {
  const current = intelligenceTasks.get(taskId);
  if (!current) return null;
  const next = {
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  intelligenceTasks.set(taskId, next);
  return next;
}

async function runIntelligenceTask(taskId, job, options = {}) {
  try {
    updateIntelligenceTask(taskId, {
      stage: "search",
      progress: 12,
      message: "正在搜索面经和相关资料…",
    });

    const cached = options.refresh ? null : await getIntelligenceReport(job.id);
    if (cached) {
      updateIntelligenceTask(taskId, {
        status: "completed",
        stage: "done",
        progress: 100,
        message: `情报简报已就绪（命中缓存，共 ${cached.meta?.total_sources || 0} 条资料）`,
        report: cached,
      });
      return;
    }

    await sleep(250);
    updateIntelligenceTask(taskId, {
      stage: "fetch",
      progress: 45,
      message: "正在抓取与清洗公开线索…",
    });

    await sleep(250);
    updateIntelligenceTask(taskId, {
      stage: "analyze",
      progress: 76,
      message: "正在提炼高频考点…",
    });

    const report = buildIntelligenceReport(job);
    await saveIntelligenceReport(report);

    await sleep(150);
    updateIntelligenceTask(taskId, {
      status: "completed",
      stage: "done",
      progress: 100,
      message: `情报简报已就绪（共 ${report.meta.total_sources} 条资料）`,
      report,
    });

    await appendAdminEvent({
      type: "intelligence_complete",
      level: report.meta.sample_warning ? "warn" : "info",
      message: "Intelligence radar completed",
      run_id: RUN_ID,
      detail: {
        task_id: taskId,
        job_id: job.id,
        company: job.company,
        job_title: job.job_title,
        total_sources: report.meta.total_sources,
        interview_post_count: report.meta.interview_post_count,
        sample_warning: report.meta.sample_warning,
      },
    });
  } catch (error) {
    updateIntelligenceTask(taskId, {
      status: "failed",
      stage: "failed",
      progress: 100,
      message: "部分资料抓取失败，暂未生成可用简报",
      error: error.message,
    });
    await appendAdminEvent({
      type: "intelligence_error",
      level: "error",
      message: error.message || "Intelligence radar failed",
      run_id: RUN_ID,
      detail: { task_id: taskId, job_id: job.id },
    });
  }
}

function cleanupIntelligenceTasks() {
  const now = Date.now();
  for (const [taskId, task] of intelligenceTasks.entries()) {
    const updated = new Date(task.updated_at || task.created_at || 0).getTime();
    if (!Number.isFinite(updated) || now - updated > TASK_TTL_MS) intelligenceTasks.delete(taskId);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePort(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const port = Number(value);
  return Number.isFinite(port) && port >= 0 ? port : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function applyResponseHeaders(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );

  const origin = req.headers.origin;
  if (!origin) return true;
  if (!isCorsOriginAllowed(origin, req)) return false;

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token, Authorization");
  return true;
}

function isCorsOriginAllowed(origin, req) {
  if (!origin) return true;
  if (ALLOWED_CORS_ORIGINS.includes("*")) return true;
  if (ALLOWED_CORS_ORIGINS.includes(origin)) return true;
  if (isSameOrigin(origin, req)) return true;
  if (!ALLOWED_CORS_ORIGINS.length && !IS_PRODUCTION) return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
  return false;
}

function isSameOrigin(origin, req) {
  try {
    const host = (req.headers.host || "").split(":")[0];
    const originHost = new URL(origin).hostname;
    return host && originHost && host === originHost;
  } catch {
    return false;
  }
}

function requireAdmin(req, res) {
  if (!SENSITIVE_ROUTES_REQUIRE_ADMIN) return true;
  if (!ADMIN_TOKEN) {
    sendJson(res, 404, { error: "NOT_FOUND" });
    return false;
  }

  const provided = adminTokenFromRequest(req);
  if (provided && timingSafeEqual(provided, ADMIN_TOKEN)) return true;
  sendJson(res, 401, { error: "UNAUTHORIZED", message: "Admin token is required." });
  return false;
}

function adminTokenFromRequest(req) {
  const headerToken = req.headers["x-admin-token"];
  if (headerToken) return String(Array.isArray(headerToken) ? headerToken[0] : headerToken);
  const authorization = req.headers.authorization || "";
  const match = String(authorization).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && cryptoSafeCompare(left, right);
}

function cryptoSafeCompare(left, right) {
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

function enforceRateLimit(req, name, { max, windowMs }) {
  const now = Date.now();
  const key = `${name}:${clientIp(req)}`;
  const bucket = rateLimitBuckets.get(key) || { startedAt: now, count: 0 };
  if (now - bucket.startedAt > windowMs) {
    bucket.startedAt = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  cleanupRateLimits(now);
  if (bucket.count <= max) return;

  const error = new Error("Too many requests");
  error.statusCode = 429;
  error.payload = { error: "RATE_LIMITED", message: "Too many requests. Please try again later." };
  throw error;
}

function cleanupRateLimits(now = Date.now()) {
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (now - bucket.startedAt > 15 * 60 * 1000) rateLimitBuckets.delete(key);
  }
}

function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}

function resolveResume(resumeId) {
  if (DEMO_MODE) return Promise.resolve(getDemoResume(resumeId));
  return getResume(resumeId);
}

function saveDemoResume(resume) {
  cleanupDemoStores();
  demoResumes.set(resume.id, {
    value: resume,
    expiresAt: Date.now() + DEMO_TTL_MS,
    createdAt: Date.now(),
  });
  return resume;
}

function getDemoResume(id) {
  cleanupDemoStores();
  const record = demoResumes.get(id);
  return record ? record.value : null;
}

function updateDemoResume(id, patch) {
  const resume = getDemoResume(id);
  if (!resume) return null;
  const updated = {
    ...resume,
    ...patch,
    id,
    updated_at: new Date().toISOString(),
    skills: normalizeList(patch.skills ?? resume.skills),
    soft_skills: normalizeList(patch.soft_skills ?? resume.soft_skills),
  };
  saveDemoResume(updated);
  return updated;
}

function listDemoResumes() {
  cleanupDemoStores();
  return [...demoResumes.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((record) => record.value);
}

async function getReportFromCache(key) {
  if (!DEMO_MODE) return getCachedReport(key);
  cleanupDemoStores();
  const item = demoReportCache.get(key);
  if (!item || Date.now() > item.expiresAt) return null;
  return item.report;
}

async function saveReportToCache(key, report) {
  if (!DEMO_MODE) return cacheReport(key, report);
  cleanupDemoStores();
  demoReportCache.set(key, {
    report,
    expiresAt: Date.now() + DEMO_TTL_MS,
  });
}

function cleanupDemoStores() {
  const now = Date.now();
  for (const [id, record] of demoResumes.entries()) {
    if (now > record.expiresAt) demoResumes.delete(id);
  }
  for (const [key, record] of demoReportCache.entries()) {
    if (now > record.expiresAt) demoReportCache.delete(key);
  }
}

function publicStats(stats) {
  if (!DEMO_MODE) return stats;
  return {
    ...stats,
    resumes: demoResumes.size,
    cached_reports: demoReportCache.size,
  };
}

function publicDashboard(dashboard) {
  if (!DEMO_MODE) return dashboard;
  return {
    ...dashboard,
    stats: publicStats(dashboard.stats || {}),
    resume_records: (dashboard.resume_records || []).map((record) => ({
      ...record,
      name: "[redacted]",
      email: null,
      contact: null,
      file_name: null,
    })),
    runtime_logs: sanitizeForLog(dashboard.runtime_logs || []),
    runs: sanitizeForLog(dashboard.runs || []),
    match_events: sanitizeForLog(dashboard.match_events || []),
    job_sync_records: sanitizeForLog(dashboard.job_sync_records || []),
    error_logs: sanitizeForLog(dashboard.error_logs || []),
  };
}

function publicResume(resume) {
  if (!resume) return null;
  if (!DEMO_MODE) return resume;
  const { raw_text, email, contact, file_meta, ...rest } = resume;
  return {
    ...rest,
    email: null,
    contact: null,
    file_meta: file_meta
      ? {
          file_size: file_meta.file_size || null,
          mime_type: file_meta.mime_type || null,
        }
      : null,
    pii_redacted: true,
  };
}

function sanitizeAdminEvent(event = {}) {
  return {
    ...event,
    detail: sanitizeForLog(event.detail || {}),
  };
}

function sanitizeForLog(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeForLog(item));
  if (!value || typeof value !== "object") return redactText(value);

  const hiddenKeys = new Set(["raw_text", "resumeText", "rawText", "email", "contact", "phone", "mobile", "file_name", "filename", "name"]);
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (hiddenKeys.has(key)) {
      result[key] = "[redacted]";
      continue;
    }
    result[key] = sanitizeForLog(nested);
  }
  return result;
}

function redactText(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/(?:\+?86[\s-]?)?1[3-9]\d{9}/g, "[redacted-phone]");
}

function validateUpload(upload) {
  const safeFilename = sanitizeUploadFilename(upload.filename || "resume");
  const extension = path.extname(safeFilename).toLowerCase();
  const allowedExtensions = new Set([".txt", ".md", ".json", ".csv", ".pdf", ".png", ".jpg", ".jpeg"]);
  if (!allowedExtensions.has(extension)) {
    const error = new Error("Unsupported file type");
    error.statusCode = 415;
    error.payload = { error: "UNSUPPORTED_FILE_TYPE", message: "Only PDF, TXT, Markdown, JSON, CSV, PNG, and JPG files are supported." };
    throw error;
  }

  const mime = String(upload.contentType || "").toLowerCase();
  const mimeOk =
    !mime ||
    mime === "application/octet-stream" ||
    (extension === ".pdf" && mime === "application/pdf") ||
    ([".txt", ".md", ".csv"].includes(extension) && mime.startsWith("text/")) ||
    (extension === ".json" && (mime === "application/json" || mime.startsWith("text/"))) ||
    (extension === ".png" && mime === "image/png") ||
    ([".jpg", ".jpeg"].includes(extension) && mime === "image/jpeg");

  if (!mimeOk || !hasExpectedSignature(extension, upload.buffer)) {
    const error = new Error("File content did not match the allowed type");
    error.statusCode = 415;
    error.payload = { error: "INVALID_FILE_CONTENT", message: "File content does not match its declared type." };
    throw error;
  }

  return { extension, safeFilename };
}

function sanitizeUploadFilename(filename) {
  const parsed = path.parse(String(filename || "resume"));
  const name = parsed.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "resume";
  return `${name}${parsed.ext.toLowerCase()}`;
}

function hasExpectedSignature(extension, buffer) {
  if ([".txt", ".md", ".json", ".csv"].includes(extension)) return true;
  if (extension === ".pdf") return buffer.subarray(0, 5).toString("utf8") === "%PDF-";
  if (extension === ".png") return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if ([".jpg", ".jpeg"].includes(extension)) return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  return false;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function parseResumeRequest(req) {
  const contentType = req.headers["content-type"] || "";

  if (contentType.includes("multipart/form-data")) {
    const body = await readRequestBuffer(req, MAX_UPLOAD_BYTES);
    const { fields, files } = parseMultipart(body, contentType);
    const upload = files.find((file) => file.name === "resumeFile" || file.filename);
    const manualText = fields.resumeText || fields.manualText || "";
    const warnings = [];
    let extractedText = "";
    let source = "manual";
    let fileMeta = null;

    if (upload?.buffer?.length) {
      const uploadInfo = validateUpload(upload);
      fileMeta = {
        file_name: uploadInfo.safeFilename,
        file_size: upload.buffer.length,
        mime_type: upload.contentType,
      };
      const extension = uploadInfo.extension;
      source = extension ? extension.slice(1) : "file";

      if ([".txt", ".md", ".json", ".csv"].includes(extension)) {
        extractedText = upload.buffer.toString("utf8");
      } else if (extension === ".pdf") {
        const pdfResult = await extractPdfText(upload.buffer);
        extractedText = pdfResult.text;
        warnings.push(...pdfResult.warnings);

        if (pdfResult.isImagePdf || !extractedText) {
          warnings.push("检测到 PDF 缺少可解析文本层，正在尝试 OCR 识别。");
          try {
            const ocrResult = await ocrPdfBuffer(upload.buffer, {
              lang: "chi_sim+eng",
              scale: 2.0,
              onProgress: (page, total) => console.log(`[OCR] PDF 第 ${page}/${total} 页`),
            });
            extractedText = ocrResult.text;
            warnings.push(...ocrResult.warnings);
          } catch (ocrError) {
            warnings.push(buildOcrWarning(ocrError, "PDF"));
            if (ocrError.statusCode !== 501) console.error("[OCR] PDF OCR error:", ocrError);
          }
        }
      } else if ([".png", ".jpg", ".jpeg"].includes(extension)) {
        warnings.push("检测到图片文件，正在尝试 OCR 识别。");
        try {
          const ocrResult = await ocrImageBuffer(upload.buffer, { lang: "chi_sim+eng" });
          extractedText = ocrResult.text;
          warnings.push(...ocrResult.warnings);
        } catch (ocrError) {
          warnings.push(buildOcrWarning(ocrError, "图片"));
          if (ocrError.statusCode !== 501) console.error("[OCR] Image OCR error:", ocrError);
        }
      } else {
        warnings.push("当前文件类型暂不支持自动解析，请粘贴简历文本。");
      }
    }

    const rawText = [extractedText, manualText].filter(Boolean).join("\n\n").trim();
    if (!rawText) {
      const error = new Error("简历内容为空");
      error.statusCode = 422;
      error.payload = {
        error: "RESUME_TEXT_EMPTY",
        message: "未识别到可解析文本，请上传文字型 PDF / TXT，或直接粘贴简历正文。",
        warnings,
      };
      throw error;
    }

    return parseResumeText(rawText, {
      source,
      fileMeta,
      warnings,
    });
  }

  const payload = await readJsonBody(req, MAX_UPLOAD_BYTES);
  const rawText = String(payload.resumeText || payload.rawText || "").trim();
  if (!rawText) {
    const error = new Error("简历内容为空");
    error.statusCode = 422;
    error.payload = {
      error: "RESUME_TEXT_EMPTY",
      message: "请提供 resumeText 或 rawText。",
    };
    throw error;
  }

  return parseResumeText(rawText, {
    source: "manual",
    fileMeta: payload.fileName ? { file_name: payload.fileName } : null,
  });
}

function buildOcrWarning(error, fileKind) {
  if (error.statusCode === 501) {
    return error.payload?.message || `${fileKind} OCR 依赖未安装，请粘贴简历文本。`;
  }
  return `${fileKind} OCR 识别失败：${error.message}。请上传更清晰文件或直接粘贴简历正文。`;
}

async function serveStatic(pathname, res) {
  const relative = pathname === "/" ? "index.html" : pathname === "/admin" || pathname === "/admin/" ? "admin.html" : pathname.replace(/^\/+/, "");
  const safeRelative = path.normalize(relative).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safeRelative);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "FORBIDDEN" });
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    const finalPath = stat.isDirectory() ? path.join(filePath, "index.html") : filePath;
    const content = await fs.readFile(finalPath);
    res.writeHead(200, {
      "Content-Type": mimeType(finalPath),
      "Cache-Control": "no-store",
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "NOT_FOUND" });
  }
}

function safeRequestPath(req) {
  try {
    return new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
  } catch {
    return req.url || "/";
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(req, maxBytes = MAX_JSON_BYTES) {
  const body = await readRequestBuffer(req, maxBytes);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    const error = new Error("JSON 格式错误");
    error.statusCode = 400;
    error.payload = { error: "INVALID_JSON" };
    throw error;
  }
}

async function readRequestBuffer(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("文件过大");
      error.statusCode = 413;
      error.payload = { error: "PAYLOAD_TOO_LARGE", message: "文件大小不能超过 10 MB。" };
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    const error = new Error("缺少 multipart boundary");
    error.statusCode = 400;
    error.payload = { error: "INVALID_MULTIPART" };
    throw error;
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const raw = buffer.toString("latin1");
  const chunks = raw.split(`--${boundary}`);
  const fields = {};
  const files = [];

  for (const chunk of chunks) {
    if (!chunk || chunk === "--\r\n" || chunk === "--") continue;
    const headerEnd = chunk.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;

    const header = chunk.slice(0, headerEnd);
    let bodyRaw = chunk.slice(headerEnd + 4);
    if (bodyRaw.endsWith("\r\n")) bodyRaw = bodyRaw.slice(0, -2);
    if (bodyRaw.endsWith("--")) bodyRaw = bodyRaw.slice(0, -2);

    const disposition = header.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || "";
    const name = disposition.match(/name="([^"]+)"/i)?.[1];
    const filename = disposition.match(/filename="([^"]*)"/i)?.[1];
    if (!name) continue;

    const contentTypeHeader = header.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim();
    const bodyBuffer = Buffer.from(bodyRaw, "latin1");

    if (filename) {
      files.push({
        name,
        filename,
        contentType: contentTypeHeader || "application/octet-stream",
        buffer: bodyBuffer,
      });
    } else {
      fields[name] = bodyBuffer.toString("utf8");
    }
  }

  return { fields, files };
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
    }[extension] || "application/octet-stream"
  );
}

process.on("uncaughtException", (error) => {
  if (error.statusCode) return;
  console.error(error);
});

process.on("SIGINT", () => {
  appendAdminEvent({
    type: "server_stop",
    level: "info",
    message: "Server stopped",
    run_id: RUN_ID,
    detail: { signal: "SIGINT" },
  }).finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  appendAdminEvent({
    type: "server_stop",
    level: "info",
    message: "Server stopped",
    run_id: RUN_ID,
    detail: { signal: "SIGTERM" },
  }).finally(() => process.exit(0));
});
