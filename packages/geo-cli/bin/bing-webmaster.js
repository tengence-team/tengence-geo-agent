#!/usr/bin/env node
/**
 * Bing Webmaster Tools CLI (tengence-geo-sdk/webmaster/bing shell)
 * ============================================================================
 * Read/write the Bing 站长后台 via the JSON API (apikey query-param auth).
 *
 * Usage:
 *   tengence-geo bing-webmaster.js --sites                    list verified sites
 *   tengence-geo bing-webmaster.js --status                   URL submission quota
 *                                                            (daily / monthly remaining)
 *   tengence-geo bing-webmaster.js --stats                    query stats (impressions/clicks/CTR/position)
 *   tengence-geo bing-webmaster.js --issues                   crawl issues
 *   tengence-geo bing-webmaster.js --submit <url>             submit a single URL (write)
 *   tengence-geo bing-webmaster.js --all [--limit=N] [--resubmit]
 *                                                            sitemap incremental batch submit
 *   tengence-geo bing-webmaster.js --dry-run                  print config only, no network
 *   --site <key>                                              site key (default tengence)
 *
 * ⚠️ Bing trimmed its JSON API when the legacy SOAP/POX protocols retired on
 *    2026-08-31 (verified 2026-09-24): GetPages / GetSitemaps / GetTrafficStats
 *    / GetUrlSubmissionStatus / SubmitSitemap now return 404 and are not
 *    implemented. Microsoft recommends IndexNow for sitemap-level submission.
 *
 * Config (sites/<site>/.env, injected into process.env by loadSite):
 *   BING_WEBMASTER_API_KEY   the Bing Webmaster API key (Webmaster → API Access)
 *   SITE_DOMAIN              optional; else site.yaml domain is used for site discovery
 *
 * 2026-09-24: new webmaster domain (搜索引擎站长后台管理, separate from search/);
 * all protocol + orchestration lives in @tengence/geo-sdk/webmaster/bing; this
 * file only parses args and renders results.
 * ============================================================================
 */
const t = require('@tengence/geo-sdk');

const SITE = t.site.loadSite();
const { bing } = t.webmaster;

function usage() {
  console.log(`
Usage: tengence-geo bing-webmaster.js [options]

Options:
  --sites            list the sites verified for this API key
  --status           URL submission quota (daily/monthly remaining)
  --stats            query stats (impressions/clicks/CTR/position)
  --issues           crawl issues
  --submit <url>     submit a single URL (write channel)
  --all              fetch all URLs from the sitemap and batch-submit (deduped by log)
  --resubmit         with --all: ignore log dedupe
  --limit=<n>        max URLs per --all run (default 100 = Bing daily quota)
  --dry-run          print config only, no network requests
  --site <key>       site key (default tengence)
`);
  process.exit(1);
}

function parseArgs(argv) {
  const { positionals, flags } = t.cli.args.parse(
    {
      site: { type: 'string' },
      'dry-run': { type: 'boolean' },
      sites: { type: 'boolean' },
      status: { type: 'boolean' },
      stats: { type: 'boolean' },
      issues: { type: 'boolean' },
      all: { type: 'boolean' },
      resubmit: { type: 'boolean' },
      limit: { type: 'string' },
      submit: { type: 'string' },
    },
    argv
  );
  return {
    dryRun: !!flags['dry-run'],
    sites: !!flags.sites,
    status: !!flags.status,
    stats: !!flags.stats,
    issues: !!flags.issues,
    all: !!flags.all,
    resubmit: !!flags.resubmit,
    limit: Number(flags.limit) || 100,
    submit: flags.submit || null,
    url: positionals[0] || null,
  };
}

function printJson(label, data) {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(data, null, 2));
}

