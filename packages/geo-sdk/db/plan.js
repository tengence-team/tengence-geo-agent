/**
 * Article plan table repository (db domain) — table tengence_geo_article_plan
 * ============================================================================
 * The single read/write entry for the Hub & Spoke article planning / publishing
 * schedule table (service layer: plan/index.js).
 * Conventions:
 *   - Every function here receives the caller's connection; none opens its own;
 *     to open a connection use db.withConn().
 *   - The business layer (publish-draft / publish-from-db / promote-daily / taxonomy)
 *     always accesses this table via the t.plan service domain; raw SQL against it
 *     is forbidden.
 *
 * State machine: todo(🆕) → written(📝) → queued(🕐) → published(✅); paused is for
 * manual holds. Queue = plan_status='queued' AND wp_post_id non-empty, ascending by
 * publish_order.
 * ============================================================================
 */

const { TABLES } = require('./schema');

const PLAN_STATUSES = ['todo', 'written', 'queued', 'published', 'paused'];
const NODE_TYPES = ['hub', 'spoke'];

/** Normalize a row record (decode JSON columns) */
function normalizeRow(row) {
  if (!row) return null;
  let tags = row.tags;
  if (typeof tags === 'string') {
    try {
      tags = JSON.parse(tags);
    } catch (e) {
      tags = [];
    }
  }
  if (!Array.isArray(tags)) tags = [];
  return { ...row, tags };
}

/**
 * List query (includes category/tag display-name aggregation)
 * @param {object} filters { status, batch, cluster, category, nodeType, limit, lang }
 */
async function list(conn, appId, filters = {}) {
  let sql = `
    SELECT p.id, p.slug, p.node_type, p.hub_cluster, p.matrix_code, p.title,
           p.focus_keyword, p.keyword_volume, p.keyword_competition,
           p.search_intent, p.content_type, p.target_word_count,
           p.publish_batch, p.publish_order, p.category, p.tags,
           p.lang, p.languages, p.article_id, p.wp_post_id, p.published_url,
           p.plan_status, p.queued_at, p.published_at, p.notes,
           c.name AS category_name,
           GROUP_CONCAT(DISTINCT t.name ORDER BY t.name SEPARATOR ', ') AS tag_names
    FROM ${TABLES.articlePlan} p
    LEFT JOIN ${TABLES.categories} c ON c.app_id = p.app_id AND c.slug = p.category
    LEFT JOIN ${TABLES.tags} t ON t.app_id = p.app_id AND JSON_CONTAINS(p.tags, JSON_QUOTE(t.slug))
    WHERE p.app_id = ?
  `;
  const params = [appId];

  if (filters.lang) {
    const lc = langClause('p.', filters.lang);
    sql += lc.sql;
    params.push(...lc.params);
  }

  if (filters.status) {
    if (Array.isArray(filters.status)) {
      sql += ` AND p.plan_status IN (${filters.status.map(() => '?').join(',')})`;
      params.push(...filters.status);
    } else {
      sql += ' AND p.plan_status = ?';
      params.push(filters.status);
    }
  }
  if (filters.batch !== undefined && filters.batch !== null && filters.batch !== '') {
    sql += ' AND p.publish_batch = ?';
    params.push(filters.batch);
  }
  if (filters.cluster) {
    sql += ' AND p.hub_cluster = ?';
    params.push(filters.cluster);
  }
  if (filters.category) {
    sql += ' AND p.category = ?';
    params.push(filters.category);
  }
  if (filters.nodeType) {
    sql += ' AND p.node_type = ?';
    params.push(filters.nodeType);
  }

  sql += ' GROUP BY p.id';
  if (filters.nodeType === 'hub') {
    sql += ' ORDER BY p.hub_cluster';
  } else {
    sql += ' ORDER BY p.publish_order, p.id';
  }
  if (filters.limit) {
    sql += ' LIMIT ?';
    params.push(parseInt(filters.limit, 10));
  }

  const [rows] = await conn.query(sql, params);
  return rows.map(normalizeRow);
}

/**
 * Canonical language code for a plan row.
 * The table stores lowercase codes ('zh-hans' | 'en' | 'zh-hant'); the DDL default is
 * the legacy 'zh-CN', so any incoming casing is normalized before it hits SQL — SQLite's
 * `=` is case-sensitive, so an unnormalized 'zh-CN' would silently miss every row.
 */
function normalizeLang(lang) {
  return lang ? String(lang).trim().toLowerCase() : null;
}

/**
 * Optional `lang` WHERE fragment + bound param.
 * Omitted when no lang is given, which preserves the historical slug-only behaviour
 * (callers that only ever deal with the zh-hans source article keep working unchanged).
 */
function langClause(alias, lang) {
  const v = normalizeLang(lang);
  if (!v) return { sql: '', params: [] };
  return { sql: ` AND ${alias}lang = ?`, params: [v] };
}

