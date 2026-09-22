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
    },
    argv
  );
  return {
    slug: flags.slug,
    query: flags.query,
    keywords: flags.keywords,
    outJson: flags['out-json'],
    dryRun: flags['dry-run'],
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

  if (o.outJson) fs.writeFileSync(o.outJson, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));

  if (result.dryRun) {
    console.error(`\n[Dry Run] produced a local ${String(process.env.IMAGE_FORMAT || 'jpg').toLowerCase() === 'webp' ? 'WebP' : 'JPG'}; not uploaded/registered`);
  } else {
    console.error(`\n✅ Featured image ready: media ID ${result.wp_media_id}`);
    // Backfill the plan table featured_image (post-publish path; does not affect the acquisition result)
    if (o.slug) {
      try {
        const productionUrl = toProductionUrl(result.url, t.site.loadSite());
        await t.plan.setFeaturedImage(o.slug, productionUrl);
        console.error(`  ✅ Plan table backfilled with featured image: ${productionUrl}`);
      } catch (e) {
        console.error(`  ⚠️ Failed to backfill the plan table (does not affect the acquisition result): ${e.message}`);
      }
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n❌ Image pipeline failed:', err.message);
    process.exit(1);
  });
}

module.exports = { main };
