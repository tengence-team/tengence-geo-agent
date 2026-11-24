/**
 * SQLite table DDL (field-isomorphic with the MySQL schema.js)
 * ============================================================================
 * Goal: the table structure inside the SQLite file = the MySQL production structure
 * (column names / column semantics / unique keys identical); only the SQLite dialect
 * differs:
 *   - BIGINT/INT/TINYINT UNSIGNED → INTEGER; VARCHAR/CHAR/TEXT/LONGTEXT → TEXT;
 *     JSON → TEXT; DECIMAL → NUMERIC; DATE/DATETIME/TIMESTAMP → TEXT.
 *   - TIMESTAMP defaults use strftime for local time (same semantics as MySQL NOW()).
 *   - ENUM → TEXT (no CHECK constraint; semantic validation stays in the app layer).
 *   - Indexes are split into standalone CREATE INDEX statements; MySQL functional
 *     indexes (CAST AS CHAR ARRAY) are not migrated.
 *   - Multi-tenant: every table carries an app_id column; business unique keys all
 *     include app_id (the single-file multi-tenant isolation basis).
 *
 * The single source of truth for table names = the TABLES constants in db/schema.js
 * (PREFIX='tengence_geo_').
 * Versioning: PRAGMA user_version (see db/sqlite.js ensureSchema).
 *
 * channel_plan note: this table is WORKSPACE-LOCAL state (publishing calendar per
 * external platform), not part of the MySQL production schema — it lives only in
 * the SQLite file and is therefore defined here (not in schema.js).
 * ============================================================================
 */

const { TABLES } = require('./schema');

/** Workspace-local channel publishing calendar (not in the MySQL schema). */
const CHANNEL_PLAN = 'tengence_geo_channel_plan';

/**
 * Workspace-local dictionary of an EXTERNAL platform's own taxonomy (category /
 * tag id + name), e.g. Juejin's 8 categories and ~725 tags. Platform-scoped, NOT
 * site-scoped: every site that publishes to the platform shares one copy, so no
 * site needs its own taxonomy config file (portability).
 */
const CHANNEL_TAXONOMY = 'tengence_geo_channel_taxonomy';

/**
 * Workspace-local SCHEDULING-RULE table (channel_schedule): when each platform
 * should auto-publish and how many articles per slot. ONE ROW = ONE
 * (platform, publish_time) slot — it is a TEMPLATE, not a task instance, so it
 * deliberately carries NO slug (the unified executor picks nextDue's N articles
 * at fire time). Distinct from channel_plan (one row = one (platform, slug, lang)
 * publish TASK): channel_plan's unique key requires a slug and cannot host
 * schedule rules.
 */
const CHANNEL_SCHEDULE = 'tengence_geo_channel_schedule';

/**
 * Workspace-local durable state for the geo-mcp MCP Tasks extension
 * (tengence_geo_mcp_tasks): one row = one long-running tool task handle.
 * Not part of the MySQL production schema — lives only in the SQLite file,
 * same as channel_plan / channel_taxonomy / channel_schedule.
 */
const MCP_TASKS = 'tengence_geo_mcp_tasks';

