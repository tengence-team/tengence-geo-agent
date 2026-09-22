/**
 * Article body save script
 *
 * Features:
 * 1. Read a local Markdown body file
 * 2. Write the body into the content_longtext column and refresh lastmod
 * 3. Optional: backfill title from the file's first H1 (--title)
 *
 * Notes: this script synchronously writes back the articles content-domain columns
 * (md is authoritative):
 *   - featured_image: updated when front matter has it (legacy files; not overwritten
 *     when new drafts have no front matter)
 *   - seo: front-matter seo merged into the existing seo column (focus_keyword is not
 *     persisted — the primary keyword follows the article plan table)
 *   - geo: reverse-parses the three GEO blocks (key takeaways / FAQ / citations) from
 *     the body, overriding with Markdown as authoritative
 * Category / tags / publish status / schedule: the article plan table (single source of truth)
 *
 * Usage: tengence-geo article-save.js <article_id> <file_path> [--title] [--site <key>]
 *
 * B-batch refactor: stripFrontMatter / extractTitle now use tengence-geo-sdk's content.md;
 * SQL uses db.articles.saveContent; connections go through db.withConn.
 * ⚠️ Keep the charset=utf8mb4 override (this script set it explicitly before the refactor;
 *    other scripts did not).
 */

const fs = require('fs');
const path = require('path');
const t = require('@tengence/geo-sdk');

// Load site config (--site <key>, default tengence): reads DB credentials from sites/<site>/.env
t.site.loadSite();

const APP_ID = process.env.APP_ID || 1;

// Reuse the SDK's content.md (public exports unchanged)
const {
  stripFrontMatter,
  extractTitle,
  parseFrontMatter,
  syncGeoFromMarkdown,
} = t.content.md;
// db-domain JSON-tolerant parsing (seo/geo columns may read back as object or string)
const dbValue = require('@tengence/geo-sdk/db/value');

/**
 * Save the article body to the database
 */
async function saveArticleToDatabase(articleId, filePath, options = {}) {
  const { updateTitle = false } = options;

  // Read the file (front matter: kept for legacy files, may be absent in new drafts;
  // the md body is authoritative)
  const rawContent = fs.readFileSync(filePath, 'utf8');
  const { data: fm } = parseFrontMatter(rawContent);
  const content = stripFrontMatter(rawContent);
  const headingTitle = extractTitle(content);

  console.log(`📄 File: ${path.basename(filePath)}`);
  console.log(`📝 Body title (H1): ${headingTitle || 'no H1 found'}`);
  console.log(`📏 Content length: ${content.length} chars\n`);

  if (updateTitle && !headingTitle) {
    throw new Error('No H1 title found, cannot backfill title; add a "# Title" at the top of the file first');
  }

  // Field merge against the existing articles row (md authoritative: reverse-parsed geo
  // overrides, front matter merges into seo)
  const payload = await t.db.withConn(async (connection) => {
    // 2026-09-20 fix: the original getDetail(conn, appId, slug) was mis-called as
    // (conn, articleId, APP_ID), so no row was ever found; here we read the seo/geo
    // columns directly by id (getDetail signature stays (conn, appId, slug))
    const [detailRows] = await connection.query(
      'SELECT seo, geo FROM tengence_geo_articles WHERE id = ? AND app_id = ?',
      [articleId, APP_ID]
    );
    if (!detailRows.length) throw new Error(`Article ID ${articleId} not found (app_id ${APP_ID})`);
    const detail = detailRows[0];

    const prevSeo = dbValue.parseJsonValue(detail.seo, {});
    const fmSeo = (fm && fm.seo && typeof fm.seo === 'object') ? fm.seo : {};
    const seo = Object.assign({}, prevSeo, fmSeo); // legacy values kept; front matter overrides when present
    // focus_keyword is not persisted to the seo column (2026-09-20: the primary keyword
    // follows the article plan table; used for plan-internal decisions only)
    if (seo && 'focus_keyword' in seo) delete seo.focus_keyword;

    const prevGeo = dbValue.parseJsonValue(detail.geo, {});
    const synced = syncGeoFromMarkdown(content, prevGeo); // the three GEO blocks follow the body
    const geo = synced.geo || prevGeo;

    const fmFi = (fm && fm.featured_image) ? String(fm.featured_image).trim() : undefined;

    console.log(`🔍 GEO updated from Markdown: ${synced.changed.length ? synced.changed.join(' / ') : '(body already contains the three blocks, no change)'}`);
    return {
      content,
      title: updateTitle ? headingTitle : undefined,
      seo: Object.keys(seo).length ? seo : undefined,
      geo: Object.keys(geo || {}).length ? geo : undefined,
      featured_image: fmFi || undefined,
    };
  });

  console.log(`💾 Saving body to database (ID: ${articleId})...\n`);

  const affectedRows = await t.db.withConn(
    (connection) =>
      t.db.articles.saveContent(connection, articleId, APP_ID, payload),
    { charset: 'utf8mb4' }
  );

  if (affectedRows === 0) {
    throw new Error(`Article ID ${articleId} not found (app_id ${APP_ID}); double-check the article ID`);
  }

  console.log(`✅ Body updated (ID: ${articleId}, affected rows: ${affectedRows})`);
  if (updateTitle) {
    console.log(`✅ Title backfilled: ${headingTitle}`);
  }
  console.log('✅ lastmod refreshed\n');

  return { success: true, articleId };
}

/**
 * Main
 */
async function main() {
  const rawArgs = process.argv.slice(2);

  // Strip --site <key> (site loading already happened at module load), keep positionals
  const args = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--site') { i++; continue; }
    if (rawArgs[i].startsWith('--site=')) continue;
    args.push(rawArgs[i]);
  }

  if (args.length < 2) {
    console.log(`
Usage: tengence-geo article-save.js <article_id> <file_path> [--title] [--site <key>]

Arguments:
  <article_id>   the article ID in the database
  <file_path>    path to the local Markdown body file
  --title        optional, backfill the DB title from the file's first H1
  --site <key>   optional, site key (default: tengence)

Notes:
  By default only the body (content_longtext) and lastmod are updated; status, lang,
  region, author, SEO/GEO config and other metadata fields are left untouched.

Examples:
  tengence-geo article-save.js 6 sites/tengence/data/inbox/zh-CN/seo-geo-dual-engine-case-study.md
  tengence-geo article-save.js 6 sites/tengence/data/inbox/zh-CN/seo-geo-dual-engine-case-study.md --title
    `);
    process.exit(1);
  }

  const articleId = parseInt(args[0]);
  const filePath = args[1];
  const updateTitle = args.includes('--title');

  if (Number.isNaN(articleId)) {
    console.error(`❌ article_id must be a number: ${args[0]}`);
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }

  try {
    await saveArticleToDatabase(articleId, filePath, { updateTitle });
    console.log('✅ Done!');
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { stripFrontMatter, extractTitle, parseFrontMatter, saveArticleToDatabase };
