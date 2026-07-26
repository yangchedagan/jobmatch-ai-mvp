import { agentSync, sampleResume } from "/app.js";

const $ = (selector) => document.querySelector(selector);

const chat = {
  sessionId: sessionStorage.getItem("jobmatch_agent_session") || null,
  pendingFile: null,
  busy: false,
};

const WELCOME = "你好，我是 JobMatch AI 求职助手。把简历发给我，我可以帮你：解析简历、筛选岗位、匹配打分、推荐 Top10、生成面试情报。直接用一句话告诉我你想做什么。";

initChat();

function initChat() {
  const composer = $("#chatComposer");
  if (!composer) return;

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    sendCurrentMessage();
  });

  const input = $("#chatInput");
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendCurrentMessage();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  });

  $("#chatFile").addEventListener("change", (event) => {
    const file = event.target.files[0];
    setPendingFile(file || null);
  });
  $("#chatAttachmentClear").addEventListener("click", () => setPendingFile(null));

  document.querySelectorAll(".chat-chip").forEach((chip) => {
    chip.addEventListener("click", () => runChip(chip.dataset.chip));
  });

  const stream = $("#chatStream");
  ["dragenter", "dragover"].forEach((name) =>
    stream.addEventListener(name, (event) => {
      event.preventDefault();
      stream.classList.add("dragging");
    }),
  );
  ["dragleave", "drop"].forEach((name) =>
    stream.addEventListener(name, (event) => {
      event.preventDefault();
      stream.classList.remove("dragging");
    }),
  );
  stream.addEventListener("drop", (event) => {
    const file = event.dataTransfer.files[0];
    if (file) setPendingFile(file);
  });

  appendAgentText(WELCOME, { animate: false });
}

function runChip(kind) {
  if (kind === "sample") {
    $("#chatInput").value = sampleResume;
    $("#chatInput").dispatchEvent(new Event("input"));
    $("#chatInput").focus();
    return;
  }
  const presets = {
    recommend: "用我的简历推荐 Top10 岗位",
    campus: "找找产品经理的校招岗位",
    radar: "最近匹配的岗位面试考什么？",
  };
  if (presets[kind]) sendMessage(presets[kind]);
}

function setPendingFile(file) {
  chat.pendingFile = file || null;
  const pill = $("#chatAttachmentPill");
  if (!file) {
    pill.hidden = true;
    $("#chatFile").value = "";
    return;
  }
  $("#chatAttachmentName").textContent = `${file.name} · ${formatBytes(file.size)}`;
  pill.hidden = false;
}

async function sendCurrentMessage() {
  const input = $("#chatInput");
  const text = input.value.trim();
  if (!text && !chat.pendingFile) return;
  input.value = "";
  input.style.height = "auto";
  await sendMessage(text);
}

async function sendMessage(text) {
  const file = chat.pendingFile;
  setPendingFile(null);
  const attachment = file ? await encodeFile(file).catch(() => null) : undefined;
  await postChat({ message: text, attachment }, text || `上传附件：${file?.name || ""}`);
}

async function sendCommand(action) {
  await postChat({ command: { ...action.command, label: action.label } }, action.label);
}

async function postChat(payload, displayText) {
  if (chat.busy) return;
  chat.busy = true;
  $("#chatSendBtn").disabled = true;

  appendUserNote(displayText);
  const thinking = appendThinking();

  try {
    const response = await fetch("/api/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: chat.sessionId, ...payload }),
    });
    const data = await response.json();
    thinking.remove();

    if (!response.ok) {
      appendAgentText(data.message || data.error || "请求失败，请稍后重试。");
      return;
    }

    chat.sessionId = data.sessionId;
    sessionStorage.setItem("jobmatch_agent_session", data.sessionId);
    (data.cards || []).forEach((card) => {
      appendCard(card);
      syncCardToPages(card);
    });
    appendAgentText(data.reply || "完成。");
    renderActions(data.actions || []);
  } catch (error) {
    thinking.remove();
    appendAgentText(`网络异常：${error.message}`);
  } finally {
    chat.busy = false;
    $("#chatSendBtn").disabled = false;
    $("#chatInput").focus();
  }
}

function encodeFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(",")[1] || "";
      resolve({ filename: file.name, content_type: file.type || "application/octet-stream", content_base64: base64 });
    };
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

/* 卡片数据同步到工作台 / 匹配报告 / 情报雷达页，切页即见 */
function syncCardToPages(card) {
  try {
    if (card.type === "resume") agentSync.resume(card.data);
    else if (card.type === "match_report") agentSync.matchReport(card.data);
    else if (card.type === "job_ranking") agentSync.ranking(card.data, card.title || "Agent 推荐排行");
    else if (card.type === "radar") agentSync.radar(card.data);
  } catch (error) {
    console.warn("[agentSync]", card.type, error);
  }
}

/* ---------- 消息渲染 ---------- */

function appendUserNote(text) {
  const node = el("div", "chat-entry user-entry");
  node.innerHTML = `<div class="user-note">${escapeHtml(text).slice(0, 2000)}</div>`;
  mount(node);
}

function appendAgentText(text, options = {}) {
  const node = el("div", `chat-entry agent-entry${options.animate === false ? " no-anim" : ""}`);
  node.innerHTML = `<div class="agent-text">${escapeHtml(stripMarkdown(text))}</div>`;
  mount(node);
  return node;
}

function stripMarkdown(text) {
  return String(text || "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/^[-*]\s+/gm, "· ");
}

function appendThinking() {
  const node = el("div", "chat-entry agent-entry thinking");
  node.innerHTML = `<div class="agent-text"><span class="think-dot"></span><span class="think-dot"></span><span class="think-dot"></span></div>`;
  mount(node);
  return node;
}

function appendCard(card) {
  const renderers = {
    resume: renderResumeCard,
    job_list: renderJobListCard,
    job_ranking: renderRankingCard,
    match_report: renderMatchReportCard,
    radar: renderRadarCard,
    interview_report: renderInterviewReportCard,
    info: renderInfoCard,
  };
  const renderer = renderers[card.type] || renderInfoCard;
  const node = el("div", "chat-entry agent-entry");
  node.innerHTML = `<article class="chat-card card-${card.type}">${renderer(card)}</article>`;
  mount(node);
  if (card.type === "job_list" || card.type === "job_ranking") bindJobSelection(node);
}

/* 岗位卡片多选 → 生成匹配报告 */
function bindJobSelection(node) {
  const rows = [...node.querySelectorAll("[data-job-id]")];
  const bar = node.querySelector(".card-select-bar");
  if (!rows.length || !bar) return;
  const countLabel = bar.querySelector(".select-count");
  const confirmBtn = bar.querySelector(".select-confirm");

  const selectedIds = () => rows.filter((row) => row.classList.contains("selected")).map((row) => row.dataset.jobId);

  const refresh = () => {
    const count = selectedIds().length;
    bar.hidden = count === 0;
    countLabel.textContent = `已选 ${count} 个岗位`;
    confirmBtn.disabled = count === 0;
  };

  rows.forEach((row) => {
    row.addEventListener("click", () => {
      row.classList.toggle("selected");
      refresh();
    });
  });

  confirmBtn.addEventListener("click", () => {
    const ids = selectedIds().slice(0, 5);
    if (!ids.length) return;
    sendCommand({
      label: `生成匹配报告（${ids.length} 个岗位）`,
      command: { skill: "match_job", args: { job_ids: ids } },
    });
  });
}

function renderActions(actions) {
  if (!actions.length) return;
  const node = el("div", "chat-entry agent-entry");
  node.innerHTML = `<div class="chat-action-row">${actions
    .slice(0, 6)
    .map((action, index) => `<button type="button" class="chat-action" data-action-index="${index}">${escapeHtml(action.label)}</button>`)
    .join("")}</div>`;
  node.querySelectorAll(".chat-action").forEach((button) => {
    button.addEventListener("click", () => {
      node.remove();
      sendCommand(actions[Number(button.dataset.actionIndex)]);
    });
  });
  mount(node);
}

function renderResumeCard(card) {
  const resume = card.data || {};
  const skills = (resume.skills || []).slice(0, 14);
  return `
    <header class="card-head"><span class="card-kicker">简历档案</span><h3>${escapeHtml(resume.name || "候选人")}</h3></header>
    <p class="card-meta">${escapeHtml(resume.highest_degree || "学历未识别")} · ${resume.total_years || 0} 年经验 · ${(resume.projects || []).length} 个项目</p>
    <div class="card-chips">${skills.map((skill) => `<span>${escapeHtml(skill)}</span>`).join("")}${(resume.skills || []).length > 14 ? `<span class="more">+${resume.skills.length - 14}</span>` : ""}</div>
    ${(resume.warnings || []).length ? `<p class="card-warn">${escapeHtml(resume.warnings[0])}</p>` : ""}`;
}

function renderJobListCard(card) {
  const jobs = card.data || [];
  return `
    <header class="card-head"><span class="card-kicker">${escapeHtml(card.title || "岗位")}</span><span class="card-hint">点击勾选</span></header>
    <ul class="card-joblist">
      ${jobs
        .map(
          (job) => `
        <li class="selectable" data-job-id="${escapeHtml(job.id || "")}">
          <span class="select-dot" aria-hidden="true"></span>
          <div class="job-cell">
            <div class="job-line">
              <strong>${escapeHtml(job.job_title || "")}</strong>
              <span class="job-company">${escapeHtml(job.company || "")}</span>
            </div>
            <span class="job-tags">${escapeHtml(job.recruitment_type || "")} · ${escapeHtml(job.category || "")} · ${escapeHtml((job.location || []).slice(0, 2).join("/"))}</span>
          </div>
        </li>`,
        )
        .join("")}
    </ul>
    <footer class="card-select-bar" hidden>
      <span class="select-count"></span>
      <button type="button" class="select-confirm" disabled>生成匹配报告</button>
    </footer>`;
}

function renderRankingCard(card) {
  const reports = card.data || [];
  return `
    <header class="card-head"><span class="card-kicker">${escapeHtml(card.title || "推荐")}</span><span class="card-hint">点击勾选</span></header>
    <ol class="card-ranking">
      ${reports
        .map(
          (report) => `
        <li class="selectable" data-job-id="${escapeHtml(report.job_id || "")}">
          <span class="select-dot" aria-hidden="true"></span>
          <span class="rank-score" data-grade="${escapeHtml(report.grade || "")}">${report.total_score ?? "--"}</span>
          <div class="rank-body">
            <strong>${escapeHtml(report.company || "")} · ${escapeHtml(report.job_title || "")}</strong>
            <span>${escapeHtml(report.grade || "")}${(report.gap_skills || []).length ? ` · 缺口：${escapeHtml(report.gap_skills.slice(0, 3).map((gap) => gap.keyword).join("、"))}` : ""}</span>
          </div>
        </li>`,
        )
        .join("")}
    </ol>
    <footer class="card-select-bar" hidden>
      <span class="select-count"></span>
      <button type="button" class="select-confirm" disabled>生成匹配报告</button>
    </footer>`;
}

function renderMatchReportCard(card) {
  const report = card.data || {};
  const dims = report.dimensions || [];
  const analysis = report.llm_analysis || {};
  return `
    <header class="card-head match-head">
      <div>
        <span class="card-kicker">匹配报告</span>
        <h3>${escapeHtml(card.title || "")}</h3>
        <p class="card-meta">${escapeHtml(report.role_focus || "")}</p>
      </div>
      <div class="score-seal" data-grade="${escapeHtml(report.grade || "")}">
        <strong>${report.total_score ?? "--"}</strong>
        <span>${escapeHtml(report.grade || "")}</span>
      </div>
    </header>
    <div class="card-dims">
      ${dims
        .map(
          (dim) => `
        <div class="dim-row">
          <span class="dim-name">${escapeHtml(dim.label || dim.key || "")}</span>
          <span class="dim-bar"><i style="width:${Math.min(100, Number(dim.score) || 0)}%"></i></span>
          <span class="dim-score">${dim.score ?? "--"}</span>
        </div>`,
        )
        .join("")}
    </div>
    ${analysis.match_explanation ? `<p class="card-explain">${escapeHtml(analysis.match_explanation)}</p>` : ""}
    ${
      (analysis.interview_predictions || []).length
        ? `<details class="card-fold"><summary>可能被问到（${analysis.interview_predictions.length}）</summary><ul>${analysis.interview_predictions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>`
        : ""
    }`;
}

function renderRadarCard(card) {
  const report = card.data || {};
  const analysis = report.llm_analysis || {};
  const topics = report.interview_topics || [];
  const company = report.company_background || {};
  const industry = report.industry_background || {};
  const sources = report.raw_sources || [];
  const meta = report.meta || {};

  return `
    <header class="card-head">
      <div>
        <span class="card-kicker">情报雷达</span>
        <h3>${escapeHtml(card.title || "")}</h3>
        <p class="card-meta">${meta.total_sources || 0} 条资料线索 · ${topics.length} 个考点 · ${formatDate(report.generated_at)} 生成${meta.sample_warning ? " · 样本较少仅供参考" : ""}</p>
      </div>
    </header>
    ${analysis.radar_brief ? `<p class="card-explain">${escapeHtml(analysis.radar_brief)}</p>` : ""}

    <details class="card-fold" open>
      <summary>高频考点明细（${topics.length}）</summary>
      <ul class="radar-topics">
        ${topics
          .map(
            (topic) => `
          <li>
            <div class="topic-line">
              <strong>${escapeHtml(topic.topic || "")}</strong>
              <span class="topic-freq">×${topic.frequency || 1}</span>
            </div>
            ${(topic.example_questions || []).map((question) => `<p class="topic-question">・${escapeHtml(question)}</p>`).join("")}
            ${
              (topic.sources || []).length
                ? `<p class="topic-sources">来源：${topic.sources
                    .map((source) => `<a href="${escapeHtml(source.url || "#")}" target="_blank" rel="noopener">${escapeHtml(source.platform || "链接")}</a>`)
                    .join(" · ")}</p>`
                : ""
            }
          </li>`,
          )
          .join("")}
      </ul>
    </details>

    ${
      (analysis.interview_predictions || []).length
        ? `<details class="card-fold" open><summary>面试预测题（${analysis.interview_predictions.length}）</summary><ul>${analysis.interview_predictions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>`
        : ""
    }
    ${
      (analysis.preparation_tips || []).length
        ? `<details class="card-fold" open><summary>准备建议（${analysis.preparation_tips.length}）</summary><ul>${analysis.preparation_tips.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>`
        : ""
    }

    <details class="card-fold">
      <summary>公司背景</summary>
      ${company.summary ? `<p class="radar-text">${escapeHtml(company.summary)}</p>` : ""}
      ${company.department_positioning ? `<p class="radar-text muted-text">部门定位：${escapeHtml(company.department_positioning)}</p>` : ""}
      ${
        (company.core_products || []).length
          ? `<div class="card-chips">${company.core_products.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>`
          : ""
      }
      ${
        (company.recent_news || []).length
          ? `<ul class="radar-links">${company.recent_news
              .map(
                (item) => `<li><a href="${escapeHtml(item.url || "#")}" target="_blank" rel="noopener">${escapeHtml(item.title || "")}</a><span class="link-date">${formatDate(item.published_at)}</span></li>`,
              )
              .join("")}</ul>`
          : ""
      }
    </details>

    <details class="card-fold">
      <summary>行业背景 · ${escapeHtml(industry.category || "")}</summary>
      ${industry.summary ? `<p class="radar-text">${escapeHtml(industry.summary)}</p>` : ""}
      ${
        (industry.competitors || []).length
          ? `<p class="radar-text muted-text">竞争对手：${industry.competitors.map(escapeHtml).join("、")}</p>`
          : ""
      }
      ${
        (industry.recent_events || []).length
          ? `<ul class="radar-links">${industry.recent_events
              .map(
                (item) => `<li><a href="${escapeHtml(item.url || "#")}" target="_blank" rel="noopener">${escapeHtml(item.title || "")}</a><span class="link-date">${formatDate(item.date)}</span></li>`,
              )
              .join("")}</ul>`
          : ""
      }
    </details>

    <details class="card-fold">
      <summary>资料线索（${sources.length}）</summary>
      <ul class="radar-sources">
        ${sources
          .map(
            (source) => `
          <li>
            <div class="source-line">
              <span class="source-platform">${escapeHtml(source.platform || "")}</span>
              <a href="${escapeHtml(source.url || "#")}" target="_blank" rel="noopener">${escapeHtml(source.title || "")}</a>
              <span class="source-score">${source.quality_score ?? "--"}</span>
            </div>
            ${source.snippet ? `<p class="source-snippet">${escapeHtml(source.snippet)}</p>` : ""}
          </li>`,
          )
          .join("")}
      </ul>
    </details>

    ${
      (report.search_keywords || []).length
        ? `<div class="radar-keywords"><span class="muted-text">搜索关键词：</span>${report.search_keywords.map((keyword) => `<span class="keyword-tag">${escapeHtml(keyword)}</span>`).join("")}</div>`
        : ""
    }`;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function renderInterviewReportCard(card) {
  const report = card.data || {};
  const records = report.records || [];
  return `
    <header class="card-head match-head">
      <div>
        <span class="card-kicker">面试模拟报告</span>
        <h3>${escapeHtml(report.company || "")} · ${escapeHtml(report.job_title || "")}</h3>
        <p class="card-meta">共 ${records.length} 题 · 回答 ${records.filter((r) => r.score != null).length} 题</p>
      </div>
      ${
        report.total_score != null
          ? `<div class="score-seal" data-grade=""><strong>${report.total_score}</strong><span>综合</span></div>`
          : ""
      }
    </header>
    <ul class="interview-records">
      ${records
        .map(
          (record, index) => `
        <li>
          <div class="record-line">
            <span class="record-index">Q${index + 1}</span>
            <span class="record-question">${escapeHtml(record.question || "")}</span>
            <span class="record-score">${record.skipped ? "跳过" : record.score != null ? `${record.score}/10` : "--"}</span>
          </div>
          ${(record.improvements || []).length ? `<p class="record-tip">${escapeHtml(record.improvements.join("；"))}</p>` : ""}
        </li>`,
        )
        .join("")}
    </ul>
    ${
      (report.suggestions || []).length
        ? `<details class="card-fold" open><summary>备战建议</summary><ul>${report.suggestions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>`
        : ""
    }`;
}

function renderInfoCard(card) {
  return `
    <header class="card-head"><span class="card-kicker">${escapeHtml(card.title || "结果")}</span></header>
    <pre class="card-json">${escapeHtml(JSON.stringify(card.data || {}, null, 2).slice(0, 1200))}</pre>`;
}

/* ---------- 工具 ---------- */

function mount(node) {
  const stream = $("#chatStream");
  stream.appendChild(node);
  stream.scrollTo({ top: stream.scrollHeight, behavior: "smooth" });
}

function el(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
