'use strict';
/**
 * taxonomy domain (tengence-geo-sdk/taxonomy)
 * ============================================================================
 * Sunk down from commands/taxonomy.js on 2026-09-20: whitelist + plan-table
 * loading, taxonomy validity checks, DB term registration (db-register
 * orchestration), DB association verification, WP assignment verification,
 * three-way verify orchestration, and wp-cleanup orchestration. Printing stays in
 * the SDK (byte-identical to the CLI output), shared by the CLI and
 * publish-draft's in-process direct call (no subprocess).
 *
 * Data sources (since 2026-09-20 P2, taxonomy.yaml has been retired):
 *   - category/tag whitelist: DB categories / tags tables
 *     (t.plan.categoryWhitelist / tagWhitelist)
 *   - article assignments (category / tags / wp_post_id): the article plan table
 *     tengence_geo_article_plan
 *
 * Note: this domain has no shared mutable state (the original CLI's module-level
 * WHITELIST/PLAN_ROWS became function parameters), so it can safely be called
 * multiple times / concurrently.
 * ============================================================================
 */

const t = require('../index');
const { TABLES } = t.db;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TAGS_PER_ARTICLE = 3; // former taxonomy.yaml rules.max_tags_per_article

/** Load the whitelist + plan table (the DB is the single source of truth) */
async function loadSources(appId) {
  const cats = await t.plan.categoryWhitelist();
  const tagRows = await t.plan.tagWhitelist();
  const categories = Object.fromEntries(cats.map((c) => [c.slug, c]));
  const tags = Object.fromEntries(tagRows.map((r) => [r.slug, r]));
  const planRows = await t.plan.list({ nodeType: 'spoke' });
  return { categories, tags, planRows, appId };
}

/** Plan-table rows → the articles structure consumed by t.db.terms.register */
function planToArticles(planRows) {
  const out = {};
  for (const p of planRows) {
    out[p.slug] = { category: p.category, tags: p.tags || [], wp_post_id: p.wp_post_id };
  }
  return out;
}

