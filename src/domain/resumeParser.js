import { CITY_KEYWORDS, DEGREE_RANK, HARD_SKILLS, ROLE_FAMILIES, ROLE_KEYWORDS, SOFT_SKILLS } from "./taxonomy.js";
import {
  compactWhitespace,
  createId,
  extractKeywordLabels,
  findEmails,
  findPhones,
  highestDegreeRank,
  parseYearCount,
  splitLines,
  unique,
} from "./textUtils.js";

export function parseResumeText(rawText, meta = {}) {
  const text = compactWhitespace(rawText);
  const lines = splitLines(text);
  const email = findEmails(text)[0] || null;
  const contact = findPhones(text)[0] || null;
  const skills = extractKeywordLabels(text, HARD_SKILLS);
  const softSkills = extractKeywordLabels(text, SOFT_SKILLS);
  const education = extractEducation(lines, text);
  const workExperience = extractWorkExperience(lines);
  const projects = extractProjects(lines, skills);
  const jobIntention = extractJobIntention(text);
  const degree = highestDegreeRank(text, DEGREE_RANK);

  const resume = {
    id: createId("resume"),
    created_at: new Date().toISOString(),
    source: meta.source || "manual",
    file_meta: meta.fileMeta || null,
    raw_text: text,
    name: extractName(lines, email, contact),
    contact,
    email,
    education,
    highest_degree: degree.label || null,
    highest_degree_rank: degree.rank,
    work_experience: workExperience.items,
    total_years: Math.max(workExperience.totalYears, parseYearCount(text)),
    skills,
    projects,
    soft_skills: softSkills,
    job_intention: jobIntention,
    confidence: 0,
    warnings: unique(meta.warnings || []),
  };

  resume.confidence = estimateConfidence(resume);
  if (resume.confidence < 0.55) {
    resume.warnings.push("结构化字段较少，建议在预览区补全技能、经历或项目。");
  }
  return resume;
}

function extractName(lines, email, contact) {
  const blacklist = /简历|resume|个人|求职|电话|邮箱|email|mobile|github|linkedin/i;
  for (const line of lines.slice(0, 8)) {
    const cleaned = line.replace(email || "", "").replace(contact || "", "").trim();
    if (!cleaned || blacklist.test(cleaned)) continue;
    const chinese = cleaned.match(/^[\u4e00-\u9fa5·]{2,8}$/)?.[0];
    if (chinese) return chinese;
    const english = cleaned.match(/^[A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2}$/)?.[0];
    if (english) return english;
  }
  return null;
}

function extractEducation(lines, text) {
  const degree = highestDegreeRank(text, DEGREE_RANK);
  const educationLines = lines.filter((line) => /大学|学院|研究生|本科|硕士|博士|学士|专业|university|college|bachelor|master|phd/i.test(line));
  const items = educationLines.slice(0, 5).map((line) => ({
    school: line.match(/([\u4e00-\u9fa5A-Za-z\s]{2,30}(?:大学|学院|University|College|Institute))/i)?.[1]?.trim() || null,
    degree: highestDegreeRank(line, DEGREE_RANK).label || degree.label || null,
    major: line.match(/(?:专业[:： ]?)([\u4e00-\u9fa5A-Za-z0-9\s]{2,24})/)?.[1]?.trim() || null,
    period: line.match(/(20\d{2}|19\d{2}).{0,12}(20\d{2}|19\d{2}|至今|现在|present)/i)?.[0] || null,
    raw: line,
  }));
  return items.length
    ? items
    : degree.label
      ? [{ school: null, degree: degree.label, major: null, period: null, raw: degree.label }]
      : [];
}

function extractWorkExperience(lines) {
  const companyPattern = /公司|集团|科技|网络|信息|字节|腾讯|阿里|美团|京东|百度|Inc\.?|Ltd\.?|Technology/i;
  const rolePattern = /工程师|开发|产品|运营|算法|数据|测试|实习|经理|designer|engineer|developer|analyst|pm/i;
  const items = [];
  const usedIndexes = new Set();

  lines.forEach((line, index) => {
    if (!(companyPattern.test(line) || (rolePattern.test(line) && /(20\d{2}|19\d{2})/.test(line)))) return;
    if (usedIndexes.has(index)) return;
    const nextLines = lines.slice(index + 1, index + 4).filter((nextLine) => !/教育|项目|技能|证书/.test(nextLine));
    nextLines.forEach((_, offset) => usedIndexes.add(index + offset + 1));
    items.push({
      company: line.match(/([\u4e00-\u9fa5A-Za-z0-9（）()\s]{2,36}(?:公司|集团|科技|网络|信息|Inc\.?|Ltd\.?))/i)?.[1]?.trim() || null,
      title: line.match(/(后端|前端|全栈|算法|数据|产品|运营|测试|客户端)?\s*(工程师|开发|经理|实习生|engineer|developer|analyst|pm)/i)?.[0]?.trim() || null,
      period: line.match(/(20\d{2}|19\d{2}).{0,16}(20\d{2}|19\d{2}|至今|现在|present)/i)?.[0] || null,
      responsibilities: nextLines,
      raw: line,
    });
  });

  return {
    items: items.slice(0, 8),
    totalYears: parseYearCount(items.map((item) => `${item.period || ""} ${item.raw}`).join("\n")),
  };
}

function extractProjects(lines, skills) {
  const projectIndexes = [];
  lines.forEach((line, index) => {
    if (/项目|project|平台|系统|小程序|app/i.test(line)) projectIndexes.push(index);
  });

  return projectIndexes.slice(0, 8).map((index) => {
    const block = lines.slice(index, index + 4).join("\n");
    const technologies = unique([...extractKeywordLabels(block, HARD_SKILLS), ...skills.filter((skill) => block.includes(skill))]);
    return {
      name: lines[index].replace(/项目|project|经验|[:：]/gi, "").trim().slice(0, 40) || "未命名项目",
      technologies,
      contribution: lines.slice(index + 1, index + 4),
      raw: block,
    };
  });
}

function extractJobIntention(text) {
  const targetRoles = ROLE_KEYWORDS.filter((role) => text.includes(role));
  const cities = CITY_KEYWORDS.filter((city) => text.includes(city));
  const salary = text.match(/(\d{1,3}\s*[kK万]-?\s*\d{0,3}\s*[kK万]?|\d{1,3}\s*-\s*\d{1,3}\s*[kK])/g)?.[0] || null;
  return {
    target_roles: targetRoles,
    role_family: inferRoleFamily(text, targetRoles),
    cities,
    salary_expectation: salary,
  };
}

function inferRoleFamily(text, targetRoles) {
  for (const [key, family] of Object.entries(ROLE_FAMILIES)) {
    if (targetRoles.some((role) => (family.title_keywords || []).some((keyword) => role.includes(keyword)))) return key;
    if ((family.title_keywords || []).some((keyword) => text.includes(keyword))) return key;
  }
  return null;
}

function estimateConfidence(resume) {
  const checks = [
    Boolean(resume.name),
    Boolean(resume.email || resume.contact),
    resume.education.length > 0,
    resume.skills.length >= 3,
    resume.projects.length > 0 || resume.work_experience.length > 0,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100) / 100;
}
