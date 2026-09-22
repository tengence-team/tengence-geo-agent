#!/usr/bin/env node
/**
 * Publish an article from the database to WordPress
 * Usage: tengence-geo publish-from-db.js <article_id> [options]
 *
 * Category/tag single source of truth (from P2 on 2026-09-20): the article plan table
 * (t.plan.getByArticleId), falling back to config when no plan row exists (legacy
 * compatibility); the allow-list comes from the DB categories / tags tables.
 *
 * Options:
 *   --site <key>          site key (default: tengence); reads sites/<key>/.env and config
 *   --status=draft|publish  publish status (default: draft)
 *   --force               force-update an existing article
 *   --dry-run             validation mode, does not actually publish
 *   --batch=1,2,3         publish multiple articles in batch
 *   --all                 publish all draft articles
 *   --featured-media <id>  force a specific WP media ID as the featured image
 *   --skip-gsc            skip Google Search Console sitemap submission after publishing
 *                         (default: submitted on publish)
 *   --skip-indexnow       skip IndexNow submission after publishing (default: submitted
 *                         on publish; requires INDEXNOW_KEY)
 *   --skip-baidu          skip Baidu normal-inclusion submission after publishing
 *                         (default: submitted on publish; requires BAIDU_TOKEN)
 *
 * GSC submission: when status=publish and publish succeeds, automatically calls
 * t.search.submitSitemap to refresh the sitemap (soft-fail: network/permission issues only
 * warn + write data/submit-log.jsonl, do not block publishing; CN networks need
 * HTTPS_PROXY, see tengence-geo-sdk/search/http.js).
 * IndexNow submission: auto-submits the new article URL under the same conditions
 * (t.search.indexnow.submitUrls); requires INDEXNOW_KEY in .env (see packages/geo-sdk/search/indexnow.js).
 * Baidu submission: POSTs to data.zz.baidu.com under the same conditions (direct CN access);
 * requires BAIDU_TOKEN in .env (see packages/geo-sdk/search/baidu.js).
 *
 * 2026-09-20 sink-down: the publish orchestration moved into tengence-geo-sdk/publish
 * (publishArticle); this file only does "parse args → create connection → call
 * publishArticle → print summary". CLI usage and output are unchanged.
 */

const t = require('@tengence/geo-sdk');
const { publishArticle, getDraftArticleIds, loadTaxonomyWhitelist, getState } = t.publish;
const { parse } = t.cli.args;

// Load site config (--site <key>, default tengence): reads credentials from sites/<site>/.env
t.site.loadSite();

// DB connection params (the original connectTimeout stays at 60s so slow links are not cut off early)
const DB_OVERRIDES = { connectTimeout: 60000 };

function usage() {
  console.log('Usage: tengence-geo publish-from-db.js <article_id> [options]');
  console.log('Options:');
  console.log('  --site <key>          site key (default: tengence)');
  console.log('  --status=draft|publish  publish status (default: draft)');
  console.log('  --force               force-update an existing article');
  console.log('  --dry-run             validation mode, does not actually publish');
  console.log('  --batch=1,2,3         publish multiple articles in batch');
  console.log('  --all                 publish all draft articles');
  console.log('  --featured-media <id>  force a specific WP media ID as the featured image (produced by the image pipeline)');
  console.log('  --skip-gsc            skip Google Search Console sitemap submission after publishing');
  console.log('  --skip-indexnow       skip IndexNow submission after publishing (default: submitted, requires INDEXNOW_KEY)');
  console.log('  --skip-baidu          skip Baidu normal-inclusion submission after publishing (default: submitted, requires BAIDU_TOKEN)');
  process.exit(1);
}

