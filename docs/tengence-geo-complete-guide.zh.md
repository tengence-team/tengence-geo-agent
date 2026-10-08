# Tengence GEO Agent 完整指南

> 本文是 
>
> **Tengence GEO Agent**
>
> （GEO 工具：GEO Agent / GEO MCP / GEO CLI）的一站式完整文档，
> 聚合了产品概览、端到端 SOP、逐模块工具作用与接口参数、CLI 命令、环境变量、数据模型及其它配套内容。
> 权威来源是代码本身：
>
> `packages/geo-mcp/tools/registry.js`
>
> （MCP 工具注册表）、
>
> `packages/geo-cli/bin/`
>
> （CLI）、
>
> `packages/geo-sdk/`
>
> （SDK）。若文档与代码不一致，以代码为准。



***

## 目录



1. [产品概览](#1-产品概览)

2. [端到端 SOP（完整工作流）](#2-端到端-sop完整工作流)

3. [SOP 逐模块详解：工具作用与接口参数](#3-sop-逐模块详解工具作用与接口参数)

4. [CLI 命令参考（24 条）](#4-cli-命令参考24-条)

5. [环境变量与配置](#5-环境变量与配置)

6. [数据模型（18 张表）](#6-数据模型18-张表)

7. [其它配套说明](#7-其它配套说明)



***

# 1. 产品概览

## 1.1 这是什么

**Tengence GEO Agent**（`tengence-geo-agent`）是一个 GEO（生成式引擎优化）/ SEO 内容生产与发布引擎。

它自动化整条流水线 —— 从**诊断站点的 GEO/SEO 健康状况**、**规划关键词与发布排期**、到**起草、门禁、翻译、发布文章**、

再到**提交搜索引擎收录**与**测量 AI 可见性**—— 并把监测结果反馈回规划，形成闭环。

它由四个形态组成，覆盖三种使用方式：



| 形态           | 包                     | 作用                                                                                                       |
| ------------ | --------------------- | -------------------------------------------------------------------------------------------------------- |
| **GEO Agent** | `@tengence/geo-agent` | LLM 运行时循环（`HARNESS=dsh\|opencode\|pi`），设置 `DEEPSEEK_API_KEY` 即可跑整条流程                                     |
| **GEO MCP**   | `@tengence/geo-mcp`   | **72 个工具**，支持 **stdio** 或 **Streamable HTTP**（Bearer 鉴权），任意 MCP 客户端都能驱动引擎                                |
| **GEO CLI**   | `@tengence/geo-cli`   | **24 条单用途命令**（`tengence-geo-*`），是规范化的编排入口                                                                |
| 能力层          | `@tengence/geo-sdk`   | 15 个领域库：site、db、plan、wp、content、images、search、publish、check、syndicate、taxonomy、llm、monitor、diagnose、util |

依赖只向下流动：MCP → CLI/SDK；CLI → SDK；SDK 从不依赖上层。SDK 不是为某一特定 harness 编写的 ——**MCP 是标准、可移植的桥接**。

## 1.2 接口面一览



* **MCP 工具：72 个**，按 14 个能力域分组。

* **CLI 命令：24 条**，每条对应一个领域操作。

* 同一能力的 MCP 工具 / CLI 命令 / SDK 函数放在一起描述（能力域分组，而非按产品形态分章）。

## 1.3 安装速览

环境要求：Node.js ≥ 22.13（内置 `node:sqlite`），推荐 24 LTS。可选 `better-sqlite3`（Node 20/21 或需完整 SQLite API）；可选 `sharp`（图片压缩 / 裁剪）。



```
npm install
cp -R examples/site-template ~/tengence/sites/my-site
cd ~/tengence/sites/my-site && cp .env.example .env   # 填入凭据/令牌
```

CLI 模式：



```
export SITES_ROOT=~/tengence/sites
tengence-geo-article-ingest hello-geo ./hello-geo.md --site my-site --research ./hello-geo.research.md
tengence-geo-check-article hello-geo --site my-site
tengence-geo-publish-draft ./hello-geo.md --site my-site            # 草稿
tengence-geo-promote-daily --site my-site                           # 定时正式发布
```

MCP 模式（stdio）：



```
{ "mcpServers": { "tengence-geo": { "command": "node", "args": ["<repo>/packages/geo-mcp/bin/geo-mcp.js"] } } }
```

HTTP 模式：



```
GEO_MCP_PORT=8787 GEO_MCP_TOKEN=sk-xxx node packages/geo-mcp/bin/geo-mcp-http.js
# Base URL = http://127.0.0.1:8787/    Auth = Bearer <GEO_MCP_TOKEN>
```

## 1.4 存储与数据



* **默认**：单文件多租户 SQLite（`~/.tengence/geo-mcp/geo.sqlite`），首次使用自动初始化（零配置），共 18 张表（`tengence_geo_*`）。

* **可选**：MySQL（`DB_DRIVER=mysql`），只写 `tengence_geo_*` 表，与生产 `tengence_omni_*` 物理隔离。

* **工作区**：站点配置 / 内容 / 计划放在用户选择的工作区（运行时 `workspace_use`，或 `SITES_ROOT`），从不从安装目录推导。

* **密钥**：只存在于 `<workspace>/<site>/.env`（已 gitignore）。

## 1.5 多语言模型

文章语言统一为 `zh-hans`**&#x20;|&#x20;**`en`**&#x20;|&#x20;**`zh-hant`（旧区域码如 `zh-cn`/`en-us` 会被拒绝）。

翻译文章与其源文章**共享同一张头图**（不重复上传）。同语言内链、每条链接独立的 CTA 布局由翻译门禁强制，并在 WordPress 写回时自动归一化。

## 1.6 通用约定



* **工作区与站点解析**：多数工具接受可选 `site`。工作区来源为 (a) `workspace_use` 参数、(b) 本会话先前的 `workspace_use`、(c) 持久化状态、(d) `SITES_ROOT`。工作区恰有一个站点时自动选用；否则必须显式传 `site`。

* **响应格式**：每个工具返回 MCP 文本内容，内容为 JSON 字符串。成功总含 `ok: true`；失败为 `{ ok: false, error }` 且标记 `isError`。



***

# 2. 端到端 SOP（完整工作流）

## 2.1 总览

流水线是一个闭环。从站点与诊断出发，产出方案与文章，**先发布草稿、再定时正式发布**，提交搜索引擎收录，并测量 AI 可见性 —— 其结果反馈到下一轮规划。

完整顺序（用户确认版）：



```
① 诊断 → ② 出方案 → ③ 关键词矩阵 → ④ 发布文章计划 → ⑤ 生成文章 → ⑥ 多语言翻译
→ ⑦ 配图 → ⑧ 门禁检查 → ⑨ 发布为草稿 → ⑩ 定时正式发布
→ （收录提交 → 监测闭环 → 反馈回规划）
```

## 2.2 计划状态机

`article_plan.plan_status` 驱动整个 SOP：



```
todo → written → queued → published     （archived/paused 为终态或暂停态）
```



* `todo` —— 已规划、未写。

* `written` —— 正文已写（配图可能未完成）。

* `queued` —— WordPress **草稿**已就位，等待排期槽位。

* `published` —— 已上线。

发布日历来自 `config/wordpress.yaml`（`publish.per_day` / `publish.skip_dates`），控制每天提升多少个待发草稿、跳过哪些日期。

## 2.3 阶段速览与工具映射



| 阶段      | 环节       | 对应工具（MCP / CLI）                                                                                  |
| ------- | -------- | ------------------------------------------------------------------------------------------------ |
| A 诊断与方案 | ① 站点诊断   | `workspace_use` / `site_init` / `site_list` / `site_status` → `diagnose_site`                    |
|         | ② 出方案    | `site_geo_plan_skill`（GEO/SEO 实施计划规范）                                                            |
| B 规划    | ③ 关键词矩阵  | `site_geo_plan_skill` + `standards_read('content-strategy')`                                     |
|         | ④ 发布文章计划 | `plan_import` / `plan_list` / `plan_mark_status`                                                 |
| C 内容生产  | ⑤ 生成文章   | `article_draft`（T1–T7 骨架 + brief）→ 写正文 → `article_ingest` / `article_export`                     |
|         | ⑥ 多语言翻译  | `translation_glossary_get` → 翻译 → `check_translation` → `article_ingest --lang`                  |
| D 配图与门禁 | ⑦ 配图     | `image_acquire`（检索→红线→下载→WebP 裁剪→上传）                                                             |
|         | ⑧ 门禁检查   | `check_article`（G1–G16 编辑门禁）                                                                     |
| E 发布    | ⑨ 发布为草稿  | `publish_draft --status=draft` / `publish_from_db --status=draft`                                |
|         | ⑩ 定时正式发布 | `publish_daily`（promote-daily：按 plan publish\_order 转 publish，可指定 date）                          |
|         | 多平台分发    | `channel_publish` / `publish_wechat` / `publish_juejin` / `publish_devto`                        |
| F 收录与监测 | 收录提交     | `search_submit_gsc` / `search_submit_indexnow` / `search_submit_baidu` / `webmaster_bing_submit` |
|         | 监测闭环     | `monitor_run` / `monitor_report` → 反馈回阶段 A                                                       |

## 2.4 阶段细节

### 阶段 A —— 诊断与方案

**A1. 绑定工作区并（重新）创建站点**：`workspace_use { path }` → `site_init { key, domain? }` → `site_list` / `site_status`。引擎从不猜测目录。`site_status` 返回配置路径、`.env` 就绪状态、DB 驱动与 SQLite 初始化状态。

**A2. 诊断站点**：`diagnose_site { url, site?, pages?, max_pages? }`。完整 GEO/SEO 健康检查：域名（DNS/TLS/WHOIS）、传输与服务端指纹（CMS / 框架 / CDN）、robots.txt、sitemap、首页 + 代表性页面（meta、H1–H6 结构、JSON-LD、OG、图片 /alt、链接、混合内容）、性能与安全。首次使用自动搭建站点。

**A3. 生成实施方案**：`site_geo_plan_skill { }` 读取规范化方案模板；`report_write { content, filename? }` 把 Markdown 方案写入 `<site>/data/reports/`。方案为多部分结构（**上篇技术修复 / 中篇关键词与内容 / 价值桥接 / 下篇实施保障 / 附录**），每条诊断问题展开为 **现状→方案→步骤→验收**，并含**完整关键词矩阵**与**人力人日矩阵**。

### 阶段 B —— 规划：关键词矩阵与发布计划

**B1. 关键词矩阵与格式选型**：`standards_read { name: "content-strategy" }` 驱动文章类型路由（T1–T7）与节奏。关键词矩阵来自实施方案（A3），转成计划表中的具体行。

**B2. 装载文章计划（发布排期）**：`plan_import { rows[] }` 按 `slug`+`lang` 幂等 upsert 计划行（每种语言一行）；`plan_list` 查看队列；`plan_mark_status` 变更状态。关键字段：`slug`、`lang`、`node_type`（spoke|hub）、`title`、`focus_keyword`、`content_type`、`publish_order`、`category`、`tags`、`plan_status`。

> 翻译行（
>
> `lang=en|zh-hant`
>
> ）必须通过 
>
> `plan_import`
>
>  的带 key 的 upsert（相同 slug）写入 —— 绝不能只用 slug，否则会静默覆盖 zh-hans 源行。

### 阶段 C —— 内容生产

**C1. 起草文章**：`article_draft { type?, topic? }` 返回匹配的 **T1–T7 正文骨架**、**research-brief 模板**与完整 `article-writing-standards`。正文必须使用规范 GEO 区块标题（摘要、关键要点、FAQ、数据来源、相关阅读、立即行动、关于）。

**C2. 摄取文章**：`article_ingest { slug, md_path, research_path?, lang? }` 把正文 + brief 写入 `articles` 表；`article_export` 导出到 `data/inbox`（用于改写 / 翻译）。

**C3. 多语言翻译**：`translation_glossary_get { target_lang }` 取合并术语表；翻译到 `en`/`zh-hant`；`check_translation` 做机械门禁（T1–T11）；`article_ingest --lang` 摄取译文。翻译与其源文章**共享同一张头图**；内链改写为对应语言前缀。

### 阶段 D —— 配图与门禁

**D1. 采集头图**：`image_acquire { query, slug, count?, dry_run? }` 运行自动图片流水线：**检索→红线过滤→下载→WebP 裁剪→上传 WP 媒体库**。`dry_run` 只预览不落库。

**D2. 运行编辑门禁**：`check_article { slug, type?, lang? }` 强制 G1–G16 规则（引用双通道、按类型字数、禁用词、GEO 区块、research-brief 硬检查）。**未通过门禁的草稿一律不得发布。** 已发布行按建议性门禁处理；草稿保持硬门禁。翻译由 `check_translation` 检查，而非 `check_article`。

### 阶段 E —— 发布

**E1. 发布为草稿**：`publish_draft { md_path, status?, site? }`（默认 `draft`）或 `publish_from_db { article_id, status? }`。创建 **WordPress 草稿**（`wp_post_id` 落库，计划状态置 `queued`）。此时尚未上线。

**E2. 定时正式发布**：`publish_daily { site?, date?, slug?, count?, dry_run? }`。提升到期草稿为已发布，按 `publish_order` 取队列最前面的 `queued` 行，遵循 `per_day`/`skip_dates`。



* 队列模式（默认）：提升接下来 `count` 个 queued 草稿。

* **slug 模式（**`--slug`**）**：把该 slug 的**所有语言版本**一起发布，仍执行内链检查与门禁复检。

* `--date`：设置被提升文章的发布时间（站点时区）—— 即**定时**正式发布。

* `--dry-run`：只报告。

**E3. 发布到外部平台（分发）**：`channel_list` → `channel_style_get { platform }` → `channel_check` → `channel_publish`。微信走**草稿→预览→群发**流程（`wechat_draft_publish` / `wechat_mass_preview` / `wechat_mass_send`—— 群发不可逆，须显式确认）。每次结果都按平台记录到 `channel_plan`。

**E4. 核对发布状态**：`wp_post_get`（确认不再是草稿）、`wechat_status` / `csdn_status` / `juejin_status`。

### 阶段 F —— 收录提交

发布后运行，让页面被收录：`search_submit_gsc`（Google，软失败）、`search_submit_indexnow`（IndexNow，需 `INDEXNOW_KEY`）、`search_submit_baidu`（百度，需 `BAIDU_TOKEN`）、`webmaster_bing_submit`（Bing，需 `BING_WEBMASTER_API_KEY`）。只读核对：`search_gsc_stats`、`search_gsc_inspect`、`webmaster_bing_status`。

### 阶段 G —— 监测闭环

`monitor_run`（一轮 站点提示词 × 模型）、`monitor_report`（读取最新 / 指定轮）。结果测量 AI 可见性（收录基线 + 可见性），反馈到阶段 B（topic-planning 刷新）与阶段 D2（下线 / 返工不达标文章），形成闭环。



***

# 3. SOP 逐模块详解：工具作用与接口参数

> 本章按 SOP 涉及的模块逐一遍历。每个工具给出：作用、参数表（名称 / 类型 / 必填 / 说明 / 默认）。接口名用英文原名，说明用中文。

## 模块 0 —— 工作区与站点（5 个工具）

### `workspace_use`

绑定用户工作区目录 —— 所有站点配置、凭据与输出文件都在其下。**先调用它。**



| 参数       | 类型      | 必填 | 说明                                |
| -------- | ------- | -- | --------------------------------- |
| `path`   | string  | 是  | 用户选择的绝对目录（如 `~/my-geo-workspace`） |
| `create` | boolean | 否  | 缺失时创建目录（默认 `false`）               |

### `site_init`

在已绑定的工作区内搭建站点：`<workspace>/<key>/{config,data/inbox,data/reports,.env}`。幂等，从不覆盖已有文件。



| 参数       | 类型     | 必填 | 说明                  |
| -------- | ------ | -- | ------------------- |
| `key`    | string | 是  | 站点 key（小写字母、数字、下划线） |
| `domain` | string | 否  | 规范域名，默认取 key        |
| `name`   | string | 否  | 显示名，默认取域名           |
| `lang`   | string | 否  | 默认语言（默认 `zh-hans`）  |

### `site_list`

列出已绑定工作区内的站点（key、域名、app\_id、存储驱动）。未绑定工作区时返回提示。

\* 参数：\* 无。

### `site_status`

站点状态：配置路径、`.env` 就绪状态、DB 驱动与 SQLite 初始化状态。



| 参数     | 类型     | 必填 | 说明                    |
| ------ | ------ | -- | --------------------- |
| `site` | string | 否  | 站点 key；工作区只有一个站点时自动选用 |

### `util_ping`

连通性自检：SDK 版本、驱动、内部数据目录、已绑定工作区与站点数。

\* 参数：\* 无。



***

## 模块 1 —— 诊断与方案（3 个工具）

### `diagnose_site`

完整 GEO/SEO 站点诊断：域名（DNS/TLS/WHOIS）、传输与服务端指纹（CMS / 框架 / CDN）、robots.txt、sitemap、首页 + 代表性页面（meta、H1–H6 结构、JSON-LD、OG、图片 /alt、链接、混合内容）、性能与安全。首次使用自动搭建站点。



| 参数          | 类型            | 必填 | 说明                                 |
| ----------- | ------------- | -- | ---------------------------------- |
| `url`       | string        | 是  | 站点 URL，如 `https://www.example.com` |
| `site`      | string        | 否  | 站点 key                             |
| `pages`     | array(string) | 否  | 除首页外需诊断的额外页面 URL                   |
| `max_pages` | integer       | 否  | 采样代表性页面上限（默认 4；站点是采样，从不全量爬取）       |

### `site_geo_plan_skill`

只读访问 site-geo-plan 技能规范（`SKILL.md` + `references/plan-template.md`），用于指导详细 GEO/SEO 实施方案生成。原样返回两个文件。

\* 参数：\* 无。

### `report_write`

把 Markdown 报告写入 `<site>/data/reports/`（路径安全）。首次使用自动搭建站点。



| 参数         | 类型     | 必填 | 说明                                         |
| ---------- | ------ | -- | ------------------------------------------ |
| `content`  | string | 是  | Markdown 报告内容                              |
| `filename` | string | 否  | 报告文件名（默认 `<YYYYMMDD>-<site>-diagnosis.md`） |
| `site`     | string | 否  | 站点 key                                     |



***

## 模块 2 —— 写作标准与起草（3 个工具）

### `standards_list`

列出引擎内置的通用写作与 GEO 标准（标题、是否存在站点补充文件）。

\* 参数：\* 无。

### `standards_read`

读取一个通用标准文档（合并基础 + 站点补充）。名称相对仓库且不带 `.md`，如 `article-writing-standards`、`content-strategy`、`block-conventions`、`templates/skeletons/howto`、`templates/research-brief`。



| 参数     | 类型     | 必填 | 说明                                           |
| ------ | ------ | -- | -------------------------------------------- |
| `name` | string | 是  | 不带 `.md` 的标准名（如 `article-writing-standards`） |

### `article_draft`

组装一份可用的写作 brief：匹配的 **T1–T7 正文骨架**、写作前的 **research-brief 模板**、完整**写作标准**（基础 + 补充）。先调用它，再写 Markdown 正文，然后 `check_article`。



| 参数      | 类型     | 必填 | 说明                                                                                     |
| ------- | ------ | -- | -------------------------------------------------------------------------------------- |
| `type`  | string | 否  | T1–T7 正文类型：`definition\|howto\|product\|case\|industry\|comparison\|guide`（默认 `guide`） |
| `topic` | string | 否  | 工作主题 / 目标关键词（回显进 brief 作上下文）                                                           |
| `site`  | string | 否  | 站点 key                                                                                 |



***

## 模块 3 —— 内容生产（4 个工具）

### `article_list`

列出文章（articles 表），支持 status/lang/limit 过滤。



| 参数       | 类型     | 必填 | 说明                                |
| -------- | ------ | -- | --------------------------------- |
| `site`   | string | 否  | 站点 key                            |
| `status` | string | 否  | `draft\|queued\|published` 等（可选）  |
| `lang`   | string | 否  | 语言过滤（`zh-hans\|en\|zh-hant`；默认全部） |
| `limit`  | number | 否  | 最大行数（默认 50）                       |

### `wp_post_get`

只读 WordPress 文章查询：按 `wp_post_id`，或按 `slug`+`lang`（经插件语言端点解析）。可选返回完整正文 HTML。



| 参数                | 类型      | 必填 | 说明                                             |
| ----------------- | ------- | -- | ---------------------------------------------- |
| `site`            | string  | 否  | 站点 key                                         |
| `wp_post_id`      | number  | 否  | WordPress 文章 ID                                |
| `slug`            | string  | 否  | 文章 slug（`wp_post_id` 缺失时必填）                    |
| `lang`            | string  | 否  | slug 查询语言：`zh-hans\|en\|zh-hant`（默认 `zh-hans`） |
| `include_content` | boolean | 否  | 是否同时返回正文 HTML（默认 `false`）                      |

### `article_ingest`

内容摄取（单入口）：正文 md + research brief → articles 表（CLI 规范化编排）。摄取后自动归档源文件（除非 `--no-archive`）。



| 参数              | 类型     | 必填 | 说明                           |
| --------------- | ------ | -- | ---------------------------- |
| `slug`          | string | 是  | 文章 slug                      |
| `md_path`       | string | 是  | 正文 Markdown 文件的绝对路径          |
| `research_path` | string | 否  | research brief 的绝对路径（发布门禁要求） |
| `site`          | string | 否  | 站点 key                       |
| `lang`          | string | 否  | 语言（默认站点默认语言）                 |

### `article_export`

把文章的 md + brief 从 DB 导出到 `<site>/data/inbox`（用于改写 / 翻译）。



| 参数     | 类型     | 必填 | 说明                                  |
| ------ | ------ | -- | ----------------------------------- |
| `slug` | string | 是  | 文章 slug                             |
| `site` | string | 否  | 站点 key                              |
| `lang` | string | 否  | 语言（`zh-hans\|en\|zh-hant`；默认站点默认语言） |



***

## 模块 4 —— 翻译与术语门禁（3 个工具）

### `translation_glossary_get`

目标语言的翻译术语表：合并的全局 + 站点术语表（品牌 / 短语 / 产品词 / 禁用词）。



| 参数            | 类型     | 必填 | 说明                  |
| ------------- | ------ | -- | ------------------- |
| `site`        | string | 否  | 站点 key              |
| `target_lang` | string | 是  | 目标语言（`en\|zh-hant`） |

### `check_translation`

翻译文章的机械门禁（T1–T9）：结构 / 区块 / 编号、与源文章的链接集 & 图片集 & 数字集一致、简体中文与 CJS 残留、禁用词、分节长度、标题与 meta\_description 长度。在 `article_ingest --lang` 前运行。



| 参数            | 类型     | 必填 | 说明                                |
| ------------- | ------ | -- | --------------------------------- |
| `slug`        | string | 是  | 文章 slug（源；`md_path` 缺失时也指目标 DB 行） |
| `source_lang` | string | 是  | 源语言（`zh-hans`）                    |
| `target_lang` | string | 是  | 目标语言（`en\|zh-hant`）               |
| `md_path`     | string | 否  | 译文的绝对路径（优先；缺失时从 DB 读目标）           |
| `site`        | string | 否  | 站点 key                            |

> 翻译由 
>
> `check_translation`
>
>  检查（T1–T11），
>
> **不是**
>
>  
>
> `check_article`
>
> 。



***

## 模块 5 —— 配图（1 个工具）

### `image_acquire`

自动图片流水线：**检索 → 红线过滤 → 下载 → WebP 裁剪 → 上传 WP 媒体库**。



| 参数        | 类型      | 必填 | 说明              |
| --------- | ------- | -- | --------------- |
| `query`   | string  | 是  | 图片搜索关键词         |
| `slug`    | string  | 是  | 目标文章 slug（用于登记） |
| `site`    | string  | 否  | 站点 key          |
| `count`   | number  | 否  | 数量（默认 3）        |
| `dry_run` | boolean | 否  | 只预览，不落库         |



***

## 模块 6 —— 门禁检查（1 个工具）

### `check_article`

发布门禁：强制 `article-writing-standards` 中固化的编辑规则（G1–G16）：引用双通道、按 T1–T7 类型的字数、禁用词、GEO 区块（摘要 / 关键要点 / FAQ / 数据来源）、research-brief 硬检查。写作前先读该标准，并先运行 `article_draft`。**草稿未过门禁不得发布。**



| 参数     | 类型     | 必填 | 说明                 |
| ------ | ------ | -- | ------------------ |
| `slug` | string | 是  | 文章 slug            |
| `site` | string | 否  | 站点 key             |
| `type` | string | 否  | T1..T7（声明时按类型硬查字数） |
| `lang` | string | 否  | 文章语言（默认站点默认语言）     |



***

## 模块 7 —— 文章发布计划（3 个工具）

### `plan_list`

文章计划表列表（status/batch/node/lang 过滤）。每种语言一行。



| 参数       | 类型     | 必填 | 说明                                   |
| -------- | ------ | -- | ------------------------------------ |
| `site`   | string | 否  | 站点 key                               |
| `status` | string | 否  | `todo\|written\|queued\|published` 等 |
| `batch`  | string | 否  | 批次                                   |
| `lang`   | string | 否  | `zh-hans\|en\|zh-hant`（默认所有语言）       |
| `limit`  | number | 否  | 最大行数（默认 100）                         |

### `plan_import`

导入 / 更新计划表（按 `(slug, lang)` 幂等 upsert）。两种模式：(a) 不传 `rows`——DB 维护（回填 article\_id/wp\_post\_id/published\_url/featured\_image、对账状态、分配 publish\_order）；(b) 传 `rows[]`—— 直接写入显式计划行（翻译行正由此创建 / 更新）。绝不读取计划文档 —— 先把 markdown/JSON 计划转成 `rows[]`。



| 参数     | 类型            | 必填 | 说明                                                                                                                                                                                                                                                                                                                                                                     |
| ------ | ------------- | -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site` | string        | 否  | 站点 key                                                                                                                                                                                                                                                                                                                                                                 |
| `rows` | array(object) | 否  | 要 upsert 的显式计划行（按语言）。每行：`slug`（string，必填）、`lang`（zh-hans\|en\|zh-hant，默认 zh-hans）、`node_type`（spoke\|hub，默认 spoke）、`title`、`publish_order`（队列位置；翻译与源共享值以便一起发布）、`publish_batch`、`category`、`tags`（array）、`article_id`、`wp_post_id`、`published_url`、`plan_status`（todo\|written\|queued\|published\|paused）、`queued_at`、`published_at`、`languages`（WP locale 列表）、`notes` |

### `plan_mark_status`

更新计划行状态。



| 参数       | 类型     | 必填 | 说明                                            |
| -------- | ------ | -- | --------------------------------------------- |
| `slug`   | string | 是  | 文章 slug                                       |
| `status` | string | 是  | 目标状态：`todo/written/queued/published/archived` |
| `site`   | string | 否  | 站点 key                                        |



***

## 模块 8 —— WordPress 发布（5 个工具）

### `publish_draft`

发布草稿（默认 `draft` → WP；可直接 `--status=publish`，须先过门禁）。



| 参数        | 类型     | 必填 | 说明                           |
| --------- | ------ | -- | ---------------------------- |
| `md_path` | string | 是  | 正文 Markdown 的绝对路径            |
| `site`    | string | 否  | 站点 key                       |
| `status`  | string | 否  | `draft\|publish`（默认 `draft`） |

### `publish_from_db`

从 DB 发布文章到 WordPress（`--force` 更新已有文章）。翻译（en/zh-hant）默认继承 zh-hans 源的发布 + 更新时间；传 `sync_source_dates=false` 关闭。



| 参数                  | 类型      | 必填 | 说明                                |
| ------------------- | ------- | -- | --------------------------------- |
| `article_id`        | number  | 是  | `articles.id`                     |
| `site`              | string  | 否  | 站点 key                            |
| `status`            | string  | 否  | `draft\|publish`（默认 `draft`）      |
| `force`             | boolean | 否  | 已存在时强制更新                          |
| `translation_group` | string  | 否  | 一篇多语言文章共享的 translation-group UUID |
| `sync_source_dates` | boolean | 否  | 继承 zh-hans 源发布时间（默认 true；仅翻译）     |

### `publish_update_article`

更新已发布文章（标题 / 正文 / 状态 + 同步 SEO/GEO meta）。传 `meta_title`/`meta_description`/`post_title` 时进入 **meta-only 模式**（只更新这些字段，正文不动）。单字段修改优先用 `publish_update_fields`。



| 参数                 | 类型     | 必填 | 说明                                           |
| ------------------ | ------ | -- | -------------------------------------------- |
| `md_path`          | string | 否  | 正文 Markdown（完整更新必需；meta-only 模式省略）           |
| `meta_title`       | string | 否  | 新 SEO 标题（≤200 字符）。提供即进入 meta-only 模式         |
| `meta_description` | string | 否  | 新 meta\_description（165–175 字符）。meta-only 模式 |
| `post_title`       | string | 否  | 新 WP 标题（≤200 字符，同步 DB title）。meta-only 模式    |
| `site`             | string | 否  | 站点 key                                       |
| `article_id`       | number | 否  | `articles.id`（解析为 slug+lang+wp\_post\_id）    |
| `slug`             | string | 否  | 目标 slug                                      |
| `lang`             | string | 否  | slug 查询语言（默认站点默认语言）                          |
| `post_id`          | number | 否  | 目标 WP post id（slug 或 post\_id 二选一）           |

### `publish_update_fields`

通过一个入口更新**任意**文章属性。字段按可写它的唯一 API 路由：WP native（`/wp/v2`）、插件 meta（`PUT /tengence/v1/posts/{id}`）、插件 dates API。只动传入的字段。



| 参数                                                               | 类型                    | 必填 | 说明                                                              |
| ---------------------------------------------------------------- | --------------------- | -- | --------------------------------------------------------------- |
| `site`                                                           | string                | 否  | 站点 key                                                          |
| `article_id`                                                     | number                | 否  | `articles.id`—— 解析到 `wp_post_id`；给了 `wp_post_id` 时省略            |
| `wp_post_id`                                                     | number                | 否  | 目标 WP post id；给定后覆盖 DB 映射                                       |
| `lang`                                                           | string                | 否  | 文章语言（用于 DB 镜像）                                                  |
| `title`/`content`/`excerpt`/`slug`                               | string                | 否  | WP native 字段                                                    |
| `status`                                                         | string                | 否  | `draft\|publish\|pending\|private`（WP native）                   |
| `categories`/`tags`                                              | array(number\|string) | 否  | 术语 ID 或 slug；slug 会解析，传 `create_terms` 自动创建                     |
| `create_terms`                                                   | boolean               | 否  | 缺失时创建 category/tag slug 而非失败                                    |
| `sticky`                                                         | boolean               | 否  | 置顶标志（WP native）                                                 |
| `featured_media`                                                 | number                | 否  | 头图**媒体 ID**（WP native）；与 `image`（URL）配对保持同步                     |
| `image`/`image_alt`/`reading_time`/`author`                      | —                     | 否  | 插件 meta：基础                                                      |
| `i18n`/`regions`/`cta`                                           | —                     | 否  | 插件 meta                                                         |
| `seo_meta_title`/`seo_meta_description`                          | string                | 否  | SEO 组                                                           |
| `seo_meta_keywords`                                              | array(string)         | 否  | SEO 关键词                                                         |
| `seo_canonical_url`/`seo_og_type`/`seo_og_locale`/`seo_og_image` | string                | 否  | SEO 组                                                           |
| `seo_noindex`                                                    | boolean               | 否  | noindex 标志                                                      |
| `geo_ai_summary`                                                 | string                | 否  | GEO AI 摘要                                                       |
| `geo_qa_pairs`                                                   | array(any)            | 否  | `[{question,answer}]`                                           |
| `geo_citations`                                                  | any                   | 否  | GEO 引用（数组或对象）                                                   |
| `geo_key_takeaways`                                              | array(string)         | 否  | GEO 关键要点                                                        |
| `geo_schema_data`/`geo_entity`                                   | any                   | 否  | GEO schema / 实体                                                 |
| `date`/`date_gmt`/`modified`/`modified_gmt`                      | string                | 否  | 时间（插件 dates API）                                                |
| `copy_dates_from`                                                | number                | 否  | 从哪个 WP post id 复制四个日期（如 zh-hans 源）                              |
| `language`                                                       | string                | 否  | 经插件语言 API 设置文章语言                                                |
| `translation_group`                                              | string                | 否  | translation-group UUID                                          |
| `sync_db`                                                        | boolean               | 否  | 把 title/seo\_meta\_title/seo\_meta\_description 镜像进 DB（默认 true） |
| `dry_run`                                                        | boolean               | 否  | 只校验并报告路由，不写任何东西                                                 |

### `publish_daily`

运行每日提升任务（把到期草稿转为发布，默认 1 / 天）。可选 `date` 设置被提升文章的发布 / 修改时间（站点时区）；可选 `slug` 切换 slug 模式。



| 参数        | 类型      | 必填 | 说明                                              |
| --------- | ------- | -- | ----------------------------------------------- |
| `site`    | string  | 否  | 站点 key                                          |
| `date`    | string  | 否  | 发布时间 `YYYY-MM-DDTHH:MM:SS`（站点时区）；省略则不动 WP 时间    |
| `slug`    | string  | 否  | slug 模式：发布该 slug 的所有语言（逗号分隔多个）；省略则走计划顺序队列       |
| `count`   | number  | 否  | 队列模式下提升多少篇（默认 `wordpress.publish.per_day`，通常 1） |
| `dry_run` | boolean | 否  | 只报告，不写入                                         |



***

## 模块 9 —— 数据库（2 个工具）

### `db_init`

显式初始化数据库（sqlite 幂等建表 /mysql DDL；`--drop` 重建）。



| 参数     | 类型      | 必填 | 说明        |
| ------ | ------- | -- | --------- |
| `site` | string  | 否  | 站点 key    |
| `drop` | boolean | 否  | 删除并重建（危险） |

### `db_status`

数据库状态：驱动、路径、schema 版本、表列表、缺失表。



| 参数     | 类型     | 必填 | 说明     |
| ------ | ------ | -- | ------ |
| `site` | string | 否  | 站点 key |



***

## 模块 10 —— 搜索引擎收录提交（7 个工具）

### `search_gsc_stats`

读取 Google Search Console 搜索分析（点击 / 展示 / CTR / 平均排名），按 query/page/date/country/device 分组。是 Google 搜索表现唯一来源。GSC 数据延迟 2–3 天定稿；默认窗口为截止 3 天前的 28 天。需要 GSC 服务账号。



| 参数           | 类型          | 必填 | 说明                                                      |
| ------------ | ----------- | -- | ------------------------------------------------------- |
| `site`       | string      | 否  | 站点 key                                                  |
| `dimensions` | array(enum) | 否  | 分组：`query\|page\|date\|country\|device`（默认 `["query"]`） |
| `start_date` | string      | 否  | `YYYY-MM-DD`（默认：end\_date 前 27 天）                       |
| `end_date`   | string      | 否  | `YYYY-MM-DD`（默认：3 天前）                                   |
| `row_limit`  | number      | 否  | 最大行数（默认 100）                                            |

### `search_gsc_inspect`

查询单个 URL 的 Google 收录状态（URL Inspection API，只读）：verdict、coverageState、indexingState、lastCrawlTime、googleCanonical。配额：2000 次 / 天。



| 参数     | 类型     | 必填 | 说明         |
| ------ | ------ | -- | ---------- |
| `url`  | string | 是  | 要检查的完整 URL |
| `site` | string | 否  | 站点 key     |

### `search_submit_gsc`

把 sitemap 提交到 Google Search Console（软失败）。



| 参数            | 类型     | 必填 | 说明                  |
| ------------- | ------ | -- | ------------------- |
| `site`        | string | 否  | 站点 key              |
| `sitemap_url` | string | 否  | sitemap URL（默认自动推导） |

### `search_submit_indexnow`

提交 URL 到 IndexNow（需要 `INDEXNOW_KEY`）。



| 参数     | 类型     | 必填 | 说明                |
| ------ | ------ | -- | ----------------- |
| `url`  | string | 是  | 要提交的 URL（多个用逗号分隔） |
| `site` | string | 否  | 站点 key            |

### `search_submit_baidu`

提交 URL 到百度普通收录（需要 `BAIDU_TOKEN`/`BAIDU_SITE`）。两种模式：显式 `url` 列表，或 `all=true` sitemap 增量模式（递归展开 `sitemap_index.xml`，跳过已在 `data/baidu-log.jsonl` 记录的 URL，最多推 `limit` 条）。



| 参数      | 类型      | 必填 | 说明                                      |
| ------- | ------- | -- | --------------------------------------- |
| `url`   | string  | 否  | 要提交的 URL（逗号分隔，≤2000 / 次）；`all=true` 时省略 |
| `all`   | boolean | 否  | sitemap 增量模式：只推未记录的 URL                 |
| `limit` | number  | 否  | `all=true` 时最多推送条数（默认 10）               |
| `site`  | string  | 否  | 站点 key                                  |

### `webmaster_bing_status`

读取 Bing Webmaster 后台数据（已验证站点 / URL 提交配额 / 查询统计 / 抓取问题）。需要 `BING_WEBMASTER_API_KEY`。注意：Bing 于 2026-08-31 缩减了其 JSON API。



| 参数       | 类型     | 必填 | 说明                            |
| -------- | ------ | -- | ----------------------------- |
| `action` | enum   | 是  | `sites\|quota\|stats\|issues` |
| `site`   | string | 否  | 站点 key                        |

### `webmaster_bing_submit`

写入 Bing Webmaster：提交 URL（逗号分隔 = 批量，≤10000 / 次）。需要 `BING_WEBMASTER_API_KEY`。



| 参数     | 类型     | 必填 | 说明               |
| ------ | ------ | -- | ---------------- |
| `url`  | string | 是  | 要提交的 URL；多个用逗号分隔 |
| `site` | string | 否  | 站点 key           |



***

## 模块 11 —— GEO 监测（2 个工具）

### `monitor_run`

运行 GEO 监测（一轮 站点提示词 × 模型；结果持久化）。



| 参数       | 类型            | 必填 | 说明               |
| -------- | ------------- | -- | ---------------- |
| `site`   | string        | 否  | 站点 key           |
| `run_id` | string        | 否  | `YYYYMMDD`（默认今天） |
| `models` | array(string) | 否  | 模型 key 子集        |
| `layers` | array(string) | 否  | 层级子集             |

### `monitor_report`

读取监测结果（最新一轮或指定 `run_id`）。



| 参数       | 类型     | 必填 | 说明               |
| -------- | ------ | -- | ---------------- |
| `site`   | string | 否  | 站点 key           |
| `run_id` | string | 否  | `YYYYMMDD`（默认最新） |



***

## 模块 12 —— 跨平台分发（15 个工具）

### `channel_list`

列出 syndicate 注册表中的所有外部内容平台：API 类型（official|cookie|none）、状态、能力与完整平台改写规则。READY：wechat（官方 API）、juejin（cookie）、csdn（cookie）。



| 参数         | 类型     | 必填 | 说明          |
| ---------- | ------ | -- | ----------- |
| `platform` | string | 否  | 过滤到单个平台 key |

### `channel_style_get`

返回**单个平台**的完整风格 / 改写规则（wechat /juejin/blog…）。服务端只提供规则，改写由 harness/Skill 完成。改写前务必先调用。



| 参数         | 类型     | 必填 | 说明                                |
| ---------- | ------ | -- | --------------------------------- |
| `platform` | string | 是  | 平台 key，如 `wechat / juejin / blog` |

### `channel_check`

按平台风格规则校验标题 / 正文（确定性，不做内容生成）。返回错误（HARD）与警告（SOFT）及清单与改写策略。



| 参数         | 类型     | 必填 | 说明               |
| ---------- | ------ | -- | ---------------- |
| `platform` | string | 是  | 平台 key           |
| `title`    | string | 否  | 待校验的文章标题         |
| `body`     | string | 否  | 待校验的正文（markdown） |

### `channel_publish`

发布 / 导出到某个外部平台。**模式 A**：传 `slugs[]`，服务端读 DB 并运行平台流水线（wechat 草稿箱；juejin 草稿→发布；csdn 草稿→发布；devto 发布）。**模式 B**：传预先写好的 `articles[]`（harness 改写），服务端导出发布包到 `<site>/data/channel-export/<platform>/<slug>.md`。`asDraft` 默认 true（绝不群发）。每次结果都按平台记录到 `channel_plan`。



| 参数          | 类型            | 必填 | 说明                                                                                  |
| ----------- | ------------- | -- | ----------------------------------------------------------------------------------- |
| `platform`  | string        | 是  | 平台 key（见 `channel_list`）                                                            |
| `slugs`     | array(string) | 否  | 模式 A：要走平台流水线的文章 slug                                                                |
| `articles`  | array(object) | 否  | 模式 B：预先写好的 `{slug,title,contentMd,summary?,tags?,sourceUrl?,cover?,rewrite?,mode?}` |
| `asDraft`   | boolean       | 否  | 默认 true：建草稿（wechat/juejin），绝不群发                                                     |
| `keepOrder` | boolean       | 否  | 仅 wechat：保持 slug 顺序（第 1 个 = 头条）                                                     |
| `dryRun`    | boolean       | 否  | 打印计划，不做外部调用                                                                         |
| `site`      | string        | 否  | 站点 key                                                                              |

### `channel_plan_next`

每平台发布日历：返回某平台下一篇要发布的文章及所有日历行。每个平台从博客 article\_plan 推导自己的队列（nextDue = 该平台尚未记录的下一篇已发布博客文章）。



| 参数         | 类型     | 必填 | 说明                                |
| ---------- | ------ | -- | --------------------------------- |
| `platform` | string | 否  | 过滤到单个平台（默认全部）                     |
| `count`    | number | 否  | 下次发送应包含多少篇（wechat 合并为一条图文消息；默认 1） |

### `channel_plan_mark`

更新 channel\_plan 行状态并可选记录其草稿 id（如 wechat media\_id）。



| 参数         | 类型            | 必填 | 说明                                         |
| ---------- | ------------- | -- | ------------------------------------------ |
| `id`       | number        | 是  | channel\_plan 行 id                         |
| `status`   | enum          | 是  | `todo\|draft\|published\|paused`           |
| `draftIds` | array(string) | 否  | 要记录的草稿 / 媒体 id（如 wechat media\_id）；省略则保留现状 |

### `channel_plan_reconcile`

对账某平台 channel\_plan 与该平台实际发布内容（juejin | csdn）。用已发布文章播种发布日志。幂等（按 slug upsert）。首次 `channel_plan_next` 前每个平台各跑一次。



| 参数         | 类型            | 必填 | 说明                                           |
| ---------- | ------------- | -- | -------------------------------------------- |
| `platform` | string        | 是  | 平台 key，如 `juejin` 或 `csdn`                   |
| `map`      | array(object) | 否  | 明确已知已发布 `{slug,title?,blogOrder?}`；省略则实时读取平台 |
| `site`     | string        | 否  | 站点 key                                       |

### `channel_taxonomy_sync`

把外部平台自身的分类法词典（category + tag id/name）刷新到 `channel_taxonomy`。目前 juejin：8 个分类 + \~725 个标签。幂等；需要 `JUEJIN_COOKIE`。



| 参数         | 类型     | 必填 | 说明                |
| ---------- | ------ | -- | ----------------- |
| `platform` | string | 否  | 平台 key（默认 juejin） |
| `site`     | string | 否  | 站点 key            |

### `channel_taxonomy_list`

读取缓存的外部平台分类法词典，支持按 `kind`、精确 `name` 或 `prefix` 过滤。



| 参数         | 类型     | 必填 | 说明                        |
| ---------- | ------ | -- | ------------------------- |
| `platform` | string | 否  | 平台 key（默认 juejin）         |
| `kind`     | enum   | 否  | `category\|tag`（省略则两者都返回） |
| `name`     | string | 否  | 精确名称查找（不区分大小写）            |
| `prefix`   | string | 否  | 名称前缀查找，如 `"搜索"`           |
| `limit`    | number | 否  | 最大行数（默认 100）              |
| `site`     | string | 否  | 站点 key                    |

### `channel_taxonomy_resolve`

预览我们的分类法如何映射到平台（`article_plan.category/tags` → 平台 category\_id/tag\_ids），**不**发布。返回所选 id / 名及每项来源（alias/exact/token/fuzzy/default/env/first/hardcoded）。绝不外部调用，绝不写入。



| 参数         | 类型            | 必填 | 说明                                         |
| ---------- | ------------- | -- | ------------------------------------------ |
| `category` | string        | 否  | 我们的分类 slug，如 `geo-ai-search`               |
| `tags`     | array(string) | 否  | 我们的标签 slug，如 `["geo-seo","search-system"]` |
| `keywords` | array(string) | 否  | 额外关键词（文章 target\_keywords）                 |
| `platform` | string        | 否  | 平台 key（默认 juejin）                          |
| `site`     | string        | 否  | 站点 key                                     |

### `juejin_status`

读取掘金后台：草稿箱与已发布列表。只读。需要 `JUEJIN_COOKIE` + `JUEJIN_UID`。



| 参数     | 类型     | 必填 | 说明             |
| ------ | ------ | -- | -------------- |
| `page` | number | 否  | 页码（默认 0，每页 50） |
| `site` | string | 否  | 站点 key         |

### `juejin_draft_delete`

删除掘金草稿。**不可逆**—— 经 `juejin_status` 核实 id 后才可 `confirm=true`。



| 参数        | 类型      | 必填 | 说明                       |
| --------- | ------- | -- | ------------------------ |
| `draftId` | string  | 是  | `juejin_status` 返回的草稿 id |
| `confirm` | boolean | 是  | 必须为 `true` 才真正删除         |
| `site`    | string  | 否  | 站点 key                   |

### `juejin_article_delete`

删除掘金已发布文章。**不可逆**—— 经 `juejin_status` 核实后才可 `confirm=true`。



| 参数          | 类型      | 必填 | 说明                       |
| ----------- | ------- | -- | ------------------------ |
| `articleId` | string  | 是  | `juejin_status` 返回的文章 id |
| `confirm`   | boolean | 是  | 必须为 `true` 才真正删除         |
| `site`      | string  | 否  | 站点 key                   |

### `csdn_status`

读取 CSDN 博客后台：草稿箱与已发布列表。只读。需要 `CSDN_COOKIE`。登录过期会以 `cookieExpired=true` 呈现。



| 参数         | 类型     | 必填 | 说明              |
| ---------- | ------ | -- | --------------- |
| `page`     | number | 否  | 从 1 开始的页码（默认 1） |
| `pageSize` | number | 否  | 每页条数（默认 20）     |
| `site`     | string | 否  | 站点 key          |

### `csdn_article_delete`

删除 CSDN 文章。**不可逆**—— 经 `csdn_status` 核实后才可 `confirm=true`。



| 参数          | 类型      | 必填 | 说明                     |
| ----------- | ------- | -- | ---------------------- |
| `articleId` | string  | 是  | `csdn_status` 返回的文章 id |
| `deep`      | boolean | 否  | 同时从回收站彻底清除（默认 false）   |
| `confirm`   | boolean | 是  | 必须为 `true` 才真正删除       |
| `site`      | string  | 否  | 站点 key                 |



***

## 模块 13 —— 多语言术语名：分类 / 标签 / 作者（11 个工具）

这些封装 Tengence 插件端点（`/tengence/v1/term-names`、`/author-names`），由站点 `.env` 的 `TENGENCE_SITE_ID` / `TENGENCE_SECRET` 驱动。语言 key 接受 `en / zh-hans / zh-hant`。

### `term_names_list`

列出 WP 分类与标签的多语言显示名表。



| 参数         | 类型     | 必填 | 说明                             |
| ---------- | ------ | -- | ------------------------------ |
| `taxonomy` | enum   | 否  | `category\|post_tag`（省略则两者都返回） |
| `site`     | string | 否  | 站点 key                         |

### `article_terms_sync`

用**术语 slug**读取和 / 或设置文章的 WP 分类（category + post\_tag）。三种模式：read（只传目标）、write（category\_slugs/tag\_slugs）、mirror（copy\_from）。返回 before/after 差异。



| 参数               | 类型            | 必填 | 说明                            |
| ---------------- | ------------- | -- | ----------------------------- |
| `site`           | string        | 否  | 站点 key                        |
| `wp_post_id`     | number        | 否  | 目标 WP post id；给了 `slug` 时省略   |
| `slug`           | string        | 否  | 目标文章 slug（`wp_post_id` 缺失时必填） |
| `lang`           | string        | 否  | slug 查询语言（默认 `zh-hans`）       |
| `copy_from`      | number        | 否  | 要镜像分类 + 标签的源 wp\_post\_id     |
| `category_slugs` | array(string) | 否  | 要设置的分类 slug                   |
| `tag_slugs`      | array(string) | 否  | 要设置的标签 slug                   |
| `create_terms`   | boolean       | 否  | 缺失时创建术语 slug 而非失败             |
| `dry_run`        | boolean       | 否  | 只解析并报告，不动 WP                  |

### `term_name_get`

读取单个 WP 术语的多语言显示名。



| 参数         | 类型     | 必填 | 说明                        |
| ---------- | ------ | -- | ------------------------- |
| `taxonomy` | enum   | 是  | `category` 或 `post_tag`   |
| `slug`     | string | 是  | 术语 slug，如 `geo-ai-search` |
| `site`     | string | 否  | 站点 key                    |

### `term_name_set`

设置（upsert）单个术语的多语言显示名：`{"names":{"en":"...","zh-hans":"...","zh-hant":"..."}}`。空串清除该语言。



| 参数         | 类型     | 必填 | 说明                      |
| ---------- | ------ | -- | ----------------------- |
| `taxonomy` | enum   | 是  | `category` 或 `post_tag` |
| `slug`     | string | 是  | 术语 slug                 |
| `names`    | object | 是  | 语言码 → 显示名；`""` 清除该语言    |
| `site`     | string | 否  | 站点 key                  |

### `term_name_delete`

删除单个术语的多语言显示名。`lang` 只删除该语言。



| 参数         | 类型     | 必填 | 说明                      |
| ---------- | ------ | -- | ----------------------- |
| `taxonomy` | enum   | 是  | `category` 或 `post_tag` |
| `slug`     | string | 是  | 术语 slug                 |
| `lang`     | string | 否  | 只删除该语言（省略则删除所有已配置名）     |
| `site`     | string | 否  | 站点 key                  |

### `term_names_batch`

批量设置多个术语的多语言显示名：`{"category":{"<slug>":{"<lang>":"<name>"}},"post_tag":{...}}`。



| 参数         | 类型     | 必填 | 说明                       |
| ---------- | ------ | -- | ------------------------ |
| `category` | object | 否  | 分类 slug → `{lang: name}` |
| `post_tag` | object | 否  | 标签 slug → `{lang: name}` |
| `site`     | string | 否  | 站点 key                   |

### `author_names_list`

列出所有 WP 作者的多语言显示名。



| 参数     | 类型     | 必填 | 说明     |
| ------ | ------ | -- | ------ |
| `site` | string | 否  | 站点 key |

### `author_name_get`

读取单个 WP 作者的多语言显示名。



| 参数     | 类型      | 必填 | 说明            |
| ------ | ------- | -- | ------------- |
| `id`   | integer | 是  | WP 作者 / 用户 ID |
| `site` | string  | 否  | 站点 key        |

### `author_name_set`

设置（upsert）单个作者的多语言显示名：`{"names":{"en":"...","zh-hans":"..."}}`。空串清除该语言。



| 参数      | 类型      | 必填 | 说明                   |
| ------- | ------- | -- | -------------------- |
| `id`    | integer | 是  | WP 作者 / 用户 ID        |
| `names` | object  | 是  | 语言码 → 显示名；`""` 清除该语言 |
| `site`  | string  | 否  | 站点 key               |

### `author_name_delete`

删除单个作者的多语言显示名。`lang` 只删除该语言。



| 参数     | 类型      | 必填 | 说明            |
| ------ | ------- | -- | ------------- |
| `id`   | integer | 是  | WP 作者 / 用户 ID |
| `lang` | string  | 否  | 只删除该语言        |
| `site` | string  | 否  | 站点 key        |

### `author_names_batch`

批量设置多个作者的多语言显示名：`{"authors":{"<id>":{"<lang>":"<name>"}}}`。



| 参数        | 类型     | 必填 | 说明                           |
| --------- | ------ | -- | ---------------------------- |
| `authors` | object | 是  | 作者 id（数字字符串）→ `{lang: name}` |
| `site`    | string | 否  | 站点 key                       |



***

## 模块 14 —— 微信（8 个工具）

### `wechat_status`

读取微信公众号后台：草稿箱与已群发列表。需要 `WECHAT_APP_ID`/`SECRET` 且出口 IP 已加白。



| 参数     | 类型     | 必填 | 说明     |
| ------ | ------ | -- | ------ |
| `site` | string | 否  | 站点 key |

### `wechat_stats`

读取公众号后台统计（`datacube/*`）。T+1 数据；多数端点窗口 ≤7 天；`article_read`/`article_share`/`article_detail` 要求 `begin_date === end_date`。



| 参数           | 类型     | 必填 | 说明                                                                                                                                                |
| ------------ | ------ | -- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`     | enum   | 否  | `overview\|user_summary\|user_cumulate\|upstream_msg\|interface_summary\|biz_summary\|article_read\|article_share\|article_detail`（默认 `overview`） |
| `begin_date` | string | 否  | `YYYY-MM-DD`（默认：end\_date 前 6 天）                                                                                                                  |
| `end_date`   | string | 否  | `YYYY-MM-DD`（默认：昨天；今天永不可用）                                                                                                                        |
| `site`       | string | 否  | 站点 key                                                                                                                                            |

### `wechat_sync_progress`

把 channel\_plan 日历与真实微信后台对账并自动修复 DB。`dryRun=true` 只预览不写入。



| 参数       | 类型      | 必填 | 说明           |
| -------- | ------- | -- | ------------ |
| `site`   | string  | 否  | 站点 key       |
| `dryRun` | boolean | 否  | 只计算并报告，不写 DB |

### `wechat_mass_preview`

把一篇草稿（media\_id）以预览形式发给单个用户。需要已认证账号。



| 参数         | 类型      | 必填 | 说明            |
| ---------- | ------- | -- | ------------- |
| `media_id` | string  | 是  | 草稿箱 media\_id |
| `openid`   | string  | 否  | 接收者 openid    |
| `wxname`   | string  | 否  | 接收者 wxname    |
| `dryRun`   | boolean | 否  | 只打印载荷，不发送     |
| `site`     | string  | 否  | 站点 key        |

### `wechat_mass_send`

群发（推送粉丝）一篇草稿。订阅号每天 1 次；成功后草稿被消耗。**高风险**—— 需要 `confirm="YES"`。



| 参数              | 类型            | 必填 | 说明                            |
| --------------- | ------------- | -- | ----------------------------- |
| `media_id`      | string        | 是  | 草稿箱 media\_id                 |
| `tag_id`        | number        | 否  | 只发给某个用户标签（省略 = 全部粉丝）          |
| `to_users`      | array(string) | 否  | 指定 openid                     |
| `client_msg_id` | string        | 否  | 去重重复发送                        |
| `confirm`       | enum          | 否  | 推送粉丝必须为 `"YES"`（`dryRun` 不需要） |
| `dryRun`        | boolean       | 否  | 只打印载荷，不发送                     |
| `site`          | string        | 否  | 站点 key                        |

### `wechat_mass_status`

查询群发任务状态。



| 参数       | 类型     | 必填 | 说明           |
| -------- | ------ | -- | ------------ |
| `msg_id` | number | 是  | 群发任务 msg\_id |
| `site`   | string | 否  | 站点 key       |

### `wechat_article_delete`

删除一篇已发布文章。**不可逆**——`confirm="YES"`。`index`（从 1 起）删除多图文消息中的一篇；省略删除整条消息。



| 参数           | 类型      | 必填 | 说明               |
| ------------ | ------- | -- | ---------------- |
| `article_id` | string  | 是  | 已发布文章 id         |
| `index`      | number  | 否  | 消息内从 1 起的位置      |
| `confirm`    | enum    | 否  | 必须为 `"YES"`（不可逆） |
| `dryRun`     | boolean | 否  | 只打印载荷，不删除        |
| `site`       | string  | 否  | 站点 key           |

### `wechat_draft_publish`

经 `freepublish/submit` 把草稿箱 media\_id 发布到公众号主页（**不**推送粉丝）。



| 参数         | 类型      | 必填 | 说明            |
| ---------- | ------- | -- | ------------- |
| `media_id` | string  | 是  | 草稿箱 media\_id |
| `dryRun`   | boolean | 否  | 只打印载荷，不发布     |
| `site`     | string  | 否  | 站点 key        |



***

# 4. CLI 命令参考（24 条）

> 所有命令统一 
>
> `tengence-geo-`
>
>  前缀。参数语法：
>
> `--flag`
>
> 、
>
> `--key=value`
>
> 、
>
> `--key value`
>
> 。CLI 是
>
> **规范化的编排入口**
>
> ，MCP 工具正是委托它执行。下表每条命令对应一个或多个 MCP 工具。



| #  | 命令                                               | 作用                        | 对应 MCP                                           |
| -- | ------------------------------------------------ | ------------------------- | ------------------------------------------------ |
| 1  | `tengence-geo-article-ingest`                    | 摄取一篇源文章进内容库               | `article_ingest`                                 |
| 2  | `tengence-geo-article-export`                    | 导出为发布包（front matter + 正文） | `article_export`                                 |
| 3  | `tengence-geo-article-save`                      | 保存 / 更新文章草稿               | `publish_update_fields`                          |
| 4  | `tengence-geo-check-article`                     | 运行 G1–G14 编辑门禁            | `check_article`                                  |
| 5  | `tengence-geo-plan`                              | 选题规划与排期                   | `plan_list` / `plan_import` / `plan_mark_status` |
| 6  | `tengence-geo-channel-plan`                      | 每平台发布日历                   | `channel_plan_*`                                 |
| 7  | `tengence-geo-channel-publish`                   | 发布到某个外部平台                 | `channel_publish`                                |
| 8  | `tengence-geo-publish-draft`                     | 发布草稿（WordPress）           | `publish_draft`                                  |
| 9  | `tengence-geo-publish-from-db`                   | 从内容库按 slug/id 批量发布        | `publish_from_db`                                |
| 10 | `tengence-geo-publish-update-article`            | 更新已发布文章                   | `publish_update_article`                         |
| 11 | `tengence-geo-publish-wechat`                    | 发布到微信                     | `channel_publish`(wechat)                        |
| 12 | `tengence-geo-publish-juejin`                    | 发布到掘金                     | `channel_publish`(juejin)                        |
| 13 | `tengence-geo-publish-devto`                     | 发布到 Dev.to                | `channel_publish`(devto)                         |
| 14 | `tengence-geo-promote-daily`                     | 每日定时提升（草稿 → 正式发布）         | `publish_daily`                                  |
| 15 | `tengence-geo-submit-gsc`                        | 提交到 Google Search Console | `search_submit_gsc` / `search_gsc_*`             |
| 16 | `tengence-geo-submit-bing`                       | 提交到 Bing Webmaster        | `webmaster_bing_submit`                          |
| 17 | `tengence-geo-bing-webmaster`                    | Bing Webmaster API 查询     | `webmaster_bing_status`                          |
| 18 | `tengence-geo-submit-indexnow`                   | IndexNow 即时收录             | `search_submit_indexnow`                         |
| 19 | `tengence-geo-submit-baidu`                      | 提交到百度                     | `search_submit_baidu`                            |
| 20 | `tengence-geo-geo-monitor`                       | 运行 AI 可见性监测               | `monitor_run`                                    |
| 21 | `tengence-geo-geo-monitor-report`                | 生成监测报告                    | `monitor_report`                                 |
| 22 | `tengence-geo-image-acquire`                     | 图片采集流水线                   | `image_acquire`                                  |
| 23 | `tengence-geo-taxonomy`                          | 分类 / 标签管理                 | `article_terms_sync` / `term_*`                  |
| 24 | `tengence-geo-db-init` / `tengence-geo-db-query` | 数据库初始化与查询                 | `db_init` / `db_status` / `db-query`             |

## 命令明细

**1.&#x20;**`tengence-geo-article-ingest` — 摄取一篇源文章进内容库



```
tengence-geo-article-ingest.js <slug> [<md-path>] [--lang zh-hans] [--research <path>] [--no-archive]
```

`<slug>` 文章 slug；`<md-path>` 正文路径（从 stdin 读可省）；`--lang` 语言（默认 zh-hans）；`--research <path>` brief 路径；`--no-archive` 摄取后不归档。

**2.&#x20;**`tengence-geo-article-export` — 导出文章 + brief 到 `data/inbox`



```
tengence-geo-article-export.js <slug> [--lang zh-hans] [--out <dir>]
```

**3.&#x20;**`tengence-geo-article-save` — 保存 / 更新文章草稿



```
tengence-geo-article-save.js <article_id> <file_path> [--title] [--site <key>]
```

**4.&#x20;**`tengence-geo-check-article` — 运行编辑门禁



```
tengence-geo-check-article.js <slug> [<dir=industry-insights>] [--type=T1..T7]
```

**5.&#x20;**`tengence-geo-plan` — 选题规划与排期。选项：`--batch`、`--category`、`--cluster`、`--dry-run`、`--limit`、`--matrix`、`--node`、`--queue`、`--set`、`--status`。

**6.&#x20;**`tengence-geo-channel-plan` — 每平台发布日历。子命令：



```
channel-plan.js mark <id> <todo|draft|published|paused>
channel-plan.js import-wechat <issues.json>
```

其它选项：`--platform`、`--status`、`--published`、`--all`、`--kind`、`--name`、`--prefix`、`--limit`、`--category`、`--tags`、`--keywords`、`--dry-run`。

**7.&#x20;**`tengence-geo-channel-publish` — 发布 / 导出到某个外部平台



```
channel-publish.js --platform=<key> --slugs=a,b,c [--publish] [--dry-run] [--keep-order] [--from-md <path>]
```

**8.&#x20;**`tengence-geo-publish-draft` — 一键把本地草稿发布到 WordPress



```
tengence-geo publish-draft.js <draft-path> [options]
  --meta=<path>       geo meta JSON 路径（默认 <draft>.meta.json）
  --status=draft|publish  发布状态（默认 draft）
  --no-move           发布后不移动文件
  --auto-image        发布前自动 检索→过滤→下载→WebP→上传 为头图
  --site <key>        站点 key（默认 tengence）
```

**9.&#x20;**`tengence-geo-publish-from-db` — 从内容库按 slug/id 批量发布



```
tengence-geo publish-from-db.js <article_id> [options]
  --status=draft|publish        （默认 draft）
  --force                       强制更新已有
  --dry-run
  --batch <ids>                 多个 id
  --all                         全部 queued
  --featured-media <id>         强制指定媒体 id（跳过 URL 下载/上传）
  --translation-group <uuid>
  --no-sync-dates               不继承 zh-hans 源时间
  --skip-gsc / --skip-indexnow / --skip-baidu   发布后跳过收录提交
  --site <key>
```

**10.&#x20;**`tengence-geo-publish-update-article` — 更新已发布文章



```
tengence-geo publish-update-article.js <markdown_file> [options]
  --slug <s> / --post-id <id>    目标
  --status=publish
  --meta-only                   只更新 meta 字段
  --meta-title <t> / --meta-desc <d> / --post-title <t>
  --no-upload
  --dry-run
  --lang <lang>（默认 zh-hans）
  --site <key>
```

**11.&#x20;**`tengence-geo-publish-wechat` — 发布到微信



```
node publish-wechat.js <slug> [--publish] [--dry-run]
```

（`--publish` 推送粉丝 —— 高风险操作；默认只建草稿。）

**12.&#x20;**`tengence-geo-publish-juejin` — 发布到掘金



```
node publish-juejin.js <markdown_file> [--title "标题"] [--draft] [--publish]
```

**13.&#x20;**`tengence-geo-publish-devto` — 发布到 Dev.to



```
tengence-geo publish-devto.js <md-file-path> [--dry-run]
```

**14.&#x20;**`tengence-geo-promote-daily` — 每日定时提升（草稿 → 正式发布）



```
tengence-geo promote-daily.js [--site <key>] [--date <YYYY-MM-DDTHH:MM:SS>] [--slug <s>] [--count <n>] [--dry-run]
```



* 队列模式（默认）：按 `publish_order` 提升接下来 `count` 个 queued 行（遵循 `wordpress.yaml` 的 `per_day`/`skip_dates`）。

* `--slug` 模式：把该 slug 的每种语言版本都发布。

* `--date`：设置被提升文章的发布 / 修改时间（站点时区）—— 即定时正式发布。

**15.&#x20;**`tengence-geo-submit-gsc` — 提交到 Google Search Console



```
tengence-geo submit-gsc.js [options]
  --site <key>  --dry-run  --sitemap  --status  --all  --limit  --indexing <url>  --url <url>
```

**16.&#x20;**`tengence-geo-submit-bing` — 提交到 Bing Webmaster。选项：`--site`、`--dry-run`、`--all`、`--limit`、`--submit <url>`。

**17.&#x20;**`tengence-geo-bing-webmaster` — Bing Webmaster API 查询。选项：`--site`、`--dry-run`、`--sites`、`--status`、`--stats`、`--issues`、`--all`、`--resubmit`、`--limit`、`--submit <url>`。

**18.&#x20;**`tengence-geo-submit-indexnow` — IndexNow 即时收录



```
tengence-geo submit-indexnow.js [options]
  --site <key>  --dry-run  --all  --limit（默认 1000）  --url <url>
```

**19.&#x20;**`tengence-geo-submit-baidu` — 提交到百度普通收录



```
tengence-geo submit-baidu.js [options]
  --site <key>  --dry-run  --all  --resubmit  --limit  --url <url>
```

`--all` 增量推送 sitemap（最多 `limit` 条，默认 10，遵守日配额）。

**20.&#x20;**`tengence-geo-geo-monitor` — 运行 GEO 监测



```
tengence-geo geo-monitor.js run --run-id=20260921 [--site <key>] [--dry-run] [--mock] [--models <m>] [--layer <l>]
```

**21.&#x20;**`tengence-geo-geo-monitor-report` — 生成监测报告。选项：`--mock`、`--models <m>`。

**22.&#x20;**`tengence-geo-image-acquire` — 图片采集流水线



```
tengence-geo image-acquire.js [options]
  --query <kw>  --slug <slug>  --keywords <k>  --count <n>  --format <fmt>
  --out-json <path>  --dry-run  --site <key>
```

**23.&#x20;**`tengence-geo-taxonomy` — 分类 / 标签管理



```
tengence-geo taxonomy.js <db-register|wp-cleanup|verify> [--slugs=a,b,c] [--site <key>]
```

**24.&#x20;**`tengence-geo-db-init`**&#x20;/&#x20;**`tengence-geo-db-query` — 数据库初始化与查询



```
tengence-geo db-init.js [--drop] [--site <key>]
tengence-geo db-query.js [--list] [--slug=xxx] [--category=xxx] [--status=xxx]
                 [--lang <l>] [--limit <n>] [--categories] [--tags] [--plan] [--site <key>]
```



***

# 5. 环境变量与配置

## 5.1 运行时与存储



| 变量                                                                | 说明                                        | 必填 | 默认                              |
| ----------------------------------------------------------------- | ----------------------------------------- | -- | ------------------------------- |
| `SITES_ROOT`                                                      | 存放各站点 `config/` 与 `.env` 的根目录             | 否  | —                               |
| `TENGENCE_GEO_HOME`                                               | 内部运行时数据目录                                 | 否  | `~/.tengence/geo-mcp`           |
| `GEO_HOME`                                                        | `TENGENCE_GEO_HOME` 的旧别名（保留至 0.2.0）       | 否  | —                               |
| `DB_DRIVER`                                                       | `sqlite`（默认）\| `mysql`                    | 否  | `sqlite`                        |
| `DB_PATH`                                                         | SQLite 文件路径（`~` 展开）                       | 否  | `$TENGENCE_GEO_HOME/geo.sqlite` |
| `GEO_SQLITE_DRIVER`                                               | `builtin` \| `native`：显式选择 SQLite 驱动      | 否  | 自动（优先 builtin）                  |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_DATABASE` | MySQL 连接（`DB_DRIVER=mysql` 时）             | 否  | —                               |
| `APP_ID`                                                          | 租户 ID；SQLite 单文件多租户与 MySQL 都按 `app_id` 隔离 | 否  | `1`                             |
| `HTTPS_PROXY` / `NO_PROXY`                                        | HTTP (S) 代理（GSC 等在 CN 网络需代理）              | 否  | —                               |
| `DEBUG` / `GEO_DEBUG_DRAFT`                                       | 调试日志开关                                    | 否  | —                               |

## 5.2 MCP 传输



| 变量              | 说明                               | 必填 | 默认     |
| --------------- | -------------------------------- | -- | ------ |
| `GEO_MCP_PORT`  | HTTP 模式监听端口                      | 否  | `8787` |
| `GEO_MCP_TOKEN` | HTTP 模式 Bearer 令牌；未设置则无鉴权（仅本地调试） | 否  | 空      |

传输：**stdio**（本地客户端）或 **Streamable HTTP**（远程 / 自托管，静态 Bearer 鉴权，单用户）。Base URL = `http://127.0.0.1:<port>/`，请求头 `Authorization: Bearer <token>`。

## 5.3 WordPress（每站点 `.env`）



| 变量                            | 说明                                  |
| ----------------------------- | ----------------------------------- |
| `WP_URL`                      | WordPress 站点 URL                    |
| `WP_API_URL`                  | WP REST API 基址（可选；缺省时从 `WP_URL` 推导） |
| `WP_USERNAME` / `WP_PASSWORD` | WP 应用凭据（REST 鉴权）                    |
| `WP_ORIGIN_HOST`              | 插件端点的允许来源 host（可选）                  |

## 5.4 搜索引擎收录（每站点 `.env`，可选 —— 缺失值软失败，不阻塞发布）



| 变量                                                         | 说明                          |
| ---------------------------------------------------------- | --------------------------- |
| `GOOGLE_SA_JSON`                                           | GSC 服务账号 JSON 的绝对路径         |
| `GSC_SITEMAP_URL`                                          | GSC sitemap URL（可选；自动推导）    |
| `GOOGLE_INDEXING_API_ENABLED`                              | 启用 Google Indexing API（可选）  |
| `BING_WEBMASTER_API_KEY`                                   | Bing Webmaster API key      |
| `BING_WEBMASTER_SITE_URL`                                  | Bing Webmaster 站点 URL（可选覆盖） |
| `INDEXNOW_KEY` / `INDEXNOW_KEY_LOCATION` / `INDEXNOW_HOST` | IndexNow 密钥、密钥文件位置、host     |
| `BAIDU_TOKEN` / `BAIDU_SITE`                               | 百度普通收录令牌与站点                 |

> 注意：Bing 于 2026-08-31 缩减了其 JSON API。

## 5.5 图片流水线（每站点 `.env`，可选）



| 变量                                                                | 说明                 |
| ----------------------------------------------------------------- | ------------------ |
| `PEXELS_API_KEY`                                                  | Pexels 图库 API key  |
| `PIXABAY_API_KEY`                                                 | Pixabay 图库 API key |
| `UNSPLASH_ACCESS_KEY` / `UNSPLASH_APP_ID` / `UNSPLASH_SECRET_KEY` | Unsplash API keys  |
| `IMAGE_FORMAT`                                                    | 输出图片格式（默认 WebP）    |
| `IMAGE_CANDIDATE_POOL`                                            | 检索候选池大小            |
| `IMAGE_API_TIMEOUT` / `IMAGE_DL_TIMEOUT`                          | API / 下载超时（ms）     |

## 5.6 分发平台（每站点 `.env`，可选）



| 变量                                                                | 说明                     |
| ----------------------------------------------------------------- | ---------------------- |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET`                             | 微信公众号凭据（出口 IP 需加白）     |
| `JUEJIN_COOKIE` / `JUEJIN_UID` / `JUEJIN_AID`                     | 掘金 cookie /uid/aid     |
| `JUEJIN_CATEGORY_ID` / `JUEJIN_TAG_ID`                            | 掘金默认分类 / 标签 id         |
| `CSDN_COOKIE` / `CSDN_USERNAME`                                   | CSDN cookie 与用户名       |
| `CSDN_TAGS` / `CSDN_CREATION_STATEMENT` / `CSDN_SOURCE`           | CSDN 默认标签 / 创作声明 / 来源  |
| `DEVTO_API_KEY`                                                   | Dev.to API key         |
| `TENCENT_COOKIE` / `TENCENT_SOURCE_TYPE`                          | 腾讯云社区 cookie / 来源类型    |
| `TENCENT_CLASSIFY_IDS` / `TENCENT_COLUMN_IDS` / `TENCENT_TAG_IDS` | 腾讯社区分类 / 专栏 / 标签 id    |
| `ALIYUN_COOKIE` / `ALIYUN_ARTICLE_TYPE`                           | 阿里云开发者社区 cookie / 文章类型 |

## 5.7 Tengence 插件端点（每站点 `.env`）



| 变量                                     | 说明                 |
| -------------------------------------- | ------------------ |
| `TENGENCE_SITE_ID` / `TENGENCE_SECRET` | 驱动插件术语名 / 作者名端点的凭据 |
| `TENGENCE_API_URL`                     | 插件 API 基址（可选覆盖）    |
| `SITE_DOMAIN`                          | 站点域名覆盖（可选）         |

## 5.8 Agent 运行时（harness）



| 变量                 | 说明                                      |
| ------------------ | --------------------------------------- |
| `HARNESS`          | Agent 运行时循环：`dsh` \| `opencode` \| `pi` |
| `DEEPSEEK_API_KEY` | Agent 运行时循环使用的 LLM API key              |

## 5.9 `.env` 如何加载



* **全局运行时变量**从进程环境读取。

* **每站点密钥**只存在于 `<workspace>/<site>/.env`（gitignore）。SDK 在解析站点时加载该站点的 `.env`，因此切勿提交密钥。

* 所有内部路径都从 `TENGENCE_GEO_HOME` 推导（唯一事实来源）。



***

# 6. 数据模型（18 张表）

> 权威来源：
>
> `packages/geo-sdk/db/sqlite-schema.js`
>
> （与 
>
> `db/schema.js`
>
>  / MySQL 字段同构）。表前缀：
>
> `tengence_geo_`
>
> 。

## 6.1 概览

共 18 张表：**16 张业务表**（与 MySQL 生产 schema 共享，`tengence_geo_*`）+ **2 张工作区本地表**（仅 SQLite，存每平台发布日历与外部平台分类法词典）。

关键设计：每张表带 `app_id`（多租户）；业务唯一键都含 `app_id`；`(app_id, slug, lang)` 是 `articles` 与 `article_plan` 的唯一键（每种语言一行）；SQLite 用本地时间，ENUM 变 TEXT（语义校验在应用层）；Schema 版本记录在 `PRAGMA user_version`（当前 `SCHEMA_VERSION = 5`）。

## 6.2 业务表（16）



| 表                                  | 作用                                               | 关键字段                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tengence_geo_articles`            | 内容库，每 slug+lang 一行                               | id、app\_id、slug、title、content\_path、content\_html、research\_md、excerpt、featured\_image、target\_keywords、lang、translation\_group、region\_market、status、author、wp\_post\_id、published\_at、created\_at、updated\_at                                                                                |
| `tengence_geo_categories`          | 分类                                               | id、app\_id、name、slug                                                                                                                                                                                                                                                                           |
| `tengence_geo_tags`                | 标签                                               | id、app\_id、name、slug                                                                                                                                                                                                                                                                           |
| `tengence_geo_article_categories`  | 文章 ↔ 分类关联                                        | article\_id、category\_id、app\_id                                                                                                                                                                                                                                                               |
| `tengence_geo_article_tags`        | 文章 ↔ 标签关联                                        | article\_id、tag\_id、app\_id                                                                                                                                                                                                                                                                    |
| `tengence_geo_seo`                 | 每篇文章的 SEO meta                                   | article\_id、title、meta\_title、meta\_description、keywords、canonical\_url、og\_\*、noindex…                                                                                                                                                                                                        |
| `tengence_geo_geo`                 | 每篇文章的 GEO meta                                   | article\_id、ai\_summary、key\_takeaways、qa、citations、schema\_data、entity…                                                                                                                                                                                                                       |
| `tengence_geo_qa_pairs`            | FAQ 问答行                                          | article\_id、question、answer                                                                                                                                                                                                                                                                    |
| `tengence_geo_citations`           | 引用行（双通道证据）                                       | article\_id、title、url、channel…                                                                                                                                                                                                                                                                 |
| `tengence_geo_social`              | 社交 / OG meta                                     | article\_id、og\_\*                                                                                                                                                                                                                                                                             |
| `tengence_geo_vectors`             | 内容向量                                             | article\_id、embedding…                                                                                                                                                                                                                                                                         |
| `tengence_geo_images`              | 媒体库镜像                                            | id、app\_id、url、file、format、width、height、alt、wp\_media\_id…                                                                                                                                                                                                                                     |
| `tengence_geo_article_images`      | 文章 ↔ 图片关联                                        | article\_id、image\_id、is\_featured…                                                                                                                                                                                                                                                            |
| `tengence_geo_geo_monitor_answers` | 监测原始回答（提示词 × 模型 × 层级）                            | run\_id、model、layer、prompt、answer…                                                                                                                                                                                                                                                             |
| `tengence_geo_geo_monitor_results` | 监测聚合结果（收录基线 + 可见性）                               | run\_id、model、layer、score…                                                                                                                                                                                                                                                                     |
| `tengence_geo_article_plan`        | 发布计划 / 队列（`todo → written → queued → published`） | id、app\_id、slug、node\_type、hub\_cluster、matrix\_code、title、focus\_keyword、keyword\_volume、keyword\_competition、search\_intent、content\_type、target\_word\_count、publish\_batch、publish\_order、category、tags、lang、article\_id、wp\_post\_id、published\_url、plan\_status、queued\_at、published\_at |

## 6.3 工作区本地表（2，仅 SQLite）



| 表                               | 作用                                          | 关键字段                                                                                                                                     |
| ------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `tengence_geo_channel_plan`     | 每平台发布日历（wechat/juejin/csdn…），工作区本地，不在 MySQL | id、app\_id、platform、period、topic、weekday、article\_slugs、status、draft\_ids、article\_id、notes、schedule\_at。唯一 `(app_id, platform, period)` |
| `tengence_geo_channel_taxonomy` | 外部平台自身分类法词典（category/tag id+name），平台级共享     | id、app\_id、platform、kind、external\_id、name、parent\_id、extra、synced\_at。唯一 `(app_id, platform, kind, external_id)`                        |

## 6.4 站点目录布局



```
<workspace>/<site>/
├── .env                    # 密钥（gitignore）
├── config/
│   ├── site.yaml           # 站点身份、默认语言
│   ├── wordpress.yaml      # WP 连接 + 发布日历（per_day/skip_dates）
│   └── monitor.yaml        # 监测模型/层级
├── data/
│   ├── inbox/              # 摄取的文章源（翻译放 <lang>/ 子目录）
│   ├── reports/            # 诊断与方案报告
│   └── channel-export/     # 每平台发布包
└── ...
```

WordPress 连接参数可在每站点 `.env` 覆盖（`WP_URL`、`WP_USERNAME`、`WP_PASSWORD` …），发布时解析。



***

# 7. 其它配套说明

## 7.1 发布形态（2026-10-07 起，按此执行）



* 发布形态为**根单包&#x20;**`tengence-geo-agent`（bundle 四个 `@tengence/*` workspace 包），不再四包分开发。

* **npm 发布只走 CI**：bump（package.json + lock 顶层 version 同步）→ commit → push → `git tag vX.Y.Z` → `release.yml` 自动 test + `npm publish --provenance --access public`（secret `NPM_TOKEN`）。本机无 npm token，**禁止本地 publish**。

* **tag 版本**：v0.1.0 /v0.1.1 被旧四包发布占用，单包从 **v0.1.2** 起递增；tag 冲突就升号，**不要 force 覆盖**。

* **npm Staged Publishing**：首版新包发布后卡在 `0.0.0-stage`，需 maintainer 在 [npmjs.com](https://npmjs.com)「Staged Packages」批准（2FA，用户操作）；同包后续版本直接上线免批准。判定：registry API 出现真实版本号。

* **MCP Registry（com.tengence/geo-agent）**：npm 包上线（含 `mcpName`）+ `server.json` 就绪后，本机背靠背 `mcp-publisher login http --domain tengence.com` + `publish ./server.json`（JWT 短效）。

* 完整流程见 `docs/release.md` 与 `docs/mcp-publication-guide.md`—— 发版前先读。

## 7.2 多语言发布规范



* 文章语言统一 `zh-hans | en | zh-hant`。

* **共享头图**：一个文章的多个语言共享一张 featured image；`publishArticle` 从不按语言重复上传 ——`--featured-media <id>` 直接强制媒体 ID；否则当同一 slug 的另一语言已在 WP 发布时，复用其 `featured_media`；首语言发布时才下载上传一次。

* **同语言内链**（每个语言，含草稿 / 已发布）：站内文章链接都带文章自身语言前缀（zh-hans→`/zh-hans/`、en→`/en/`、zh-hant→`/zh-hant/`）；无裸链接、无跨语言跳转；翻译把源链接前缀改写为目标语言（slug 不变）。

* **CTA 布局**：Get Started / 立即行动 区块每条链接独占一行，禁止用 `|` 在同一行拼接。

* 翻译行经 `article-ingest.js <slug> <md> --lang en|zh-hant` 摄取（文件放 `<site>/data/inbox/<lang>/<slug>.md`，YAML front matter 按 `standards/translation-standards.md` §10）。

## 7.3 高风险 / 不可逆操作

以下是对外、单向动作，执行前必须确认（`confirm=true` / `confirm="YES"`，或用户显式确认）：



* `wechat_mass_send`（推送粉丝 —— 不可逆）

* `channel_publish` 且 `asDraft=false`（对外正式发布）

* `wechat_article_delete` / `csdn_article_delete` / `juejin_article_delete`

* `juejin_draft_delete`

* `db_init { drop: true }`（删除并重建数据库）

## 7.4 通用约定（复用 / 补充）



* **写作标准体系**：`packages/geo-sdk/standards/` 是基础（权威、品牌无关、随包版本化）；部署可加补充于 `$TENGENCE_GEO_HOME/standards/`（仅可收紧 / 实例化，不可放宽硬要求；冲突须声明 `Overrides:`）。站点内文章文件保留站点自身语言。

* **GEO 区块标题**（正文中，解析器对粗体不敏感但单词固定）：摘要 `> **Summary**`/`> **摘要**`、关键要点 `## Key Takeaways`/`## 关键要点`、FAQ `## FAQ`/`## 常见问题`、数据来源 `## Data Sources`/`## 数据来源`、相关阅读 `## Related Reading`/`## 相关阅读`、立即行动 `## Get Started`/`## 立即行动`、关于 `## About <Brand>`/`## 关于 <Brand>`。

* **作者 / 写作循环**：`workspace_use` → `site_init` → `article_draft` →（按标准写作）→ `article_ingest` → `check_article` → `publish_draft`。门禁 `check/index.js` 是 `article-writing-standards` 的固化管理器，两者须人工保持同步；代码不读文档生成检查。



***

*本文档聚合自仓库&#x20;*`docs/`*&#x20;下的分主题文档（overview /workflow/pipeline/reference/mcp-tools/reference/cli-commands/reference/environment/reference/data-model 等）。分主题文档与本文档并存；内容以代码与分主题文档为准。*