/**
 * article-state / repo — the ONLY place that touches the two status columns
 * ============================================================================
 * `plan_status` (tengence_geo_article_plan.plan_status)
 * `status`      (tengence_geo_articles.status)
 *
 * C I rule: those two column names appear nowhere else in packages/. A CI grep
 * guards it (see status-unification-implementation-plan-2026-11-13.md §6.4).
 *
 * Conventions follow db/plan.js: every function receives the caller's connection,
 * none opens its own. Business layer goes through article-state/index.js.
 * ============================================================================
 */

const { TABLES } = require('../db/schema');

const ORDER = 'p.publish_order ASC, p.publish_batch ASC, p.id ASC';

/** Read the (plan, article) pair for one slug+lang. Either side may be null. */
async function selectOne(conn, appId, slug, lang) {
  const [rows] = await conn.query(
    `SELECT p.id AS plan_id, p.slug, p.lang, p.title AS title, p.node_type, p.hub_cluster, p.matrix_code,
            p.publish_batch, p.publish_order, p.category, p.tags, p.focus_keyword,
            p.notes, p.article_id AS plan_article_id, p.wp_post_id AS plan_wp_post_id,
            p.plan_status,
            a.id AS article_id, a.status AS article_status,
            a.wp_post_id AS article_wp_post_id, a.featured_image,
            a.published_at AS article_published_at
       FROM ${TABLES.articlePlan} p
       LEFT JOIN ${TABLES.articles} a
              ON a.app_id = p.app_id AND a.slug = p.slug AND a.lang = p.lang
      WHERE p.app_id = ? AND p.slug = ? AND p.lang = ?
      LIMIT 1`,
    [appId, slug, lang]
  );
  if (rows && rows.length) return rows[0];

  // no plan row: an orphan article can still be addressed by state
  const [aRows] = await conn.query(
    `SELECT id AS article_id, slug, lang, status AS article_status,
            wp_post_id AS article_wp_post_id, featured_image,
            published_at AS article_published_at
       FROM ${TABLES.articles}
      WHERE app_id = ? AND slug = ? AND lang = ?
      LIMIT 1`,
    [appId, slug, lang]
  );
  return aRows && aRows.length ? aRows[0] : null;
}

/**
 * List merged rows (plan-driven, article left-joined).
 * Only light columns — never正文/SEO/GEO — so list queries stay cheap.
 */
async function selectList(conn, appId, filters = {}) {
  const { lang = null, readyToPublish = false, limit = 1000 } = filters;
  const where = ['p.app_id = ?'];
  const params = [appId];
  if (lang) {
    where.push('p.lang = ?');
    params.push(lang);
  }
  if (readyToPublish) {
    where.push(`a.status IN ('publish','future','private')`);
    where.push('COALESCE(a.wp_post_id, 0) > 0');
  }
  const [rows] = await conn.query(
    `SELECT p.id AS plan_id, p.slug, p.lang, p.title AS title, p.node_type, p.hub_cluster, p.matrix_code,
            p.publish_batch, p.publish_order, p.category, p.tags, p.focus_keyword,
            p.notes, p.article_id AS plan_article_id, p.wp_post_id AS plan_wp_post_id,
            p.plan_status,
            a.id AS article_id, a.status AS article_status,
            a.wp_post_id AS article_wp_post_id, a.featured_image,
            a.published_at AS article_published_at
       FROM ${TABLES.articlePlan} p
       LEFT JOIN ${TABLES.articles} a
              ON a.app_id = p.app_id AND a.slug = p.slug AND a.lang = p.lang
      WHERE ${where.join(' AND ')}
      ORDER BY ${ORDER}
      LIMIT ?`,
    [...params, Number(limit)]
  );
  return rows || [];
}

/** Write the article row for one state transition (never touches plan_status) */
async function updateArticle(conn, appId, articleId, patch) {
  const set = [];
  const params = [];
  if (patch.status !== undefined) {
    set.push('status = ?');
    params.push(patch.status);
  }
  if (patch.wpPostId !== undefined && patch.wpPostId !== null) {
    set.push('wp_post_id = ?');
    params.push(patch.wpPostId);
  }
  if (patch.touchPublishedAt) {
    set.push('published_at = ?');
    params.push(patch.publishedAt || nowString());
  }
  if (!set.length) return { affectedRows: 0 };
  set.push('lastmod = NOW()');
  params.push(articleId, appId);
  const [res] = await conn.query(
    `UPDATE ${TABLES.articles} SET ${set.join(', ')} WHERE id = ? AND app_id = ?`,
    params
  );
  return { affectedRows: res ? res.affectedRows : 0 };
}

