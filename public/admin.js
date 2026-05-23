const state = {
  dashboard: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

init();

function init() {
  bindEvents();
  loadDashboard();
}

function bindEvents() {
  $("#refreshBtn").addEventListener("click", loadDashboard);
  $$(".admin-tabs button").forEach((button) => {
    button.addEventListener("click", () => activatePanel(button.dataset.panel));
  });
}

async function loadDashboard() {
  $("#refreshBtn").disabled = true;
  try {
    const data = await api("/api/admin?limit=200");
    state.dashboard = data.dashboard;
    renderDashboard(data.dashboard);
    $("#adminStatus").textContent = `已刷新 ${formatTime(data.dashboard.generated_at)}`;
    $("#adminStatus").classList.add("ok");
  } catch (error) {
    $("#adminStatus").textContent = error.message || "加载失败";
    $("#adminStatus").classList.remove("ok");
  } finally {
    $("#refreshBtn").disabled = false;
  }
}

function renderDashboard(dashboard) {
  renderStats(dashboard.stats);
  renderRuns(dashboard.runs);
  renderRuntimeRows(dashboard.runtime_logs);
  renderResumes(dashboard.resume_records);
  renderMatches(dashboard.match_records, dashboard.match_events);
  renderJobSync(dashboard.job_sync_records, dashboard.meta);
  renderErrors(dashboard.error_logs);
}

function renderStats(stats) {
  const items = [
    ["岗位", stats.active_jobs ?? 0],
    ["公司", stats.companies ?? 0],
    ["校招", stats.campus_jobs ?? 0],
    ["实习", stats.internship_jobs ?? 0],
    ["社招", stats.social_jobs ?? 0],
    ["实时抓取", stats.live_crawl_jobs ?? 0],
    ["简历", stats.resumes ?? 0],
    ["报告缓存", stats.cached_reports ?? 0],
    ["情报简报", stats.intelligence_reports ?? 0],
    ["日志事件", stats.log_events ?? 0],
    ["错误", stats.error_events ?? 0],
    ["上次同步", stats.last_job_sync_at ? formatTime(stats.last_job_sync_at) : "未同步"],
  ];
  $("#statsGrid").innerHTML = items
    .map(([label, value]) => `<article class="stat-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`)
    .join("");
}

function renderRuns(runs) {
  $("#runCount").textContent = `${runs.length} 条`;
  $("#runsList").innerHTML =
    runs.length === 0
      ? emptyCard("暂无运行记录")
      : runs
          .map(
            (event) => `
      <article class="admin-card">
        <div class="admin-card-row">
          <span class="level ${event.level}">${escapeHtml(event.level)}</span>
          <strong>${escapeHtml(event.message)}</strong>
          <span class="pill">${escapeHtml(formatTime(event.at))}</span>
          <span class="pill muted">${escapeHtml(event.run_id || "-")}</span>
        </div>
        <div class="muted">PID ${escapeHtml(event.detail?.pid ?? "-")} · Port ${escapeHtml(event.detail?.port ?? "-")} · Node ${escapeHtml(event.detail?.node ?? "-")}</div>
      </article>`,
          )
          .join("");
}

function renderRuntimeRows(events) {
  $("#eventCount").textContent = `${events.length} 条`;
  $("#runtimeRows").innerHTML =
    events.length === 0
      ? tableEmpty(5, "暂无事件")
      : events
          .map(
            (event) => `
      <tr>
        <td>${escapeHtml(formatTime(event.at))}</td>
        <td><span class="level ${event.level}">${escapeHtml(event.level)}</span></td>
        <td>${escapeHtml(event.type)}</td>
        <td>${escapeHtml(event.message)}</td>
        <td><button class="detail-button" type="button" data-event-id="${escapeHtml(event.id)}">查看</button></td>
      </tr>`,
          )
          .join("");
  bindDetailButtons();
}

function renderResumes(records) {
  $("#resumeCount").textContent = `${records.length} 条`;
  $("#resumeRows").innerHTML =
    records.length === 0
      ? tableEmpty(7, "暂无简历解析记录")
      : records
          .map(
            (record) => `
      <tr>
        <td>${escapeHtml(formatTime(record.created_at))}</td>
        <td>${escapeHtml(record.name || record.email || record.contact || "未识别")}</td>
        <td>${escapeHtml(record.file_name || record.source || "-")}</td>
        <td>${record.skill_count}</td>
        <td>${record.project_count}</td>
        <td>${Math.round((record.confidence || 0) * 100)}%</td>
        <td>${record.warning_count}</td>
      </tr>`,
          )
          .join("");
}

function renderMatches(records, events) {
  $("#matchCount").textContent = `${records.length} 条`;
  $("#matchRows").innerHTML =
    records.length === 0
      ? tableEmpty(7, "暂无匹配报告缓存")
      : records
          .map(
            (record) => `
      <tr>
        <td>${escapeHtml(formatTime(record.cached_at))}</td>
        <td>${escapeHtml(record.job_title || "-")}</td>
        <td>${escapeHtml(record.company || "-")}</td>
        <td><strong>${escapeHtml(record.total_score ?? "-")}</strong></td>
        <td>${escapeHtml(record.grade || "-")}</td>
        <td>${record.gap_count}</td>
        <td>${escapeHtml(record.recommendation || "-")}</td>
      </tr>`,
          )
          .join("");

  $("#matchEventCount").textContent = `${events.length} 条`;
  $("#matchEventsList").innerHTML =
    events.length === 0
      ? emptyCard("暂无匹配调用事件")
      : events
          .map(
            (event) => `
      <article class="admin-card">
        <div class="admin-card-row">
          <span class="level ${event.level}">${escapeHtml(event.level)}</span>
          <strong>${escapeHtml(event.detail?.company || event.detail?.top_job || event.message)}</strong>
          <span class="pill">${escapeHtml(formatTime(event.at))}</span>
          <span class="pill">分数 ${escapeHtml(event.detail?.total_score ?? event.detail?.top_score ?? "-")}</span>
        </div>
        <div class="muted">${escapeHtml(event.message)} · ${escapeHtml(event.detail?.job_title || `${event.detail?.returned_reports || 0} 份报告`)}</div>
      </article>`,
          )
          .join("");
}

function renderJobSync(records, meta) {
  $("#jobSyncCount").textContent = `${records.length} 条`;
  $("#jobSyncList").innerHTML =
    records.length === 0
      ? emptyCard("暂无岗位同步事件")
      : records
          .map(
            (event) => `
      <article class="admin-card">
        <div class="admin-card-row">
          <span class="level ${event.level}">${escapeHtml(event.level)}</span>
          <strong>${escapeHtml(event.message)}</strong>
          <span class="pill">${escapeHtml(formatTime(event.at))}</span>
          <span class="pill">${escapeHtml(event.detail?.inserted_or_updated ?? 0)} 条</span>
        </div>
        <div class="muted">${escapeHtml(event.detail?.source || "-")}</div>
      </article>`,
          )
          .join("");
  $("#jobMeta").textContent = JSON.stringify(meta || {}, null, 2);
}

function renderErrors(records) {
  $("#errorCount").textContent = `${records.length} 条`;
  $("#errorList").innerHTML =
    records.length === 0
      ? emptyCard("暂无错误")
      : records
          .map(
            (event) => `
      <article class="admin-card">
        <div class="admin-card-row">
          <span class="level error">error</span>
          <strong>${escapeHtml(event.message)}</strong>
          <span class="pill">${escapeHtml(formatTime(event.at))}</span>
          <button class="detail-button" type="button" data-event-id="${escapeHtml(event.id)}">查看</button>
        </div>
        <div class="muted">${escapeHtml(event.detail?.method || "-")} ${escapeHtml(event.detail?.path || "-")} · ${escapeHtml(event.detail?.status || "-")}</div>
      </article>`,
          )
          .join("");
  bindDetailButtons();
}

function activatePanel(panelId) {
  $$(".admin-tabs button").forEach((button) => button.classList.toggle("active", button.dataset.panel === panelId));
  $$(".admin-panel").forEach((panel) => panel.classList.toggle("active", panel.id === panelId));
}

function bindDetailButtons() {
  $$("[data-event-id]").forEach((button) => {
    button.addEventListener("click", () => showEventDetail(button.dataset.eventId));
  });
}

function showEventDetail(eventId) {
  const events = state.dashboard?.runtime_logs || [];
  const event = events.find((item) => item.id === eventId);
  $("#detailJson").textContent = JSON.stringify(event || {}, null, 2);
  $("#detailDialog").showModal();
}

async function api(path) {
  const response = await fetch(path);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || "请求失败");
  return data;
}

function emptyCard(text) {
  return `<article class="admin-card muted">${escapeHtml(text)}</article>`;
}

function tableEmpty(colspan, text) {
  return `<tr><td colspan="${colspan}" class="muted">${escapeHtml(text)}</td></tr>`;
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
