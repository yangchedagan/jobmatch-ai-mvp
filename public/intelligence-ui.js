export async function loadIntelligenceReport(jobId) {
  const data = await api(`/api/intelligence/${encodeURIComponent(jobId)}`);
  return data.report || null;
}

export async function startIntelligence(jobId, options = {}) {
  const data = await api("/api/intelligence/start", {
    method: "POST",
    body: JSON.stringify({ jobId, refresh: Boolean(options.refresh) }),
  });
  const taskId = data.taskId;
  let status = null;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(attempt < 2 ? 260 : 520);
    status = await api(`/api/intelligence/status/${encodeURIComponent(taskId)}`);
    if (options.onStatus) options.onStatus(status);
    if (status.status === "completed") return status.report || loadIntelligenceReport(jobId);
    if (status.status === "failed") throw new Error(status.error || status.message || "情报任务失败");
  }

  throw new Error("情报任务超时，请稍后刷新");
}

export function renderIntelligenceLoading(status = {}) {
  const progress = Math.max(1, Math.min(100, Number(status.progress || 8)));
  return `
    <div class="intel-loading">
      <div class="intel-loading-row">
        <strong>${escapeHtml(status.message || "正在启动情报雷达…")}</strong>
        <span>${progress}%</span>
      </div>
      <div class="intel-progress"><span style="--value: ${progress}%"></span></div>
      <div class="intel-stage-list">
        ${stage("search", "搜索资料", status.stage)}
        ${stage("fetch", "抓取清洗", status.stage)}
        ${stage("analyze", "考点提炼", status.stage)}
        ${stage("done", "生成简报", status.stage)}
      </div>
    </div>
  `;
}

export function renderIntelligenceReport(report) {
  if (!report) {
    return `<div class="empty-state">暂无情报简报，点击启动后生成</div>`;
  }

  const platforms = unique((report.raw_sources || []).map((source) => source.platform));
  return `
    <div class="intelligence-report">
      <div class="intel-banner">
        <div>
          <span class="section-index">岗位情报雷达</span>
          <h3>${escapeHtml(report.company || "")} · ${escapeHtml(report.job_title || "")}</h3>
          <p class="muted">刷新时间 ${formatTime(report.generated_at)} · ${report.meta?.total_sources || 0} 条资料 · ${escapeHtml((report.search_keywords || []).join(" / "))}</p>
        </div>
        <button class="ghost-button small-button" type="button" data-intel-refresh>刷新情报</button>
      </div>
      ${
        report.meta?.sample_warning
          ? `<div class="intel-warning">面经样本量不足，考点提炼仅供参考。建议打开原始链接继续核验。</div>`
          : ""
      }

      <details class="intel-section" open>
        <summary>高频面试考点</summary>
        <ol class="intel-topic-list">
          ${(report.interview_topics || []).map(renderTopic).join("")}
        </ol>
      </details>

      <details class="intel-section" open>
        <summary>公司背景速览</summary>
        ${renderCompany(report.company_background)}
      </details>

      <details class="intel-section">
        <summary>行业背景速览</summary>
        ${renderIndustry(report.industry_background)}
      </details>

      <details class="intel-section">
        <summary>原始资料汇总</summary>
        <div class="source-toolbar">
          <select data-source-filter aria-label="按平台筛选">
            <option value="">全部平台</option>
            ${platforms.map((platform) => `<option value="${escapeAttr(platform)}">${escapeHtml(platform)}</option>`).join("")}
          </select>
          <select data-source-sort aria-label="资料排序">
            <option value="quality">按质量分</option>
            <option value="time">按发布时间</option>
          </select>
        </div>
        <div class="source-table-wrap">
          <table class="source-table">
            <thead>
              <tr>
                <th>平台</th>
                <th>标题</th>
                <th>时间</th>
                <th>质量</th>
              </tr>
            </thead>
            <tbody>
              ${(report.raw_sources || []).map(renderSourceRow).join("")}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  `;
}

export function renderIntelligenceError(message) {
  return `<div class="intel-error">${escapeHtml(message || "情报任务失败，请稍后重试")}</div>`;
}

