/**
 * Articles main-table repository (db domain)
 * ============================================================================
 * Convergence note (batch B): before the refactor, the `tengence_geo_articles`
 * read/write SQL was scattered across publish-from-db.js (getArticleFromDB /
 * checkSlugExistsInDB / getDraftArticleIds / UPDATE wp_post_id,status,excerpt),
 * publish-draft.js (findArticleIdBySlug / createArticleRecord) and
 * save-article-to-db.js (UPDATE content_longtext). Now unified into this module;
 * table names always reference the TABLES constants in ./schema.js.
 *
 * Conventions: every function here receives the caller's connection; none opens its
 * own. To open a connection use db.withConn().
 * ============================================================================
 */

const { TABLES } = require('./schema');
const { parseJsonValue } = require('./value');

/**
 * Read an article (fields needed by the publish chain), returns a normalized object
 * @throws when the article does not exist
 */
async function getById(conn, articleId, appId) {
  const [articles] = await conn.query(
    `SELECT id, title, slug, content_longtext, excerpt, status, lang, region_market, wp_post_id
     FROM ${TABLES.articles}
     WHERE id = ? AND app_id = ?`,
    [articleId, appId]
  );

  if (articles.length === 0) {
    throw new Error(`Article ID ${articleId} not found`);
  }

  const article = articles[0];
  return {
    id: article.id,
    slug: article.slug,
    title: article.title,
    content: article.content_longtext || '',
    excerpt: article.excerpt || '',
    status: article.status,
    lang: article.lang,
    region: article.region_market ? { market: article.region_market } : null,
    wpPostId: article.wp_post_id,
  };
}

/** Look up an article id by slug (returns null when not found) */
async function findIdBySlug(conn, slug, appId) {
  const [rows] = await conn.query(
    `SELECT id FROM ${TABLES.articles} WHERE app_id = ? AND slug = ? LIMIT 1`,
    [appId, slug]
  );
  return rows.length ? rows[0].id : null;
}

/**
 * Check whether the slug already exists
 * @param {string|null} slug pass null to filter only by the excluded id (legacy behavior, kept)
 * @param {number|null} excludeId article to exclude
 * @returns {Promise<object|null>} the conflicting article record
 */
async function checkSlugExists(conn, slug, excludeId, appId) {
  let query = `SELECT id, slug, wp_post_id FROM ${TABLES.articles} WHERE slug = ? AND app_id = ?`;
  const params = [slug, appId];

  if (excludeId) {
    query += ' AND id != ?';
    params.push(excludeId);
  }

  const [rows] = await conn.query(query, params);
  return rows.length > 0 ? rows[0] : null;
}

/** All unpublished draft article ids */
async function findDraftIds(conn, appId) {
  const [articles] = await conn.query(
    `SELECT id FROM ${TABLES.articles}
     WHERE app_id = ? AND status IN ('draft', 'pending')
     AND wp_post_id IS NULL
     ORDER BY id`,
    [appId]
  );
  return articles.map((a) => a.id);
}