/** Look up a single row by slug (hub or spoke). Pass `lang` to pick one language. */
async function getBySlug(conn, appId, slug, lang) {
  const lc = langClause('', lang);
  const [rows] = await conn.query(
    `SELECT * FROM ${TABLES.articlePlan} WHERE app_id = ? AND slug = ?${lc.sql} LIMIT 1`,
    [appId, slug, ...lc.params]
  );
  return normalizeRow(rows[0] || null);
}

/** Look up a single row by article_id (used by the publish chain to reverse-look-up category/tags) */
async function getByArticleId(conn, appId, articleId, lang) {
  const lc = langClause('', lang);
  const [rows] = await conn.query(
    `SELECT * FROM ${TABLES.articlePlan} WHERE app_id = ? AND article_id = ?${lc.sql} LIMIT 1`,
    [appId, articleId, ...lc.params]
  );
  return normalizeRow(rows[0] || null);
}

/**
 * Register / update one row (idempotent: UPDATE when app_id+slug+lang exists, else INSERT)
 * Field-merge semantics: non-empty fields provided in record are written; unprovided
 * fields keep their existing values (defaults on INSERT).
 *
 * The lookup is keyed on (app_id, slug, lang) to match the table's UNIQUE constraint.
 * Keying on slug alone could never create a translation row: it would always match the
 * zh-hans source row and update it in place, which is how en/zh-hant plan rows went missing.
 *
 * @param {object} record see the import/upsert calls in plan/index.js
 * @param {object} [opts] { lang } — defaults to the record's own lang, else 'zh-hans'
 * @returns {Promise<{created:boolean, id:number}>}
 */
/**
 * publish_order is an INTEGER column that must hold ONE number per ARTICLE
 * (all of a slug's language rows share it) and that number must be unique across
 * articles — that is what makes "按历史发布顺序" a hard guarantee instead of a
 * convention. S9 (2026-11-13):
 *   - a non-integer (e.g. the literal "written") is refused;
 *   - an order already owned by ANOTHER slug is refused (no silent re-sequencing);
 *   - when a non-primary language row is written, the value is normalised to the
 *     zh-hans row's (the primary language owns the number).
 * The database enforces the same rule with uq_sqlite_plan_order (schema v11).
 */
async function assertOrderUsable(conn, appId, slug, order, lang) {
  if (order === undefined) return;
  if (order === null) return;
  const n = Number(order);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `publish_order must be a non-negative integer (got ${JSON.stringify(order)} for ${slug}/${lang}) — ` +
        'a text value in an integer column silently breaks history ordering'
    );
  }
  if (n === 0) return; // "not assigned yet" — plan sync assigns the tail number later
  const [rows] = await conn.query(
    `SELECT slug FROM ${TABLES.articlePlan}
      WHERE app_id = ? AND publish_order = ? AND lang = 'zh-hans' AND slug <> ? LIMIT 1`,
    [appId, n, slug]
  );
  if (rows && rows.length) {
    throw new Error(
      `publish_order ${n} is already taken by "${rows[0].slug}" — pick the next free number instead of sharing it`
    );
  }
}

/** After a zh-hans row carries an order, every other language row of that slug follows. */
async function syncOrderAcrossLangs(conn, appId, slug) {
  const [rows] = await conn.query(
    `SELECT publish_order FROM ${TABLES.articlePlan}
      WHERE app_id = ? AND slug = ? AND lang = 'zh-hans' LIMIT 1`,
    [appId, slug]
  );
  if (!rows || !rows.length) return;
  const order = rows[0].publish_order;
  if (order === undefined || order === null) return;
  await conn.query(
    `UPDATE ${TABLES.articlePlan} SET publish_order = ?
      WHERE app_id = ? AND slug = ? AND lang <> 'zh-hans' AND publish_order <> ?`,
    [order, appId, slug, order]
  );
}

