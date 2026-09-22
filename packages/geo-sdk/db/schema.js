/**
 * Database table-name constants and DDL (db domain)
 * ============================================================================
 * Batch A converged the `tengence_geo_*` table names that were previously
 * hard-coded in 6 scripts; batch B further moved db-init.js's create/drop DDL here,
 * degrading db-init to a thin shell.
 *
 * Batch D completion: articleConfig / images / articleImages — these three tables
 * were already in use (config domain, images domain) but had no DDL; they are now
 * added to createTablesSQL following the REAL structure from the production DB's
 * `SHOW CREATE TABLE`, field-identical with production.
 *
 * Note: db-init still creates the 6 tables (seo/geo/qa_pairs/citations/social/vectors)
 * that nobody currently reads/writes — they belong to the platform-side schema and
 * are kept for a complete rebuild.
 * ============================================================================
 */

const PREFIX = 'tengence_geo_';

const TABLES = {
  articles: `${PREFIX}articles`,
   categories: `${PREFIX}categories`,
  tags: `${PREFIX}tags`,
  articleCategories: `${PREFIX}article_categories`,
  articleTags: `${PREFIX}article_tags`,
  seo: `${PREFIX}seo`,
  geo: `${PREFIX}geo`,
  qaPairs: `${PREFIX}qa_pairs`,
  citations: `${PREFIX}citations`,
  social: `${PREFIX}social`,
  vectors: `${PREFIX}vectors`,
  images: `${PREFIX}images`,
  articleImages: `${PREFIX}article_images`,
  geoMonitorAnswers: `${PREFIX}geo_monitor_answers`,
  geoMonitorResults: `${PREFIX}geo_monitor_results`,
  articlePlan: `${PREFIX}article_plan`,
};

/** Tables db-init.js actually creates (after batch D = all 14) */
const CREATED_BY_DB_INIT = [
  TABLES.articles,
  TABLES.categories,
  TABLES.tags,
  TABLES.articleCategories,
  TABLES.articleTags,
  TABLES.seo,
  TABLES.geo,
  TABLES.qaPairs,
  TABLES.citations,
  TABLES.social,
  TABLES.vectors,
  TABLES.images,
  TABLES.articleImages,
  // GEO monitoring (added P1 2026-09-16, see plan/2026 doc 10, section 10)
  TABLES.geoMonitorAnswers,
  TABLES.geoMonitorResults,
  // Article plan table (added P2 2026-09-20: single source of truth for Hub & Spoke
  // article planning / publishing schedule)
  TABLES.articlePlan,
];

/** Tables that were "in use but had no DDL" (batch D completed them on 2026-09-14; now empty) */
const MISSING_IN_DB_INIT = [];

// ---------------------------------------------------------------------------
// Create / drop DDL
//   Moved verbatim from the original db-init.js, with table names only replaced by
//   the TABLES constants above; string-equality checks confirmed byte-identical
//   content during the move.
// ---------------------------------------------------------------------------

