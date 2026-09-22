/**
 * Article SEO/GEO metadata repository (db domain)
 * ============================================================================
 * 2026-09-20 merge refactor: the `tengence_geo_article_config` table retired; SEO/GEO
 * metadata merged into the `tengence_geo_articles` table's `seo` / `geo` /
 * `featured_image` columns; the single source of truth for category/tags is the
 * article plan table (t.plan), looked up here by article_id.
 *
 * API signatures stay unchanged (getFull / upsertFull / getRawFull / updateRaw), so
 * callers (publish-draft / publish-from-db / publish-update-article / publish-wechat)
 * need no changes.
 *
 * Return shapes:
 *   getFull → { category, tags, seo, geo, featured_image }
 *   getRawFull → { id: articleId, config_keywords: { ...same as above } }
 * ============================================================================
 */

const { TABLES } = require('./schema');
const { parseJsonValue } = require('./value');

/**
 * Read the article SEO/GEO metadata + plan assignment (category/tags from the article plan table)
 * @returns {Promise<{category:string, tags:string[], seo:object|null, geo:object|null, featured_image:string|null}>}
 */
async function getFull(conn, articleId, appId) {
  const [arts] = await conn.query(
    `SELECT seo, geo, featured_image FROM ${TABLES.articles} WHERE id = ? AND app_id = ? LIMIT 1`,
    [articleId, appId]
  );

  let category = 'product-solutions';
  let tags = [];
  let seo = null;
  let geo = null;
  let featured_image = null;

  if (arts.length) {
    const a = arts[0];
    seo = parseJsonValue(a.seo, null);
    geo = parseJsonValue(a.geo, null);
    featured_image = a.featured_image || null;
  }

  // category/tags: article plan table (single source of truth)
  const [plans] = await conn.query(
    `SELECT category, tags FROM ${TABLES.articlePlan} WHERE app_id = ? AND article_id = ? LIMIT 1`,
    [appId, articleId]
  );
  if (plans.length) {
    if (plans[0].category) category = plans[0].category;
    tags = Array.isArray(plans[0].tags) ? plans[0].tags : [];
  }

  return { category, tags, seo, geo, featured_image };
}

/**
 * Write / update the SEO/GEO metadata (articles table columns; category/tags are
 * managed by the plan table and ignored here)
 * @param {object} configKeywords shape { seo, geo, featured_image } (category/tags keys ignored)
 * @returns {Promise<undefined>} keeps the legacy signature for compatibility
 */
async function upsertFull(conn, articleId, appId, configKeywords) {
  const { seo, geo, featured_image } = configKeywords || {};
  const sets = [];
  const vals = [];
  if (seo !== undefined && seo !== null) { sets.push('seo = ?'); vals.push(typeof seo === 'string' ? seo : JSON.stringify(seo)); }
  if (geo !== undefined && geo !== null) { sets.push('geo = ?'); vals.push(typeof geo === 'string' ? geo : JSON.stringify(geo)); }
  if (featured_image !== undefined) { sets.push('featured_image = ?'); vals.push(String(featured_image).trim() || null); }
  if (!sets.length) return undefined;

  vals.push(articleId, appId);
  await conn.query(
    `UPDATE ${TABLES.articles} SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ? AND app_id = ?`,
    vals
  );
  return undefined;
}

/**
 * Read the article metadata (compatible with the legacy getRawFull usage: returns { id, config_keywords })
 * @returns {Promise<{id:number, config_keywords:object}|null>}
 */
async function getRawFull(conn, articleId, appId) {
  const full = await getFull(conn, articleId, appId);
  return { id: articleId, config_keywords: full };
}

/**
 * Update metadata by article id (compatible with the legacy updateRaw usage; rowId = articleId)
 */
async function updateRaw(conn, articleId, configKeywords) {
  const { seo, geo, featured_image } = configKeywords || {};
  const sets = [];
  const vals = [];
  if (seo !== undefined && seo !== null) { sets.push('seo = ?'); vals.push(typeof seo === 'string' ? seo : JSON.stringify(seo)); }
  if (geo !== undefined && geo !== null) { sets.push('geo = ?'); vals.push(typeof geo === 'string' ? geo : JSON.stringify(geo)); }
  if (featured_image !== undefined) { sets.push('featured_image = ?'); vals.push(String(featured_image).trim() || null); }
  if (!sets.length) return;

  vals.push(articleId);
  await conn.query(
    `UPDATE ${TABLES.articles} SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`,
    vals
  );
}

module.exports = { getFull, upsertFull, getRawFull, updateRaw };
