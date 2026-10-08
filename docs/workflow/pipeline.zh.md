# 端到端工作流 / SOP

> 中文版。英文版见 [pipeline.en.md](pipeline.en.md)。
>
> 本文是**详细介绍完整 SOP 的唯一入口**，按顺序展开。文中涉及的每个工具/命令的完整参数参考见 [../reference/mcp-tools.zh.md](../reference/mcp-tools.zh.md) 与 [../reference/cli-commands.zh.md](../reference/cli-commands.zh.md)。

## 0. 总览

流水线是一个闭环。从站点与诊断出发，产出方案与文章，先发布草稿、再定时正式发布，提交搜索引擎收录，并测量 AI 可见性——其结果反馈到下一轮规划。

**文章计划**（article plan）上的规范状态机：

```
todo → written → queued → published
```

- `todo` —— 已规划但尚未写作的文章。
- `written` —— 正文已写好（配图可能未完成）。
- `queued` —— WordPress **草稿**已就位，等待排期槽位。
- `published` —— 文章已正式上线。

发布日历来自 `config/wordpress.yaml`（`publish.per_day` / `publish.skip_dates`），控制每天提升多少个待发草稿、跳过哪些日期。

---

## 阶段 A —— 诊断与方案

### A1. 绑定工作区并（重新）创建站点

引擎从不猜测目录。先绑定用户工作区，再确保站点存在。

- **MCP**：`workspace_use { path }` → `site_init { key, domain? }` → `site_list` / `site_status`
- **CLI**：工作区取自 `SITES_ROOT`；站点通过模板拷贝搭建

`site_status` 返回配置路径、`.env` 就绪状态、DB 驱动与 SQLite 初始化状态，用于在诊断前确认站点可用。

### A2. 诊断站点

- **MCP**：`diagnose_site { url, site?, pages?, max_pages? }`
- **CLI**：无（诊断是 MCP/SDK 能力）

执行完整 GEO/SEO 健康检查：域名（DNS/TLS/WHOIS）、传输与服务端指纹（CMS/框架/CDN）、robots.txt、sitemap、首页 + 代表性页面（meta、H1–H6 结构、JSON-LD、OG、图片/alt、链接、混合内容）、性能与安全检查。首次使用时会根据 URL 自动搭建站点。

### A3. 生成实施方案

- **MCP**：`site_geo_plan_skill { }` —— 读取规范化的方案模板
- **MCP**：`report_write { content, filename? }` —— 把 Markdown 方案写入 `<site>/data/reports/`

`site_geo_plan_skill` 返回 site-geo-plan 技能规范（`SKILL.md` + `references/plan-template.md`），用于指导详细方案生成：多部分结构（**上篇技术修复 / 中篇关键词与内容 / 价值桥接 / 下篇实施保障 / 附录**），每条诊断问题展开为 **现状 → 方案 → 步骤 → 验收**，并包含**完整关键词矩阵**与**人力人日矩阵**。调用方据此实现/校验方案。

---

## 阶段 B —— 规划：关键词矩阵与发布计划

### B1. 关键词矩阵与格式选型

- **MCP**：`standards_read { name: "content-strategy" }` —— 格式选型规则与节奏
- **MCP**：`standards_list` / `standards_read` —— 所有标准的渐进加载索引

关键词矩阵来自实施方案（阶段 A3），被转成文章计划表中的具体行。`content-strategy` 标准驱动文章类型路由（T1–T7）与节奏。

### B2. 装载文章计划（发布排期）

- **MCP**：`plan_import { rows[] }` —— 按 `slug`+`lang` 幂等 upsert 计划行；每种语言一行
- **MCP**：`plan_list { status?, batch?, lang?, limit? }` —— 查看队列
- **MCP**：`plan_mark_status { slug, status }` —— 变更行状态（`todo|written|queued|published|archived`）
- **CLI**：`tengence-geo-plan` —— 终端里做计划维护

关键计划字段：`slug`、`lang`、`node_type`（spoke|hub）、`title`、`focus_keyword`、`content_type`、`publish_order`、`category`、`tags`、`plan_status`。