/** Insert an article record, returns the insertId */
async function insert(conn, { appId, title, slug, lang, region, status = 'draft' }) {
  const [result] = await conn.query(
    `INSERT INTO ${TABLES.articles} (app_id, title, slug, lang, region_market, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [appId, title, slug, lang, region, status]
  );
  return result.insertId;
}

/** Update the title only */
async function updateTitle(conn, articleId, title) {
  await conn.query(`UPDATE ${TABLES.articles} SET title = ? WHERE id = ?`, [title, articleId]);
}

/**
 * Save the body (optionally backfills the title) and refresh lastmod / updated_at
 * Only touches the body and title; never changes any metadata field.
 * @returns {Promise<number>} affected rows
 */
/**
 * Save the article body plus content-domain fields (2026-09-20 extension:
 * content_html / research_md / featured_image / seo / geo are written together;
 * seo/geo are serialized when they are objects.
 * The focus_keyword column retired on 2026-09-20: the primary keyword now lives in
 * the article plan table)
 * @param {object} data { content, title?, content_html?, research_md?, featured_image?, seo?, geo? }
 */
async function saveContent(conn, articleId, appId, { content, title, content_html, research_md, featured_image, seo, geo }) {
  const updateData = { content_longtext: content };
  if (title !== undefined) updateData.title = title;
  if (content_html !== undefined) updateData.content_html = content_html;
  if (research_md !== undefined) updateData.research_md = research_md;
  if (featured_image !== undefined) updateData.featured_image = featured_image;
  if (seo !== undefined) updateData.seo = typeof seo === 'string' ? seo : JSON.stringify(seo);
  if (geo !== undefined) updateData.geo = typeof geo === 'string' ? geo : JSON.stringify(geo);

  const setClause = [];
  const values = [];
  for (const [key, value] of Object.entries(updateData)) {
    if (value === null || value === undefined) continue;
    // Writing '' into JSON columns breaks JSON semantics: convert to NULL
    const final = (['seo', 'geo'].includes(key) && value === '') ? null : value;
    if (final === null && ['seo', 'geo'].includes(key)) { setClause.push(`${key} = NULL`); continue; }
    setClause.push(`${key} = ?`);
    values.push(value);
  }

  values.push(articleId, appId);

  const [result] = await conn.query(
    `UPDATE ${TABLES.articles}
     SET ${setClause.join(', ')} , lastmod = NOW(), updated_at = NOW()
     WHERE id = ? AND app_id = ?`,
    values
  );
  return result.affectedRows;
}

/**
 * Write-back after a successful publish: wp_post_id / status / excerpt + timestamps
 * @param {{wpPostId:number|string, status:string, excerpt:string}} data
 */
async function markPublished(conn, articleId, appId, data) {
  await conn.query(
    `UPDATE ${TABLES.articles}
     SET wp_post_id = ?, status = ?, excerpt = ?, published_at = NOW(), lastmod = NOW()
     WHERE id = ? AND app_id = ?`,
    [data.wpPostId, data.status, data.excerpt, articleId, appId]
  );
}

/** Look up an article title by slug (returns null when not found) */
async function findTitleBySlug(conn, slug, appId) {
  const [rows] = await conn.query(
    `SELECT title FROM ${TABLES.articles} WHERE slug = ? AND app_id = ?`,
    [slug, appId]
  );
  return rows.length && rows[0].title ? rows[0].title : null;
}

/**
 * List articles (list view): includes category/tag aggregation
 * 2026-09-14 entry-layer refactor: moved verbatim from listArticles in
 * commands/db-query.js, SQL unchanged byte-for-byte.
 *
 * @param {object} filters { status, category, lang, limit }
 */
async function list(conn, appId, filters = {}) {
  let query = `
        SELECT a.id, a.slug, a.title, a.status, a.lang, a.region_market,
               a.date, a.lastmod, a.published_at,
               GROUP_CONCAT(DISTINCT c.name ORDER BY ac.position SEPARATOR ', ') as categories,
               GROUP_CONCAT(DISTINCT t.name SEPARATOR ', ') as tags
        FROM ${TABLES.articles} a
        LEFT JOIN ${TABLES.articleCategories} ac ON a.id = ac.article_id AND ac.app_id = a.app_id
        LEFT JOIN ${TABLES.categories} c ON ac.category_id = c.id AND c.app_id = a.app_id
        LEFT JOIN ${TABLES.articleTags} at ON a.id = at.article_id AND at.app_id = a.app_id
        LEFT JOIN ${TABLES.tags} t ON at.tag_id = t.id AND t.app_id = a.app_id
        WHERE a.app_id = ?
    `;

  const params = [appId];

  if (filters.status) {
    query += ' AND a.status = ?';
    params.push(filters.status);
  }

  if (filters.category) {
    query += ` AND EXISTS (SELECT 1 FROM ${TABLES.articleCategories} ac2 WHERE ac2.article_id = a.id AND ac2.app_id = a.app_id AND ac2.category_id = (SELECT id FROM ${TABLES.categories} WHERE app_id = ? AND slug = ? LIMIT 1))`;
    params.push(appId, filters.category);
  }

  if (filters.lang) {
    query += ' AND a.lang = ?';
    params.push(filters.lang);
  }

  query += ' GROUP BY a.id ORDER BY a.lastmod DESC';

  if (filters.limit) {
    query += ' LIMIT ?';
    params.push(parseInt(filters.limit));
  }

  const [articles] = await conn.query(query, params);
  return articles;
}

/**
 * Normalize the different citation source shapes into { url, text }
 * (config.geo.citations uses {url,text}; legacy tables use {source,claim})
 */
function normalizeCitation(c) {
  if (!c) return { url: '', text: '' };
  if (c.url !== undefined || c.text !== undefined) return { url: c.url || '', text: c.text || '' };
  return { url: c.source || '', text: c.claim || '' };
}

/**
 * Read a single article detail: article + category/tag aggregation + SEO / GEO / QA /
 * Citations / Social / vector status
 *
 * 2026-09-20 merge refactor: SEO/GEO are read directly from the articles table's
 * seo/geo columns (the article_config table retired; legacy seo/geo/qa_pairs/citations
 * tables are no longer read). Returns null when the article is not found.
 */
async function getDetail(conn, appId, slug) {
  const [articles] = await conn.query(
    `SELECT a.*,
                GROUP_CONCAT(DISTINCT c.name ORDER BY ac.position SEPARATOR ', ') as categories,
                GROUP_CONCAT(DISTINCT t.name SEPARATOR ', ') as tags
         FROM ${TABLES.articles} a
         LEFT JOIN ${TABLES.articleCategories} ac ON a.id = ac.article_id AND ac.app_id = a.app_id
         LEFT JOIN ${TABLES.categories} c ON ac.category_id = c.id AND c.app_id = a.app_id
         LEFT JOIN ${TABLES.articleTags} at ON a.id = at.article_id AND at.app_id = a.app_id
         LEFT JOIN ${TABLES.tags} t ON at.tag_id = t.id AND t.app_id = a.app_id
         WHERE a.app_id = ? AND a.slug = ?
         GROUP BY a.id`,
    [appId, slug]
  );

  if (articles.length === 0) {
    return null;
  }

  const article = articles[0];

  // 2026-09-20 merge refactor: SEO/GEO read directly from the articles columns (article_config retired)
  article.seo = parseJsonValue(article.seo, null);
  article.geo = parseJsonValue(article.geo, null);

  // QA Pairs / Citations: extracted from the geo column (normalized to {url, text})
  article.qa_pairs = (article.geo && Array.isArray(article.geo.qa_pairs)) ? article.geo.qa_pairs : [];
  const geoCitations = (article.geo && Array.isArray(article.geo.citations)) ? article.geo.citations : [];
  article.citations = geoCitations.map(normalizeCitation);

  // Social / vector status: legacy tables only (the articles columns carry neither)
  const [social] = await conn.query(`SELECT * FROM ${TABLES.social} WHERE article_id = ?`, [article.id]);
  article.social = social[0] || null;

  const [vectors] = await conn.query(`SELECT * FROM ${TABLES.vectors} WHERE article_id = ?`, [article.id]);
  article.vector = vectors[0] || null;

  return article;
}

module.exports = {
  getById,
  findIdBySlug,
  findTitleBySlug,
  checkSlugExists,
  findDraftIds,
  insert,
  updateTitle,
  saveContent,
  markPublished,
  list,
  getDetail,
};
