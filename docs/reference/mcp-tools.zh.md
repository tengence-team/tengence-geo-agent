# MCP 工具参考 —— 72 个工具

> 中文版。英文版见 [mcp-tools.en.md](mcp-tools.en.md)。
>
> 权威来源：`packages/geo-mcp/tools/registry.js`。每个工具 = `{ name, description, inputSchema, run }`；所有响应均为 `content[0].text` 下的 JSON 字符串，成功含 `ok: true`，失败为 `{ ok: false, error }`（标记 `isError`）。
>
> **工作区与站点解析**：多数工具接受可选 `site`。工作区来源为 (a) `workspace_use` 参数、(b) 本会话先前的 `workspace_use`、(c) 持久化状态、或 (d) `SITES_ROOT`。当工作区恰有一个站点时自动选用；否则必须显式传 `site`。
>
> **语言码**统一为 `zh-hans | en | zh-hant`；旧区域码（`zh-cn`/`en-us`/`zh-hk`/`zh-tw`…）会被拒绝。

## 1. 工作区与站点（5）

### `workspace_use`
绑定用户工作区目录——站点配置、凭据与输出文件都在其下。先调用它。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 用户选择的绝对目录（如 `~/my-geo-workspace`） |
| `create` | boolean | 否 | 缺失时创建目录（默认 `false`） |

### `site_init`
在已绑定的工作区内搭建站点：`<workspace>/<key>/{config,data/inbox,data/reports,.env}`。幂等，从不覆盖已有文件。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `key` | string | 是 | 站点 key（小写字母、数字、下划线） |
| `domain` | string | 否 | 规范域名，默认取 key |
| `name` | string | 否 | 显示名，默认取域名 |
| `lang` | string | 否 | 默认语言（默认 `zh-hans`） |

### `site_list`
列出已绑定工作区内的站点（key、域名、app_id、存储驱动）。未绑定工作区时返回提示。

*参数：*无。

### `site_status`
站点状态：配置路径、`.env` 就绪状态、DB 驱动与 SQLite 初始化状态。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `site` | string | 否 | 站点 key；工作区只有一个站点时自动选用 |

### `util_ping`
连通性自检：SDK 版本、驱动、内部数据目录、已绑定工作区与站点数。

*参数：*无。

---

## 2. 诊断与方案（3）

### `diagnose_site`
完整 GEO/SEO 站点诊断：域名（DNS/TLS/WHOIS）、传输与服务端指纹（CMS/框架/CDN）、robots.txt、sitemap、首页 + 代表性页面（meta、H1–H6 结构、JSON-LD、OG、图片/alt、链接、混合内容）、性能与安全。首次使用自动搭建站点。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 站点 URL，如 `https://www.example.com` |
| `site` | string | 否 | 站点 key |
| `pages` | array(string) | 否 | 除首页外需诊断的额外页面 URL |
| `max_pages` | integer | 否 | 采样代表性页面上限（默认 4；站点是采样，从不全量爬取） |

### `site_geo_plan_skill`
只读访问 site-geo-plan 技能规范（`SKILL.md` + `references/plan-template.md`），用于指导详细 GEO/SEO 实施方案生成（多部分：上篇技术修复/中篇关键词与内容/价值桥接/下篇实施保障/附录；每条诊断问题展开为现状→方案→步骤→验收；完整关键词矩阵；人力人日矩阵）。原样返回两个文件。

*参数：*无。

### `report_write`
把 Markdown 报告写入 `<site>/data/reports/`（路径安全）。首次使用自动搭建站点。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `content` | string | 是 | Markdown 报告内容 |
| `filename` | string | 否 | 报告文件名（默认 `<YYYYMMDD>-<site>-diagnosis.md`） |
| `site` | string | 否 | 站点 key |

---

## 3. 写作标准（3）

### `standards_list`
列出引擎内置的通用写作与 GEO 标准（标题、是否存在站点补充文件）。

*参数：*无。

### `standards_read`
读取一个通用标准文档（合并基础 + 站点补充）。名称相对仓库且不带 `.md`，如 `article-writing-standards`、`content-strategy`、`block-conventions`、`templates/skeletons/howto`、`templates/research-brief`。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 是 | 不带 `.md` 的标准名（如 `article-writing-standards`） |

