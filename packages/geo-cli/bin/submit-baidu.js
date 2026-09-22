#!/usr/bin/env node
/**
 * Baidu Search Resource Platform "normal inclusion — API push" CLI
 * ============================================================================
 * Docs: https://ziyuan.baidu.com/linksubmit/index
 *   POST http://data.zz.baidu.com/urls?site=<site>&token=<token>
 *   body: plain text, one URL per line (≤ 2000 per call)
 *   response: {"remain":remaining-quota,"success":succeeded-count}; errors {"error":400,"message":"..."}
 * Note: data.zz.baidu.com is directly reachable from CN networks; no proxy needed
 * (does not go through gFetch).
 *
 * Usage:
 *   tengence-geo submit-baidu.js --url=<url>       single-URL submission (for the publish chain)
 *   tengence-geo submit-baidu.js --all [--limit=N] submit all URLs from the sitemap (default 2000)
 *   tengence-geo submit-baidu.js --all --resubmit  ignore log dedupe, force a full re-push
 *   tengence-geo submit-baidu.js --dry-run         print config only, no network
 *
 * Incremental logic (important): --all by default reads the URLs already successfully
 * submitted in data/baidu-log.jsonl and dedupes, pushing only URLs not pushed before —
 * combined with a scheduled task, pushes a batch within the quota each day until all are
 * done; --resubmit disables dedupe. Single --url is not affected by dedupe.
 *
 * Config (sites/<site>/.env):
 *   BAIDU_TOKEN  the token= parameter in the Baidu Search Resource Platform →
 *                link submission → normal inclusion → API-call URL
 *   BAIDU_SITE   the site added in Baidu's console (default www.<domain>)
 *
 * 2026-09-20 sink-down: the protocol (submitBatch), log dedupe (loadDoneUrls / logLine),
 * and sitemap incremental orchestration (submitUrlsFromSitemap) moved into
 * tengence-geo-sdk/search/baidu; this file only does "parse args → call the baidu domain
 * → render the result". CLI usage and output stay byte-identical.
 * ============================================================================
 */
const path = require('path');
const t = require('@tengence/geo-sdk');

const SITE = t.site.loadSite();
const ROOT = path.resolve(__dirname, '..', '..');
const { baidu } = t.search;
const API = baidu.API;
const LOG_PATH = baidu.DEFAULT_LOG_PATH;

const TOKEN = process.env.BAIDU_TOKEN || '';
const BAIDU_SITE = process.env.BAIDU_SITE || `www.${SITE.site.domain || 'tengence.com'}`;

function usage() {
  console.log(`
Usage: tengence-geo submit-baidu.js [options]

Options:
  --url=<url>       submit a single URL (for the publish chain)
  --all             fetch all URLs from the sitemap and batch-submit (dedupes by log by default; only pushes unsubmitted ones)
  --resubmit        with --all: ignore log dedupe, force re-push everything
  --limit=<n>       max number to submit with --all (default 2000, Baidu's per-call cap)
  --dry-run         print config only, no network requests
  --site <key>      site key (default tengence)
`);
  process.exit(1);
}

function parseArgs(argv) {
  const { positionals, flags } = t.cli.args.parse(
    {
      site: { type: 'string' },
      'dry-run': { type: 'boolean' },
      all: { type: 'boolean' },
      resubmit: { type: 'boolean' },
      limit: { type: 'string' },
      url: { type: 'string' },
    },
    argv
  );
  return {
    dryRun: !!flags['dry-run'],
    all: !!flags.all,
    resubmit: !!flags.resubmit,
    limit: Number(flags.limit) || 2000,
    url: flags.url || (positionals[0] || null),
  };
}