/** Write plan_status — only legal while no article row exists (validated upstream) */
async function updatePlanStatus(conn, appId, slug, lang, planStatus) {
  const [res] = await conn.query(
    `UPDATE ${TABLES.articlePlan}
        SET plan_status = ?, updated_at = NOW()
      WHERE app_id = ? AND slug = ? AND lang = ?`,
    [planStatus, appId, slug, lang]
  );
  return { affectedRows: res ? res.affectedRows : 0 };
}

/** Mirror the featured image URL into the article rows (all langs when lang is null) */
async function updateFeaturedImage(conn, appId, slug, lang, url) {
  if (lang) {
    const [res] = await conn.query(
      `UPDATE ${TABLES.articles} SET featured_image = ?, lastmod = NOW()
        WHERE app_id = ? AND slug = ? AND lang = ?`,
      [url, appId, slug, lang]
    );
    return { affectedRows: res ? res.affectedRows : 0 };
  }
  const [res] = await conn.query(
    `UPDATE ${TABLES.articles} SET featured_image = ?, lastmod = NOW()
      WHERE app_id = ? AND slug = ?`,
    [url, appId, slug]
  );
  return { affectedRows: res ? res.affectedRows : 0 };
}

/** plan.article_id <-> articles.lang consistency repair (FK only) */
async function repairArticleLink(conn, appId, slug, lang, articleId) {
  const [res] = await conn.query(
    `UPDATE ${TABLES.articlePlan} SET article_id = ?, updated_at = NOW()
      WHERE app_id = ? AND slug = ? AND lang = ?`,
    [articleId, appId, slug, lang]
  );
  return { affectedRows: res ? res.affectedRows : 0 };
}

/**
 * Read-only audit sources. Returns raw row sets; index.js shapes the report.
 */
async function auditRows(conn, appId) {
  const [drift] = await conn.query(
    `SELECT p.slug, p.lang, p.plan_status, a.status AS article_status
       FROM ${TABLES.articlePlan} p
       JOIN ${TABLES.articles} a
         ON a.app_id = p.app_id AND a.slug = p.slug AND a.lang = p.lang
      WHERE p.app_id = ?
        AND ((p.plan_status IN ('published') AND a.status NOT IN ('publish','future','private'))
          OR (p.plan_status = 'queued' AND COALESCE(a.wp_post_id, 0) = 0))`,
    [appId]
  );

  const [dangling] = await conn.query(
    `SELECT p.slug, p.lang, p.plan_status
       FROM ${TABLES.articlePlan} p
       LEFT JOIN ${TABLES.articles} a
              ON a.app_id = p.app_id AND a.slug = p.slug AND a.lang = p.lang
      WHERE p.app_id = ? AND a.id IS NULL AND p.plan_status IN ('queued','published')`,
    [appId]
  );

  const [fkMismatch] = await conn.query(
    `SELECT p.slug, p.lang, p.article_id, a.lang AS article_lang, a.slug AS article_slug
       FROM ${TABLES.articlePlan} p
       JOIN ${TABLES.articles} a ON a.id = p.article_id
      WHERE p.app_id = ? AND a.lang <> p.lang`,
    [appId]
  );

  const [missingCover] = await conn.query(
    `SELECT a.slug, a.lang
       FROM ${TABLES.articles} a
      WHERE a.app_id = ?
        AND a.status IN ('publish','future','private')
        AND TRIM(COALESCE(a.featured_image, '')) = ''`,
    [appId]
  );

  return { drift: drift || [], dangling: dangling || [], fkMismatch: fkMismatch || [], missingCover: missingCover || [] };
}

function nowString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

module.exports = {
  selectOne,
  selectList,
  updateArticle,
  updatePlanStatus,
  updateFeaturedImage,
  repairArticleLink,
  auditRows,
  nowString,
};
