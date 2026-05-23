import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeJob } from "./domain/jdParser.js";
import { isIntelligenceReportFresh } from "./domain/intelligenceRadar.js";
import { buildCrawlerPolicySummary } from "./domain/crawlerPolicy.js";
import { crawlOfficialSources } from "./domain/jobCrawler.js";
import { expandGeneratedSeeds } from "./domain/jobSeedGenerator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = process.env.JOBMATCH_DATA_DIR ? path.resolve(process.env.JOBMATCH_DATA_DIR) : path.join(ROOT_DIR, "data");
const SEED_FILE = path.join(DATA_DIR, "jobs.seed.json");
const EXPANDED_SEED_FILE = path.join(DATA_DIR, "jobs.expanded.seed.json");
const GENERATED_SEED_FILE = path.join(DATA_DIR, "jobs.generated.seed.json");
const LIVE_CRAWL_FILE = path.join(DATA_DIR, "jobs.live.json");
const CRAWLER_SOURCES_FILE = path.join(DATA_DIR, "crawler.sources.json");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const RESUMES_FILE = path.join(DATA_DIR, "resumes.json");
const REPORTS_FILE = path.join(DATA_DIR, "report-cache.json");
const INTELLIGENCE_REPORTS_FILE = path.join(DATA_DIR, "intelligence-reports.json");
const META_FILE = path.join(DATA_DIR, "meta.json");
const ADMIN_LOG_FILE = path.join(DATA_DIR, "admin-log.json");
const MAX_ADMIN_EVENTS = 1000;

export async function ensureDataStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await ensureJsonFile(RESUMES_FILE, []);
  await ensureJsonFile(REPORTS_FILE, {});
  await ensureJsonFile(INTELLIGENCE_REPORTS_FILE, {});
  await ensureJsonFile(META_FILE, { last_job_sync_at: null, crawler_policy: buildCrawlerPolicySummary() });
  await ensureJsonFile(ADMIN_LOG_FILE, { events: [] });
  return runJobSync();
}

export async function listJobs(filters = {}) {
  const jobs = await readJson(JOBS_FILE, []);
  const query = normalize(filters.query || filters.q || "");
  const company = normalize(filters.company || "");
  const category = normalize(filters.category || "");
  const recruitmentType = normalize(filters.recruitment_type || filters.recruitmentType || "");
  const location = normalize(filters.location || "");

  return jobs
    .filter((job) => job.status !== "closed")
    .filter((job) => !company || normalize(job.company).includes(company))
    .filter((job) => !category || normalize(job.category).includes(category))
    .filter((job) => !recruitmentType || normalize(job.recruitment_type).includes(recruitmentType))
    .filter((job) => !location || normalize((job.location || []).join(" ")).includes(location))
    .filter((job) => {
      if (!query) return true;
      const haystack = normalize(
        [job.job_title, job.company, job.department, job.category, job.recruitment_type, ...(job.hard_skills || []), job.jd_raw_text].join(" "),
      );
      return haystack.includes(query);
    })
    .sort((a, b) => String(b.publish_date || "").localeCompare(String(a.publish_date || "")));
}

export async function getJob(id) {
  const jobs = await readJson(JOBS_FILE, []);
  return jobs.find((job) => job.id === id) || null;
}

export async function runJobSync() {
  const seedJobs = await readSeedJobs();
  const existing = await readJson(JOBS_FILE, []);
  const existingById = new Map(existing.map((job) => [job.id, job]));
  const normalized = seedJobs.map((seed) => normalizeJob({ ...existingById.get(seed.id), ...seed }));
  await writeJson(JOBS_FILE, normalized);
  const meta = await readJson(META_FILE, {});
  const nextMeta = {
    ...meta,
    last_job_sync_at: new Date().toISOString(),
    crawler_policy: buildCrawlerPolicySummary(),
  };
  await writeJson(META_FILE, nextMeta);
  return {
    inserted_or_updated: normalized.length,
    source: "seed + expanded + generated + live-crawl",
    policy: nextMeta.crawler_policy,
  };
}

