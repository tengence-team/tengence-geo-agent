#!/usr/bin/env node
/**
 * Article featured-image auto-acquisition pipeline (CLI thin shell)
 * ============================================================================
 * The implementation lives in tengence-geo-sdk/images/:
 *   redline.js (red-line rules & scoring) · sources.js (source search) · acquire.js (five-step orchestration)
 * This file only: parses args → calls t.images.acquire() → outputs (progress to stderr,
 * result JSON to stdout).
 *
 * Five steps: search → red-line filter → download (pHash dedupe) → crop & transcode → upload & register
 *
 * Output format: default JPG (quality 85), compatible with all external content platforms;
 * use --format=webp to force WebP.
 *
 * Usage:
 *   tengence-geo image-acquire.js --slug=<slug> [--query="..."] \
 *     [--keywords="k1,k2"] [--site <key>] [--format=jpg|webp] [--dry-run] [--out-json=<path>]
 *
 * Output: progress to stderr; the final JSON result to stdout (--out-json also writes it
 * to disk for orchestrating scripts to parse).
 *
 * The red-line rules are also codified in skills/wordpress/README.md §"5.1 Automatic image pipeline".
 * ============================================================================
 */

const fs = require('fs');
const t = require('@tengence/geo-sdk');

// site .env → process.env (provides stock-library keys and DB credentials)
t.site.loadSite();

function parseArgs(argv) {
  const { flags } = t.cli.args.parse(
    {
      slug: { type: 'string' },
      query: { type: 'string' },
      keywords: { type: 'string' },
      'out-json': { type: 'string' },
      format: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'no-backfill': { type: 'boolean' },
    },
    argv
  );
  return {
    slug: flags.slug,
    query: flags.query,
    keywords: flags.keywords,
    outJson: flags['out-json'],
    dryRun: flags['dry-run'],
    noBackfill: flags['no-backfill'],
    format: flags.format,
  };
}

/** WP media URL → production URL (/wp-content/uploads/... → /blog/static/images/...) */
function toProductionUrl(wpMediaUrl, site) {
  if (!wpMediaUrl) return null;
  const m = String(wpMediaUrl).match(/\/wp-content\/uploads\/(.+)$/);
  if (!m) return wpMediaUrl;
  return `https://www.${site.site.domain}/blog/static/images/${m[1]}`;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));

  // --format passes through to acquire (read as process.env.IMAGE_FORMAT); jpg unless set
  if (o.format) process.env.IMAGE_FORMAT = o.format;

  const result = await t.images.acquire({
    slug: o.slug,
    query: o.query,
    keywords: o.keywords,
    dryRun: o.dryRun,
    appId: parseInt(process.env.APP_ID || '1', 10),
    log: console.error,
  });

  // Backfill FIRST, print after (2026-11-13): the old order printed the result and
  // then wrote the DB, so a client timeout / Ctrl-C killed the process after the image
  // existed in WP but before articles.featured_image was recorded — that is exactly how
  // media 5134/5135 ended up "uploaded but unregistered". The write must be durable
  // before we declare success; when it fails we still report wp_media_id (so the caller
  // can register by hand) and exit non-zero instead of pretending everything is fine.
  if (!result.dryRun && o.slug && !o.noBackfill) {
    try {
      const productionUrl = toProductionUrl(result.url, t.site.loadSite());
      await t.plan.setFeaturedImage(o.slug, productionUrl);
      result.db_backfill = 'ok';
      result.featured_image = productionUrl;
      console.error(`  ✅ Featured image registered in the DB: ${productionUrl}`);
    } catch (e) {
      result.db_backfill = 'failed';
      result.db_backfill_error = e.message;
      console.error(`  ❌ Failed to register the featured image in the DB: ${e.message}`);
      console.error(`     WP already has the image (media ID ${result.wp_media_id}); register it with publish_update_fields or re-run without --no-backfill.`);
    }
  } else if (!result.dryRun && o.noBackfill) {
    result.db_backfill = 'skipped';
  }

  if (o.outJson) fs.writeFileSync(o.outJson, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));

  if (result.dryRun) {
    console.error(`\n[Dry Run] produced a local ${String(process.env.IMAGE_FORMAT || 'jpg').toLowerCase() === 'webp' ? 'WebP' : 'JPG'}; not uploaded/registered`);
  } else if (result.db_backfill === 'failed') {
    process.exitCode = 2;
  } else if (result.db_backfill === 'skipped') {
    console.error(`\nℹ️ Featured image uploaded (media ID ${result.wp_media_id}); DB registration skipped by --no-backfill`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n❌ Image pipeline failed:', err.message);
    process.exit(1);
  });
}

module.exports = { main };