// NOTE: v4 (not v3) — some local DBs were already stamped 3 by a transient earlier
// bump that was rolled back while the committed value stayed 2. The version stamp is
// only used as a monotonic "DDL already applied" marker (the DDL itself is idempotent,
// IF NOT EXISTS), so jumping to 4 guarantees the channel_taxonomy table is created
// everywhere regardless of which of {2,3} a given DB is currently at.
//
// v6 was skipped: the intermediate "slug_key (JSON slug set)" design was replaced by
// the v7 design (single-article rows + lang) before anything was shipped.
//
// v7 (2026-10-11): channel_plan rows became ONE ROW = ONE (platform, slug, lang)
// publish task; unique key moved from (app_id, platform, period) to
// (app_id, platform, slug, lang). Existing v5 databases are migrated by the
// one-off script scripts/migrate-channel-plan-v7.js (NOT by ensureSchema —
// ensureSchema only stamps the version and applies IF NOT EXISTS DDL for new DBs).
//
// v8 (2026-10-11): new table tengence_geo_channel_schedule — pure ADDITIVE DDL
// (no data migration needed; ensureSchema applies the IF NOT EXISTS table).
// The scheduling rules table for the unified auto-publish executor
// (channel_publish_due): one row = one (platform, publish_time) slot.
//
// v9 (2026-10-13): new table tengence_geo_mcp_tasks — pure ADDITIVE DDL
// (no data migration needed; ensureSchema applies the IF NOT EXISTS table).
// Workspace-local durable state for the geo-mcp MCP Tasks extension (long-running
// tools publish_daily / monitor_run / diagnose_site / channel_publish_due):
// one row = one task handle (app_id multi-tenant, official Task status vocabulary).
//
// v10 (2026-10-18): channel_plan gains 5 error columns — error_code / error_message /
// error_stage / error_detail(JSON) / failed_at — so a failed multi-platform dispatch
// records the real platform rejection (e.g. Juejin err_no/err_msg) instead of a generic
// "publishToChannel returned not-ok". Pure ADDITIVE (5 nullable TEXT columns); the
// existing DBs get them via ensureColumnType (idempotent ALTER) and fresh DBs via the
// DDL above.
// v11 (2026-11-13): publish_order gets a partial UNIQUE index (one article = one
// position in the history order) and the dead `article_images.status` column is gone.
// The index is created by a one-off script for existing DBs (the table already has
// data that must be normalised first); fresh DBs get it from the DDL above.
// v12 (2026-11-24): the 6 legacy content tables (seo/geo/qa_pairs/citations/social/vectors)
// and the category/tag association tables (article_categories/article_tags) are gone
// (0 rows, never written after 2026-09-20, never read). Existing DBs had them DROPPed
// by a one-off operation (scripts/drop-legacy-metadata-tables-2026-11-24.js); fresh DBs
// never create them because the DDL below no longer contains them.
const SCHEMA_VERSION = 12;

/**
 * publish_order is the history order every channel queue derives from, so the
 * database itself refuses to hold two articles at the same position.
 * Scoped to zh-hans (the primary language owns the number; the other language rows
 * follow it) and to publish_order > 0 (0 means "not assigned yet").
 */
const PLAN_ORDER_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_sqlite_plan_order
  ON ${TABLES.articlePlan} (app_id, publish_order)
  WHERE lang = 'zh-hans' AND publish_order > 0;`;

/**
 * channel_plan v7 DDL template (workspace-local publishing TASK table).
 *
 * One row = one (platform, slug, lang) publish task/log entry:
 *   - wechat: one issue (一期) = N rows sharing the same `period` ("第N期");
 *     in-issue headline order = row id order (insertion order of the slugs).
 *   - single-article channels (juejin / csdn / aliyun / tencent / devto …): one
 *     row per article language; `period` keeps historical values only (v5 legacy),
 *     new rows leave it NULL — period is NEVER derived from publish_order anymore
 *     (that was the root cause of the v5 unique-key collisions).
 * Unique key = (app_id, platform, slug, lang) — the dedup semantics live in
 * publishedSlugs()/filterUnpublished() (per slug+lang); the unique key is the DB
 * backstop and is order/format independent (plain text columns, no JSON).
 */
function channelPlanDDL(tableName) {
  return `