### `article_draft`
组装一份可用的写作 brief：匹配的 **T1–T7 正文骨架**、写作前的 **research-brief 模板**、完整**写作标准**（基础 + 补充）。先调用它，再写 Markdown 正文，然后 `check_article`。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | string | 否 | T1–T7 正文类型：`definition|howto|product|case|industry|comparison|guide`（默认 `guide`） |
| `topic` | string | 否 | 工作主题 / 目标关键词（回显进 brief 作上下文） |
| `site` | string | 否 | 站点 key |

---

## 4. 文章与内容（4）

### `article_list`
列出文章（articles 表），支持 status/lang/limit 过滤。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `site` | string | 否 | 站点 key |
| `status` | string | 否 | `draft|queued|published` 等（可选） |
| `lang` | string | 否 | 语言过滤（`zh-hans|en|zh-hant`；默认全部） |
| `limit` | number | 否 | 最大行数（默认 50） |

### `wp_post_get`
只读 WordPress 文章查询：按 `wp_post_id`，或按 `slug`+`lang`（经插件语言端点解析）。可选返回完整正文 HTML。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `site` | string | 否 | 站点 key |
| `wp_post_id` | number | 否 | WordPress 文章 ID |
| `slug` | string | 否 | 文章 slug（`wp_post_id` 缺失时必填） |
| `lang` | string | 否 | slug 查询语言：`zh-hans\|en\|zh-hant`（默认 `zh-hans`） |
| `include_content` | boolean | 否 | 是否同时返回正文 HTML（默认 `false`） |

### `article_ingest`
内容摄取（单入口）：正文 md + research brief → articles 表（CLI 规范化编排）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `slug` | string | 是 | 文章 slug |
| `md_path` | string | 是 | 正文 Markdown 文件的绝对路径 |
| `research_path` | string | 否 | research brief 的绝对路径（发布门禁要求） |
| `site` | string | 否 | 站点 key |
| `lang` | string | 否 | 语言（默认站点默认语言） |

### `article_export`
把文章的 md + brief 从 DB 导出到 `<site>/data/inbox`（用于改写/翻译）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `slug` | string | 是 | 文章 slug |
| `site` | string | 否 | 站点 key |
| `lang` | string | 否 | 语言（`zh-hans|en|zh-hant`；默认站点默认语言） |

---

## 5. 编辑与翻译门禁（3）

### `check_article`
发布门禁：强制 `article-writing-standards` 中固化的编辑规则（引用双通道、按 T1–T7 类型的字数、禁用词、GEO 区块——摘要/关键要点/FAQ/数据来源——以及 research-brief 硬检查）。写作前先读该标准，并先运行 `article_draft`。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `slug` | string | 是 | 文章 slug |
| `site` | string | 否 | 站点 key |
| `type` | string | 否 | T1..T7（声明时按类型硬查字数） |
| `lang` | string | 否 | 文章语言（默认站点默认语言） |

### `translation_glossary_get`
目标语言的翻译术语表：合并的全局 + 站点术语表（品牌 / 短语 / 产品词 / 禁用词）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `site` | string | 否 | 站点 key |
| `target_lang` | string | 是 | 目标语言（`en|zh-hant`） |

### `check_translation`
翻译文章的机械门禁（T1–T9）：结构/区块/编号、与源文章的链接集 & 图片集 & 数字集一致、简体中文与 CJS 残留、禁用词、分节长度、标题与 meta_description 长度。在 `article_ingest --lang` 前运行。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `slug` | string | 是 | 文章 slug（源；`md_path` 缺失时也指目标 DB 行） |
| `source_lang` | string | 是 | 源语言（`zh-hans`） |
| `target_lang` | string | 是 | 目标语言（`en|zh-hant`） |
| `md_path` | string | 否 | 译文的绝对路径（优先；缺失时从 DB 读目标） |
| `site` | string | 否 | 站点 key |

---

## 6. 图片采集（1）

### `image_acquire`
自动图片流水线：**检索 → 红线过滤 → 下载 → WebP 裁剪 → 上传 WP 媒体库**。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `query` | string | 是 | 图片搜索关键词 |
| `slug` | string | 是 | 目标文章 slug（用于登记） |
| `site` | string | 否 | 站点 key |
| `count` | number | 否 | 数量（默认 3） |
| `dry_run` | boolean | 否 | 只预览，不落库 |

