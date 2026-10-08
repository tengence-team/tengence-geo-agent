# Tengence GEO Agent — Overview

> English version. For 中文版 see [overview.zh.md](overview.zh.md).

## What it is

The **Tengence GEO Agent** (`tengence-geo-agent`) is a GEO (Generative Engine
Optimization) / SEO content production & publishing engine. It automates the whole
pipeline — from **diagnosing a site's GEO/SEO health**, to **planning keywords and a
publishing schedule**, to **drafting, gating, translating, and publishing articles**,
to **submitting for search indexing** and **measuring AI visibility** — and closes the
loop by feeding monitoring results back into planning.

It is built as a monorepo with four layers:

| Layer | Package | Role |
| --- | --- | --- |
| Capability | `@tengence/geo-sdk` | 15-domain library: site, db, plan, wp, content, images, search, publish, check, syndicate, taxonomy, llm, monitor, diagnose, util |
| CLI orchestration | `@tengence/geo-cli` | 24 single-purpose commands (`tengence-geo-*`), the canonical orchestration path |
| MCP bridge | `@tengence/geo-mcp` | 72 tools over **stdio** or **Streamable HTTP** (Bearer auth), so any MCP-capable AI client can drive the engine |
| Agent launcher | `@tengence/geo-agent` | LLM runtime loop (`HARNESS=dsh|opencode|pi`) — runs once a `DEEPSEEK_API_KEY` is set |

Dependencies flow downward only: MCP → CLI/SDK; CLI → SDK; the SDK never depends on an
upper layer. The SDK is not written for any single harness — MCP is the standard,
portable bridge.

## Interface surface

- **MCP tools: 72** — grouped by capability domain (workspace/site, diagnosis & plan,
  writing standards, articles, gates, image, article plan, WordPress publish, database,
  search submission, monitoring, cross-platform syndication, multilingual term names,
  WeChat). Full reference: [reference/mcp-tools.en.md](reference/mcp-tools.en.md).
- **CLI commands: 24** — each mirrors a domain operation. Full reference:
  [reference/cli-commands.en.md](reference/cli-commands.en.md).

## The end-to-end pipeline

```
diagnose_site → site_geo_plan_skill → (keyword matrix + article plan)
  → article_draft → write body → article_ingest
  → multilingual translation (glossary → translate → check_translation → ingest --lang)
  → image_acquire → check_article
  → publish_draft (draft) → publish_daily (scheduled live publish, plan publish_order)
  → channel_publish (wechat/juejin/csdn/devto…)
  → search submission (GSC/IndexNow/Baidu/Bing)
  → monitor_run / monitor_report → feed back into planning
```

The full step-by-step workflow with per-step tool calls is in
[workflow/pipeline.en.md](workflow/pipeline.en.md).

## Storage & data

- **Default:** single-file multi-tenant SQLite (`~/.tengence/geo-mcp/geo.sqlite`),
  auto-initialized on first use (zero-config). 18 tables (`tengence_geo_*`).
- **Optional:** MySQL (`DB_DRIVER=mysql`) — writes only `tengence_geo_*` tables,
  physically isolated from the production `tengence_omni_*`.
- **Workspace:** site config/content/plans live under a user-chosen workspace
  (`workspace_use` at runtime, or `SITES_ROOT`), never derived from the install dir.
- **Secrets:** live only in `<workspace>/<site>/.env` (gitignored).

## Installation at a glance

```bash
npm install
cp -R examples/site-template ~/tengence/sites/my-site
cd ~/tengence/sites/my-site && cp .env.example .env   # fill in credentials/tokens
```

CLI mode:

```bash
export SITES_ROOT=~/tengence/sites
tengence-geo-article-ingest hello-geo ./hello-geo.md --site my-site --research ./hello-geo.research.md
tengence-geo-check-article hello-geo --site my-site
tengence-geo-publish-draft ./hello-geo.md --site my-site            # draft
tengence-geo-promote-daily --site my-site                           # scheduled live publish
```

MCP mode (stdio):

```jsonc
{ "mcpServers": { "tengence-geo": { "command": "node", "args": ["<repo>/packages/geo-mcp/bin/geo-mcp.js"] } } }
```

HTTP mode:

```bash
GEO_MCP_PORT=8787 GEO_MCP_TOKEN=sk-xxx node packages/geo-mcp/bin/geo-mcp-http.js
```

Requirements: Node.js ≥ 22.13 (built-in `node:sqlite`), 24 LTS recommended. Optional
`better-sqlite3` for Node 20/21 or full SQLite API; optional `sharp` for image
compression/cropping.

## Multilingual model

Article languages are unified to **`zh-hans` | `en` | `zh-hant`** (legacy region codes
like `zh-cn`/`en-us` are rejected). A translated article shares **one featured image**
with its source (no re-upload). Same-language internal links and per-link CTA layout are
enforced by the translation gate and normalized on the WordPress write exit.

## See also

- End-to-end SOP: [workflow/pipeline.en.md](workflow/pipeline.en.md)
- MCP tools: [reference/mcp-tools.en.md](reference/mcp-tools.en.md)
- CLI commands: [reference/cli-commands.en.md](reference/cli-commands.en.md)
- Environment: [reference/environment.en.md](reference/environment.en.md)
- Data model: [reference/data-model.en.md](reference/data-model.en.md)