> 翻译行（`lang=en|zh-hant`）必须通过 `plan_import` 的带 key 的 upsert（相同 slug）写入——绝不能只用 slug，否则会静默覆盖 zh-hans 源行。

---

## 阶段 C —— 内容生产

### C1. 起草文章

- **MCP**：`article_draft { type?, topic? }` —— 返回匹配的 **T1–T7 正文骨架**、**research-brief 模板**与完整 **`article-writing-standards`**
- **MCP**：`standards_read { name }` —— 按需读取任一标准

根据 brief 撰写 Markdown 正文。正文必须使用规范 GEO 区块标题（见 `standards/block-conventions.md`）：摘要、关键要点、FAQ、数据来源、相关阅读、立即行动、关于。

### C2. 摄取文章

- **MCP**：`article_ingest { slug, md_path, research_path?, lang? }` —— 正文 + research brief → `articles` 表
- **MCP**：`article_export { slug, lang? }` —— 导出文章 + brief 到 `data/inbox`（用于改写/翻译）
- **CLI**：`tengence-geo-article-ingest <slug> <md> --research <brief>`
- **CLI**：`tengence-geo-article-save <article_id> <file>`

`article_ingest` 摄取后会自动归档源文件（除非 `--no-archive`）。

### C3. 多语言翻译

- **MCP**：`translation_glossary_get { target_lang }` —— 合并的全局 + 站点术语表（品牌/短语/产品词/禁用词）
- （用你自己的 LLM 翻译到 `en` / `zh-hant`。）
- **MCP**：`check_translation { slug, source_lang, target_lang, md_path? }` —— 摄取前的机械门禁 T1–T11
- **MCP**：`article_ingest { slug, md_path, lang }` —— 摄取译文（`--lang en|zh-hant`）
- **CLI**：`tengence-geo-article-ingest <slug> <md> --lang en|zh-hant`

翻译门禁检查结构/区块/编号、与源文章的链接集 & 图片集 & 数字集一致、简体中文与 CJS 残留、禁用词、分节长度、标题与 meta 长度。翻译与其源文章**共享同一张头图**；内链改写为对应语言前缀。

---

## 阶段 D —— 配图与门禁

### D1. 采集头图

- **MCP**：`image_acquire { query, slug, count?, dry_run? }`
- **CLI**：`tengence-geo-image-acquire --query <kw> --slug <slug> --count <n>`

运行自动图片流水线：**检索 → 红线过滤 → 下载 → WebP 裁剪 → 上传 WordPress 媒体库**。`dry_run` 只预览不落库。

### D2. 运行编辑门禁

- **MCP**：`check_article { slug, type?, lang? }`
- **CLI**：`tengence-geo-check-article <slug> [--type=T1..T7]`

强制 `article-writing-standards` 中固化的编辑规则（G1–G16）：引用双通道、按 T1–T7 类型的字数、禁用词、GEO 区块、research-brief 硬检查。**未通过门禁的草稿一律不得发布。** 已发布的行按“建议性”门禁处理（元数据修复不被晚于正文的规则阻塞）；草稿则保持硬门禁。

> 翻译由 `check_translation`（T1–T11）检查，而非 `check_article`。

---

## 阶段 E —— 发布

### E1. 发布为草稿

- **MCP**：`publish_draft { md_path, status?, site? }` —— 默认 `draft`
- **MCP**：`publish_from_db { article_id, status?, force?, translation_group?, sync_source_dates? }`
- **CLI**：`tengence-geo-publish-draft <md> --site <key> [--status=draft]`
- **CLI**：`tengence-geo-publish-from-db <article_id> --status=draft`

创建 **WordPress 草稿**（`wp_post_id` 落库，计划状态置 `queued`）。此时尚未上线。`--force` 更新已存在文章；翻译默认继承 zh-hans 源的发布/更新时间（`sync_source_dates=false` 可关闭）。

### E2. 定时正式发布

- **MCP**：`publish_daily { site?, date?, slug?, count?, dry_run? }`
- **CLI**：`tengence-geo-promote-daily [--date <ts>] [--slug <slug>] [--count <n>]`