async function readSeedJobs() {
  const [baseSeeds, expandedSeeds, generatedSeedConfig, liveSeeds] = await Promise.all([
    readJson(SEED_FILE, []),
    readJson(EXPANDED_SEED_FILE, []),
    readJson(GENERATED_SEED_FILE, { sources: [], templates: [] }),
    readJson(LIVE_CRAWL_FILE, []),
  ]);
  const generatedSeeds = expandGeneratedSeeds(generatedSeedConfig);
  const seedGroups = [baseSeeds, expandedSeeds, generatedSeeds, liveSeeds];
  const byId = new Map();
  for (const job of seedGroups.flat()) {
    if (!job?.id) continue;
    byId.set(job.id, job);
  }
  return [...byId.values()];
}

export async function runLiveJobCrawl(options = {}) {
  const sources = await readJson(CRAWLER_SOURCES_FILE, []);
  const result = await crawlOfficialSources(sources, options);
  const normalizedLiveJobs = result.jobs.map((job) => normalizeJob(job));
  await writeJson(LIVE_CRAWL_FILE, normalizedLiveJobs);
  const syncResult = await runJobSync();
  const meta = await readJson(META_FILE, {});
  const nextMeta = {
    ...meta,
    last_live_crawl_at: new Date().toISOString(),
    last_live_crawl_result: {
      ...result.summary,
      live_jobs: normalizedLiveJobs.length,
      merged_jobs: syncResult.inserted_or_updated,
    },
  };
  await writeJson(META_FILE, nextMeta);
  return {
    ...result.summary,
    live_jobs: normalizedLiveJobs.length,
    merged_jobs: syncResult.inserted_or_updated,
    policy: nextMeta.crawler_policy,
  };
}

