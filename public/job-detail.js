import {
  bindIntelligenceControls,
  loadIntelligenceReport,
  renderIntelligenceError,
  renderIntelligenceLoading,
  renderIntelligenceReport,
  startIntelligence,
} from "/intelligence-ui.js";

const $ = (selector) => document.querySelector(selector);

init();

async function init() {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) {
    renderError("缺少岗位 ID");
    return;
  }

  try {
    const data = await api(`/api/jobs/${encodeURIComponent(id)}`);
    renderJob(data.job);
  } catch (error) {
    renderError(error.message || "岗位加载失败");
  }
}

function renderJob(job) {
  document.title = `${job.company} · ${job.job_title} - JobMatch AI`;
  const detail = $("#jobDetail");
  detail.classList.remove("empty-state");
  detail.innerHTML = `
    <div class="detail-hero">
      <div>
        <span class="section-index">${escapeHtml(job.recruitment_type || "岗位")}</span>
        <h2>${escapeHtml(job.job_title)}</h2>
        <p>${escapeHtml(job.company)} · ${escapeHtml(job.department || "未标注部门")}</p>
      </div>
      <div class="detail-actions">
        <button id="startIntelBtn" class="secondary-button" type="button">启动情报雷达</button>
        ${job.source_url ? `<a class="primary-button detail-source" href="${escapeAttr(job.source_url)}" target="_blank" rel="noreferrer">打开来源</a>` : ""}
      </div>
    </div>

    <div class="detail-grid">
      ${field("地点", (job.location || []).join(" / ") || "不限")}
      ${field("岗位性质", job.recruitment_type || "不限")}
      ${field("经验要求", job.experience_required || "不限")}
      ${field("学历要求", job.education_required || job.education_label || "不限")}
      ${field("岗位级别", job.job_level || "未标注")}
      ${field("来源", job.source_channel || "seed")}
    </div>

    <div class="report-section">
      <h3>核心要求</h3>
      <div class="chips">${(job.hard_skills || []).map((item) => chip(item)).join("") || chip("未标注")}</div>
    </div>

    <div class="report-section">
      <h3>软素质</h3>
      <div class="chips">${(job.soft_skills || []).map((item) => chip(item, "good")).join("") || chip("未标注")}</div>
    </div>

    <div class="report-section">
      <h3>JD 原文</h3>
      <article class="jd-raw">${escapeHtml(job.jd_raw_text || "暂无 JD 原文")}</article>
    </div>

    <div class="report-section">
      <h3>岗位情报雷达</h3>
      <div id="intelligencePanel" class="intelligence-slot empty-state">点击“启动情报雷达”生成面经考点、公司背景和行业线索。</div>
    </div>
  `;
  $("#startIntelBtn").addEventListener("click", () => runIntelligence(job, { refresh: false }));
  loadCachedIntelligence(job);
}

async function loadCachedIntelligence(job) {
  try {
    const report = await loadIntelligenceReport(job.id);
    if (!report) return;
    renderIntelligenceSlot(job, report);
    $("#startIntelBtn").textContent = "查看情报简报";
  } catch {
    // Cache lookup should not block the user from starting a new radar run.
  }
}

async function runIntelligence(job, options = {}) {
  const button = $("#startIntelBtn");
  const slot = $("#intelligencePanel");
  button.disabled = true;
  button.textContent = "情报抓取中…";
  slot.classList.remove("empty-state");
  slot.innerHTML = renderIntelligenceLoading();

  try {
    const report = await startIntelligence(job.id, {
      refresh: options.refresh,
      onStatus: (status) => {
        slot.innerHTML = renderIntelligenceLoading(status);
      },
    });
    renderIntelligenceSlot(job, report);
    button.textContent = "查看情报简报";
  } catch (error) {
    slot.innerHTML = renderIntelligenceError(error.message);
    button.textContent = "重新启动情报雷达";
  } finally {
    button.disabled = false;
  }
}

function renderIntelligenceSlot(job, report) {
  const slot = $("#intelligencePanel");
  slot.classList.remove("empty-state");
  slot.innerHTML = renderIntelligenceReport(report);
  bindIntelligenceControls(slot, {
    onRefresh: () => runIntelligence(job, { refresh: true }),
  });
}

function field(label, value) {
  return `
    <div class="field">
      <span class="field-label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>`;
}

function chip(label, tone = "") {
  return `<span class="chip ${tone}">${escapeHtml(label)}</span>`;
}

function renderError(message) {
  $("#jobDetail").textContent = message;
}

async function api(path) {
  const response = await fetch(path);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || "请求失败");
  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