const createTablesSQL = `
-- 1. articles main table
CREATE TABLE IF NOT EXISTS ${TABLES.articles} (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    app_id BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'application id (multi-tenant)',
    slug VARCHAR(255) NOT NULL COMMENT 'article unique key (unique with lang: one slug x one language = one article)',
    title VARCHAR(500) NOT NULL COMMENT 'article title',

    -- content
    content_path VARCHAR(500) COMMENT 'Markdown file path (writing source path, not the published URL)',
    content_longtext LONGTEXT COMMENT 'Markdown body (no FrontMatter; md is authoritative for reverse-parsing)',
    content_html LONGTEXT COMMENT 'Markdown-converted HTML (publish cache: re-converted when md changes, reused otherwise)',
    research_md LONGTEXT COMMENT 'research brief body (pre-writing research gate; the file may be deleted after ingest)',
    excerpt TEXT COMMENT 'article summary',
    featured_image VARCHAR(500) COMMENT 'featured image path (https://www.<domain>/blog/static/images/...; backfilled by the image pipeline)',
    seo JSON COMMENT 'SEO metadata { title, keywords[], meta_description } (document-shaped, submitted to the WP plugin as a whole)',
    geo JSON COMMENT 'GEO metadata { ai_summary, key_takeaways[], qa_pairs[], citations[] } (reverse-parsed and written back from the body)',

    -- basic metadata
    description TEXT COMMENT 'article description',
    target_keywords JSON COMMENT 'target keyword array',
    long_tail_keywords JSON COMMENT 'long-tail keyword array',

    -- audience info
    target_audience JSON COMMENT 'target audience array',
    difficulty_level ENUM('beginner', 'intermediate', 'advanced') DEFAULT 'intermediate',
    estimated_reading_time INT DEFAULT 5 COMMENT 'estimated reading time (minutes)',
    target_word_count INT DEFAULT 1800 COMMENT 'target word count',

    -- language & region
    lang VARCHAR(10) DEFAULT 'zh-CN' COMMENT 'content language',
    region_market VARCHAR(10) DEFAULT 'cn' COMMENT 'target market',
    region_currency VARCHAR(10) DEFAULT 'CNY' COMMENT 'currency',
    region_compliance JSON COMMENT 'compliance requirements',

    -- workflow status
    status ENUM('draft', 'review', 'publish', 'archived') DEFAULT 'draft',
    version VARCHAR(20) DEFAULT '1.0.0',
    reviewer VARCHAR(100),
    review_date DATE,

    -- time info
    date DATETIME COMMENT 'created time',
    lastmod DATETIME COMMENT 'last modified time',
    published_at DATETIME COMMENT 'publish time',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- author
    author VARCHAR(100),
    author_id INT DEFAULT 1,

    -- WordPress link
    wp_post_id BIGINT UNSIGNED,
    wp_post_type VARCHAR(50) DEFAULT 'post',
    wp_post_format VARCHAR(50) DEFAULT 'standard',

    -- indexes
    UNIQUE KEY uk_app_slug_lang (app_id, slug, lang),
    INDEX idx_app_id (app_id),
    INDEX idx_status (app_id, status),
    INDEX idx_lang (app_id, lang),
    INDEX idx_region (app_id, region_market),
    INDEX idx_published_at (app_id, published_at),
    INDEX idx_wp_post_id (wp_post_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='articles main table (content blobs + SEO/GEO metadata; one row per slug x language)';

-- 2. categories table
CREATE TABLE IF NOT EXISTS ${TABLES.categories} (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    app_id BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'application id (multi-tenant)',
    name VARCHAR(100) NOT NULL COMMENT 'category name',
    slug VARCHAR(100) NOT NULL COMMENT 'category key',
    parent_id INT UNSIGNED DEFAULT NULL COMMENT 'parent category id',
    description TEXT COMMENT 'category description',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uk_app_slug (app_id, slug),
    INDEX idx_app_id (app_id),
    INDEX idx_parent_id (app_id, parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='categories table';

-- 3. tags table
CREATE TABLE IF NOT EXISTS ${TABLES.tags} (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    app_id BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'application id (multi-tenant)',
    name VARCHAR(100) NOT NULL COMMENT 'tag name',
    slug VARCHAR(100) NOT NULL COMMENT 'tag key',
    description TEXT COMMENT 'tag description',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uk_app_slug (app_id, slug),
    INDEX idx_app_id (app_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='tags table';

-- 4. article-category link table
CREATE TABLE IF NOT EXISTS ${TABLES.articleCategories} (
    article_id BIGINT UNSIGNED NOT NULL,
    app_id BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'application id (multi-tenant)',
    category_id INT UNSIGNED NOT NULL,
    position INT DEFAULT 0 COMMENT 'sort position',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (article_id, category_id),
    INDEX idx_app_id (app_id),
    INDEX idx_category_id (app_id, category_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='article-category link table';

-- 5. article-tag link table
CREATE TABLE IF NOT EXISTS ${TABLES.articleTags} (
    article_id BIGINT UNSIGNED NOT NULL,
    app_id BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'application id (multi-tenant)',
    tag_id INT UNSIGNED NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (article_id, tag_id),
    INDEX idx_app_id (app_id),
    INDEX idx_tag_id (app_id, tag_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='article-tag link table';

-- 6. SEO metadata table
CREATE TABLE IF NOT EXISTS ${TABLES.seo} (
    article_id BIGINT UNSIGNED NOT NULL,
    app_id BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'application id (multi-tenant)',
    title VARCHAR(500) COMMENT 'SEO title',
    meta_description TEXT COMMENT 'page description',
    keywords JSON COMMENT 'keyword array',
    canonical_url VARCHAR(500) COMMENT 'canonical URL',
    focus_keyword VARCHAR(200) COMMENT 'primary keyword',
    og_type VARCHAR(50) DEFAULT 'article',
    og_image VARCHAR(500),
    og_title VARCHAR(500),
    og_description TEXT,
    og_locale VARCHAR(20),

    PRIMARY KEY (article_id),
    INDEX idx_app_id (app_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='SEO metadata table';

-- 7. GEO metadata table
CREATE TABLE IF NOT EXISTS ${TABLES.geo} (
    article_id BIGINT UNSIGNED NOT NULL,
    app_id BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'application id (multi-tenant)',
    ai_summary TEXT COMMENT 'AI summary',
    key_takeaways JSON COMMENT 'key takeaways array',
    call_to_action JSON COMMENT 'call to action',
    content_structure JSON COMMENT 'content structure',

    PRIMARY KEY (article_id),
    INDEX idx_app_id (app_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='GEO metadata table';

-- 8. GEO Q&A pairs table
CREATE TABLE IF NOT EXISTS ${TABLES.qaPairs} (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    article_id BIGINT UNSIGNED NOT NULL,
    app_id BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'application id (multi-tenant)',
    question TEXT NOT NULL COMMENT 'question',
    answer TEXT NOT NULL COMMENT 'answer',
    position INT DEFAULT 0 COMMENT 'sort position',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_article_id (article_id),
    INDEX idx_app_article (app_id, article_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='GEO Q&A pairs table';

-- 9. GEO citations table
CREATE TABLE IF NOT EXISTS ${TABLES.citations} (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    article_id BIGINT UNSIGNED NOT NULL,
    app_id BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'application id (multi-tenant)',
    source VARCHAR(500) NOT NULL COMMENT 'source',
    claim TEXT COMMENT 'claimed content',
    position INT DEFAULT 0 COMMENT 'sort position',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_article_id (article_id),
    INDEX idx_app_article (app_id, article_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='GEO citations table';

-- 10. social share metadata table
CREATE TABLE IF NOT EXISTS ${TABLES.social} (
    article_id BIGINT UNSIGNED NOT NULL,
    app_id BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'application id (multi-tenant)',
    og_type VARCHAR(50) DEFAULT 'article',
    og_image VARCHAR(500),
    og_title VARCHAR(500),
    og_description TEXT,
    twitter_card VARCHAR(50),
    twitter_image VARCHAR(500),

    PRIMARY KEY (article_id),
    INDEX idx_app_id (app_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='social share metadata table';

-- 11. vector index status table
CREATE TABLE IF NOT EXISTS ${TABLES.vectors} (
    article_id BIGINT UNSIGNED NOT NULL,
    app_id BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'application id (multi-tenant)',
    vector_id VARCHAR(100) COMMENT 'external vector store point id (legacy field, currently unused)',
    indexed_at TIMESTAMP NULL COMMENT 'index time',
    embedding_version VARCHAR(20) DEFAULT 'v1' COMMENT 'vector version',
    embedding_provider VARCHAR(50) DEFAULT 'simple' COMMENT 'simple, openai, python',

    PRIMARY KEY (article_id),
    INDEX idx_app_id (app_id),
    INDEX idx_app_vector (app_id, vector_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='vector index status table';

-- 13. image library (batch D completion: images domain uses it; no DDL existed before)
CREATE TABLE IF NOT EXISTS ${TABLES.images} (
    id INT AUTO_INCREMENT PRIMARY KEY,
    app_id INT NOT NULL DEFAULT 1,
    original_url VARCHAR(512) NOT NULL COMMENT 'original image URL',
    source_platform ENUM('unsplash','pexels','pixabay','freepik','stockadobio','custom') NOT NULL DEFAULT 'unsplash' COMMENT 'image source platform',
    wp_media_id INT COMMENT 'WordPress media id (returned after upload)',
    image_hash VARCHAR(64) COMMENT 'perceptual hash (pHash) for quick comparison',
    width INT COMMENT 'image width',
    height INT COMMENT 'image height',
    aspect_ratio DECIMAL(5,4) COMMENT 'aspect ratio',
    file_size INT COMMENT 'file size (bytes)',
    quality_score DECIMAL(3,2) DEFAULT 0.80 COMMENT 'quality score 0-1',
    aesthetic_score DECIMAL(3,2) COMMENT 'aesthetic score',
    qdrant_id BIGINT COMMENT 'point id in Qdrant',
    embedding_dimension INT DEFAULT 384 COMMENT 'embedding dimension',
    usage_count INT DEFAULT 0 COMMENT 'usage count',
    last_used_at DATETIME COMMENT 'last used time',
    alt_text VARCHAR(255) COMMENT 'alternative text',
    caption TEXT COMMENT 'image caption',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uk_original_url (app_id, original_url),
    INDEX idx_source_platform (app_id, source_platform),
    INDEX idx_usage_count (app_id, usage_count),
    INDEX idx_image_hash (app_id, image_hash),
    INDEX idx_qdrant_id (app_id, qdrant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='image library';

-- 14. article image table (batch D completion: images domain uses it; no DDL existed before)
--    Note: \`position\` / \`format\` are backquoted to avoid ambiguity with
--    same-named functions/keywords.
CREATE TABLE IF NOT EXISTS ${TABLES.articleImages} (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    app_id BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'application id',
    article_id BIGINT UNSIGNED NOT NULL COMMENT 'article id',
    image_id BIGINT UNSIGNED,
    \`position\` ENUM('featured','content') DEFAULT 'content',
    display_order INT DEFAULT 0,
    image_type ENUM('hero','content','thumbnail','og','featured') DEFAULT 'content' COMMENT 'image type',
    original_url VARCHAR(1000) COMMENT 'original image URL',
    local_path VARCHAR(500) COMMENT 'local storage path',
    local_url VARCHAR(1000) COMMENT 'local access URL',
    insert_position VARCHAR(500) COMMENT 'insert position description/paragraph marker',
    position_order INT DEFAULT 0 COMMENT 'sort position',
    caption TEXT COMMENT 'image caption',
    alt_text VARCHAR(500) COMMENT 'Alt text',
    width INT COMMENT 'image width',
    height INT COMMENT 'image height',
    file_size INT COMMENT 'file size (bytes)',
    \`format\` VARCHAR(20) COMMENT 'image format (jpg, png, etc.)',
    quality_score DECIMAL(3,2) COMMENT 'quality score 0.00-1.00',
    relevance_score DECIMAL(3,2) COMMENT 'relevance score 0.00-1.00',
    aesthetic_score DECIMAL(3,2) COMMENT 'aesthetic score 0.00-1.00',
    ai_description TEXT COMMENT 'AI-generated image description',
    ai_tags JSON COMMENT 'AI-recognized tags',
    ai_suggestions TEXT COMMENT 'AI optimization suggestions',
    status ENUM('pending','downloading','processing','ready','failed','used') DEFAULT 'pending' COMMENT 'processing status',
    download_attempt INT DEFAULT 0 COMMENT 'download attempt count',
    config_keywords JSON COMMENT 'configured keyword array',
    prompt TEXT COMMENT 'image generation prompt',
    source ENUM('upload','url','ai_generated','stock') DEFAULT 'url' COMMENT 'image source',
    source_reference VARCHAR(500) COMMENT 'source reference',
    notes TEXT COMMENT 'notes',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_article (app_id, article_id),
    INDEX idx_type (app_id, image_type),
    INDEX idx_status (app_id, status),
    INDEX idx_position (app_id, article_id, position_order),
    INDEX fk_image_article (article_id),
    CONSTRAINT fk_image_article FOREIGN KEY (article_id) REFERENCES ${TABLES.articles} (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='article image table';

-- 15. GEO monitor - raw answers (added P1 2026-09-16; full raw answer persisted = evidence chain)
CREATE TABLE IF NOT EXISTS ${TABLES.geoMonitorAnswers} (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    app_id BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'application id (multi-tenant)',
    run_id VARCHAR(20) NOT NULL COMMENT 'monitor round (YYYYMMDD, weekly)',
    model VARCHAR(100) NOT NULL COMMENT 'model key (deepseek/kimi/qwen/doubao)',
    model_version VARCHAR(200) DEFAULT NULL COMMENT 'model version from the API response, stored verbatim',
    prompt_id VARCHAR(20) NOT NULL COMMENT 'prompt id (from monitor-prompts.yaml)',
    layer VARCHAR(4) NOT NULL COMMENT 'question layer L1-L5',
    variant INT NOT NULL DEFAULT 0 COMMENT 'variant index (0=original, 1/2=synonym rewrites)',
    attempt INT NOT NULL DEFAULT 1 COMMENT 'attempt number (1..N, majority of 3 by default)',
    question TEXT NOT NULL COMMENT 'full question text actually sent',
    answer_text LONGTEXT NOT NULL COMMENT 'full model answer',
    prompt_tokens INT DEFAULT 0,
    completion_tokens INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY uk_monitor_answer (app_id, run_id, model, prompt_id, attempt),
    INDEX idx_monitor_answer_run (app_id, run_id, model),
    INDEX idx_monitor_answer_prompt (app_id, prompt_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='GEO monitor - raw answers';

-- 16. GEO monitor - extraction & scoring (added P1 2026-09-16; one aggregated row per prompt x model)
--    Note: \`position\` is backquoted (same rationale as articleImages, avoiding function/keyword ambiguity).
CREATE TABLE IF NOT EXISTS ${TABLES.geoMonitorResults} (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    app_id BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'application id (multi-tenant)',
    run_id VARCHAR(20) NOT NULL COMMENT 'monitor round (YYYYMMDD)',
    model VARCHAR(100) NOT NULL COMMENT 'model key',
    prompt_id VARCHAR(20) NOT NULL COMMENT 'prompt id',
    layer VARCHAR(4) NOT NULL COMMENT 'question layer L1-L5',
    mentioned TINYINT NOT NULL DEFAULT 0 COMMENT 'whether the brand is mentioned (majority of 3, string-level)',
    entity_match VARCHAR(10) NOT NULL DEFAULT 'none' COMMENT 'entity disambiguation: ours=confirmed our Tengence / ambiguous=homonymous entity / none=not mentioned',
    mention_type TINYINT NOT NULL DEFAULT 0 COMMENT '0=not mentioned 1=casual 2=enumerated 3=proactively recommended',
    \`position\` TINYINT NOT NULL DEFAULT 0 COMMENT 'brand rank vs competitors (0=not mentioned, 1=first, capped at 5)',
    sentiment VARCHAR(10) NOT NULL DEFAULT 'neutral' COMMENT 'positive/neutral/negative',
    cited_tengence TINYINT NOT NULL DEFAULT 0 COMMENT 'whether tengence.com is cited',
    cited_any TINYINT NOT NULL DEFAULT 0 COMMENT 'whether any external link is cited',
    accuracy VARCHAR(20) NOT NULL DEFAULT 'basic' COMMENT 'flagged/complete/basic',
    score INT NOT NULL DEFAULT 0 COMMENT 'GEO Visibility Score (0-100)',
    competitors JSON COMMENT 'competitor names mentioned in this answer',
    flags JSON COMMENT 'alerts (hallucination descriptions / negative sentiment etc., structured details)',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY uk_monitor_result (app_id, run_id, model, prompt_id),
    INDEX idx_monitor_result_run (app_id, run_id),
    INDEX idx_monitor_result_layer (app_id, layer),
    INDEX idx_monitor_result_flag (app_id, accuracy)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='GEO monitor - extraction & scoring';

-- 17. article plan table (added P2 2026-09-20)
--     Single source of truth for Hub & Spoke article planning / publishing schedule:
--       - One article has exactly one slug (UNIQUE app_id+slug); hub pages and spoke
--         articles share this table, distinguished by node_type (hub=cluster hub page /
--         spoke=spoke article).
--       - The category/tag allow-list comes from the categories / tags tables
--         (taxonomy.yaml retired after migration).
--       - plan_status state machine: todo(not written) → written(written, awaiting image)
--         → queued(drafted, awaiting publish) → published(published).
--       - The promote-daily queue = rows with plan_status='queued' and non-empty
--         wp_post_id, ascending by publish_order; scheduling params (per_day /
--         skip_dates) live in config/wordpress.yaml (publish node), no queue table.
--       - published_url / featured_image store the post-publish online paths (not local).
CREATE TABLE IF NOT EXISTS ${TABLES.articlePlan} (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    app_id BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'application id (multi-tenant)',
    slug VARCHAR(255) NOT NULL COMMENT 'page key (hub pages and spoke articles share it; one page one slug)',
    node_type ENUM('hub','spoke') NOT NULL DEFAULT 'spoke' COMMENT 'page role: hub=cluster hub page / spoke=spoke article',
    hub_cluster VARCHAR(10) COMMENT 'hub cluster key (A-G; hub rows mark their own cluster, spoke rows mark their home cluster)',
    matrix_code VARCHAR(20) COMMENT 'keyword matrix code (A01-G10; hub pages/legacy articles may be null)',
    title VARCHAR(500) COMMENT 'plan title',
    focus_keyword VARCHAR(200) COMMENT 'primary keyword (keyword matrix)',
    keyword_volume INT COMMENT 'monthly search volume',
    keyword_competition VARCHAR(20) COMMENT 'competition (low/medium/high)',
    search_intent VARCHAR(10) COMMENT 'search intent (I/C/N)',
    content_type VARCHAR(50) COMMENT 'content form (guide/list/comparison/solution/case/document/definition/analysis/roundup/report/product)',
    target_word_count INT COMMENT 'target word count',
    publish_batch TINYINT COMMENT 'publish batch (1/2/3)',
    publish_order INT DEFAULT 0 COMMENT 'publish order (promote-daily ascends by this to pick the next due)',
    category VARCHAR(100) COMMENT 'category slug (allow-list from the categories table)',
    tags JSON COMMENT 'tag slug array (≤3, allow-list from the tags table)',
    lang VARCHAR(10) NOT NULL DEFAULT 'zh-CN' COMMENT 'language (one slug x one language = one plan row; each language tracks its own schedule)',
    languages JSON COMMENT 'languages planned for this topic (topic-level aggregation marker, e.g. ["zh-CN","en-US"]; maintained by import/upsert)',
    article_id BIGINT UNSIGNED COMMENT 'linked articles.id (backfilled after the row is created)',
    wp_post_id BIGINT UNSIGNED COMMENT 'WordPress article id (redundant; backfilled after drafting/publishing, directly usable by the queue)',
    published_url VARCHAR(500) COMMENT 'post-publish online path (https://www.<domain>/blog/article/<slug>/)',
    plan_status ENUM('todo','written','queued','published','paused') NOT NULL DEFAULT 'todo' COMMENT 'plan status: todo=not written written=written, awaiting image queued=drafted, awaiting publish published=published paused=paused',
    queued_at DATETIME COMMENT 'draft push time',
    published_at DATETIME COMMENT 'promotion time',
    notes TEXT COMMENT 'notes',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uk_app_slug_lang (app_id, slug, lang),
    INDEX idx_status_order (app_id, plan_status, publish_order),
    INDEX idx_node (app_id, node_type),
    INDEX idx_cluster (app_id, hub_cluster),
    INDEX idx_article (app_id, article_id),
    INDEX idx_wp (app_id, wp_post_id),
    INDEX idx_published_at (app_id, published_at),
    INDEX idx_queued_at (app_id, queued_at),
    INDEX idx_category (app_id, category),
    INDEX idx_slug (slug),
    INDEX idx_batch (app_id, publish_batch),
    INDEX idx_tags ((CAST(tags AS CHAR(50) ARRAY)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='article plan table (Hub & Spoke article planning / publishing schedule; single source of truth)';
`;