export async function listResumes() {
  const resumes = await readJson(RESUMES_FILE, []);
  return resumes.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export async function getResume(id) {
  const resumes = await readJson(RESUMES_FILE, []);
  return resumes.find((resume) => resume.id === id) || null;
}

export async function saveResume(resume) {
  const resumes = await readJson(RESUMES_FILE, []);
  const next = [resume, ...resumes.filter((item) => item.id !== resume.id)].slice(0, 50);
  await writeJson(RESUMES_FILE, next);
  return resume;
}

export async function updateResume(id, patch) {
  const resumes = await readJson(RESUMES_FILE, []);
  const index = resumes.findIndex((resume) => resume.id === id);
  if (index === -1) return null;
  const updated = {
    ...resumes[index],
    ...patch,
    id,
    updated_at: new Date().toISOString(),
    skills: normalizeArray(patch.skills ?? resumes[index].skills),
    soft_skills: normalizeArray(patch.soft_skills ?? resumes[index].soft_skills),
  };
  resumes[index] = updated;
  await writeJson(RESUMES_FILE, resumes);
  return updated;
}

export async function getCachedReport(key) {
  const cache = await readJson(REPORTS_FILE, {});
  const item = cache[key];
  if (!item) return null;
  const created = new Date(item.cached_at).getTime();
  if (Number.isNaN(created) || Date.now() - created > 24 * 60 * 60 * 1000) return null;
  return item.report;
}

export async function cacheReport(key, report) {
  const cache = await readJson(REPORTS_FILE, {});
  cache[key] = { cached_at: new Date().toISOString(), report };
  await writeJson(REPORTS_FILE, cache);
}

export async function getIntelligenceReport(jobId, options = {}) {
  const reports = await readJson(INTELLIGENCE_REPORTS_FILE, {});
  const report = reports[jobId] || null;
  if (!report) return null;
  if (!options.includeExpired && !isIntelligenceReportFresh(report)) return null;
  return report;
}

export async function saveIntelligenceReport(report) {
  const reports = await readJson(INTELLIGENCE_REPORTS_FILE, {});
  reports[report.job_id] = report;
  await writeJson(INTELLIGENCE_REPORTS_FILE, reports);
  return report;
}

export async function deleteIntelligenceReport(jobId) {
  const reports = await readJson(INTELLIGENCE_REPORTS_FILE, {});
  const existed = Boolean(reports[jobId]);
  delete reports[jobId];
  await writeJson(INTELLIGENCE_REPORTS_FILE, reports);
  return existed;
}

export async function appendAdminEvent(event) {
  let log;
  try {
    log = await readJson(ADMIN_LOG_FILE, { events: [] });
  } catch {
    log = { events: [] };
  }
  const nextEvent = {
    id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    level: event.level || "info",
    type: event.type || "runtime",
    message: event.message || "",
    run_id: event.run_id || null,
    detail: event.detail || {},
  };
  log.events = [nextEvent, ...(log.events || [])].slice(0, MAX_ADMIN_EVENTS);
  await writeJson(ADMIN_LOG_FILE, log);
  return nextEvent;
}

export async function getAdminDashboard(limit = 80) {
  const [stats, jobs, resumes, reportsCache, meta, log] = await Promise.all([
    getStats(),
    readJson(JOBS_FILE, []),
    readJson(RESUMES_FILE, []),
    readJson(REPORTS_FILE, {}),
    readJson(META_FILE, {}),
    readJson(ADMIN_LOG_FILE, { events: [] }),
  ]);
  const events = (log.events || []).slice(0, limit);
  const reportRecords = Object.values(reportsCache)
    .map((item) => ({
      cached_at: item.cached_at,
      report_id: item.report?.id || null,
      resume_id: item.report?.resume_id || null,
      job_id: item.report?.job_id || null,
      company: item.report?.company || null,
      job_title: item.report?.job_title || null,
      total_score: item.report?.total_score ?? null,
      grade: item.report?.grade || null,
      gap_count: item.report?.gap_skills?.length || 0,
      recommendation: item.report?.recommendation || "",
    }))
    .sort((a, b) => String(b.cached_at || "").localeCompare(String(a.cached_at || "")))
    .slice(0, limit);

  return {
    generated_at: new Date().toISOString(),
    stats: {
      ...stats,
      total_jobs: jobs.length,
      log_events: log.events?.length || 0,
      error_events: (log.events || []).filter((event) => event.level === "error").length,
    },
    runtime_logs: events,
    runs: events.filter((event) => event.type === "server_start" || event.type === "server_stop"),
    resume_records: resumes
      .map((resume) => ({
        id: resume.id,
        created_at: resume.created_at,
        updated_at: resume.updated_at || null,
        name: resume.name,
        email: resume.email,
        contact: resume.contact,
        source: resume.source,
        file_name: resume.file_meta?.file_name || null,
        confidence: resume.confidence,
        skill_count: resume.skills?.length || 0,
        project_count: resume.projects?.length || 0,
        warning_count: resume.warnings?.length || 0,
      }))
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
      .slice(0, limit),
    match_records: reportRecords,
    match_events: events.filter((event) => event.type === "match" || event.type === "match_batch"),
    job_sync_records: events.filter((event) => event.type === "job_sync"),
    error_logs: events.filter((event) => event.level === "error"),
    meta,
  };
}

export async function getStats() {
  const [jobs, resumes, reports, intelligenceReports, meta] = await Promise.all([
    readJson(JOBS_FILE, []),
    readJson(RESUMES_FILE, []),
    readJson(REPORTS_FILE, {}),
    readJson(INTELLIGENCE_REPORTS_FILE, {}),
    readJson(META_FILE, {}),
  ]);
  return {
    jobs: jobs.length,
    active_jobs: jobs.filter((job) => job.status !== "closed").length,
    companies: new Set(jobs.map((job) => job.company).filter(Boolean)).size,
    campus_jobs: jobs.filter((job) => job.recruitment_type === "校招").length,
    internship_jobs: jobs.filter((job) => job.recruitment_type === "实习").length,
    social_jobs: jobs.filter((job) => job.recruitment_type === "社招").length,
    live_crawl_jobs: jobs.filter((job) => job.source_channel === "live-crawl").length,
    resumes: resumes.length,
    cached_reports: Object.keys(reports).length,
    intelligence_reports: Object.values(intelligenceReports).filter((report) => isIntelligenceReportFresh(report)).length,
    last_job_sync_at: meta.last_job_sync_at || null,
    last_live_crawl_at: meta.last_live_crawl_at || null,
    crawler_policy: meta.crawler_policy || buildCrawlerPolicySummary(),
  };
}

async function ensureJsonFile(filePath, fallback) {
  if (!(await exists(filePath))) await writeJson(filePath, fallback);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function normalize(value) {
  return String(value || "").toLowerCase().trim();
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
