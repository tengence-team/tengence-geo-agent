#!/usr/bin/env node
/**
 * IndexNow inclusion submission CLI (Bing / Yandex / Naver / Seznam joint protocol)
 * ============================================================================
 * Principle: POST a URL list + key to https://api.indexnow.org/indexnow, and the search
 * engines crawl immediately. Ownership is proven by the key file:
 * https://<host>/<key>.txt must be reachable. No Bing console login, no quota limit
 * (official: on demand daily, no hard cap).
 *
 * Usage:
 *   tengence-geo submit-indexnow.js --url=<url>       single-URL submission (for the publish chain)
 *   tengence-geo submit-indexnow.js --all [--limit=N] submit all URLs from the sitemap (first time / backfill)
 *   tengence-geo submit-indexnow.js --dry-run         print config only, no network
 *
 * Config (sites/<site>/.env):
 *   INDEXNOW_KEY          32-hex key (gitignore)
 *   INDEXNOW_HOST         site host (default www.<domain>)
 *   INDEXNOW_KEY_LOCATION key-file URL (default https://<host>/<key>.txt)
 *
 * Notes:
 *   - Networking reuses gFetch from tengence-geo-sdk/search/http.js (HTTPS_PROXY tunnel + timeout).
 *   - A single failure only logs (data/indexnow-log.jsonl) and does not stop other actions.
 *   - HTTP 200/202 after submission means accepted (not "indexed"; indexing takes hours to days).
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const t = require('@tengence/geo-sdk');

const SITE = t.site.loadSite();
const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(SITE.siteDir, 'data');
const LOG_PATH = path.join(DATA_DIR, 'indexnow-log.jsonl');

const DEFAULT_HOST = `www.${SITE.site.domain || process.env.SITE_DOMAIN || 'tengence.com'}`;
const KEY = process.env.INDEXNOW_KEY || '';
const HOST = process.env.INDEXNOW_HOST || DEFAULT_HOST;
const KEY_LOCATION =
  process.env.INDEXNOW_KEY_LOCATION || `https://${HOST}/${KEY}.txt`;

function usage() {
  console.log(`
Usage: tengence-geo submit-indexnow.js [options]

Options:
  --url=<url>       submit a single URL (for the publish chain)
  --all             fetch all URLs from the sitemap and submit in batch
  --limit=<n>       max number to submit with --all (default 1000; IndexNow single-call cap 10000)
  --dry-run         print config only, no network requests
  --site <key>      site key (default tengence)
`);
  process.exit(1);
}

function parseArgs(argv) {
  const { positionals, flags } = t.cli.args.parse(
    {
      site: { type: 'string', default: 'tengence' },
      'dry-run': { type: 'boolean' },
      all: { type: 'boolean' },
      limit: { type: 'string', default: '1000' },
      url: { type: 'string' },
    },
    argv
  );
  return {
    dryRun: flags['dry-run'],
    all: flags.all,
    limit: Number(flags.limit) || 1000,
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

/** Submit a batch of URLs to IndexNow (single-call cap 10000; implementation in SDK search/indexnow.js) */
function submitBatch(urlList) {
  return t.search.indexnow.submitUrls({
    host: HOST,
    key: KEY,
    keyLocation: KEY_LOCATION,
    urlList,
  });
}

async function runDryRun() {
  console.log('🔍 Dry-run mode (no network)');
  console.log('  Endpoint        :', t.search.indexnow.API);
  console.log('  host            :', HOST);
  console.log('  key             :', KEY ? `${KEY.slice(0, 6)}… (${KEY.length} chars)` : '❌ INDEXNOW_KEY not configured');
  console.log('  keyLocation     :', KEY_LOCATION);
  console.log('  Proxy           :', process.env.HTTPS_PROXY ? 'HTTPS_PROXY=' + process.env.HTTPS_PROXY : '(direct)');
  if (!KEY) {
    console.log('\n  ⚠️ INDEXNOW_KEY missing: configure it in sites/<site>/.env (32-hex).');
    process.exit(1);
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.dryRun) {
    await runDryRun();
    return;
  }
  if (!o.url && !o.all) {
    console.error('❌ No action specified: --url=<url> or --all');
    usage();
  }
  if (!KEY) {
    console.error('❌ INDEXNOW_KEY not configured (sites/<site>/.env)');
    process.exit(1);
  }

  let urlList = [];
  if (o.url) {
    urlList = [o.url];
    console.log(`📣 Submitting 1 URL: ${o.url}`);
  } else {
    const sitemapUrl =
      process.env.GSC_SITEMAP_URL ||
      `https://${DEFAULT_HOST}/sitemap_index.xml`;
    console.log(`📋 Fetching all URLs from the sitemap: ${sitemapUrl} (sitemap index auto-flattened recursively)...`);
    const all = await t.search.fetchAllSitemapUrls(sitemapUrl);
    urlList = all.slice(0, o.limit);
    console.log(`  Fetched ${all.length} URLs, submitting ${urlList.length}`);
    if (urlList.length === 0) {
      console.warn('  ⚠️ No URLs fetched from the sitemap, aborting');
      return;
    }
  }

  // submit in batches (IndexNow single-call cap 10000)
  const BATCH = 10000;
  let okCount = 0;
  let failCount = 0;
  for (let i = 0; i < urlList.length; i += BATCH) {
    const batch = urlList.slice(i, i + BATCH);
    const batchNo = i / BATCH + 1;
    try {
      const r = await submitBatch(batch);
      okCount += r.count;
      console.log(`  ✅ Batch ${batchNo} accepted (HTTP ${r.httpStatus}, ${r.count} URLs)`);
      logLine({ action: 'submit', batch: batchNo, ok: true, detail: r, urls: batch.slice(0, 20) });
    } catch (e) {
      failCount += batch.length;
      console.error(`  ❌ Batch ${batchNo} failed: ${e.message}`);
      logLine({ action: 'submit', batch: batchNo, ok: false, error: e.message, urls: batch.slice(0, 20) });
    }
  }
  console.log(`\n=== Done: ${okCount} accepted, ${failCount} failed ===`);
  if (failCount > 0) process.exit(1);
  console.log(`  Log: ${path.relative(ROOT, LOG_PATH)}`);
  console.log('  ⚠️ 200/202 only means accepted; indexing takes hours to days (Bing usually 24-48h).');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('\n❌ Unexpected error:', e.message);
    process.exit(1);
  });
}

module.exports = { main };