把到期草稿提升为 **已发布**，按 `publish_order` 取队列最前面的 `queued` 行（`plan.nextDue`），遵循 `per_day` / `skip_dates`。选项：
- **队列模式（默认）**：提升接下来的 N 个 `queued` 草稿（`count`，默认取自 `wordpress.yaml`）。
- **slug 模式（`--slug`）**：把该 slug 的**所有语言版本**一起发布（zh-hans/en/zh-hant），仍执行内链检查与门禁复检。
- **`--date`**：设置被提升文章的发布时间（`YYYY-MM-DDTHH:MM:SS`，站点时区）——即 **定时** 正式发布。
- **`--dry-run`**：只报告。

计划行由 `queued → published`。

### E3. 发布到外部平台（分发）

- **MCP**：`channel_list` → `channel_style_get { platform }` → `channel_check { platform, title?, body? }` → `channel_publish { platform, slugs[]? , articles[]?, asDraft?, keepOrder?, dryRun? }`
- **CLI**：`tengence-geo-channel-publish --platform=<key> --slugs=a,b,c`
- **CLI**：`tengence-geo-publish-wechat <slug>` / `tengence-geo-publish-juejin` / `tengence-geo-publish-devto`

先经 `channel_style_get` 读取平台改写规则，按平台改写，再用 `channel_check` 校验，然后发布。微信走 **草稿 → 预览 → 群发** 流程（`wechat_draft_publish` / `wechat_mass_preview` / `wechat_mass_send`——最后一项是不可逆的推送，必须显式确认）。每次发布结果都按平台记录到 `channel_plan`，使每个平台拥有独立的发布日历。

### E4. 核对发布状态

- **MCP**：`wp_post_get { slug, lang? | wp_post_id }` —— 确认文章已不再是草稿
- **MCP**：`wechat_status` / `csdn_status` / `juejin_status` —— 读取各平台后台
- **CLI**：`tengence-geo-publish-update-article <md> --slug <s>` —— 更新已发布文章（或 `publish_update_fields` 更新任意单字段）

---

## 阶段 F —— 收录提交

发布后运行，让页面被收录：

- **MCP**：`search_submit_gsc { sitemap_url? }` —— Google Search Console sitemap（软失败）
- **MCP**：`search_submit_indexnow { url }` —— IndexNow（需要 `INDEXNOW_KEY`）
- **MCP**：`search_submit_baidu { url? | all, limit? }` —— 百度普通收录（需要 `BAIDU_TOKEN`）
- **MCP**：`webmaster_bing_submit { url }` —— Bing Webmaster（需要 `BING_WEBMASTER_API_KEY`）
- **CLI**：`tengence-geo-submit-gsc` / `tengence-geo-submit-indexnow` / `tengence-geo-submit-baidu` / `tengence-geo-bing-webmaster`

只读核对工具：`search_gsc_stats`（搜索分析）、`search_gsc_inspect`（单 URL 收录状态）、`webmaster_bing_status`（sites/quota/stats/issues）。

---

## 阶段 G —— 监测闭环

- **MCP**：`monitor_run { run_id?, models?, layers? }` —— 一轮 站点提示词 × 模型
- **MCP**：`monitor_report { run_id? }` —— 读取最新（或指定）一轮
- **CLI**：`tengence-geo-geo-monitor run` / `tengence-geo-geo-monitor-report`

结果测量 AI 可见性（收录基线 + 可见性）。监测反馈到**阶段 B**（topic-planning 刷新）与**阶段 D2**（下线/返工不达标文章），形成闭环。

---

## 高风险 / 不可逆操作

以下是对外、单向动作，执行前必须确认（`confirm=true` / `confirm="YES"`，或用户显式确认）：

- `wechat_mass_send`（推送粉丝——不可逆）
- `channel_publish` 且 `asDraft=false`（对外正式发布）
- `wechat_article_delete` / `csdn_article_delete` / `juejin_article_delete`
- `juejin_draft_delete`
- `db_init { drop: true }`（删除并重建数据库）