---

## 7. 文章计划表（3）

### `plan_list`
文章计划表列表（status/batch/node/lang 过滤）。每种语言一行。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `site` | string | 否 | 站点 key |
| `status` | string | 否 | `todo|written|queued|published` 等 |
| `batch` | string | 否 | 批次 |
| `lang` | string | 否 | `zh-hans|en|zh-hant`（默认所有语言） |
| `limit` | number | 否 | 最大行数（默认 100） |

### `plan_import`
导入/更新计划表（按 `(slug, lang)` 幂等 upsert）。两种模式：(a) 不传 `rows`——DB 维护（回填 article_id/wp_post_id/published_url/featured_image、对账状态、分配 publish_order）；(b) 传 `rows[]`——直接写入显式计划行（翻译行正是这样创建/更新的）。绝不读取计划文档——先把 markdown/JSON 计划转成 `rows[]`。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `site` | string | 否 | 站点 key |
| `rows` | array(object) | 否 | 要 upsert 的显式计划行（按语言）。每行：`slug`（string，必填）、`lang`（zh-hans\|en\|zh-hant，默认 zh-hans）、`node_type`（spoke\|hub，默认 spoke）、`title`、`publish_order`（队列位置；翻译与源共享值以便一起发布）、`publish_batch`、`category`、`tags`（array）、`article_id`、`wp_post_id`、`published_url`、`plan_status`（todo\|written\|queued\|published\|paused）、`queued_at`、`published_at`、`languages`（WP locale 列表）、`notes` |

### `plan_mark_status`
更新计划行状态（`todo/written/queued/published/archived`）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `slug` | string | 是 | 文章 slug |
| `status` | string | 是 | 目标状态 |
| `site` | string | 否 | 站点 key |

---

## 8. WordPress 发布（5）

### `publish_draft`
发布草稿（默认 `draft` → WP；可直接 `--status=publish`，须先过门禁）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `md_path` | string | 是 | 正文 Markdown 的绝对路径 |
| `site` | string | 否 | 站点 key |
| `status` | string | 否 | `draft|publish`（默认 `draft`） |

### `publish_from_db`
从 DB 发布文章到 WordPress（`--force` 更新已有文章）。翻译（en/zh-hant）默认继承 zh-hans 源的发布+更新时间；传 `sync_source_dates=false` 关闭。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `article_id` | number | 是 | `articles.id` |
| `site` | string | 否 | 站点 key |
| `status` | string | 否 | `draft|publish`（默认 `draft`） |
| `force` | boolean | 否 | 已存在时强制更新 |
| `translation_group` | string | 否 | 一篇多语言文章共享的 translation-group UUID |
| `sync_source_dates` | boolean | 否 | 继承 zh-hans 源发布时间（默认 true；仅翻译） |

### `publish_update_article`
更新已发布文章（标题/正文/状态 + 同步 SEO/GEO meta）。传 `meta_title`/`meta_description`/`post_title` 时进入 **meta-only 模式**（只更新这些字段，正文不动）。单字段修改优先用 `publish_update_fields`。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `md_path` | string | 否 | 正文 Markdown（完整更新必需；meta-only 模式省略） |
| `meta_title` | string | 否 | 新 SEO 标题（≤200 字符）。提供即进入 meta-only 模式 |
| `meta_description` | string | 否 | 新 meta_description（165–175 字符）。meta-only 模式 |
| `post_title` | string | 否 | 新 WP 标题（≤200 字符，同步 DB title）。meta-only 模式 |
| `site` | string | 否 | 站点 key |
| `article_id` | number | 否 | `articles.id`（解析为 slug+lang+wp_post_id） |
| `slug` | string | 否 | 目标 slug |
| `lang` | string | 否 | slug 查询语言（默认站点默认语言） |
| `post_id` | number | 否 | 目标 WP post id（slug 或 post_id 二选一） |