function runDryRun() {
  console.log('🔍 Dry-run mode (no network)');
  console.log('  Endpoint        :', bing.API);
  console.log('  API key         :', bing.maskKey(process.env.BING_WEBMASTER_API_KEY));
  console.log('  Site domain     :', SITE.site && SITE.site.site && SITE.site.site.domain);
  console.log('  SITE_DOMAIN     :', process.env.SITE_DOMAIN || '(unset, falls back to site.yaml)');
  console.log('  Network         : direct (ssl.bing.com, no proxy)');
  if (!process.env.BING_WEBMASTER_API_KEY) {
    console.log('\n  ⚠️ BING_WEBMASTER_API_KEY missing: Bing Webmaster → Settings → API Access →');
    console.log('    copy the API key into sites/<site>/.env as BING_WEBMASTER_API_KEY.');
    process.exit(1);
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const actionCount = ['sites', 'status', 'stats', 'issues', 'all', 'submit'].filter((k) => o[k]).length;
  if (o.dryRun) {
    runDryRun();
    return;
  }
  if (actionCount === 0) {
    console.error('❌ No action specified: --sites | --status | --stats | --issues | --submit | --all');
    usage();
  }
  if (!process.env.BING_WEBMASTER_API_KEY) {
    console.error('❌ BING_WEBMASTER_API_KEY not configured (sites/<site>/.env)');
    process.exit(1);
  }

  // read: verified sites
  if (o.sites) {
    const sites = await bing.listSites({ apiKey: process.env.BING_WEBMASTER_API_KEY });
    printJson('Bing verified sites', Array.isArray(sites) ? sites : sites);
    return;
  }

  // read: URL submission quota
  if (o.status) {
    const quota = await bing.getQuota({ apiKey: process.env.BING_WEBMASTER_API_KEY });
    printJson('URL submission quota', quota);
    return;
  }

  // read: query stats
  if (o.stats) {
    const queries = await bing.getQueryStats({ apiKey: process.env.BING_WEBMASTER_API_KEY });
    printJson('Query stats', queries);
    return;
  }

  // read: crawl issues
  if (o.issues) {
    const issues = await bing.getCrawlIssues({ apiKey: process.env.BING_WEBMASTER_API_KEY });
    printJson('Crawl issues', issues);
    return;
  }

  // write: submit a single URL
  if (o.submit) {
    console.log(`📣 Submitting URL to Bing: ${o.submit}`);
    try {
      const r = await bing.submitUrl({ apiKey: process.env.BING_WEBMASTER_API_KEY, url: o.submit });
      printJson('SubmitUrl response', r);
      bing.logLine({ action: 'submit', ok: true, detail: r, urls: [o.submit] }, bing.defaultLogPath('bing'));
      console.log('\n=== Done: 1 URL submitted to Bing ===');
    } catch (e) {
      console.error(`  ❌ SubmitUrl failed: ${e.message}`);
      bing.logLine({ action: 'submit', ok: false, error: e.message, urls: [o.submit] }, bing.defaultLogPath('bing'));
      console.log('\n=== Done: 0 succeeded, 1 failed ===');
      process.exit(1);
    }
    return;
  }

  // write: full incremental submission from sitemap (--all)
  const sitemapUrl = process.env.GSC_SITEMAP_URL || `https://www.${SITE.site && SITE.site.site && SITE.site.site.domain || 'tengence.com'}/sitemap_index.xml`;
  console.log(`📋 Fetching all URLs from the sitemap: ${sitemapUrl} (sitemap index auto-flattened recursively)...`);
  const stats = await bing.submitUrlsFromSitemap({
    apiKey: process.env.BING_WEBMASTER_API_KEY,
    sitemapUrl,
    resubmit: o.resubmit,
    limit: o.limit,
    logPath: bing.defaultLogPath('bing'),
  });
  if (!o.resubmit && stats.doneCount > 0) {
    console.log(`  Log dedupe: ${stats.doneCount} already submitted, ${stats.pendingCount} remaining`);
  }
  console.log(`  Fetched ${stats.total} URLs, submitted ${stats.submitted} this call`);
  if (stats.noPending) {
    console.log('  ✅ Every sitemap URL has already been submitted (or limit=0); nothing to do');
    return;
  }
  for (const b of stats.batches) {
    if (b.ok) console.log(`  ✅ Batch ${b.no} succeeded (${b.count} URLs)`);
    else console.error(`  ❌ Batch ${b.no} failed: ${b.error}`);
  }
  console.log(`\n=== Done: ${stats.ok} succeeded, ${stats.fail} failed ===`);
  if (stats.fail > 0) process.exit(1);
  console.log(`  Log: ${bing.defaultLogPath('bing')}`);
  console.log('  ⚠️ Bing indexing typically takes hours to days; check progress in Bing Webmaster.');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('\n❌ Unexpected error:', e.message);
    bing.logLine({ action: 'fatal', ok: false, error: e.message }, bing.defaultLogPath('bing'));
    process.exit(1);
  });
}

module.exports = { bing };
