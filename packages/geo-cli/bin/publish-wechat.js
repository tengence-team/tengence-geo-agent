#!/usr/bin/env node
/**
 * publish-wechat.js — sync articles to the WeChat Official Account drafts box
 *
 * Usage:
 *   Single-article sync (into the drafts box, no mass broadcast):
 *     tengence-geo publish-wechat.js <slug>
 *
 *   Batch multi-image articles (max 8, new articles first):
 *     tengence-geo publish-wechat.js --slugs=slug-a,slug-b,slug-c
 *
 *   Direct publish (skips the drafts box, mass broadcasts immediately; use with care):
 *     tengence-geo publish-wechat.js <slug> --publish
 *
 *   Dry run (print the plan only, no API calls):
 *     tengence-geo publish-wechat.js <slug> --dry-run
 *
 * 2026-09-20 sink-down: the WeChat API client / body cleaning / single-article
 * preparation / main-flow orchestration moved into tengence-geo-sdk/syndicate/wechat
 * (syncWechat); this file only keeps argument parsing, article-count validation and
 * credential pre-checks. CLI usage and output stay byte-identical. Argument parsing
 * and validation only run in the CLI entry (requiring this file has no side effects,
 * so it can be reused in-process by dsh etc.).
 */

const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const t = require('@tengence/geo-sdk');

async function main() {
  // ==================== argument parsing ====================

  const { positionals, flags } = t.cli.args.parse(
    { slugs: { type: 'string' }, publish: { type: 'boolean' }, 'dry-run': { type: 'boolean' } },
    process.argv.slice(2)
  );
  const dryRun = flags['dry-run'];
  const shouldPublish = flags.publish;
  const siteKey = t.site.readSiteArg();

  let slugs = [];
  if (flags.slugs) {
    slugs = String(flags.slugs).split(',').map((s) => s.trim()).filter(Boolean);
  } else if (positionals[0]) {
    slugs = [positionals[0]];
  }

  if (slugs.length === 0) {
    console.error('Usage: node publish-wechat.js <slug> [--publish] [--dry-run]');
    console.error('       node publish-wechat.js --slugs=a,b,c [--publish] [--dry-run]');
    process.exit(1);
  }

  if (slugs.length > 8) {
    console.error(`❌ WeChat Official Account allows at most 8 image-text articles per send; got ${slugs.length}`);
    process.exit(1);
  }

  // ==================== site & environment ====================

  t.site.loadSite(siteKey);

  const WECHAT_APP_ID = process.env.WECHAT_APP_ID;
  const WECHAT_APP_SECRET = process.env.WECHAT_APP_SECRET;
  if (!WECHAT_APP_ID || !WECHAT_APP_SECRET) {
    console.error('❌ WECHAT_APP_ID / WECHAT_APP_SECRET not set (in sites/tengence/.env)');
    process.exit(1);
  }

  // ==================== main flow ====================

  await t.syndicate.wechat.syncWechat({ slugs, dryRun, shouldPublish, siteKey });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n❌ Failed:', err.message);
    process.exit(1);
  });
}

module.exports = { syncWechat: (opts) => t.syndicate.wechat.syncWechat(opts) };
