/**
 * Category / tag dictionary repository (db domain)
 * ============================================================================
 * Read-only: the categories / tags tables are the publish allow-list (the only
 * source of canonical category/tag slugs since taxonomy.yaml was retired on
 * 2026-09-20).
 *
 * 2026-11-24: the write half of this module (`getOrCreateTerm` / `register`) and the
 * article_categories / article_tags association tables were removed. They mirrored
 * the plan row's category/tags into a second copy that was never written by the main
 * pipeline and never read by anything that mattered (list/detail now read the plan
 * row directly). `getFull` and publish resolve category/tags from the plan table.
 * ============================================================================
 */

const { TABLES } = require('./schema');
const { parseJsonValue } = require('./value');

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

module.exports = { parseJsonValue, listCategories, listTags };