async function upsert(conn, appId, record, opts = {}) {
  const lang = normalizeLang((opts && opts.lang) || record.lang) || 'zh-hans';
  const existing = await getBySlug(conn, appId, record.slug, lang);
  await assertOrderUsable(conn, appId, record.slug, record.publish_order, lang);
  if (existing) {
    const set = [];
    const values = [];
    const fields = [
      'lang',
      'node_type', 'hub_cluster', 'matrix_code', 'title', 'focus_keyword',
      'keyword_volume', 'keyword_competition', 'search_intent', 'content_type',
      'target_word_count', 'publish_batch', 'publish_order', 'category', 'tags',
      'article_id', 'wp_post_id', 'published_url',
      'plan_status', 'queued_at', 'published_at', 'notes',
    ];
    for (const f of fields) {
      let v = record[f];
      if (f === 'lang') v = lang;
      if (v === undefined || v === null) continue;
      set.push(`\`${f}\` = ?`);
      values.push(f === 'tags' ? JSON.stringify(v) : v);
    }
    if (set.length) {
      values.push(existing.id);
      await conn.query(
        `UPDATE ${TABLES.articlePlan} SET ${set.join(', ')} WHERE id = ?`,
        values
      );
    }
    if (record.publish_order !== undefined) await syncOrderAcrossLangs(conn, appId, record.slug);
    return { created: false, id: existing.id };
  }

  const tags = Array.isArray(record.tags) ? JSON.stringify(record.tags) : JSON.stringify([]);
  await conn.query(
    `INSERT INTO ${TABLES.articlePlan}
       (app_id, slug, node_type, hub_cluster, matrix_code, title, focus_keyword,
        keyword_volume, keyword_competition, search_intent, content_type,
        target_word_count, publish_batch, publish_order, category, tags,
        lang, languages, article_id, wp_post_id, published_url,
        plan_status, queued_at, published_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      appId, record.slug,
      record.node_type || 'spoke', record.hub_cluster || null, record.matrix_code || null,
      record.title || null, record.focus_keyword || null,
      record.keyword_volume || null, record.keyword_competition || null,
      record.search_intent || null, record.content_type || null,
      record.target_word_count || null, record.publish_batch || null,
      record.publish_order || 0, record.category || null, tags,
      lang, record.languages || null,
      record.article_id || null, record.wp_post_id || null,
      record.published_url || null,
      record.plan_status || 'todo', record.queued_at || null, record.published_at || null,
      record.notes || null,
    ]
  );
  if (record.publish_order !== undefined) await syncOrderAcrossLangs(conn, appId, record.slug);
  return { created: true, id: undefined };
}

/**
 * Status transition (one of the single status-write entries): update a row's status
 * and accompanying fields.
 * Updatable fields: plan_status / article_id / wp_post_id / published_url /
 *                   queued_at / published_at / notes (featured_image moved to
 *                   articles on 2026-09-20)
 */
async function updateStatus(conn, appId, slug, fields, opts = {}) {
  const set = [];
  const values = [];
  const allowed = [
    'lang', 'plan_status', 'article_id', 'wp_post_id', 'published_url',
    'queued_at', 'published_at', 'notes',
  ];
  for (const f of allowed) {
    let v = fields[f];
    if (f === 'lang') v = normalizeLang((opts && opts.lang) || fields.lang);
    if (v === undefined || v === null) continue;
    set.push(`\`${f}\` = ?`);
    values.push(v);
  }
  if (!set.length) return { updated: false };
  // Without an explicit lang, fall back to the record's own value so a translation
  // status write targets its own row instead of the zh-hans source row.
  const lang = normalizeLang((opts && opts.lang) || fields.lang);
  const lc = langClause('', lang);
  values.push(appId, slug, ...lc.params);
  const [result] = await conn.query(
    `UPDATE ${TABLES.articlePlan} SET ${set.join(', ')} WHERE app_id = ? AND slug = ?${lc.sql}`,
    values
  );
  return { updated: result.affectedRows > 0 };
}

/**
 * Pick the "next due" candidates: plan_status='queued' AND wp_post_id non-empty,
 * ascending by publish_order, at most count rows (over-fetch handled by callers via
 * count+OVERFETCH as needed).
 *
 * Only zh-hans source rows are eligible: translations must never be promoted through the
 * source pipeline (they are published with the source article, via publish_from_db).
 * @param {object} opts { count, skipSlugs, lang }
 */
async function nextDue(conn, appId, { count = 1, skipSlugs = [], lang = 'zh-hans' } = {}) {
  // 2026-11-13 status unification: "queued" is DERIVED from the article row
  // (draft + a pushed wp_post_id), never from the plan_status mirror. Filtering on
  // plan_status here is what let a plan row claiming `published` skip the queue while
  // its article was still a draft — and let `queued` rows with no article slip in.
  const lc = langClause('p.', lang);
  let sql = `
    SELECT p.* FROM ${TABLES.articlePlan} p
    LEFT JOIN ${TABLES.articles} a
           ON a.app_id = p.app_id AND a.slug = p.slug AND a.lang = p.lang
    WHERE p.app_id = ? AND p.node_type = 'spoke'
      AND p.plan_status <> 'paused'
      AND a.status = 'draft'
      AND (COALESCE(a.wp_post_id, 0) > 0 OR COALESCE(p.wp_post_id, 0) > 0)${lc.sql}
  `;
  const params = [appId, ...lc.params];
  if (skipSlugs.length) {
    sql += ` AND slug NOT IN (${skipSlugs.map(() => '?').join(',')})`;
    params.push(...skipSlugs);
  }
  sql += ' ORDER BY p.publish_order, p.id LIMIT ?';
  params.push(parseInt(count, 10));
  const [rows] = await conn.query(sql, params);
  return rows.map(normalizeRow);
}

module.exports = {
  PLAN_STATUSES,
  NODE_TYPES,
  normalizeLang,
  list,
  getBySlug,
  getByArticleId,
  upsert,
  updateStatus,
  nextDue,
};
