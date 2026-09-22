# Tengence GEO Agent Architecture

> This document is the single source of truth for the repository architecture.
> Finalized 2026-09-21 after extraction/refactor from the legacy business scripts.

## 1. Positioning & design principles

The company's existing GEO content production/publishing scripts (WordPress publishing
pipeline, SEO/GEO gates, search submission, GEO monitoring, auto image acquisition,
multi-site planning) are extracted from the business repository into an **independently
open-sourcable content engine that AI can call**.

Layering principles:

1. **Tool layer decoupled from orchestration layer**: `@tengence/geo-sdk` (capability) →
   `@tengence/geo-cli` (CLI orchestration) → `@tengence/geo-mcp` (MCP bridge) →
   `apps/agent` (LLM runtime loop).
2. **MCP is the standard bridge, not bound to any harness**: the SDK is not written as a
   plugin for one specific harness but exposed via MCP, over stdio or Streamable HTTP;
   any MCP-capable client integrates the same way and nothing in the packages, configs or
   comments references a particular one.
3. **Dual-driver storage, production DB untouched**: default single-file multi-tenant
   SQLite (auto-initialized); with `DB_DRIVER=mysql` it connects directly to the business
   MySQL (tables `tengence_geo_*`, physically isolated from production `tengence_omni_*`).
4. **Site directories are runtime data chosen by the user**: site config/content/plans live
   under `<user workspace>/<site>/`, independent of where the package is installed. The
   workspace is provided at runtime (`workspace_use` or `SITES_ROOT`), never derived from
   the process working directory. Server-internal data (DB/state/logs) is separate and fixed:
   `~/.tengence/geo-mcp/`.

## 2. Repository structure

```
tengence-geo-agent/
├── packages/
│   ├── geo-sdk/          # capability layer (15 domains, single require entry index.js, lazy-loaded)
│   ├── geo-cli/          # CLI orchestration layer (21 bins, tengence-geo-*)
│   └── geo-mcp/          # MCP bridge layer (22 tools, stdio + Streamable HTTP dual transport)
├── apps/
│   └── agent/            # runtime-loop launcher (HARNESS=dsh|opencode|pi, runs with an API key)
├── examples/
│   └── site-template/    # site template (copy to SITES_ROOT/<site>/ to use)
├── docs/                 # architecture / getting-started / mcp-platforms / release
├── scripts/check-workspaces.js   # consistency check for `npm run build`
├── tests/                # node:test full regression (116 tests, all green on SQLite)
└── dev/                  # dev baselines (sdk-smoke / sdk-probe / sdk-snapshot …)
```

## 3. Layering & call relationships

```
AI clients (any MCP-capable harness)
        │  MCP (stdio or Streamable HTTP + Bearer)
        ▼
  @tengence/geo-mcp   22 tools: site/article/check/publish/plan/image/monitor/db/search/util
        │  calls domain APIs directly; delegates orchestration ops to geo-cli (canonical behavior)
        ▼
  @tengence/geo-cli   21 tengence-geo-* commands (ingest / gate / publish / images / submission / monitor…)
        ▼
  @tengence/geo-sdk   15 domains: site/db/plan/wp/content/images/search/publish/check/
                      syndicate/taxonomy/llm/monitor/util/cli
        │  dispatched by DB_DRIVER
        ▼
  SQLite (~/.tengence/geo-mcp/geo.sqlite, auto-initialized)  or  MySQL (tengence_geo_*)
```

Dependencies only flow downward: MCP → CLI/SDK, CLI → SDK; the SDK never depends on an upper layer.

## 4. Data model & multi-tenancy

- **Table names**: all `tengence_geo_*` (16 tables: articles / article_plan / article_images /
  categories / tags / article_categories / article_tags / seo / geo / qa_pairs / citations /
  geo_monitor_results / geo_monitor_answers / images / social / vectors). They correspond
  one-to-one with the legacy business `tengence_omni_*` tables for easy future migration.
- **Multi-tenancy**: business tables carry an `app_id` column; all repository queries filter
  by `app_id`. `app_id` resolution: env var `APP_ID` > site `.env` `APP_ID` > default 1.
- **Single-file SQLite**: all app_ids share one file at the default path
  `~/.tengence/geo-mcp/geo.sqlite` (overridable via `DB_PATH`); no per-site/per-tenant files. The
  structure stays consistent with MySQL (fields/indexes aligned column by column, see
  `packages/geo-sdk/db/sqlite-schema.js`).
- **Dialect translation**: `db/sqlite.js` provides a mysql2-compatible facade (query returns
  `[rows, fields]`, insertId, transaction API) plus an allow-list SQL dialect translator
  (NOW()/GROUP_CONCAT/SUBSTRING_INDEX/JSON_CONTAINS/IFNULL…). MySQL-only functions outside
  the allow-list **fail fast** instead of silently producing wrong results.

## 5. Initialization model (important)

Normal MCP/CLI usage has **no separate init step**:

- **Lazy auto-initialization**: when SQLite is first touched via `db.withConn`, it
  automatically creates the file → runs the 16-table DDL → writes `PRAGMA user_version`
  (idempotent; later migrations run incrementally by version).
- **Explicit entry (optional)**: use `tengence-geo-db-init` (CLI) or `db_init` (MCP tool)
  when you need to create, diagnose, or rebuild the database.
- **MySQL**: same behavior as before — `db_init` runs the DDL plus idempotent
  INFORMATION_SCHEMA column backfills.

## 6. Why MCP bridging instead of a DSH plugin

| Dimension | MCP bridge | Direct DSH plugin |
| --- | --- | --- |
| Client compatibility | any MCP client (stdio or HTTP) | DSH only |
| Tool-layer coupling | SDK/CLI independent of the runtime loop, unit-testable | coupled to harness lifecycle |
| Reuse | one implementation serves the CLI and all AI clients | duplicated implementation |
| Evolution | switching harnesses needs no business-layer change | harness upgrades mean refactors |

`apps/agent` owns the "runtime loop" (LLM decision + tool-call loop), while `geo-mcp` owns
the "tools". This separation of responsibilities is the standard boundary between an agent
product (e.g. DSH) and a tool product (e.g. an MCP server).

## 7. Pluggable harnesses

`HARNESS=dsh|opencode|pi` is dispatched by `apps/agent/launcher.js`; the `presets` directory
holds one integration config per harness (model = deepseek-chat, MCP pointing at
`npx -y @tengence/geo-mcp`). Setting `DEEPSEEK_API_KEY` is enough to start; when the harness
binary is missing, installation guidance is printed instead of silently degrading.

## 8. Security & data boundaries

- Secrets (WP app passwords / submission tokens / image-library keys / DB passwords) exist
  only in `SITES_ROOT/<site>/.env` (gitignored); the repo ships only the `.env.example`
  template; the MCP HTTP transport requires `GEO_MCP_TOKEN` (Bearer).
- The production MySQL (`tengence_omni_*`) is never touched by any write logic in this repo;
  migrations go through explicit export/import, executed only after confirmation.