### `publish_update_fields`
通过一个入口更新**任意**文章属性。字段按可写它的唯一 API 路由：WP native（`/wp/v2`：title/content/excerpt/slug/status/categories/tags/sticky/featured_media）、插件 meta（`PUT /tengence/v1/posts/{id}`：image、image_alt、reading_time、author、i18n、regions、cta、`seo_*`、`geo_*`）、插件 dates API（date、date_gmt、modified、modified_gmt）。只动传入的字段。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `site` | string | 否 | 站点 key |
| `article_id` | number | 否 | `articles.id`——解析到 `wp_post_id`；给了 `wp_post_id` 时省略 |
| `wp_post_id` | number | 否 | 目标 WP post id；给定后覆盖 DB 映射 |
| `lang` | string | 否 | 文章语言（用于 DB 镜像） |
| `title`/`content`/`excerpt`/`slug` | string | 否 | WP native 字段 |
| `status` | string | 否 | `draft|publish|pending|private`（WP native） |
| `categories`/`tags` | array(number\|string) | 否 | 术语 ID 或 slug；slug 会解析，传 `create_terms` 自动创建 |
| `create_terms` | boolean | 否 | 缺失时创建 category/tag slug 而非失败 |
| `sticky` | boolean | 否 | 置顶标志（WP native） |
| `featured_media` | number | 否 | 头图**媒体 ID**（WP native）；与 `image`（URL）配对保持同步 |
| `image`/`image_alt`/`reading_time`/`author` | — | 否 | 插件 meta：基础 |
| `i18n`/`regions`/`cta` | — | 否 | 插件 meta |
| `seo_meta_title`/`seo_meta_description` | string | 否 | SEO 组 |
| `seo_meta_keywords` | array(string) | 否 | SEO 关键词 |
| `seo_canonical_url`/`seo_og_type`/`seo_og_locale`/`seo_og_image` | string | 否 | SEO 组 |
| `seo_noindex` | boolean | 否 | noindex 标志 |
| `geo_ai_summary` | string | 否 | GEO AI 摘要 |
| `geo_qa_pairs` | array(any) | 否 | `[{question,answer}]` |
| `geo_citations` | any | 否 | GEO 引用（数组或对象） |
| `geo_key_takeaways` | array(string) | 否 | GEO 关键要点 |
| `geo_schema_data`/`geo_entity` | any | 否 | GEO schema / 实体 |
| `date`/`date_gmt`/`modified`/`modified_gmt` | string | 否 | 时间（插件 dates API） |
| `copy_dates_from` | number | 否 | 从哪个 WP post id 复制四个日期（如 zh-hans 源） |
| `language` | string | 否 | 经插件语言 API 设置文章语言 |
| `translation_group` | string | 否 | translation-group UUID |
| `sync_db` | boolean | 否 | 把 title/seo_meta_title/seo_meta_description 镜像进 DB（默认 true） |
| `dry_run` | boolean | 否 | 只校验并报告路由，不写任何东西 |

### `publish_daily`
运行每日提升任务（按计划 `publish_order` 把到期草稿转为发布；默认 1/天）。可选 `date` 设置被提升文章的发布/修改时间（站点时区）。可选 `slug` 切换 slug 模式（把该 slug 的每种语言版本都发布）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `site` | string | 否 | 站点 key |
| `date` | string | 否 | 发布时间 `YYYY-MM-DDTHH:MM:SS`（站点时区）；省略则不动 WP 时间 |
| `slug` | string | 否 | slug 模式：发布该 slug 的所有语言（逗号分隔多个）；省略则走计划顺序队列 |
| `count` | number | 否 | 队列模式下提升多少篇（默认 `wordpress.publish.per_day`，通常 1） |
| `dry_run` | boolean | 否 | 只报告，不写入 |

---

## 9. 数据库（2）

### `db_init`
显式初始化数据库（sqlite 幂等建表 / mysql DDL；`--drop` 重建）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `site` | string | 否 | 站点 key |
| `drop` | boolean | 否 | 删除并重建（危险） |

### `db_status`
数据库状态：驱动、路径、schema 版本、表列表、缺失表。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `site` | string | 否 | 站点 key |

---

## 10. 搜索引擎收录提交（7）

### `search_gsc_stats`
读取 Google Search Console 搜索分析（点击/展示/CTR/平均排名），按 query/page/date/country/device 分组。是 Google 搜索表现唯一来源。GSC 数据延迟 2–3 天定稿；默认窗口为截止 3 天前的 28 天。需要 GSC 服务账号。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `site` | string | 否 | 站点 key |
| `dimensions` | array(enum) | 否 | 分组：`query|page|date|country|device`（默认 `["query"]`） |
| `start_date` | string | 否 | `YYYY-MM-DD`（默认：end_date 前 27 天） |
| `end_date` | string | 否 | `YYYY-MM-DD`（默认：3 天前） |
| `row_limit` | number | 否 | 最大行数（默认 100） |

