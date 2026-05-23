# JobMatch AI MVP

> Public demo deployment is supported through `DEMO_MODE=true`. In demo mode,
> uploaded resumes are kept in short-lived memory only, response payloads redact
> raw resume text/contact fields, and admin-only routes are protected or hidden.

基于 PRD v1.0 实现的单机可运行 MVP，覆盖「简历识别 → 岗位库 → 智能匹配报告」闭环。

## 运行

```bash
npm run dev
```

Windows PowerShell 如果拦截 `npm.ps1`，使用：

```powershell
npm.cmd run dev
```

或直接运行：

```powershell
node server.js
```

打开浏览器访问：

```text
http://localhost:5173
```

后台页：

```text
http://localhost:5173/admin
```

后台会展示运行日志、简历解析记录、匹配记录、岗位同步记录和错误日志。运行态日志保存在 `data/admin-log.json`，匹配报告缓存保存在 `data/report-cache.json`。

核心服务使用 Node.js 20+ 即可运行；PDF 文本解析与 OCR 依赖见下方可选依赖说明。

## 已实现

- 简历上传 / 粘贴解析：支持 TXT、Markdown、文字层 PDF；PDF 文本层提取已切换为 PDF.js（`pdfjs-dist`），可处理 CID / ToUnicode / Identity-H 等复杂字体编码；图片/扫描件 PDF 可走 OCR fallback。
- 结构化简历 JSON：基本信息、教育、经历、技能、项目、软素质、求职意向。
- 岗位库同步：合并 `data/jobs.seed.json`、`data/jobs.expanded.seed.json`、`data/jobs.generated.seed.json` 与可选实时抓取结果，覆盖校招 / 社招 / 实习，保留真实爬虫策略边界。
- 官方入口爬虫：`POST /api/jobs/crawl` 会按 `data/crawler.sources.json` 抓取招聘入口，先校验 robots.txt，再按同域名间隔限速，结果落到 `data/jobs.live.json` 后合并入岗位库。
- JD 标准化：硬技能、软素质、年限、学历要求结构化。
- 关键词匹配引擎：按角色方向输出 0-100 分、等级、维度明细、亮点、缺口与冗余项；前端默认按产品经理方向优先匹配。
- 前端工作台：简历解析、岗位筛选、主动匹配、批量匹配、Top10 推荐、字段修正。
- 岗位库筛选：支持目标方向、公司、岗位性质（校招 / 社招 / 实习）、类型和关键词搜索。
- 本地缓存：匹配报告 24 小时 TTL，数据落在 `data/`。

## API

- `GET /api/health`
- `GET /api/admin`
- `GET /api/jobs`
- `POST /api/jobs/sync`
- `POST /api/jobs/crawl`
- `POST /api/resumes/parse`
- `GET /api/resumes/latest`
- `PUT /api/resumes/:id`
- `POST /api/match`
- `POST /api/match/batch`

## 测试

```bash
npm test
```

Windows PowerShell：

```powershell
npm.cmd test
```

## Deployment

Recommended public demo settings for Render or Railway:

- Build command: `npm ci`
- Start command: `npm start`
- Required environment: `NODE_ENV=production`, `DEMO_MODE=true`, `HOST=0.0.0.0`
- Set `CORS_ORIGIN` to the deployed origin after the first successful deploy.
- Optional: set `ADMIN_TOKEN` to access protected admin routes with `X-Admin-Token`.

Runtime JSON files under `data/` are intentionally ignored except seed/source
files. Do not commit resumes, report caches, admin logs, generated live jobs, or
local log files.

Before the first GitHub push:

```powershell
git status --untracked-files=all --short
git status --ignored --short
npm.cmd test
npm.cmd audit --audit-level=moderate --omit=dev
```

## OCR 可选依赖

PDF 文本解析依赖 `pdfjs-dist`。若要识别扫描件 PDF 或 PNG/JPG 图片简历，还需要 OCR 可选依赖：

```bash
npm install
```

OCR 相关包在 `optionalDependencies` 中：`tesseract.js`、`canvas`。如果 `canvas` 安装失败，文字型 PDF/TXT 解析仍可使用；图片 OCR 会返回明确的依赖缺失提示。

## 后续替换点

- 可将 `src/domain/ocrAdapter.js` 替换为 PaddleOCR 服务以提升中文扫描件识别准确率。
- 继续增强 `src/domain/jobCrawler.js`，把当前 HTML 关键词候选提取升级为各招聘站点的结构化接口适配器。
- 将 `src/domain/matchEngine.js` 替换或扩展为向量语义匹配。
- 将本地 JSON 存储迁移到 MySQL / MongoDB / Redis。