async function main() {
  // Validate site credentials and endpoint (keeps original wording; matches the pre-sink-down
  // module-load-time validation behavior)
  const s = getState();
  if (!s.CONFIG.wp.username || !s.CONFIG.wp.password) {
    console.error(`✗ Missing WordPress credentials: set WP_USERNAME / WP_PASSWORD in sites/${s.SITE.siteKey}/.env`);
    process.exit(1);
  }
  if (!s.CONFIG.wp.url) {
    console.error(`✗ Missing WordPress endpoint: set WP_URL (and optionally WP_API_URL) in sites/${s.SITE.siteKey}/.env`);
    process.exit(1);
  }
  if (!s.SITE_DOMAIN) {
    console.error(
      `✗ Missing site domain: set SITE_DOMAIN in sites/${s.SITE.siteKey}/.env, or fill in site.domain in config/site.yaml`
    );
    process.exit(1);
  }

  // Argument parsing (t.cli.args.parse; --site is parsed internally by site-config, not consumed here)
  const { positionals, flags } = parse(
    {
      site: { type: 'string' },
      status: { type: 'string', default: 'draft' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      batch: { type: 'array' },
      all: { type: 'boolean' },
      'featured-media': { type: 'string' },
      'skip-gsc': { type: 'boolean' },
      'skip-indexnow': { type: 'boolean' },
      'skip-baidu': { type: 'boolean' },
    },
    process.argv.slice(2)
  );

  const status = flags.status;
  const force = flags.force;
  const dryRun = flags['dry-run'];
  const featuredMedia = flags['featured-media'];
  const skipGsc = flags['skip-gsc'];
  const skipIndexnow = flags['skip-indexnow'];
  const skipBaidu = flags['skip-baidu'];

  let articleIds = positionals.map((x) => parseInt(x));
  let batch = false;
  if (flags.all) batch = true;
  if (flags.batch && flags.batch.length) {
    batch = true;
    articleIds = flags.batch.flatMap((v) => String(v).split(',').map((x) => parseInt(x.trim())));
  }

  if (articleIds.length === 0 && !batch) {
    usage();
  }

  // Category/tag allow-list comes from the DB categories / tags tables (taxonomy.yaml retired)
  await loadTaxonomyWhitelist();

  // Create the DB connection (keeps the original message and exit code on failure)
  let connection;
  try {
    connection = await t.db.createConnection(DB_OVERRIDES);
    console.log('✓ Database connected');
  } catch (error) {
    console.error('✗ Database connection failed:', error.message);
    process.exit(1);
  }

  try {
    // If --all, fetch all draft articles
    if (batch && articleIds.length === 0) {
      articleIds = await getDraftArticleIds(connection);
      console.log(`Found ${articleIds.length} draft articles`);
    }

    // Publish the articles
    const results = [];
    let gateSkipped = 0;
    for (const articleId of articleIds) {
      // Gate: hard block before publishing (2026-09-20 scripted AGENTS.md "must pass the gate
      // before publishing"; same source as the promote-daily re-check; single-article failure
      // exits 1, batch mode skips that article and continues)
      const planRow = await t.plan.getByArticleId(articleId);
      let slug = planRow && planRow.slug;
      if (!slug) {
        const [rows] = await connection.query(
          'SELECT slug FROM tengence_geo_articles WHERE id = ? AND app_id = ? LIMIT 1',
          [articleId, getState().CONFIG.app_id]
        );
        slug = rows[0] && rows[0].slug;
      }
      const gateDir = (planRow && planRow.category) || 'industry-insights';
      if (slug) {
        const gateReport = await t.check.checkArticle({ slug, dir: gateDir });
        if (!gateReport.ok) {
          console.log(`\n⛔ Gate failed, skipping ID ${articleId} (${slug})`);
          for (const [k, v, ok, soft] of gateReport.rows) {
            console.log((ok ? '✅' : (soft ? '⚠️' : '❌')) + ' ' + k + ': ' + v);
          }
          console.log('>>> Some checks failed (must pass the gate before publishing, see AGENTS.md)');
          gateSkipped++;
          results.push({ articleId, success: false, gate: true });
          continue;
        }
        console.log(`  ✅ Gate passed: ${slug}`);
      }
      try {
        const result = await publishArticle(connection, articleId, {
          status, force, dryRun, featuredMedia, skipGsc, skipIndexnow, skipBaidu,
        });
        results.push({ articleId, success: !!result, result });
      } catch (error) {
        console.error(`\n✗ Failed to publish article ID ${articleId}: ${error.message}`);
        results.push({ articleId, success: false, error: error.message });
      }
    }

    // Summary
    console.log('\n========================================');
    console.log('Publish summary');
    console.log('========================================');
    console.log(`Total: ${results.length}`);
    console.log(`Succeeded: ${results.filter(r => r.success).length}`);
    console.log(`Gate-skipped: ${gateSkipped}`);
    console.log(`Failed: ${results.filter(r => !r.success && !r.gate).length}`);

    if (results.some(r => !r.success)) {
      console.log('\nFailed/skipped articles:');
      results.filter(r => !r.success).forEach(r => {
        if (r.gate) console.log(`  - ID ${r.articleId}: gate not passed (fix before publishing)`);
        else console.log(`  - ID ${r.articleId}: ${r.error}`);
      });
    }

    // Single-article mode: gate failure → exit code 1 (so the publish gate is visible to scripts/CI)
    if (!batch && results.some((r) => r.gate)) process.exitCode = 1;
  } finally {
    // Close the database connection
    await connection.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(' fatal error:', error);
    process.exit(1);
  });
}

module.exports = { publishArticle, getDraftArticleIds };
