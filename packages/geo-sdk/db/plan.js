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
 * @param {object} filters { status, batch, cluster, category, nodeType, limit }
 */
async function list(conn, appId, filters = {}) {
  let sql = `
    SELECT p.id, p.slug, p.node_type, p.hub_cluster, p.matrix_code, p.title,
           p.focus_keyword, p.keyword_volume, p.keyword_competition,
           p.search_intent, p.content_type, p.target_word_count,
           p.publish_batch, p.publish_order, p.category, p.tags,
           p.article_id, p.wp_post_id, p.published_url,
           p.plan_status, p.queued_at, p.published_at, p.notes,
           c.name AS category_name,
           GROUP_CONCAT(DISTINCT t.name ORDER BY t.name SEPARATOR ', ') AS tag_names
    FROM ${TABLES.articlePlan} p
    LEFT JOIN ${TABLES.categories} c ON c.app_id = p.app_id AND c.slug = p.category
    LEFT JOIN ${TABLES.tags} t ON t.app_id = p.app_id AND JSON_CONTAINS(p.tags, JSON_QUOTE(t.slug))
    WHERE p.app_id = ?
  `;
  const params = [appId];

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

/** Look up a single row by slug (hub or spoke) */
async function getBySlug(conn, appId, slug) {
  const [rows] = await conn.query(
    `SELECT * FROM ${TABLES.articlePlan} WHERE app_id = ? AND slug = ? LIMIT 1`,
    [appId, slug]
  );
  return normalizeRow(rows[0] || null);
}

/** Look up a single row by article_id (used by the publish chain to reverse-look-up category/tags) */
async function getByArticleId(conn, appId, articleId) {
  const [rows] = await conn.query(
    `SELECT * FROM ${TABLES.articlePlan} WHERE app_id = ? AND article_id = ? LIMIT 1`,
    [appId, articleId]
  );
  return normalizeRow(rows[0] || null);
}

/**
 * Register / update one row (idempotent: UPDATE when app_id+slug exists, else INSERT)
 * Field-merge semantics: non-empty fields provided in record are written; unprovided
 * fields keep their existing values (defaults on INSERT).
 * @param {object} record see the import/upsert calls in plan/index.js
 * @returns {Promise<{created:boolean, id:number}>}
 */
async function upsert(conn, appId, record) {
  const existing = await getBySlug(conn, appId, record.slug);
  if (existing) {
    const set = [];
    const values = [];
    const fields = [
      'node_type', 'hub_cluster', 'matrix_code', 'title', 'focus_keyword',
      'keyword_volume', 'keyword_competition', 'search_intent', 'content_type',
      'target_word_count', 'publish_batch', 'publish_order', 'category', 'tags',
      'article_id', 'wp_post_id', 'published_url',
      'plan_status', 'queued_at', 'published_at', 'notes',
    ];
    for (const f of fields) {
      const v = record[f];
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
    return { created: false, id: existing.id };
  }

  const tags = Array.isArray(record.tags) ? JSON.stringify(record.tags) : JSON.stringify([]);
  await conn.query(
    `INSERT INTO ${TABLES.articlePlan}
       (app_id, slug, node_type, hub_cluster, matrix_code, title, focus_keyword,
        keyword_volume, keyword_competition, search_intent, content_type,
        target_word_count, publish_batch, publish_order, category, tags,
        article_id, wp_post_id, published_url,
        plan_status, queued_at, published_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      appId, record.slug,
      record.node_type || 'spoke', record.hub_cluster || null, record.matrix_code || null,
      record.title || null, record.focus_keyword || null,
      record.keyword_volume || null, record.keyword_competition || null,
      record.search_intent || null, record.content_type || null,
      record.target_word_count || null, record.publish_batch || null,
      record.publish_order || 0, record.category || null, tags,
      record.article_id || null, record.wp_post_id || null,
      record.published_url || null,
      record.plan_status || 'todo', record.queued_at || null, record.published_at || null,
      record.notes || null,
    ]
  );
  return { created: true, id: undefined };
}

/**
 * Status transition (one of the single status-write entries): update a row's status
 * and accompanying fields.
 * Updatable fields: plan_status / article_id / wp_post_id / published_url /
 *                   queued_at / published_at / notes (featured_image moved to
 *                   articles on 2026-09-20)
 */
async function updateStatus(conn, appId, slug, fields) {
  const set = [];
  const values = [];
  const allowed = [
    'plan_status', 'article_id', 'wp_post_id', 'published_url',
    'queued_at', 'published_at', 'notes',
  ];
  for (const f of allowed) {
    const v = fields[f];
    if (v === undefined) continue;
    set.push(`\`${f}\` = ?`);
    values.push(v);
  }
  if (!set.length) return { updated: false };
  values.push(appId, slug);
  const [result] = await conn.query(
    `UPDATE ${TABLES.articlePlan} SET ${set.join(', ')} WHERE app_id = ? AND slug = ?`,
    values
  );
  return { updated: result.affectedRows > 0 };
}

/**
 * Pick the "next due" candidates: plan_status='queued' AND wp_post_id non-empty,
 * ascending by publish_order, at most count rows (over-fetch handled by callers via
 * count+OVERFETCH as needed).
 * @param {object} opts { count, skipSlugs }
 */
async function nextDue(conn, appId, { count = 1, skipSlugs = [] } = {}) {
  let sql = `
    SELECT * FROM ${TABLES.articlePlan}
    WHERE app_id = ? AND node_type = 'spoke'
      AND plan_status = 'queued' AND wp_post_id IS NOT NULL
  `;
  const params = [appId];
  if (skipSlugs.length) {
    sql += ` AND slug NOT IN (${skipSlugs.map(() => '?').join(',')})`;
    params.push(...skipSlugs);
  }
  sql += ' ORDER BY publish_order, id LIMIT ?';
  params.push(parseInt(count, 10));
  const [rows] = await conn.query(sql, params);
  return rows.map(normalizeRow);
}

module.exports = {
  PLAN_STATUSES,
  NODE_TYPES,
  list,
  getBySlug,
  getByArticleId,
  upsert,
  updateStatus,
  nextDue,
};