CREATE TABLE IF NOT EXISTS ${tableName} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL DEFAULT 1,
  platform TEXT NOT NULL,
  slug TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'zh-hans',
  period TEXT,
  topic TEXT,
  weekday TEXT,
  status TEXT DEFAULT 'todo',
  draft_ids TEXT,
  article_id TEXT,
  notes TEXT,
  error_code TEXT,
  error_message TEXT,
  error_stage TEXT,
  error_detail TEXT,
  failed_at TEXT,
  schedule_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  UNIQUE (app_id, platform, slug, lang)
);`;
}

/**
 * channel_schedule DDL template (workspace-local SCHEDULING-RULE table).
 *
 * One row = one (platform, publish_time) auto-publish slot:
 *   - count    how many articles one fire takes (wechat: one issue = N rows of
 *              channel_plan sharing one period; count=2 → next 2 un-dispatched)
 *   - enabled  0 = paused slot (kept in config, not fired)
 *   - last_run_at  local "YYYY-MM-DD HH:MM:SS" of the last fire — the executor
 *              never fires the same slot twice on the same day (defense #1; the
 *              channel_plan unique key is defense #2, a process lock #3).
 * Unique key = (app_id, platform, publish_time) — one slot per channel per time.
 */
function channelScheduleDDL(tableName) {
  return `
CREATE TABLE IF NOT EXISTS ${tableName} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL DEFAULT 1,
  platform TEXT NOT NULL,
  publish_time TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  UNIQUE (app_id, platform, publish_time)
);`;
}

/**
 * mcp_tasks DDL template (workspace-local geo-mcp MCP Tasks durable state).
 *
 * One row = one long-running tool task handle (official Task vocabulary):
 *   - task_id           durable handle (uuid) — survives client/server restarts
 *   - status            working|input_required|completed|failed|cancelled
 *   - ttl_ms            durable lifetime; poll_interval_ms suggested poll cadence
 *   - progress          JSON progress snapshot (official statusMessage/progress)
 *   - input_requests    JSON map of outstanding inputRequests (reserved, empty initially)
 *   - result / error    JSON terminal output (completed) / error (failed)
 *   - expires_at        TTL expiry, swept by the task manager
 * Unique key = (app_id, task_id) — multi-tenant durable handle.
 */
function mcpTasksDDL(tableName) {
  return `
CREATE TABLE IF NOT EXISTS ${tableName} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL DEFAULT 1,
  task_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'working',
  ttl_ms INTEGER,
  poll_interval_ms INTEGER,
  progress TEXT,
  input_requests TEXT,
  result TEXT,
  error TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  expires_at TEXT,
  UNIQUE (app_id, task_id)
);`;
}

const createSqliteTablesSQL = `
-- ========== 1. articles main table ==========
CREATE TABLE IF NOT EXISTS ${TABLES.articles} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL DEFAULT 1,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  content_path TEXT,
  content_longtext TEXT,
  content_html TEXT,
  research_md TEXT,
  excerpt TEXT,
  featured_image TEXT,
  seo TEXT,
  geo TEXT,
  description TEXT,
  target_keywords TEXT,
  long_tail_keywords TEXT,
  target_audience TEXT,
  difficulty_level TEXT DEFAULT 'intermediate',
  estimated_reading_time INTEGER DEFAULT 5,
  target_word_count INTEGER DEFAULT 1800,
  lang TEXT DEFAULT 'en',
  translation_group TEXT,
  region_market TEXT DEFAULT 'cn',
  region_currency TEXT DEFAULT 'CNY',
  region_compliance TEXT,
  status TEXT DEFAULT 'draft',
  version TEXT DEFAULT '1.0.0',
  reviewer TEXT,
  review_date TEXT,
  date TEXT,
  lastmod TEXT,
  published_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  author TEXT,
  author_id INTEGER DEFAULT 1,
  wp_post_id INTEGER,
  wp_post_type TEXT DEFAULT 'post',
  wp_post_format TEXT DEFAULT 'standard',
  UNIQUE (app_id, slug, lang)
);
CREATE INDEX IF NOT EXISTS idx_sqlite_articles_app ON ${TABLES.articles} (app_id);
CREATE INDEX IF NOT EXISTS idx_sqlite_articles_status ON ${TABLES.articles} (app_id, status);
CREATE INDEX IF NOT EXISTS idx_sqlite_articles_lang ON ${TABLES.articles} (app_id, lang);
CREATE INDEX IF NOT EXISTS idx_sqlite_articles_region ON ${TABLES.articles} (app_id, region_market);
CREATE INDEX IF NOT EXISTS idx_sqlite_articles_published ON ${TABLES.articles} (app_id, published_at);
CREATE INDEX IF NOT EXISTS idx_sqlite_articles_wp ON ${TABLES.articles} (wp_post_id);

