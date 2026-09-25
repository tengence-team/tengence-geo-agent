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

// NOTE: v4 (not v3) — some local DBs were already stamped 3 by a transient earlier
// bump that was rolled back while the committed value stayed 2. The version stamp is
// only used as a monotonic "DDL already applied" marker (the DDL itself is idempotent,
// IF NOT EXISTS), so jumping to 4 guarantees the channel_taxonomy table is created
// everywhere regardless of which of {2,3} a given DB is currently at.
const SCHEMA_VERSION = 4;

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
  lang TEXT DEFAULT 'zh-CN',
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

-- ========== 4. article-category link table ==========
CREATE TABLE IF NOT EXISTS ${TABLES.articleCategories} (
  article_id INTEGER NOT NULL,
  app_id INTEGER NOT NULL DEFAULT 1,
  category_id INTEGER NOT NULL,
  position INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  PRIMARY KEY (article_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_sqlite_ac_app ON ${TABLES.articleCategories} (app_id);
CREATE INDEX IF NOT EXISTS idx_sqlite_ac_category ON ${TABLES.articleCategories} (app_id, category_id);

-- ========== 5. article-tag link table ==========
CREATE TABLE IF NOT EXISTS ${TABLES.articleTags} (
  article_id INTEGER NOT NULL,
  app_id INTEGER NOT NULL DEFAULT 1,
  tag_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  PRIMARY KEY (article_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_sqlite_at_app ON ${TABLES.articleTags} (app_id);
CREATE INDEX IF NOT EXISTS idx_sqlite_at_tag ON ${TABLES.articleTags} (app_id, tag_id);

-- ========== 6. SEO metadata table ==========
CREATE TABLE IF NOT EXISTS ${TABLES.seo} (
  article_id INTEGER NOT NULL,
  app_id INTEGER NOT NULL DEFAULT 1,
  title TEXT,
  meta_description TEXT,
  keywords TEXT,
  canonical_url TEXT,
  focus_keyword TEXT,
  og_type TEXT DEFAULT 'article',
  og_image TEXT,
  og_title TEXT,
  og_description TEXT,
  og_locale TEXT,
  PRIMARY KEY (article_id)
);
CREATE INDEX IF NOT EXISTS idx_sqlite_seo_app ON ${TABLES.seo} (app_id);

-- ========== 7. GEO metadata table ==========
CREATE TABLE IF NOT EXISTS ${TABLES.geo} (
  article_id INTEGER NOT NULL,
  app_id INTEGER NOT NULL DEFAULT 1,
  ai_summary TEXT,
  key_takeaways TEXT,
  call_to_action TEXT,
  content_structure TEXT,
  PRIMARY KEY (article_id)
);
CREATE INDEX IF NOT EXISTS idx_sqlite_geo_app ON ${TABLES.geo} (app_id);

-- ========== 8. GEO Q&A pairs table ==========
CREATE TABLE IF NOT EXISTS ${TABLES.qaPairs} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  app_id INTEGER NOT NULL DEFAULT 1,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  position INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sqlite_qa_article ON ${TABLES.qaPairs} (article_id);
CREATE INDEX IF NOT EXISTS idx_sqlite_qa_app ON ${TABLES.qaPairs} (app_id, article_id);

-- ========== 9. GEO citations table ==========
CREATE TABLE IF NOT EXISTS ${TABLES.citations} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  app_id INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  claim TEXT,
  position INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sqlite_cit_article ON ${TABLES.citations} (article_id);
CREATE INDEX IF NOT EXISTS idx_sqlite_cit_app ON ${TABLES.citations} (app_id, article_id);

-- ========== 10. social share metadata table ==========
CREATE TABLE IF NOT EXISTS ${TABLES.social} (
  article_id INTEGER NOT NULL,
  app_id INTEGER NOT NULL DEFAULT 1,
  og_type TEXT DEFAULT 'article',
  og_image TEXT,
  og_title TEXT,
  og_description TEXT,
  twitter_card TEXT,
  twitter_image TEXT,
  PRIMARY KEY (article_id)
);
CREATE INDEX IF NOT EXISTS idx_sqlite_social_app ON ${TABLES.social} (app_id);

-- ========== 11. vector index status table ==========
CREATE TABLE IF NOT EXISTS ${TABLES.vectors} (
  article_id INTEGER NOT NULL,
  app_id INTEGER NOT NULL DEFAULT 1,
  vector_id TEXT,
  indexed_at TEXT,
  embedding_version TEXT DEFAULT 'v1',
  embedding_provider TEXT DEFAULT 'simple',
  PRIMARY KEY (article_id)
);
CREATE INDEX IF NOT EXISTS idx_sqlite_vectors_app ON ${TABLES.vectors} (app_id);
CREATE INDEX IF NOT EXISTS idx_sqlite_vectors_appv ON ${TABLES.vectors} (app_id, vector_id);

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
  status TEXT DEFAULT 'pending',
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
CREATE INDEX IF NOT EXISTS idx_sqlite_aimg_status ON ${TABLES.articleImages} (app_id, status);
CREATE INDEX IF NOT EXISTS idx_sqlite_aimg_position ON ${TABLES.articleImages} (app_id, article_id, position_order);

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
  lang TEXT NOT NULL DEFAULT 'zh-CN',
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

-- ========== 17. channel publishing calendar (workspace-local, not in MySQL) ==========
CREATE TABLE IF NOT EXISTS ${CHANNEL_PLAN} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL DEFAULT 1,
  platform TEXT NOT NULL,
  period TEXT NOT NULL,
  topic TEXT,
  weekday TEXT,
      article_slugs TEXT NOT NULL,
      status TEXT DEFAULT 'todo',
      draft_ids TEXT,
      notes TEXT,
  schedule_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  UNIQUE (app_id, platform, period)
);
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
`;

module.exports = { SCHEMA_VERSION, createSqliteTablesSQL, CHANNEL_PLAN, CHANNEL_TAXONOMY };