### `search_gsc_inspect`
查询单个 URL 的 Google 收录状态（URL Inspection API，只读）：verdict、coverageState、indexingState、lastCrawlTime、googleCanonical。配额：2000 次/天。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 要检查的完整 URL |
| `site` | string | 否 | 站点 key |

### `search_submit_gsc`
把 sitemap 提交到 Google Search Console（软失败）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `site` | string | 否 | 站点 key |
| `sitemap_url` | string | 否 | sitemap URL（默认自动推导） |

### `search_submit_indexnow`
提交 URL 到 IndexNow（需要 `INDEXNOW_KEY`）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 要提交的 URL（多个用逗号分隔） |
| `site` | string | 否 | 站点 key |

### `search_submit_baidu`
提交 URL 到百度普通收录（需要 `BAIDU_TOKEN`/`BAIDU_SITE`）。两种模式：显式 `url` 列表，或 `all=true` sitemap 增量模式（递归展开 `sitemap_index.xml`，跳过已在 `data/baidu-log.jsonl` 记录的 URL，最多推 `limit` 条）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 否 | 要提交的 URL（逗号分隔，≤2000/次）；`all=true` 时省略 |
| `all` | boolean | 否 | sitemap 增量模式：只推未记录的 URL |
| `limit` | number | 否 | `all=true` 时最多推送条数（默认 10） |
| `site` | string | 否 | 站点 key |

### `webmaster_bing_status`
读取 Bing Webmaster 后台数据（已验证站点 / URL 提交配额 / 查询统计 / 抓取问题）。需要 `BING_WEBMASTER_API_KEY`。注意：Bing 于 2026-08-31 缩减了其 JSON API。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `action` | enum | 是 | `sites|quota|stats|issues` |
| `site` | string | 否 | 站点 key |

### `webmaster_bing_submit`
写入 Bing Webmaster：提交 URL（逗号分隔 = 批量，≤10000/次）。需要 `BING_WEBMASTER_API_KEY`。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 要提交的 URL；多个用逗号分隔 |
| `site` | string | 否 | 站点 key |

---

## 11. GEO 监测（2）

### `monitor_run`
运行 GEO 监测（一轮 站点提示词 × 模型；结果持久化）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `site` | string | 否 | 站点 key |
| `run_id` | string | 否 | `YYYYMMDD`（默认今天） |
| `models` | array(string) | 否 | 模型 key 子集 |
| `layers` | array(string) | 否 | 层级子集 |

### `monitor_report`
读取监测结果（最新一轮或指定 `run_id`）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `site` | string | 否 | 站点 key |
| `run_id` | string | 否 | `YYYYMMDD`（默认最新） |

---

## 12. 跨平台分发（15）

### `channel_list`
列出 syndicate 注册表中的所有外部内容平台：API 类型（official|cookie|none）、状态、能力与完整平台改写规则。READY：wechat（官方 API）、juejin（cookie）、csdn（cookie）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 否 | 过滤到单个平台 key |

### `channel_style_get`
返回**单个平台**的完整风格 / 改写规则（wechat / juejin / blog…）。服务端只提供规则，改写由 harness/Skill 完成。改写前务必先调用。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 是 | 平台 key，如 `wechat / juejin / blog` |

### `channel_check`
按平台风格规则校验标题/正文（确定性，不做内容生成）。返回错误（HARD）与警告（SOFT）及清单与改写策略。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 是 | 平台 key |
| `title` | string | 否 | 待校验的文章标题 |
| `body` | string | 否 | 待校验的正文（markdown） |