-- ========== 2. categories table ==========
CREATE TABLE IF NOT EXISTS ${TABLES.categories} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  parent_id INTEGER,
  description TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  UNIQUE (app_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_sqlite_categories_app ON ${TABLES.categories} (app_id);
CREATE INDEX IF NOT EXISTS idx_sqlite_categories_parent ON ${TABLES.categories} (app_id, parent_id);

-- ========== 3. tags table ==========
CREATE TABLE IF NOT EXISTS ${TABLES.tags} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  UNIQUE (app_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_sqlite_tags_app ON ${TABLES.tags} (app_id);

-- ========== 12. image library ==========
CREATE TABLE IF NOT EXISTS ${TABLES.images} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL DEFAULT 1,
  original_url TEXT NOT NULL,
  source_platform TEXT NOT NULL DEFAULT 'unsplash',
  wp_media_id INTEGER,
  image_hash TEXT,
  width INTEGER,
  height INTEGER,
  aspect_ratio NUMERIC,
  file_size INTEGER,
  quality_score NUMERIC DEFAULT 0.80,
  aesthetic_score NUMERIC,
  qdrant_id INTEGER,
  embedding_dimension INTEGER DEFAULT 384,
  usage_count INTEGER DEFAULT 0,
  last_used_at TEXT,
  alt_text TEXT,
  caption TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at TEXT,
  UNIQUE (app_id, original_url)
);
CREATE INDEX IF NOT EXISTS idx_sqlite_images_platform ON ${TABLES.images} (app_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_sqlite_images_usage ON ${TABLES.images} (app_id, usage_count);
CREATE INDEX IF NOT EXISTS idx_sqlite_images_hash ON ${TABLES.images} (app_id, image_hash);
CREATE INDEX IF NOT EXISTS idx_sqlite_images_qdrant ON ${TABLES.images} (app_id, qdrant_id);

-- ========== 13. article image table ==========
CREATE TABLE IF NOT EXISTS ${TABLES.articleImages} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL DEFAULT 1,
  article_id INTEGER NOT NULL,
  image_id INTEGER,
  \`position\` TEXT DEFAULT 'content',
  display_order INTEGER DEFAULT 0,
  image_type TEXT DEFAULT 'content',
  original_url TEXT,
  local_path TEXT,
  local_url TEXT,
  insert_position TEXT,
  position_order INTEGER DEFAULT 0,
  caption TEXT,
  alt_text TEXT,
  width INTEGER,
  height INTEGER,
  file_size INTEGER,
  \`format\` TEXT,
  quality_score NUMERIC,
  relevance_score NUMERIC,
  aesthetic_score NUMERIC,
  ai_description TEXT,
  ai_tags TEXT,
  ai_suggestions TEXT,
  download_attempt INTEGER DEFAULT 0,
  config_keywords TEXT,
  prompt TEXT,
  source TEXT DEFAULT 'url',
  source_reference TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  FOREIGN KEY (article_id) REFERENCES ${TABLES.articles} (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sqlite_aimg_article ON ${TABLES.articleImages} (app_id, article_id);
CREATE INDEX IF NOT EXISTS idx_sqlite_aimg_type ON ${TABLES.articleImages} (app_id, image_type);
CREATE INDEX IF NOT EXISTS idx_sqlite_aimg_position ON ${TABLES.articleImages} (app_id, article_id, position_order);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sqlite_aimg_link ON ${TABLES.articleImages} (app_id, article_id, image_id, \`position\`);

-- ========== 14. GEO monitor - raw answers ==========
CREATE TABLE IF NOT EXISTS ${TABLES.geoMonitorAnswers} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL DEFAULT 1,
  run_id TEXT NOT NULL,
  model TEXT NOT NULL,
  model_version TEXT,
  prompt_id TEXT NOT NULL,
  layer TEXT NOT NULL,
  variant INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  question TEXT NOT NULL,
  answer_text TEXT NOT NULL,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  UNIQUE (app_id, run_id, model, prompt_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_sqlite_gma_run ON ${TABLES.geoMonitorAnswers} (app_id, run_id, model);
CREATE INDEX IF NOT EXISTS idx_sqlite_gma_prompt ON ${TABLES.geoMonitorAnswers} (app_id, prompt_id);

-- ========== 15. GEO monitor - extraction & scoring ==========
CREATE TABLE IF NOT EXISTS ${TABLES.geoMonitorResults} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL DEFAULT 1,
  run_id TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  layer TEXT NOT NULL,
  mentioned INTEGER NOT NULL DEFAULT 0,
  entity_match TEXT NOT NULL DEFAULT 'none',
  mention_type INTEGER NOT NULL DEFAULT 0,
  \`position\` INTEGER NOT NULL DEFAULT 0,
  sentiment TEXT NOT NULL DEFAULT 'neutral',
  cited_tengence INTEGER NOT NULL DEFAULT 0,
  cited_any INTEGER NOT NULL DEFAULT 0,
  accuracy TEXT NOT NULL DEFAULT 'basic',
  score INTEGER NOT NULL DEFAULT 0,
  competitors TEXT,
  flags TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  UNIQUE (app_id, run_id, model, prompt_id)
);
CREATE INDEX IF NOT EXISTS idx_sqlite_gmr_run ON ${TABLES.geoMonitorResults} (app_id, run_id);
CREATE INDEX IF NOT EXISTS idx_sqlite_gmr_layer ON ${TABLES.geoMonitorResults} (app_id, layer);
CREATE INDEX IF NOT EXISTS idx_sqlite_gmr_flag ON ${TABLES.geoMonitorResults} (app_id, accuracy);

-- ========== 16. article plan table ==========
CREATE TABLE IF NOT EXISTS ${TABLES.articlePlan} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL DEFAULT 1,
  slug TEXT NOT NULL,
  node_type TEXT NOT NULL DEFAULT 'spoke',
  hub_cluster TEXT,
  matrix_code TEXT,
  title TEXT,
  focus_keyword TEXT,
  keyword_volume INTEGER,
  keyword_competition TEXT,
  search_intent TEXT,
  content_type TEXT,
  target_word_count INTEGER,
  publish_batch INTEGER,
  publish_order INTEGER DEFAULT 0,
  category TEXT,
  tags TEXT,
  lang TEXT NOT NULL DEFAULT 'en',
  languages TEXT,
  article_id INTEGER,
  wp_post_id INTEGER,
  published_url TEXT,
  plan_status TEXT NOT NULL DEFAULT 'todo',
  queued_at TEXT,
  published_at TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  UNIQUE (app_id, slug, lang)
);
CREATE INDEX IF NOT EXISTS idx_sqlite_plan_status ON ${TABLES.articlePlan} (app_id, plan_status, publish_order);
CREATE INDEX IF NOT EXISTS idx_sqlite_plan_node ON ${TABLES.articlePlan} (app_id, node_type);
CREATE INDEX IF NOT EXISTS idx_sqlite_plan_cluster ON ${TABLES.articlePlan} (app_id, hub_cluster);
CREATE INDEX IF NOT EXISTS idx_sqlite_plan_article ON ${TABLES.articlePlan} (app_id, article_id);
CREATE INDEX IF NOT EXISTS idx_sqlite_plan_wp ON ${TABLES.articlePlan} (app_id, wp_post_id);
CREATE INDEX IF NOT EXISTS idx_sqlite_plan_published ON ${TABLES.articlePlan} (app_id, published_at);
CREATE INDEX IF NOT EXISTS idx_sqlite_plan_queued ON ${TABLES.articlePlan} (app_id, queued_at);
CREATE INDEX IF NOT EXISTS idx_sqlite_plan_category ON ${TABLES.articlePlan} (app_id, category);
CREATE INDEX IF NOT EXISTS idx_sqlite_plan_slug ON ${TABLES.articlePlan} (slug);
CREATE INDEX IF NOT EXISTS idx_sqlite_plan_batch ON ${TABLES.articlePlan} (app_id, publish_batch);
-- publish_order unique index is created SEPARATELY (PLAN_ORDER_INDEX_SQL) because a
-- legacy DB still holds duplicate / text orders: a failure there must not abort
-- startup, it must tell the operator to run
-- scripts/migrate-plan-order-unique-2026-11-13.js (S9 2026-11-13).

-- ========== 17. channel publishing tasks (workspace-local, not in MySQL) ==========
${channelPlanDDL(CHANNEL_PLAN)}
CREATE INDEX IF NOT EXISTS idx_sqlite_channel_plan_app ON ${CHANNEL_PLAN} (app_id);
CREATE INDEX IF NOT EXISTS idx_sqlite_channel_plan_status ON ${CHANNEL_PLAN} (app_id, platform, status);

-- ========== 18. external-platform taxonomy dictionary (workspace-local, not in MySQL) ==========
-- One row per platform category/tag. platform-scoped (shared by every site).
-- Index rationale (verified with EXPLAIN QUERY PLAN against better-sqlite3, the
-- driver this project actually uses):
--   * UNIQUE (app_id, platform, kind, external_id) — the sync upsert key + direct
--     lookup by platform id.
--   * idx_channel_taxonomy_name — composite with name LAST so the leading equality
--     columns pin a tight range. With COLLATE NOCASE it serves all three lookup
--     shapes:
--       exact     name = ?         COLLATE NOCASE → SEARCH ... AND name=?
--       prefix    name LIKE ?      ('kw%')       → SEARCH ... AND name>? AND name<?
--       ordering  ORDER BY name    COLLATE NOCASE → reuses the index (no temp b-tree)
--     A plain (BINARY) index does NOT accelerate a prefix LIKE: SQLite's LIKE
--     optimization only applies when the index collation is NOCASE (while the
--     default case_sensitive_like is OFF). Infix LIKE '%kw%' cannot use ANY index
--     — that matching runs in the application layer over the small dictionary.
CREATE TABLE IF NOT EXISTS ${CHANNEL_TAXONOMY} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL DEFAULT 1,
  platform TEXT NOT NULL,
  kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id TEXT,
  extra TEXT,
  synced_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  UNIQUE (app_id, platform, kind, external_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_taxonomy_name ON ${CHANNEL_TAXONOMY} (app_id, platform, kind, name COLLATE NOCASE);
-- NOTE: no separate (app_id, platform, kind) index — it is a redundant prefix of
-- idx_channel_taxonomy_name (extra write cost, zero read benefit).

-- ========== 19. channel publish scheduling rules (workspace-local, not in MySQL) ==========
${channelScheduleDDL(CHANNEL_SCHEDULE)}
CREATE INDEX IF NOT EXISTS idx_channel_schedule_app ON ${CHANNEL_SCHEDULE} (app_id);
CREATE INDEX IF NOT EXISTS idx_channel_schedule_platform ON ${CHANNEL_SCHEDULE} (app_id, platform, enabled);

-- ========== 20. geo-mcp long-running task state (workspace-local, MCP Tasks) ==========
${mcpTasksDDL(MCP_TASKS)}
CREATE INDEX IF NOT EXISTS idx_sqlite_mcp_tasks_app ON ${MCP_TASKS} (app_id);
CREATE INDEX IF NOT EXISTS idx_sqlite_mcp_tasks_status ON ${MCP_TASKS} (app_id, status);
CREATE INDEX IF NOT EXISTS idx_sqlite_mcp_tasks_updated ON ${MCP_TASKS} (app_id, updated_at);
`;

module.exports = { SCHEMA_VERSION, PLAN_ORDER_INDEX_SQL, createSqliteTablesSQL, CHANNEL_PLAN, CHANNEL_TAXONOMY, CHANNEL_SCHEDULE, MCP_TASKS, channelPlanDDL, channelScheduleDDL, mcpTasksDDL };
