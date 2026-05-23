import { DEGREE_RANK, HARD_SKILLS, ROLE_FAMILIES, SOFT_SKILLS } from "./taxonomy.js";
import { compactWhitespace, extractKeywordLabels, highestDegreeRank, parseYearCount, unique } from "./textUtils.js";

export function normalizeJob(seedJob) {
  const rawText = compactWhitespace(
    [
      seedJob.job_title,
      seedJob.company,
      seedJob.department,
      seedJob.category,
      seedJob.recruitment_type,
      seedJob.job_level,
      seedJob.experience_required,
      seedJob.education_required,
      seedJob.jd_raw_text,
      ...(seedJob.hard_skills || []),
      ...(seedJob.soft_skills || []),
    ].join("\n"),
  );
  const hardSkills = unique([...(seedJob.hard_skills || []), ...extractKeywordLabels(rawText, HARD_SKILLS)]);
  const softSkills = unique([...(seedJob.soft_skills || []), ...extractKeywordLabels(rawText, SOFT_SKILLS)]);
  const education = highestDegreeRank(seedJob.education_required || rawText, DEGREE_RANK);

  return {
    ...seedJob,
    id: seedJob.id,
    location: normalizeLocation(seedJob.location),
    hard_skills: hardSkills,
    soft_skills: softSkills,
    min_years: parseYearCount(seedJob.experience_required || rawText),
    education_rank: education.rank,
    education_label: education.label || seedJob.education_required || "不限",
    role_family: seedJob.role_family || inferRoleFamily(seedJob),
    recruitment_type: seedJob.recruitment_type || inferRecruitmentType(seedJob),
    jd_raw_text: rawText,
    status: seedJob.status || "active",
    updated_at: new Date().toISOString(),
  };
}

function normalizeLocation(location) {
  if (Array.isArray(location)) return location.map((item) => String(item).trim()).filter(Boolean);
  return String(location || "")
    .split(/[、/,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferRoleFamily(job) {
  const text = [job.job_title, job.category, job.department, job.jd_raw_text].join(" ");
  for (const [key, family] of Object.entries(ROLE_FAMILIES)) {
    if ((family.categories || []).includes(job.category)) return key;
    if ((family.title_keywords || []).some((keyword) => text.includes(keyword))) return key;
  }
  return "general";
}

function inferRecruitmentType(job) {
  const text = [job.recruitment_type, job.job_level, job.experience_required, job.jd_raw_text].join(" ");
  if (text.includes("实习")) return "实习";
  if (text.includes("校招") || text.includes("应届") || text.includes("毕业生")) return "校招";
  if (text.includes("社招") || /\d+\s*年/.test(text) || /P\d/.test(text)) return "社招";
  return "不限";
}