### `channel_publish`
发布/导出到某个外部平台。**模式 A**：传 `slugs[]`，服务端读 DB 并运行平台流水线（wechat 草稿箱；juejin 草稿→发布；csdn 草稿→发布；devto 发布）。**模式 B**：传预先写好的 `articles[]`（harness 改写），服务端导出发布包到 `<site>/data/channel-export/<platform>/<slug>.md`。`asDraft` 默认 true（绝不群发）。每次结果都按平台记录到 `channel_plan`。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 是 | 平台 key（见 `channel_list`） |
| `slugs` | array(string) | 否 | 模式 A：要走平台流水线的文章 slug |
| `articles` | array(object) | 否 | 模式 B：预先写好的 `{slug,title,contentMd,summary?,tags?,sourceUrl?,cover?,rewrite?,mode?}` |
| `asDraft` | boolean | 否 | 默认 true：建草稿（wechat/juejin），绝不群发 |
| `keepOrder` | boolean | 否 | 仅 wechat：保持 slug 顺序（第 1 个 = 头条） |
| `dryRun` | boolean | 否 | 打印计划，不做外部调用 |
| `site` | string | 否 | 站点 key |

### `channel_plan_next`
每平台发布日历：返回某平台下一篇要发布的文章及所有日历行。每个平台从博客 article_plan 推导自己的队列（nextDue = 该平台尚未记录的下一篇已发布博客文章）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 否 | 过滤到单个平台（默认全部） |
| `count` | number | 否 | 下次发送应包含多少篇（wechat 合并为一条图文消息；默认 1） |

### `channel_plan_mark`
更新 channel_plan 行状态（`todo|draft|published|paused`）并可选记录其草稿 id（如 wechat media_id）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | number | 是 | channel_plan 行 id |
| `status` | enum | 是 | `todo|draft|published|paused` |
| `draftIds` | array(string) | 否 | 要记录的草稿/媒体 id（如 wechat media_id）；省略则保留现状 |

### `channel_plan_reconcile`
对账某平台 channel_plan 与该平台实际发布内容（juejin | csdn）。用已发布文章播种发布日志。幂等（按 slug upsert）。首次 `channel_plan_next` 前每个平台各跑一次。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 是 | 平台 key，如 `juejin` 或 `csdn` |
| `map` | array(object) | 否 | 明确已知已发布 `{slug,title?,blogOrder?}`；省略则实时读取平台 |
| `site` | string | 否 | 站点 key |

### `channel_taxonomy_sync`
把外部平台自身的分类法词典（category + tag id/name）刷新到 `channel_taxonomy`。目前 juejin：8 个分类 + ~725 个标签。幂等；需要 `JUEJIN_COOKIE`。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 否 | 平台 key（默认 juejin） |
| `site` | string | 否 | 站点 key |

### `channel_taxonomy_list`
读取缓存的外部平台分类法词典，支持按 `kind`、精确 `name` 或 `prefix` 过滤。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 否 | 平台 key（默认 juejin） |
| `kind` | enum | 否 | `category|tag`（省略则两者都返回） |
| `name` | string | 否 | 精确名称查找（不区分大小写） |
| `prefix` | string | 否 | 名称前缀查找，如 `"搜索"` |
| `limit` | number | 否 | 最大行数（默认 100） |
| `site` | string | 否 | 站点 key |

### `channel_taxonomy_resolve`
预览我们的分类法如何映射到平台（`article_plan.category/tags` → 平台 category_id/tag_ids），**不**发布。返回所选 id/名及每项来源（alias/exact/token/fuzzy/default/env/first/hardcoded）。绝不外部调用，绝不写入。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `category` | string | 否 | 我们的分类 slug，如 `geo-ai-search` |
| `tags` | array(string) | 否 | 我们的标签 slug，如 `["geo-seo","search-system"]` |
| `keywords` | array(string) | 否 | 额外关键词（文章 target_keywords） |
| `platform` | string | 否 | 平台 key（默认 juejin） |
| `site` | string | 否 | 站点 key |

### `juejin_status`
读取掘金后台：草稿箱与已发布列表。只读。需要 `JUEJIN_COOKIE` + `JUEJIN_UID`。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `page` | number | 否 | 页码（默认 0，每页 50） |
| `site` | string | 否 | 站点 key |

### `juejin_draft_delete`
删除掘金草稿。**不可逆**——经 `juejin_status` 核实 id 后才可 `confirm=true`。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `draftId` | string | 是 | `juejin_status` 返回的草稿 id |
| `confirm` | boolean | 是 | 必须为 `true` 才真正删除 |
| `site` | string | 否 | 站点 key |

