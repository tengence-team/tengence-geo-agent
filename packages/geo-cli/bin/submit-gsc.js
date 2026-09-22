#!/usr/bin/env node
/**
 * Google inclusion submission CLI (thin shell)
 * ============================================================================
 * Wraps tengence-geo-sdk/search to submit articles/sites to Google Search Console.
 *
 * Usage:
 *   tengence-geo submit-gsc.js --sitemap
 *   tengence-geo submit-gsc.js --status <url>
 *   tengence-geo submit-gsc.js --status --all --limit 20
 *   tengence-geo submit-gsc.js --indexing <url>          # needs the switch enabled
 *   tengence-geo submit-gsc.js --dry-run                # print config only, no network
 *
 * Notes:
 *   - siteUrl is auto-discovered by sites.list (sc-domain:tengence.com / URL prefix),
 *     not hand-filled.
 *   - Every submission action has its own try/catch; a single failure only logs and
 *     does not stop the other actions.
 *   - Run results are appended to data/submit-log.jsonl (gitignore).
 *   - Prerequisite: the service-account email must be added as a "full" user in GSC,
 *     otherwise sites.list returns 403.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const t = require('@tengence/geo-sdk');

const SITE = t.site.loadSite();
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(SITE.siteDir, 'data');
const LOG_PATH = path.join(DATA_DIR, 'submit-log.jsonl');
const SCOPE = 'https://www.googleapis.com/auth/webmasters';

const DEFAULT_SITEMAP =
  process.env.GSC_SITEMAP_URL ||
  `https://www.${SITE.site.domain || process.env.SITE_DOMAIN || 'tengence.com'}/sitemap_index.xml`;

function usage() {
  console.log(`
Usage: tengence-geo submit-gsc.js [options]

Options:
  --sitemap            submit/refresh the sitemap (GSC_SITEMAP_URL)
  --status [url]       check a single URL's inclusion status via the URL Inspection API (url as positional or --url=)
  --status --all       sample and batch-check inclusion status from the sitemap (with --limit N, default 50)
  --limit=<n>          max number of URLs to sample (default 50)
  --indexing [url]     notify updates via the Indexing API (needs GOOGLE_INDEXING_API_ENABLED=1)
  --url=<url>          the URL to inspect/notify
  --dry-run            print config only, no network requests
  --site <key>         site key (default tengence)
`);
  process.exit(1);
}

function parseArgs(argv) {
  const { positionals, flags } = t.cli.args.parse(
    {
      site: { type: 'string', default: 'tengence' },
      'dry-run': { type: 'boolean' },
      sitemap: { type: 'boolean' },
      status: { type: 'boolean' },
      all: { type: 'boolean' },
      limit: { type: 'string', default: '50' },
      indexing: { type: 'string' },
      url: { type: 'string' },
    },
    argv
  );
  return {
    dryRun: flags['dry-run'],
    sitemap: flags.sitemap,
    status: flags.status,
    all: flags.all,
    limit: Number(flags.limit) || 50,
    indexing: flags.indexing,
    url: flags.url || positionals[0] || null,
    site: flags.site,
  };
}

function logLine(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.warn(`  ⚠️ Failed to write the log (does not affect the main flow): ${e.message}`);
  }
}

function summarizeInspect(r) {
  const ir = (r && r.inspectionResult) || {};
  const isr = ir.indexStatusResult || {};
  return {
    url: ir.inspectionUrl,
    verdict: isr.verdict || '-',
    coverage: isr.coverageState || '-',
    indexingState: isr.indexingState || '-',
    canonical: isr.googleCanonical || '-',
    lastCrawl: isr.lastCrawlTime || '-',
    robots: isr.robotsTxtState || '-',
    pageFetch: isr.pageFetchState || '-',
  };
}

async function runDryRun() {
  let saInfo = {};
  try {
    const sa = t.search.auth.loadServiceAccount(SITE);
    saInfo = { project_id: sa.project_id, client_email: sa.client_email, token_uri: sa.token_uri };
  } catch (e) {
    saInfo = { error: e.message };
  }
  console.log('🔍 Dry-run mode (no network)');
  console.log('  Service-account key path:', t.search.auth.resolveSaPath(SITE));
  console.log('  Service-account email   :', saInfo.client_email || saInfo.error);
  console.log('  project_id              :', saInfo.project_id || '-');
  console.log('  Scope                   :', SCOPE);
  console.log('  Sitemap URL             :', DEFAULT_SITEMAP);
  console.log('  Indexing API            :', process.env.GOOGLE_INDEXING_API_ENABLED === '1' ? 'enabled' : 'disabled (default)');
  console.log('  Site property           :', SITE.siteKey);
  console.log('\n  Target endpoints:');
  console.log('    token : https://oauth2.googleapis.com/token');
  console.log('    sites : https://www.googleapis.com/webmasters/v3/sites');
  console.log('    smap  : https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}');
  console.log('    insp  : https://www.googleapis.com/v1/urlInspection/index:inspect');
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.dryRun) {
    await runDryRun();
    return;
  }
  if (!o.sitemap && !o.status && o.indexing === null) {
    console.error('❌ No action specified: pick at least one of --sitemap / --status / --indexing (or --dry-run)');
    usage();
  }

  const ok = [];
  const failed = [];

  // 1) sitemap submission
  if (o.sitemap) {
    try {
      console.log(`\n📤 Submitting sitemap: ${DEFAULT_SITEMAP}`);
      const r = await t.search.submitSitemap(SITE, DEFAULT_SITEMAP);
      console.log(`  ✅ Submitted (HTTP ${r.httpStatus})`);
      logLine({ action: 'sitemap', input: DEFAULT_SITEMAP, ok: true, detail: r });
      ok.push('sitemap');
    } catch (e) {
      console.error(`  ❌ Submission failed: ${e.message}`);
      logLine({ action: 'sitemap', input: DEFAULT_SITEMAP, ok: false, error: e.message });
      failed.push('sitemap');
    }
  }

  // 2) single-URL status
  if (o.status && !o.all) {
    const url = o.url;
    if (!url) {
      console.error('❌ --status needs a URL (positional or --url=)');
      usage();
    }
    try {
      console.log(`\n🔍 Checking inclusion status: ${url}`);
      const r = await t.search.inspectUrl(SITE, url);
      const s = summarizeInspect(r);
      console.log('  verdict      :', s.verdict);
      console.log('  coverage     :', s.coverage);
      console.log('  indexingState:', s.indexingState);
      console.log('  canonical    :', s.canonical);
      console.log('  lastCrawl    :', s.lastCrawl);
      console.log('  robots       :', s.robots, '| pageFetch:', s.pageFetch);
      logLine({ action: 'status', input: url, ok: true, detail: s });
      ok.push('status');
    } catch (e) {
      console.error(`  ❌ Check failed: ${e.message}`);
      logLine({ action: 'status', input: url, ok: false, error: e.message });
      failed.push('status');
    }
  }

  // 3) batch sampling
  if (o.status && o.all) {
    try {
      console.log(`\n📋 Sampling ${o.limit} URLs from the sitemap to check status...`);
      const urls = await t.search.collectSampleUrls(SITE, o.limit);
      if (urls.length === 0) {
        console.warn('  ⚠️ No URLs fetched from the sitemap (sitemap may not be submitted yet, or fetching failed)');
      }
      let idx = 0;
      for (const url of urls) {
        idx++;
        try {
          const r = await t.search.inspectUrl(SITE, url);
          const s = summarizeInspect(r);
          console.log(
            `  [${idx}/${urls.length}] ${s.verdict}/${s.coverage}  ${url}`
          );
          logLine({ action: 'status-batch', input: url, ok: true, detail: s });
        } catch (e) {
          console.warn(`  [${idx}/${urls.length}] ❌ ${url}: ${e.message}`);
          logLine({ action: 'status-batch', input: url, ok: false, error: e.message });
          failed.push(`status:${url}`);
        }
      }
      ok.push('status-batch');
    } catch (e) {
      console.error(`  ❌ Batch sampling failed: ${e.message}`);
      failed.push('status-batch');
    }
  }

  // 4) Indexing API (switch-protected)
  if (o.indexing !== null) {
    const url = o.indexing || o.url;
    if (!url) {
      console.error('❌ --indexing needs a URL (argument or --url=)');
      usage();
    }
    try {
      console.log(`\n📣 Indexing API notification: ${url}`);
      const r = await t.search.notifyIndexing(SITE, url);
      console.log('  ✅ Notified:', JSON.stringify(r));
      logLine({ action: 'indexing', input: url, ok: true, detail: r });
      ok.push('indexing');
    } catch (e) {
      console.error(`  ❌ Notification failed: ${e.message}`);
      logLine({ action: 'indexing', input: url, ok: false, error: e.message });
      failed.push('indexing');
    }
  }

  console.log(`\n=== Done: ${ok.length} succeeded, ${failed.length} failed ===`);
  if (failed.length) {
    console.log('  Failed items:', failed.join(', '));
    console.log('  Log:', path.relative(ROOT, LOG_PATH));
    process.exit(1);
  }
  console.log('  Log:', path.relative(ROOT, LOG_PATH));
}

if (require.main === module) {
  main().catch((e) => {
    console.error('\n❌ Unexpected error:', e.message);
    console.error(e.stack);
    process.exit(1);
  });
}

module.exports = { main };