export function bindIntelligenceControls(root, options = {}) {
  const refreshButton = root.querySelector("[data-intel-refresh]");
  if (refreshButton && options.onRefresh) refreshButton.addEventListener("click", options.onRefresh);

  const filter = root.querySelector("[data-source-filter]");
  const sorter = root.querySelector("[data-source-sort]");
  const rows = () => [...root.querySelectorAll(".source-table tbody tr")];

  if (filter) {
    filter.addEventListener("change", () => {
      for (const row of rows()) {
        row.hidden = Boolean(filter.value) && row.dataset.platform !== filter.value;
      }
    });
  }

  if (sorter) {
    sorter.addEventListener("change", () => {
      const tbody = root.querySelector(".source-table tbody");
      if (!tbody) return;
      const key = sorter.value;
      rows()
        .sort((a, b) => Number(b.dataset[key] || 0) - Number(a.dataset[key] || 0))
        .forEach((row) => tbody.appendChild(row));
    });
  }
}

function renderTopic(item) {
  return `
    <li class="intel-topic">
      <div class="intel-topic-head">
        <strong>${escapeHtml(item.topic)}</strong>
        <span class="pill">${Number(item.frequency || 0)} 次</span>
      </div>
      <div class="intel-questions">
        ${(item.example_questions || []).map((question) => `<p>${escapeHtml(question)}</p>`).join("")}
      </div>
      <div class="intel-links">
        ${(item.sources || []).map(renderInlineSource).join("")}
      </div>
    </li>
  `;
}

function renderCompany(company = {}) {
  return `
    <p class="intel-copy">${escapeHtml(company.summary || "暂无公司背景摘要。")}</p>
    <div class="chips">${(company.core_products || []).map((item) => `<span class="chip good">${escapeHtml(item)}</span>`).join("")}</div>
    <p class="muted">${escapeHtml(company.department_positioning || "")}</p>
    <div class="intel-card-list">
      ${(company.recent_news || []).map(renderNewsCard).join("")}
    </div>
  `;
}

function renderIndustry(industry = {}) {
  return `
    <p class="intel-copy"><strong>${escapeHtml(industry.category || "行业")}</strong>：${escapeHtml(industry.summary || "暂无行业背景摘要。")}</p>
    <div class="chips">${(industry.competitors || []).map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}</div>
    <div class="intel-timeline">
      ${(industry.recent_events || []).map(renderEvent).join("")}
    </div>
  `;
}

function renderNewsCard(item) {
  return `
    <article class="intel-card">
      <a href="${escapeAttr(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(truncate(item.title, 40))}</a>
      <span class="muted">${relativeTime(item.published_at)}</span>
      <p>${escapeHtml(item.summary || "")}</p>
    </article>
  `;
}

function renderEvent(item) {
  return `
    <article class="intel-event">
      <span>${formatDate(item.date)}</span>
      <a href="${escapeAttr(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(truncate(item.title, 40))}</a>
      <p>${escapeHtml(item.summary || "")}</p>
    </article>
  `;
}

function renderInlineSource(source) {
  return `<a href="${escapeAttr(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.platform)} · ${escapeHtml(truncate(source.title, 40))}</a>`;
}

function renderSourceRow(source) {
  const timeValue = new Date(source.published_at || 0).getTime() || 0;
  return `
    <tr data-platform="${escapeAttr(source.platform)}" data-quality="${Number(source.quality_score || 0)}" data-time="${timeValue}">
      <td>${escapeHtml(source.platform || "-")}</td>
      <td>
        <a href="${escapeAttr(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(truncate(source.title || "-", 40))}</a>
        <p class="muted">${escapeHtml(truncate(source.snippet || "", 72))}</p>
      </td>
      <td>${relativeTime(source.published_at)}</td>
      <td><strong>${Number(source.quality_score || 0)}</strong>${source.is_expired ? ` <span class="expired-badge">已失效</span>` : ""}</td>
    </tr>
  `;
}

function stage(key, label, current) {
  const order = ["queued", "search", "fetch", "analyze", "done"];
  const done = order.indexOf(current) >= order.indexOf(key);
  return `<span class="${done ? "done" : ""}">${escapeHtml(label)}</span>`;
}

async function api(path, options = {}) {
  const headers = options.body instanceof FormData ? {} : { "Content-Type": "application/json" };
  const response = await fetch(path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || "请求失败");
  return data;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().slice(0, 10);
}

function relativeTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const days = Math.max(0, Math.round((Date.now() - date.getTime()) / 86400000));
  if (days < 31) return `${days || 1} 天前`;
  const months = Math.max(1, Math.round(days / 30));
  return `${months} 个月前`;
}

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
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