/** Whitelist + plan-table validity checks (complements db/terms's rule checks) */
async function validateTaxonomy({ categories, tags, planRows }) {
  const errors = [];
  for (const [slug, item] of Object.entries(categories)) {
    if (!SLUG_PATTERN.test(slug)) errors.push(`Invalid category slug: ${slug}`);
    if (!item.name) errors.push(`Missing category name: ${slug}`);
  }
  for (const [slug, item] of Object.entries(tags)) {
    if (!SLUG_PATTERN.test(slug)) errors.push(`Invalid tag slug: ${slug}`);
    if (!item.name) errors.push(`Missing tag name: ${slug}`);
  }
  for (const p of planRows) {
    if (!categories[p.category]) errors.push(`${p.slug}: unknown category ${p.category}`);
    if (!Array.isArray(p.tags)) errors.push(`${p.slug}: tags must be an array`);
    if ((p.tags || []).length > MAX_TAGS_PER_ARTICLE) {
      errors.push(`${p.slug}: more than ${MAX_TAGS_PER_ARTICLE} tags`);
    }
    for (const tagSlug of p.tags || []) {
      if (!tags[tagSlug]) errors.push(`${p.slug}: unknown tag ${tagSlug}`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

/**
 * DB term-association registration (idempotent; only touches plan-table rows with a
 * non-null wp_post_id, never rewrites articles outside the plan)
 * @returns {Promise<Array>} register report (also console.logs the same JSON as the
 *         original CLI)
 */
async function registerDatabase({ slugFilter = [], appId }) {
  const src = await loadSources(appId);
  await validateTaxonomy(src);
  const taxonomy = {
    categories: src.categories,
    tags: src.tags,
    articles: planToArticles(src.planRows),
    rules: { max_tags_per_article: MAX_TAGS_PER_ARTICLE },
  };
  const report = await t.db.terms.register({ taxonomy, appId, slugFilter });
  console.log(JSON.stringify({ action: 'db-register', articles: report.length, report }, null, 2));
  return report;
}

/** WP-side article-category/tag assignment verification (row-by-row vs the plan) */
async function assertWpAssignments(planRows) {
  const wpCategories = await t.wp.apiAll('categories', { context: 'edit', hide_empty: 'false' });
  const wpTags = await t.wp.apiAll('tags', { context: 'edit', hide_empty: 'false' });
  const categoryBySlug = new Map(wpCategories.map((item) => [item.slug, item]));
  const tagBySlug = new Map(wpTags.map((item) => [item.slug, item]));
  const errors = [];

  for (const p of planRows) {
    if (!p.wp_post_id) continue;
    const post = await t.wp.api(
      `/posts/${p.wp_post_id}?context=edit&_fields=id,slug,categories,tags`
    );
    const expectedCategory = categoryBySlug.get(p.category);
    const expectedTags = (p.tags || []).map((tagSlug) => tagBySlug.get(tagSlug)).filter(Boolean);
    if (!expectedCategory || post.categories.length !== 1 || post.categories[0] !== expectedCategory.id) {
      errors.push(`${p.slug}: category mismatch`);
    }
    const actualTagIds = [...post.tags].sort((a, b) => a - b);
    const expectedTagIds = expectedTags.map((item) => item.id).sort((a, b) => a - b);
    if (JSON.stringify(actualTagIds) !== JSON.stringify(expectedTagIds)) {
      errors.push(`${p.slug}: tag mismatch`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { wpCategories, wpTags };
}

/** DB association verification: whitelist ↔ plan table ↔ DB term associations ↔ wp_post_id */
async function verifyDatabase({ categories, tags, planRows, appId }) {
  return t.db.withConn(async (connection) => {
    const [dbCategories] = await connection.query(
      `SELECT id, name, slug FROM ${TABLES.categories} WHERE app_id = ? ORDER BY slug`,
      [appId]
    );
    const [dbTags] = await connection.query(
      `SELECT id, name, slug FROM ${TABLES.tags} WHERE app_id = ? ORDER BY slug`,
      [appId]
    );
    const [dbArticles] = await connection.query(
      `SELECT a.id, a.slug, a.wp_post_id,
              GROUP_CONCAT(DISTINCT c.slug ORDER BY ac.position) category_slugs,
              GROUP_CONCAT(DISTINCT t.slug ORDER BY t.slug) tag_slugs
       FROM ${TABLES.articles} a
       LEFT JOIN ${TABLES.articleCategories} ac ON ac.article_id = a.id AND ac.app_id = a.app_id
       LEFT JOIN ${TABLES.categories} c ON c.id = ac.category_id AND c.app_id = ac.app_id
       LEFT JOIN ${TABLES.articleTags} atg ON atg.article_id = a.id AND atg.app_id = a.app_id
       LEFT JOIN ${TABLES.tags} t ON t.id = atg.tag_id AND t.app_id = atg.app_id
       WHERE a.app_id = ? GROUP BY a.id ORDER BY a.id`,
      [appId]
    );

    const errors = [];
    const categorySlugs = dbCategories.map((item) => item.slug).sort();
    const tagSlugs = dbTags.map((item) => item.slug).sort();
    if (JSON.stringify(categorySlugs) !== JSON.stringify(Object.keys(categories).sort())) {
      errors.push('Database category set mismatch');
    }
    if (JSON.stringify(tagSlugs) !== JSON.stringify(Object.keys(tags).sort())) {
      errors.push('Database tag set mismatch');
    }
    for (const article of dbArticles) {
      const plan = planRows.find((p) => p.slug === article.slug && p.article_id === article.id);
      if (!plan) continue; // articles outside the plan aren't checked (legacy non-plan articles)
      if (article.category_slugs !== plan.category) errors.push(`${article.slug}: DB category mismatch`);
      const actualTags = article.tag_slugs ? article.tag_slugs.split(',').sort() : [];
      if (JSON.stringify(actualTags) !== JSON.stringify([...(plan.tags || [])].sort())) {
        errors.push(`${article.slug}: DB tags mismatch`);
      }
      if (plan.wp_post_id && article.wp_post_id !== plan.wp_post_id) {
        errors.push(`${article.slug}: wp_post_id mismatch`);
      }
    }
    if (errors.length) throw new Error(errors.join('\n'));
    return { articles: dbArticles.length, categories: dbCategories.length, tags: dbTags.length };
  });
}

/** Local verification: written/queued/published plan rows must have a body row in the articles table */
async function verifyLocal(planRows, appId, categories) {
  const warnings = [];
  let checked = 0;
  // Since 2026-09-20: local md moved to data/ and is untracked; "ingested" = a body
  // row exists in the articles table
  const rows = await t.db.withConn(async (conn) => {
    const [r] = await conn.query('SELECT slug FROM tengence_geo_articles WHERE app_id = ? AND content_longtext IS NOT NULL', [appId]);
    return r;
  });
  const dbSlugs = new Set(rows.map((r) => r.slug));
  for (const p of planRows) {
    if (!['written', 'queued', 'published'].includes(p.plan_status)) continue;
    if (!p.category) continue;
    if (!dbSlugs.has(p.slug)) warnings.push(`${p.slug}: no body row in the articles table (only ingested counts as written/queued/published; may be a legacy article awaiting merge)`);
    checked += 1;
  }
  return { files: checked, directories: Object.keys(categories).length, warnings };
}

/**
 * Three-way verification: DB whitelist ↔ plan table ↔ DB associations ↔ WP
 * categories/tags + local md (console.logs the same JSON as the original CLI)
 * @returns {Promise<object>} verification summary
 */
async function verify({ appId }) {
  const src = await loadSources(appId);
  await validateTaxonomy(src);
  const [{ wpCategories, wpTags }, database] = await Promise.all([
    assertWpAssignments(src.planRows),
    verifyDatabase(src),
  ]);
  const local = await verifyLocal(src.planRows, appId, src.categories);
  const wpCategorySlugs = wpCategories.map((item) => item.slug).sort();
  const wpTagSlugs = wpTags.map((item) => item.slug).sort();
  const errors = [];
  if (JSON.stringify(wpCategorySlugs) !== JSON.stringify(Object.keys(src.categories).sort())) {
    errors.push('WordPress category set mismatch');
  }
  if (JSON.stringify(wpTagSlugs) !== JSON.stringify(Object.keys(src.tags).sort())) {
    errors.push('WordPress tag set mismatch');
  }
  if (errors.length) throw new Error(errors.join('\n'));
  const result = {
    wordpress: {
      categories: wpCategories.length,
      tags: wpTags.length,
      posts: src.planRows.filter((p) => p.wp_post_id).length,
    },
    database,
    local,
  };
  console.log(JSON.stringify({ action: 'verify', ...result }, null, 2));
  return result;
}

/** Delete non-canonical WP categories/tags (whitelist from the DB; diagnostic tool
 * only, use with care) */
async function cleanup({ appId }) {
  const src = await loadSources(appId);
  await validateTaxonomy(src);
  const { wpCategories, wpTags } = await assertWpAssignments(src.planRows);
  const categoryBySlug = new Map(wpCategories.map((item) => [item.slug, item]));
  const defaultCategory = categoryBySlug.get('product-solutions');
  if (!defaultCategory) throw new Error('Canonical default category product-solutions is missing');
  await t.wp.api('/settings', { method: 'POST', body: { default_category: defaultCategory.id } });

  const deletedCategories = [];
  for (const item of wpCategories) {
    if (src.categories[item.slug]) continue;
    await t.wp.api(`/categories/${item.id}?force=true`, { method: 'DELETE' });
    deletedCategories.push({ id: item.id, slug: item.slug });
  }

  const deletedTags = [];
  for (const item of wpTags) {
    if (src.tags[item.slug]) continue;
    await t.wp.api(`/tags/${item.id}?force=true`, { method: 'DELETE' });
    deletedTags.push({ id: item.id, slug: item.slug });
  }

  console.log(JSON.stringify({
    action: 'wp-cleanup',
    deleted_categories: deletedCategories,
    deleted_tags: deletedTags,
  }, null, 2));
  return { deletedCategories, deletedTags };
}

module.exports = { registerDatabase, verify, cleanup };
