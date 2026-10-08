# Tengence GEO Agent — 产品概览

> 中文版。英文版见 [overview.en.md](overview.en.md)。

## 这是什么

**Tengence GEO Agent**（`tengence-geo-agent`）是一个 GEO（生成式引擎优化）/ SEO 内容生产与发布引擎。它自动化整条流水线——从**诊断站点的 GEO/SEO 健康状况**、**规划关键词与发布排期**、到**起草、门禁、翻译、发布文章**、再到**提交搜索引擎收录**与**测量 AI 可见性**——并把监测结果反馈回规划，形成闭环。

它采用 monorepo 四层结构：

| 层次 | 包 | 作用 |
| --- | --- | --- |
| 能力层 | `@tengence/geo-sdk` | 15 个领域库：site、db、plan、wp、content、images、search、publish、check、syndicate、taxonomy、llm、monitor、diagnose、util |
| CLI 编排层 | `@tengence/geo-cli` | 24 条单用途命令（`tengence-geo-*`），是规范化的编排入口 |
| MCP 桥接层 | `@tengence/geo-mcp` | 72 个工具，支持 **stdio** 或 **Streamable HTTP**（Bearer 鉴权），任意 MCP 客户端都能驱动引擎 |
| Agent 启动器 | `@tengence/geo-agent` | LLM 运行时循环（`HARNESS=dsh|opencode|pi`）——设置 `DEEPSEEK_API_KEY` 即可运行 |

依赖只向下流动：MCP → CLI/SDK；CLI → SDK；SDK 从不依赖上层。SDK 不是为某一特定 harness 编写的——MCP 是标准、可移植的桥接。

## 接口面

- **MCP 工具：72 个** —— 按能力域分组（workspace/站点、诊断与方案、写作标准、文章、门禁、图片、文章计划、WordPress 发布、数据库、收录提交、监测、跨平台分发、多语言术语名、微信）。完整参考见 [reference/mcp-tools.zh.md](reference/mcp-tools.zh.md)。
- **CLI 命令：24 条** —— 每条对应一个领域操作。完整参考见 [reference/cli-commands.zh.md](reference/cli-commands.zh.md)。

## 端到端流水线

```
diagnose_site → site_geo_plan_skill → (关键词矩阵 + 文章计划)
  → article_draft → 撰写正文 → article_ingest
  → 多语言翻译（术语表 → 翻译 → check_translation → ingest --lang）
  → image_acquire → check_article
  → publish_draft（草稿）→ publish_daily（按 plan publish_order 定时正式发布）
  → channel_publish（微信/掘金/CSDN/Dev.to…）
  → 收录提交（GSC/IndexNow/百度/Bing）
  → monitor_run / monitor_report → 反馈回规划
```

每一步的详细调用与参数见 [workflow/pipeline.zh.md](workflow/pipeline.zh.md)。

## 存储与数据

- **默认**：单文件多租户 SQLite（`~/.tengence/geo-mcp/geo.sqlite`），首次使用自动初始化（零配置）。共 18 张表（`tengence_geo_*`）。
- **可选**：MySQL（`DB_DRIVER=mysql`）——只写 `tengence_geo_*` 表，与生产 `tengence_omni_*` 物理隔离。
- **工作区**：站点的配置/内容/计划放在用户选择的工作区（运行时 `workspace_use`，或 `SITES_ROOT`），从不从安装目录推导。
- **密钥**：只存在于 `<workspace>/<site>/.env`（已 gitignore）。

## 安装速览

```bash
npm install
cp -R examples/site-template ~/tengence/sites/my-site
cd ~/tengence/sites/my-site && cp .env.example .env   # 填入凭据/令牌
```

CLI 模式：

```bash
export SITES_ROOT=~/tengence/sites
tengence-geo-article-ingest hello-geo ./hello-geo.md --site my-site --research ./hello-geo.research.md
tengence-geo-check-article hello-geo --site my-site
tengence-geo-publish-draft ./hello-geo.md --site my-site            # 草稿
tengence-geo-promote-daily --site my-site                           # 定时正式发布
```

MCP 模式（stdio）：

```jsonc
{ "mcpServers": { "tengence-geo": { "command": "node", "args": ["<repo>/packages/geo-mcp/bin/geo-mcp.js"] } } }
```

HTTP 模式：

```bash
GEO_MCP_PORT=8787 GEO_MCP_TOKEN=sk-xxx node packages/geo-mcp/bin/geo-mcp-http.js
```

环境要求：Node.js ≥ 22.13（内置 `node:sqlite`），推荐 24 LTS。可选 `better-sqlite3`（Node 20/21 或需要完整 SQLite API）；可选 `sharp`（图片压缩/裁剪）。

## 多语言模型

文章语言统一为 **`zh-hans` | `en` | `zh-hant`**（旧区域码如 `zh-cn`/`en-us` 会被拒绝）。翻译文章与其源文章**共享同一张头图**（不重复上传）。同语言内链、每条链接独立的 CTA 布局由翻译门禁强制，并在 WordPress 写回时自动归一化。

## 参见

- 端到端 SOP：[workflow/pipeline.zh.md](workflow/pipeline.zh.md)
- MCP 工具：[reference/mcp-tools.zh.md](reference/mcp-tools.zh.md)
- CLI 命令：[reference/cli-commands.zh.md](reference/cli-commands.zh.md)
- 环境变量：[reference/environment.zh.md](reference/environment.zh.md)
- 数据模型：[reference/data-model.zh.md](reference/data-model.zh.md)