### `juejin_article_delete`
删除掘金已发布文章。**不可逆**——经 `juejin_status` 核实后才可 `confirm=true`。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `articleId` | string | 是 | `juejin_status` 返回的文章 id |
| `confirm` | boolean | 是 | 必须为 `true` 才真正删除 |
| `site` | string | 否 | 站点 key |

### `csdn_status`
读取 CSDN 博客后台：草稿箱与已发布列表。只读。需要 `CSDN_COOKIE`。登录过期会以 `cookieExpired=true` 呈现。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `page` | number | 否 | 从 1 开始的页码（默认 1） |
| `pageSize` | number | 否 | 每页条数（默认 20） |
| `site` | string | 否 | 站点 key |

### `csdn_article_delete`
删除 CSDN 文章。**不可逆**——经 `csdn_status` 核实后才可 `confirm=true`。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `articleId` | string | 是 | `csdn_status` 返回的文章 id |
| `deep` | boolean | 否 | 同时从回收站彻底清除（默认 false） |
| `confirm` | boolean | 是 | 必须为 `true` 才真正删除 |
| `site` | string | 否 | 站点 key |

---

## 13. 多语言术语名——分类 / 标签 / 作者（11）

这些封装 Tengence 插件端点（`/tengence/v1/term-names`、`/author-names`），由站点 `.env` 的 `TENGENCE_SITE_ID` / `TENGENCE_SECRET` 驱动。语言 key 接受 `en / zh-hans / zh-hant`。

### `term_names_list`
列出 WP 分类与标签的多语言显示名表。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `taxonomy` | enum | 否 | `category|post_tag`（省略则两者都返回） |
| `site` | string | 否 | 站点 key |

### `article_terms_sync`
用**术语 slug**读取和/或设置文章的 WP 分类（category + post_tag）。三种模式：read（只传目标）、write（category_slugs/tag_slugs）、mirror（copy_from）。返回 before/after 差异。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `site` | string | 否 | 站点 key |
| `wp_post_id` | number | 否 | 目标 WP post id；给了 `slug` 时省略 |
| `slug` | string | 否 | 目标文章 slug（`wp_post_id` 缺失时必填） |
| `lang` | string | 否 | slug 查询语言（默认 `zh-hans`） |
| `copy_from` | number | 否 | 要镜像分类+标签的源 wp_post_id |
| `category_slugs` | array(string) | 否 | 要设置的分类 slug |
| `tag_slugs` | array(string) | 否 | 要设置的标签 slug |
| `create_terms` | boolean | 否 | 缺失时创建术语 slug 而非失败 |
| `dry_run` | boolean | 否 | 只解析并报告，不动 WP |

### `term_name_get`
读取单个 WP 术语的多语言显示名。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `taxonomy` | enum | 是 | `category` 或 `post_tag` |
| `slug` | string | 是 | 术语 slug，如 `geo-ai-search` |
| `site` | string | 否 | 站点 key |

### `term_name_set`
设置（upsert）单个术语的多语言显示名：`{"names":{"en":"...","zh-hans":"...","zh-hant":"..."}}`。空串清除该语言。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `taxonomy` | enum | 是 | `category` 或 `post_tag` |
| `slug` | string | 是 | 术语 slug |
| `names` | object | 是 | 语言码 → 显示名；`""` 清除该语言 |
| `site` | string | 否 | 站点 key |

### `term_name_delete`
删除单个术语的多语言显示名。`lang` 只删除该语言。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `taxonomy` | enum | 是 | `category` 或 `post_tag` |
| `slug` | string | 是 | 术语 slug |
| `lang` | string | 否 | 只删除该语言（省略则删除所有已配置名） |
| `site` | string | 否 | 站点 key |

### `term_names_batch`
批量设置多个术语的多语言显示名：`{"category":{"<slug>":{"<lang>":"<name>"}},"post_tag":{...}}`。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `category` | object | 否 | 分类 slug → `{lang: name}` |
| `post_tag` | object | 否 | 标签 slug → `{lang: name}` |
| `site` | string | 否 | 站点 key |

### `author_names_list`
列出所有 WP 作者的多语言显示名。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `site` | string | 否 | 站点 key |

### `author_name_get`
读取单个 WP 作者的多语言显示名。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | WP 作者/用户 ID |
| `site` | string | 否 | 站点 key |

