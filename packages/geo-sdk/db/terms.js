/**
 * Category / tag term repository (db domain)
 * ============================================================================
 * Convergence note (batch B): the whole "targeted registration of terms and article
 * assignments from taxonomy.yaml" logic used to live in
 * packages/geo-cli/bin/taxonomy.js (getOrCreateDbTerm + registerDatabase, ~100 lines).
 * That logic is CLI-independent and needs transactional semantics, so batch B moved
 * it into this module; the CLI degraded to a thin shell.
 *
 * ⚠️ Only targeted registration (--slugs given, or taxonomy.yaml entries that carry a
 *    wp_post_id) — NEVER a "full database rebuild": the DB still holds 290+ legacy
 *    articles outside the taxonomy (wp_post_id = null), and a full DELETE-then-INSERT
 *    would silently rewrite them.
 * ============================================================================
 */

const { TABLES } = require('./schema');
const { withConn } = require('./connection');
const { parseJsonValue } = require('./value');

/** Get or create a term (category / tag); syncs name when it exists; returns its id */
async function getOrCreateTerm(conn, table, appId, slug, definition) {
  const [rows] = await conn.query(
    `SELECT id FROM ${table} WHERE app_id = ? AND slug = ? LIMIT 1`,
    [appId, slug]
  );
  if (rows.length) {
    await conn.query(
      `UPDATE ${table} SET name = ? WHERE id = ? AND app_id = ?`,
      [definition.name, rows[0].id, appId]
    );
    return rows[0].id;
  }
  const [result] = await conn.query(
    `INSERT INTO ${table} (app_id, name, slug) VALUES (?, ?, ?)`,
    [appId, definition.name, slug]
  );
  return result.insertId;
}

/**
 * Targeted registration: write taxonomy.yaml article assignments into the DB
 * (category/tag terms + links + config sync)
 *
 * @param {object} opts
 * @param {object} opts.taxonomy  parsed taxonomy.yaml (categories / tags / articles)
 * @param {number} opts.appId
 * @param {string[]} [opts.slugFilter] process only these slugs; empty array = all entries with a wp_post_id
 * @returns {Promise<Array>} one report entry per processed item
 */
async function register({ taxonomy, appId, slugFilter = [] }) {
  const categories = taxonomy.categories || {};
  const tags = taxonomy.tags || {};
  const articles = taxonomy.articles || {};

  return withConn(async (connection) => {
    await connection.beginTransaction();
    try {
      const categoryIds = {};
      for (const [slug, definition] of Object.entries(categories)) {
        categoryIds[slug] = await getOrCreateTerm(connection, TABLES.categories, appId, slug, definition);
      }
      const tagIds = {};
      for (const [slug, definition] of Object.entries(tags)) {
        tagIds[slug] = await getOrCreateTerm(connection, TABLES.tags, appId, slug, definition);
      }

      const targets = Object.entries(articles).filter(([slug, item]) =>
        item.wp_post_id && (slugFilter.length === 0 || slugFilter.includes(slug))
      );

      const report = [];
      for (const [slug, assignment] of targets) {
        const [rows] = await connection.query(
          `SELECT id FROM ${TABLES.articles} WHERE app_id = ? AND slug = ? LIMIT 1`,
          [appId, slug]
        );
        if (!rows.length) {
          report.push({ slug, status: 'skipped', reason: 'not found in database' });
          continue;
        }
        const article = rows[0];

        const [[beforeCategory]] = await connection.query(
          `SELECT COUNT(*) n FROM ${TABLES.articleCategories} WHERE app_id = ? AND article_id = ?`,
          [appId, article.id]
        );
        const [[beforeTag]] = await connection.query(
          `SELECT COUNT(*) n FROM ${TABLES.articleTags} WHERE app_id = ? AND article_id = ?`,
          [appId, article.id]
        );

        await connection.query(
          `DELETE FROM ${TABLES.articleCategories} WHERE app_id = ? AND article_id = ?`,
          [appId, article.id]
        );
        await connection.query(
          `INSERT INTO ${TABLES.articleCategories} (article_id, app_id, category_id, position)
           VALUES (?, ?, ?, 0)`,
          [article.id, appId, categoryIds[assignment.category]]
        );

        await connection.query(
          `DELETE FROM ${TABLES.articleTags} WHERE app_id = ? AND article_id = ?`,
          [appId, article.id]
        );
        for (const tagSlug of assignment.tags) {
          await connection.query(
            `INSERT INTO ${TABLES.articleTags} (article_id, app_id, tag_id) VALUES (?, ?, ?)`,
            [article.id, appId, tagIds[tagSlug]]
          );
        }

        // 2026-09-20: article_config retired; category/tags are managed by the article
        // plan table (getFull reverse-look-up), so no config sync key is written back.
        report.push({
          id: article.id,
          slug,
          category: assignment.category,
          tags: assignment.tags,
          before: { categories: beforeCategory.n, tags: beforeTag.n },
          after: { categories: 1, tags: assignment.tags.length },
          config_synced: false,
        });
      }

      await connection.commit();
      return report;
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  });
}

/**
 * List all categories (read-only)
 * 2026-09-14 entry-layer refactor: moved verbatim from listCategories in
 * commands/db-query.js, SQL unchanged byte-for-byte.
 */
async function listCategories(conn, appId) {
  const [categories] = await conn.query(
    `SELECT * FROM ${TABLES.categories} WHERE app_id = ? ORDER BY name`,
    [appId]
  );
  return categories;
}

/**
 * List all tags (read-only)
 * 2026-09-14 entry-layer refactor: moved verbatim from listTags in
 * commands/db-query.js, SQL unchanged byte-for-byte.
 */
async function listTags(conn, appId) {
  const [tags] = await conn.query(
    `SELECT * FROM ${TABLES.tags} WHERE app_id = ? ORDER BY name`,
    [appId]
  );
  return tags;
}

module.exports = { getOrCreateTerm, register, parseJsonValue, listCategories, listTags };