// Drop SQL (reverse dependency order; the two monitor tables have no FKs, dropped first)
const dropTablesSQL = `
DROP TABLE IF EXISTS ${TABLES.geoMonitorResults};
DROP TABLE IF EXISTS ${TABLES.geoMonitorAnswers};
DROP TABLE IF EXISTS ${TABLES.vectors};
DROP TABLE IF EXISTS ${TABLES.social};
DROP TABLE IF EXISTS ${TABLES.citations};
DROP TABLE IF EXISTS ${TABLES.qaPairs};
DROP TABLE IF EXISTS ${TABLES.geo};
DROP TABLE IF EXISTS ${TABLES.seo};
DROP TABLE IF EXISTS ${TABLES.articleImages};
DROP TABLE IF EXISTS ${TABLES.images};
DROP TABLE IF EXISTS ${TABLES.articleTags};
DROP TABLE IF EXISTS ${TABLES.articleCategories};
DROP TABLE IF EXISTS ${TABLES.tags};
DROP TABLE IF EXISTS ${TABLES.categories};
DROP TABLE IF EXISTS ${TABLES.articlePlan};
DROP TABLE IF EXISTS ${TABLES.articles};
`;

module.exports = {
  PREFIX,
  TABLES,
  CREATED_BY_DB_INIT,
  MISSING_IN_DB_INIT,
  createTablesSQL,
  dropTablesSQL,
};