### `author_name_set`
设置（upsert）单个作者的多语言显示名：`{"names":{"en":"...","zh-hans":"..."}}`。空串清除该语言。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | WP 作者/用户 ID |
| `names` | object | 是 | 语言码 → 显示名；`""` 清除该语言 |
| `site` | string | 否 | 站点 key |

### `author_name_delete`
删除单个作者的多语言显示名。`lang` 只删除该语言。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | WP 作者/用户 ID |
| `lang` | string | 否 | 只删除该语言 |
| `site` | string | 否 | 站点 key |

### `author_names_batch`
批量设置多个作者的多语言显示名：`{"authors":{"<id>":{"<lang>":"<name>"}}}`。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `authors` | object | 是 | 作者 id（数字字符串）→ `{lang: name}` |
| `site` | string | 否 | 站点 key |

---

## 14. 微信（8）

### `wechat_status`
读取微信公众号后台：草稿箱与已群发列表。需要 `WECHAT_APP_ID`/`SECRET` 且出口 IP 已加白。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `site` | string | 否 | 站点 key |

### `wechat_stats`
读取公众号后台统计（`datacube/*`）。T+1 数据；多数端点窗口 ≤7 天；`article_read`/`article_share`/`article_detail` 要求 `begin_date === end_date`。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `action` | enum | 否 | `overview|user_summary|user_cumulate|upstream_msg|interface_summary|biz_summary|article_read|article_share|article_detail`（默认 `overview`） |
| `begin_date` | string | 否 | `YYYY-MM-DD`（默认：end_date 前 6 天） |
| `end_date` | string | 否 | `YYYY-MM-DD`（默认：昨天；今天永不可用） |
| `site` | string | 否 | 站点 key |

### `wechat_sync_progress`
把 channel_plan 日历与真实微信后台对账并自动修复 DB。`dryRun=true` 只预览不写入。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `site` | string | 否 | 站点 key |
| `dryRun` | boolean | 否 | 只计算并报告，不写 DB |

### `wechat_mass_preview`
把一篇草稿（media_id）以预览形式发给单个用户。需要已认证账号。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `media_id` | string | 是 | 草稿箱 media_id |
| `openid` | string | 否 | 接收者 openid |
| `wxname` | string | 否 | 接收者 wxname |
| `dryRun` | boolean | 否 | 只打印载荷，不发送 |
| `site` | string | 否 | 站点 key |

### `wechat_mass_send`
群发（推送粉丝）一篇草稿。订阅号每天 1 次；成功后草稿被消耗。**高风险**——需要 `confirm="YES"`。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `media_id` | string | 是 | 草稿箱 media_id |
| `tag_id` | number | 否 | 只发给某个用户标签（省略 = 全部粉丝） |
| `to_users` | array(string) | 否 | 指定 openid |
| `client_msg_id` | string | 否 | 去重重复发送 |
| `confirm` | enum | 否 | 推送粉丝必须为 `"YES"`（`dryRun` 不需要） |
| `dryRun` | boolean | 否 | 只打印载荷，不发送 |
| `site` | string | 否 | 站点 key |

### `wechat_mass_status`
查询群发任务状态。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `msg_id` | number | 是 | 群发任务 msg_id |
| `site` | string | 否 | 站点 key |

### `wechat_article_delete`
删除一篇已发布文章。**不可逆**——`confirm="YES"`。`index`（从 1 起）删除多图文消息中的一篇；省略删除整条消息。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `article_id` | string | 是 | 已发布文章 id |
| `index` | number | 否 | 消息内从 1 起的位置 |
| `confirm` | enum | 否 | 必须为 `"YES"`（不可逆） |
| `dryRun` | boolean | 否 | 只打印载荷，不删除 |
| `site` | string | 否 | 站点 key |

### `wechat_draft_publish`
经 `freepublish/submit` 把草稿箱 media_id 发布到公众号主页（**不**推送粉丝）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `media_id` | string | 是 | 草稿箱 media_id |
| `dryRun` | boolean | 否 | 只打印载荷，不发布 |
| `site` | string | 否 | 站点 key |

---

## 响应格式

每个工具返回 MCP 文本内容，内容为 JSON 字符串。成功形态因域而异但总含 `ok: true`；错误为 `{ ok: false, error }` 且标记 `isError`，便于 AI 客户端确定性处理。
