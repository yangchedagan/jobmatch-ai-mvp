import {
  bindIntelligenceControls,
  loadIntelligenceReport,
  renderIntelligenceError,
  renderIntelligenceLoading,
  renderIntelligenceReport,
  startIntelligence,
} from "/intelligence-ui.js";

const state = {
  jobs: [],
  filteredJobs: [],
  selectedJobIds: new Set(),
  resume: null,
  activeJobId: null,
  currentReport: null,
  intelligenceJobId: null,
  intelligenceJobLabel: "",
  autoIntelligenceJobs: new Set(),
  targetRole: "product_manager",
  page: "agent",
  runtime: {
    demo: false,
    admin: false,
    protectedAdmin: false,
  },
};

const sampleResume = `张明
联系方式：公开演示样本已脱敏
求职意向：产品经理，北京 / 杭州

教育背景
浙江大学 信息管理与信息系统 本科 2017-2021

工作经历
杭州某科技公司 产品经理 2021-2025
负责电商交易链路和会员增长产品，完成用户研究、竞品分析、需求分析、PRD、原型设计、数据埋点和 A/B 测试。
搭建转化漏斗和指标体系，推动研发、运营、设计协作，核心转化率提升 18%。

项目经验
会员增长与优惠券策略平台
基于用户分层、增长策略、数据分析和 A/B 测试优化领取、核销、复购链路，负责产品规划、流程图、原型和上线复盘。

技能栈
产品设计 / 需求分析 / 用户研究 / 竞品分析 / 数据分析 / SQL / BI / 数据埋点 / A/B 测试 / 指标体系 / 用户增长 / 增长策略 / 项目管理 / Figma / Axure
软素质：沟通能力、跨部门推动、业务理解、结果导向、逻辑思维`;

export { sampleResume };

/* Agent 对话产出 → 各页面状态同步（保证切页即见） */
export const agentSync = {
  resume(resume) {
    if (!resume) return;
    state.resume = resume;
    renderResume(resume);
  },
  matchReport(report) {
    if (!report?.job_id) return;
    state.activeJobId = report.job_id;
    renderReport(report);
  },
  ranking(reports, title = "Agent 推荐排行") {
    if (!Array.isArray(reports) || !reports.length) return;
    renderRanking(reports, title);
  },
  radar(report) {
    if (!report?.job_id) return;
    renderPageIntelligence(report.job_id, report);
    const button = $("#startIntelligenceBtn");
    if (button) button.textContent = "刷新情报";
  },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

init();

async function init() {
  bindEvents();
  setupCoverPage();
  setActivePage(pageFromHash(location.hash), { replace: true, scroll: false });
  await Promise.all([loadHealth(), loadJobs(), loadLatestResume()]);
}

function bindEvents() {
  $("#resumeForm").addEventListener("submit", parseResume);
  $("#resumeFile").addEventListener("change", handleFilePicked);
  $("#sampleResumeBtn").addEventListener("click", () => {
    $("#resumeText").value = sampleResume;
    showToast("示例简历已载入");
  });
  $("#syncJobsBtn").addEventListener("click", syncJobs);
  $("#crawlJobsBtn").addEventListener("click", crawlJobs);
  $$(".view-tab").forEach((tab) => tab.addEventListener("click", () => setActivePage(tab.dataset.page)));
  $("#openReportBtn").addEventListener("click", () => setActivePage("report"));
  $("#backToJobsBtn").addEventListener("click", () => setActivePage("workbench"));
  $("#backToReportFromIntelBtn").addEventListener("click", () => setActivePage("report"));
  $("#startIntelligenceBtn").addEventListener("click", () => runPageIntelligence({ refresh: false }));
  $("#coverPathBtn").addEventListener("click", () => enterFromCover("workbench"));
  $("#coverWorkbenchBtn").addEventListener("click", () => enterFromCover("workbench"));
  $("#coverEnterBtn").addEventListener("click", () => enterFromCover("agent"));
  $("#coverMatchBtn")?.addEventListener("click", () => enterFromCover("report"));
  window.addEventListener("hashchange", () => {
    setActivePage(pageFromHash(location.hash), { syncHash: false });
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.classList.contains("cover-visible")) enterFromCover("agent");
  });
  $("#jobSearch").addEventListener("input", applyFilters);
  $("#companyFilter").addEventListener("change", applyFilters);
  $("#jobTypeFilter").addEventListener("change", applyFilters);
  $("#categoryFilter").addEventListener("change", applyFilters);
  $("#roleFocus").addEventListener("change", () => {
    state.targetRole = $("#roleFocus").value;
    if (state.targetRole === "product_manager") $("#categoryFilter").value = "产品";
    applyFilters();
    runRecommendations();
  });
  $("#batchMatchBtn").addEventListener("click", runBatchMatch);

  const dropZone = $("#dropZone");
  ["dragenter", "dragover"].forEach((eventName) => {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.add("dragging");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.remove("dragging");
    });
  });
  dropZone.addEventListener("drop", (event) => {
    const file = event.dataTransfer.files[0];
    if (!file) return;
    $("#resumeFile").files = event.dataTransfer.files;
    $("#fileName").textContent = `${file.name} · ${formatBytes(file.size)}`;
  });
}