function runDryRun(o) {
  console.log('🔍 Dry-run mode (no network)');
  console.log('  Endpoint        :', API);
  console.log('  site            :', BAIDU_SITE);
  console.log('  token           :', TOKEN ? `${TOKEN.slice(0, 6)}… (${TOKEN.length} chars)` : '❌ BAIDU_TOKEN not configured');
  console.log('  Network         : direct from CN (no proxy)');
  if (o.all) {
    const done = baidu.loadDoneUrls(LOG_PATH);
    console.log('  Mode            :', o.resubmit ? 'full re-push (--resubmit, ignoring dedupe)' : 'incremental push (deduped by log)');
    console.log('  Already pushed  :', done.size, 'entries');
  }
  if (!TOKEN) {
    console.log('\n  ⚠️ BAIDU_TOKEN missing: Baidu Search Resource Platform → link submission → normal inclusion →');
    console.log('    take the token= parameter from the API-call URL and write it to sites/<site>/.env as BAIDU_TOKEN.');
    process.exit(1);
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.dryRun) {
    runDryRun(o);
    return;
  }
  if (!o.url && !o.all) {
    console.error('❌ No action specified: --url=<url> or --all');
    usage();
  }
  if (!TOKEN) {
    console.error('❌ BAIDU_TOKEN not configured (sites/<site>/.env)');
    process.exit(1);
  }

  // single-URL submission (for the publish chain; not affected by log dedupe)
  if (o.url) {
    console.log(`📣 Submitting 1 URL: ${o.url}`);
    try {
      const r = await baidu.submitBatch([o.url], { token: TOKEN, site: BAIDU_SITE });
      console.log(`  ✅ Batch 1 succeeded with ${r.success} URLs (today's remaining quota ${r.remain})`);
      baidu.logLine({ action: 'submit', batch: 1, ok: true, detail: r, urls: [o.url] }, LOG_PATH);
      console.log(`\n=== Done: ${r.success} succeeded, 0 failed ===`);
    } catch (e) {
      console.error(`  ❌ Batch 1 failed: ${e.message}`);
      baidu.logLine({ action: 'submit', batch: 1, ok: false, error: e.message, urls: [o.url] }, LOG_PATH);
      console.log(`\n=== Done: 0 succeeded, 1 failed ===`);
      process.exit(1);
    }
    console.log(`  Log: ${path.relative(ROOT, LOG_PATH)}`);
    console.log('  ⚠️ Baidu inclusion typically takes ~7-14 days; check progress in the Baidu Search Resource Platform.');
    return;
  }

  // full incremental submission (--all)
  const sitemapUrl =
    process.env.GSC_SITEMAP_URL ||
    `https://www.${SITE.site.domain || 'tengence.com'}/sitemap_index.xml`;
  console.log(`📋 Fetching all URLs from the sitemap: ${sitemapUrl} (sitemap index auto-flattened recursively)...`);
  const stats = await baidu.submitUrlsFromSitemap({
    token: TOKEN,
    site: BAIDU_SITE,
    sitemapUrl,
    resubmit: o.resubmit,
    limit: o.limit,
    logPath: LOG_PATH,
  });
  if (!o.resubmit && stats.doneCount > 0) {
    console.log(`  Log dedupe: ${stats.doneCount} already pushed, ${stats.pendingCount} remaining to push`);
  }
  console.log(`  Fetched ${stats.total} URLs, submitted ${stats.submitted} this call`);
  if (stats.noPending) {
    console.log('  ✅ Every sitemap URL has already been pushed (or limit=0); nothing to submit');
    return;
  }
  for (const b of stats.batches) {
    if (b.ok) {
      console.log(`  ✅ Batch ${b.no} succeeded with ${b.detail.success} URLs (today's remaining quota ${b.detail.remain})`);
    } else {
      console.error(`  ❌ Batch ${b.no} failed: ${b.error}`);
    }
  }
  console.log(`\n=== Done: ${stats.ok} succeeded, ${stats.fail} failed ===`);
  if (stats.fail > 0) process.exit(1);
  console.log(`  Log: ${path.relative(ROOT, LOG_PATH)}`);
  console.log('  ⚠️ Baidu inclusion typically takes ~7-14 days; check progress in the Baidu Search Resource Platform.');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('\n❌ Unexpected error:', e.message);
    baidu.logLine({ action: 'fatal', ok: false, error: e.message }, LOG_PATH);
    process.exit(1);
  });
}

module.exports = { baidu };
