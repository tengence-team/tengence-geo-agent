#!/usr/bin/env node

/**
 * Canonical taxonomy tooling for local content, MySQL, and WordPress:
 * verify consistency and register per-article terms.
 *
 * Data sources (from P2 on 2026-09-20, taxonomy.yaml retired):
 *   - Category / tag allow-list: the DB categories / tags tables (t.plan.categoryWhitelist / tagWhitelist)
 *   - Article assignments (category / tags / wp_post_id): the article plan table tengence_geo_article_plan
 *
 * Commands:
 *   wp-cleanup      delete non-canonical WordPress categories / tags (allow-list from the DB)
 *   verify          verify: DB allow-list ↔ plan table ↔ articles ↔ WP category/tags + local md
 *
 * 2026-11-24: `db-register` removed. It wrote the article_categories / article_tags
 * association tables, which no longer exist — category/tags are staged in the article
 * plan table and nothing else reads a second copy.
 *
 * B-batch refactor: the CLI degraded to a thin shell — verification orchestration
 * moved into tengence-geo-sdk/taxonomy, WP requests are
 * funneled through tengence-geo-sdk/wp, table names reference db.TABLES, and
 * connections go through db.withConn.
 *
 * Usage: tengence-geo taxonomy.js <wp-cleanup|verify> [--site <key>]
 */

const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const t = require('@tengence/geo-sdk');

async function main() {
  // Site loading (reads sites/<site>/.env and config) — must happen before reading env
  const siteKey = t.site.readSiteArg();
  t.site.loadSite(siteKey);
  const appId = Number(process.env.APP_ID || 1);

  const argv = process.argv.slice(2);
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--site') { i++; continue; }
    if (argv[i].startsWith('--site=')) continue;
    positional.push(argv[i]);
  }
  const command = positional[0];

  if (command === 'wp-cleanup') return t.taxonomy.cleanup({ appId });
  if (command === 'verify') return t.taxonomy.verify({ appId });
  throw new Error('Usage: tengence-geo taxonomy.js <wp-cleanup|verify> [--site <key>]  (db-register removed 2026-11-24: category/tags live in the plan table only)');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  verify: (opts) => t.taxonomy.verify(opts),
  cleanup: (opts) => t.taxonomy.cleanup(opts),
};