function setupCoverPage() {
  const cover = $("#coverPage");
  if (!cover) return;
  const hasDeepLink = Boolean(location.hash && pageFromHash(location.hash) !== "agent");
  if (hasDeepLink) {
    cover.hidden = true;
    document.body.classList.remove("cover-visible");
    return;
  }
  cover.hidden = false;
  document.body.classList.add("cover-visible");
}

function enterFromCover(page) {
  const cover = $("#coverPage");
  if (!cover || cover.hidden) {
    setActivePage(page);
    return;
  }

  cover.classList.add("leaving");
  window.setTimeout(() => {
    cover.hidden = true;
    cover.classList.remove("leaving");
    document.body.classList.remove("cover-visible");
    setActivePage(page);
  }, 640);
}

function setActivePage(page, options = {}) {
  state.page = ["workbench", "report", "intelligence"].includes(page) ? page : "agent";
  if (state.page === "intelligence") {
    ensureIntelligenceTarget();
    updateIntelligenceTarget();
    if (state.intelligenceJobId && options.loadIntelligence !== false) loadPageIntelligence(state.intelligenceJobId, { silent: true });
  }
  $$(".page-view").forEach((view) => view.classList.toggle("active", view.id === `${state.page}Page`));
  $$(".view-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.page === state.page));
  if (options.syncHash !== false) {
    const nextHash = `#${state.page}`;
    if (location.hash !== nextHash) {
      const method = options.replace ? "replaceState" : "pushState";
      history[method](null, "", nextHash);
    }
  }
  if (options.scroll !== false) window.scrollTo({ top: 0, behavior: "smooth" });
}

function pageFromHash(hash) {
  const page = String(hash || "").replace(/^#/, "");
  return ["agent", "workbench", "report", "intelligence"].includes(page) ? page : "agent";
}

async function loadHealth() {
  const data = await api("/api/health");
  state.runtime = {
    demo: Boolean(data.mode?.demo),
    admin: Boolean(data.mode?.admin),
    protectedAdmin: Boolean(data.mode?.protected_admin),
  };
  applyRuntimeMode();
  $("#health").textContent = `可用 · ${data.stats.active_jobs} 岗`;
  $("#health").classList.add("ok");
}

function applyRuntimeMode() {
  const hideAdminTools = state.runtime.demo || state.runtime.protectedAdmin;
  document.body.classList.toggle("demo-mode", state.runtime.demo);
  [".admin-link", "#crawlJobsBtn", "#syncJobsBtn"].forEach((selector) => {
    const node = $(selector);
    if (node) node.hidden = hideAdminTools;
  });
}

async function loadJobs() {
  const data = await api("/api/jobs");
  state.jobs = data.jobs;
  state.filteredJobs = data.jobs;
  renderFilters();
  renderJobs();
}

async function loadLatestResume() {
  try {
    const data = await api("/api/resumes/latest");
    if (data.resume) {
      state.resume = data.resume;
      renderResume(data.resume);
      await runRecommendations();
    }
  } catch (error) {
    if (!isProtectedRouteError(error)) throw error;
  }
}

async function parseResume(event) {
  event.preventDefault();
  setStep("upload");
  const formData = new FormData();
  const file = $("#resumeFile").files[0];
  if (file) formData.append("resumeFile", file);
  formData.append("resumeText", $("#resumeText").value);

  try {
    setStep("parse");
    const data = await api("/api/resumes/parse", { method: "POST", body: formData });
    state.resume = data.resume;
    setStep("done");
    renderResume(data.resume);
    showToast("简历解析完成");
    await runRecommendations();
  } catch (error) {
    resetSteps();
    showToast(error.message || "解析失败");
  }
}

function handleFilePicked(event) {
  const file = event.target.files[0];
  $("#fileName").textContent = file ? `${file.name} · ${formatBytes(file.size)}` : "拖拽或点击上传";
}

async function syncJobs() {
  $("#syncJobsBtn").disabled = true;
  try {
    const result = await api("/api/jobs/sync", { method: "POST" });
    await loadJobs();
    showToast(`岗位库已同步：${result.inserted_or_updated} 条`);
  } finally {
    $("#syncJobsBtn").disabled = false;
  }
}

async function crawlJobs() {
  $("#crawlJobsBtn").disabled = true;
  try {
    showToast("开始抓取官方招聘入口，已启用 robots 与限速");
    const result = await api("/api/jobs/crawl", {
      method: "POST",
      body: JSON.stringify({ limitSources: 6, maxPagesPerSource: 2, minIntervalMs: 3000 }),
    });
    await loadHealth();
    await loadJobs();
    showToast(`抓取完成：新增/更新 ${result.live_jobs} 条，合并后 ${result.merged_jobs} 条`);
  } catch (error) {
    showToast(error.message || "抓取失败，请查看后台日志");
  } finally {
    $("#crawlJobsBtn").disabled = false;
  }
}

function renderFilters() {
  fillSelect("#companyFilter", "全部公司", unique(state.jobs.map((job) => job.company)));
  fillSelect("#jobTypeFilter", "全部性质", unique(state.jobs.map((job) => job.recruitment_type || "不限")));
  fillSelect("#categoryFilter", "全部类型", unique(state.jobs.map((job) => job.category)));
  if (state.targetRole === "product_manager" && [...$("#categoryFilter").options].some((option) => option.value === "产品")) {
    $("#categoryFilter").value = "产品";
    state.filteredJobs = state.jobs.filter((job) => job.category === "产品");
  }
}

function fillSelect(selector, firstLabel, values) {
  const select = $(selector);
  const current = select.value;
  select.innerHTML = `<option value="">${firstLabel}</option>${values
    .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
    .join("")}`;
  select.value = current;
}

function applyFilters() {
  const query = $("#jobSearch").value.trim().toLowerCase();
  const company = $("#companyFilter").value;
  const category = $("#categoryFilter").value;
  const jobType = $("#jobTypeFilter").value;
  state.filteredJobs = state.jobs.filter((job) => {
    const haystack = [job.job_title, job.company, job.department, job.category, job.recruitment_type, ...(job.hard_skills || [])].join(" ").toLowerCase();
    return (
      (!query || haystack.includes(query)) &&
      (!company || job.company === company) &&
      (!category || job.category === category) &&
      (!jobType || job.recruitment_type === jobType)
    );
  });
  renderJobs();
}

function renderJobs() {
  const list = $("#jobsList");
  const template = $("#jobTemplate");
  $("#jobCount").textContent = `${state.filteredJobs.length} 个岗位`;
  $("#selectedCount").textContent = `已选 ${state.selectedJobIds.size} 个`;
  list.innerHTML = "";

  for (const [index, job] of state.filteredJobs.entries()) {
    const node = template.content.cloneNode(true);
    const card = node.querySelector(".job-card");
    card.style.setProperty("--i", index);
    const checkbox = node.querySelector("input");
    const button = node.querySelector(".match-button");
    card.classList.toggle("active", state.activeJobId === job.id);
    checkbox.checked = state.selectedJobIds.has(job.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedJobIds.add(job.id);
      else state.selectedJobIds.delete(job.id);
      $("#selectedCount").textContent = `已选 ${state.selectedJobIds.size} 个`;
    });
    button.addEventListener("click", () => runSingleMatch(job.id));
    node.querySelector("h3").innerHTML = `<a class="job-link" href="${jobDetailUrl(job)}">${escapeHtml(job.job_title)}</a>`;
    node.querySelector(".company").innerHTML = `<a href="${jobDetailUrl(job)}">${escapeHtml(job.company)}</a>`;
    node.querySelector(".job-meta").textContent = `${job.recruitment_type || "不限"} · ${job.department || "未标注部门"} · ${(job.location || []).join(" / ")} · ${job.experience_required || "经验不限"}`;
    node.querySelector(".chips").innerHTML = [job.recruitment_type ? chip(job.recruitment_type, "good") : "", ...(job.hard_skills || []).slice(0, 7).map((skill) => chip(skill))].join("");
    list.appendChild(node);
  }
}

function renderResume(resume) {
  const preview = $("#resumePreview");
  preview.classList.remove("empty-state");
  preview.innerHTML = `
    <div class="resume-grid">
      <div class="field"><span class="field-label">姓名</span><strong>${escapeHtml(resume.name || "未识别")}</strong></div>
      <div class="field"><span class="field-label">联系方式</span><strong>${escapeHtml(resume.contact || resume.email || "未识别")}</strong></div>
      <div class="field"><span class="field-label">最高学历</span><strong>${escapeHtml(resume.highest_degree || "未识别")}</strong></div>
      <div class="field"><span class="field-label">工作年限</span><strong>${resume.total_years || 0} 年</strong></div>
      <div class="field wide"><span class="field-label">技能栈</span><div class="chips">${(resume.skills || []).map((item) => chip(item, "good")).join("") || chip("未识别")}</div></div>
      <div class="field wide"><span class="field-label">软素质</span><div class="chips">${(resume.soft_skills || []).map((item) => chip(item)).join("") || chip("未识别")}</div></div>
      <div class="field wide">
        <span class="field-label">修正技能</span>
        <textarea id="skillsEditor" rows="3">${escapeHtml((resume.skills || []).join("，"))}</textarea>
        <button id="saveResumeBtn" class="ghost-button" type="button">保存修正</button>
      </div>
    </div>
    ${
      resume.warnings?.length
        ? `<div class="report-section"><h3>提示</h3>${resume.warnings.map((warning) => `<p class="muted">${escapeHtml(warning)}</p>`).join("")}</div>`
        : ""
    }
  `;
  $("#saveResumeBtn").addEventListener("click", saveResumeCorrections);
}

async function saveResumeCorrections() {
  if (!state.resume) return;
  const skills = $("#skillsEditor").value
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const data = await api(`/api/resumes/${state.resume.id}`, {
    method: "PUT",
    body: JSON.stringify({ skills }),
  });
  state.resume = data.resume;
  renderResume(data.resume);
  showToast("修正已保存");
  await runRecommendations();
}

async function runSingleMatch(jobId) {
  if (!state.resume) {
    showToast("请先解析简历");
    return;
  }
  state.activeJobId = jobId;
  renderJobs();
  const data = await api("/api/match", {
    method: "POST",
    body: JSON.stringify({ resumeId: state.resume.id, jobId, targetRole: state.targetRole }),
  });
  renderReport(data.report);
  setActivePage("report");
}

async function runBatchMatch() {
  if (!state.resume) {
    showToast("请先解析简历");
    return;
  }
  const jobIds = [...state.selectedJobIds];
  if (!jobIds.length) {
    showToast("请选择岗位");
    return;
  }
  const data = await api("/api/match/batch", {
    method: "POST",
    body: JSON.stringify({ resumeId: state.resume.id, jobIds, limit: jobIds.length, targetRole: state.targetRole }),
  });
  renderRanking(data.reports, "批量匹配排行");
  if (data.reports[0]) {
    state.activeJobId = data.reports[0].job_id;
    renderReport(data.reports[0]);
  }
  setActivePage("report");
}

async function runRecommendations() {
  if (!state.resume) return;
  const data = await api("/api/match/batch", {
    method: "POST",
    body: JSON.stringify({ resumeId: state.resume.id, limit: 10, targetRole: state.targetRole }),
  });
  renderRanking(data.reports, "Top10 推荐");
}

function renderReport(report) {
  state.currentReport = report;
  selectIntelligenceTarget(report.job_id, `${report.company} · ${report.job_title}`);
  $("#reportStamp").textContent = `${report.company} · ${report.grade}`;
  const view = $("#reportView");
  view.classList.remove("empty-state");
  view.innerHTML = `
    <div class="score-row">
      <div class="score-ring" style="--score: ${report.total_score}"><strong>${report.total_score}</strong></div>
      <div class="score-copy">
        <h3>${escapeHtml(report.company)} · ${escapeHtml(report.job_title)}</h3>
        <p>${escapeHtml(report.recommendation)}</p>
        <span class="pill">${escapeHtml(report.role_focus ? `${report.role_focus}优先 · ${report.disclaimer}` : report.disclaimer)}</span>
      </div>
    </div>
    ${renderMatchLlmAnalysis(report.llm_analysis)}
    <div class="dimension-list">
      ${report.dimensions
        .map(
          (item) => `
        <div class="metric-row">
          <span class="metric-label">${escapeHtml(item.label)}</span>
          <div class="bar"><span style="--value: ${item.score}%"></span></div>
          <strong class="metric-score">${item.score}</strong>
        </div>`,
        )
        .join("")}
    </div>
    <div class="report-section">
      <h3>亮点匹配项</h3>
      <div class="chips">${report.matched_highlights.map((item) => chip(item, "good")).join("") || chip("暂无命中")}</div>
    </div>
    <div class="report-section">
      <h3>缺口技能清单</h3>
      <div class="gap-list">
        ${
          report.gap_skills.length
            ? report.gap_skills
                .slice(0, 8)
                .map(
                  (gap) => `
          <div class="gap-item">
            <strong>${escapeHtml(gap.priority)} · ${escapeHtml(gap.keyword)}</strong>
            <span class="muted">${escapeHtml(gap.action)}</span>
          </div>`,
                )
                .join("")
            : `<div class="gap-item"><strong>暂无明显缺口</strong><span class="muted">当前关键词覆盖较完整。</span></div>`
        }
      </div>
    </div>
    <div class="report-section">
      <h3>冗余项提示</h3>
      <div class="chips">${report.redundant_items.map((item) => chip(item)).join("") || chip("暂无")}</div>
    </div>
  `;
  autoStartIntelligenceForReport(report);
}

function autoStartIntelligenceForReport(report) {
  if (!report?.job_id || state.autoIntelligenceJobs.has(report.job_id)) return;
  state.autoIntelligenceJobs.add(report.job_id);
  runPageIntelligence({ refresh: false, silent: true }).catch(() => {
    state.autoIntelligenceJobs.delete(report.job_id);
  });
}

function renderMatchLlmAnalysis(analysis = null) {
  if (!analysis) return "";
  const predictions = analysis.interview_predictions || [];
  const tips = analysis.preparation_tips || [];
  return `
    <div class="report-section llm-section">
      <h3>DeepSeek V4 深度分析</h3>
      <p>${escapeHtml(analysis.match_explanation || "")}</p>
      ${analysis.status === "generated" ? "" : `<p class="muted">当前为规则降级结果：${escapeHtml(analysis.reason || analysis.status || "")}</p>`}
      <div class="gap-list">
        ${predictions
          .map(
            (item) => `
          <div class="gap-item">
            <strong>面试追问</strong>
            <span class="muted">${escapeHtml(item)}</span>
          </div>`,
          )
          .join("")}
      </div>
      <div class="chips">${tips.map((item) => chip(item, "good")).join("")}</div>
    </div>
  `;
}

function selectIntelligenceTarget(jobId, label = "") {
  if (!jobId) return;
  state.intelligenceJobId = jobId;
  state.intelligenceJobLabel = label || labelForJob(jobId);
  updateIntelligenceTarget();
}

function ensureIntelligenceTarget() {
  if (state.intelligenceJobId) return;
  if (state.currentReport?.job_id) {
    selectIntelligenceTarget(state.currentReport.job_id, `${state.currentReport.company} · ${state.currentReport.job_title}`);
    return;
  }
  if (state.activeJobId) selectIntelligenceTarget(state.activeJobId, labelForJob(state.activeJobId));
}

function updateIntelligenceTarget() {
  const title = $("#intelligenceTargetTitle");
  const hint = $("#intelligenceTargetHint");
  const stamp = $("#intelligenceStamp");
  const button = $("#startIntelligenceBtn");
  const view = $("#intelligenceView");
  if (!title || !hint || !stamp || !button || !view) return;

  if (!state.intelligenceJobId) {
    title.textContent = "尚未选择岗位";
    hint.textContent = "先在岗位工作台完成匹配，或从匹配报告进入岗位情报雷达。";
    stamp.textContent = "等待目标岗位";
    button.disabled = true;
    if (!view.dataset.renderedFor) {
      view.classList.add("empty-state");
      view.textContent = "暂无目标岗位";
    }
    return;
  }

  title.textContent = state.intelligenceJobLabel || labelForJob(state.intelligenceJobId);
  hint.textContent = "可生成或刷新该岗位的面经考点、公司背景、行业背景和原始资料链接。";
  stamp.textContent = "目标岗位已选";
  button.disabled = false;
}

async function loadPageIntelligence(jobId, options = {}) {
  const view = $("#intelligenceView");
  if (!jobId || !view) return;
  try {
    const report = await loadIntelligenceReport(jobId);
    if (!report) {
      if (!options.silent || view.dataset.renderedFor !== jobId) {
        view.dataset.renderedFor = "";
        view.classList.add("empty-state");
        view.textContent = "当前岗位暂无情报简报，点击“启动情报雷达”生成。";
      }
      return;
    }
    renderPageIntelligence(jobId, report);
    $("#startIntelligenceBtn").textContent = "刷新情报";
  } catch {
    if (!options.silent) view.innerHTML = renderIntelligenceError("情报简报加载失败，请稍后重试。");
  }
}

async function runPageIntelligence(options = {}) {
  ensureIntelligenceTarget();
  const jobId = state.intelligenceJobId;
  const button = $("#startIntelligenceBtn");
  const view = $("#intelligenceView");
  if (!jobId || !button || !view) {
    showToast("请先选择一个岗位");
    return;
  }

  button.disabled = true;
  button.textContent = "情报抓取中…";
  view.classList.remove("empty-state");
  view.innerHTML = renderIntelligenceLoading();

  try {
    const report = await startIntelligence(jobId, {
      refresh: options.refresh,
      resumeId: state.resume?.id || null,
      matchReport: state.currentReport || null,
      onStatus: (status) => {
        view.innerHTML = renderIntelligenceLoading(status);
      },
    });
    renderPageIntelligence(jobId, report);
    button.textContent = "刷新情报";
  } catch (error) {
    view.innerHTML = renderIntelligenceError(error.message);
    button.textContent = "重新启动情报雷达";
    if (options.silent) throw error;
  } finally {
    button.disabled = false;
  }
}

function renderPageIntelligence(jobId, report) {
  const view = $("#intelligenceView");
  if (!view) return;
  state.intelligenceJobId = jobId;
  state.intelligenceJobLabel = `${report.company} · ${report.job_title}`;
  view.dataset.renderedFor = jobId;
  view.classList.remove("empty-state");
  view.innerHTML = renderIntelligenceReport(report);
  bindIntelligenceControls(view, {
    onRefresh: () => runPageIntelligence({ refresh: true }),
  });
  updateIntelligenceTarget();
}

function labelForJob(jobId) {
  const job = state.jobs.find((item) => item.id === jobId);
  return job ? `${job.company} · ${job.job_title}` : "目标岗位";
}

function renderRanking(reports, title) {
  const view = $("#rankingView");
  view.classList.remove("empty-state");
  view.innerHTML = `
    <div class="report-section">
      <h3>${escapeHtml(title)}</h3>
      <div class="ranking-list">
        ${reports
          .map(
            (report, index) => `
          <button class="ranking-item" type="button" data-job-id="${escapeHtml(report.job_id)}">
            <strong>${index + 1}. ${escapeHtml(report.company)} · ${escapeHtml(report.job_title)} · ${report.total_score}</strong>
            <span class="muted">${escapeHtml(report.recommendation)}</span>
          </button>`,
          )
          .join("")}
      </div>
    </div>
  `;
  $$(".ranking-item").forEach((item) => item.addEventListener("click", () => runSingleMatch(item.dataset.jobId)));
}

function setStep(step) {
  const order = ["upload", "parse", "done"];
  $$(".stepper span").forEach((item) => {
    const current = item.dataset.step;
    item.classList.toggle("active", current === step);
    item.classList.toggle("done", order.indexOf(current) < order.indexOf(step));
  });
}

function resetSteps() {
  $$(".stepper span").forEach((item) => item.classList.remove("active", "done"));
}

async function api(path, options = {}) {
  const headers = options.body instanceof FormData ? {} : { "Content-Type": "application/json" };
  const response = await fetch(path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || "Request failed");
    error.status = response.status;
    throw error;
  }
  return data;
}

function isProtectedRouteError(error) {
  return [401, 403, 404].includes(error?.status);
}

function chip(label, tone = "") {
  return `<span class="chip ${tone}">${escapeHtml(label)}</span>`;
}

function jobDetailUrl(job) {
  return `/job.html?id=${encodeURIComponent(job.id)}`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2400);
}
