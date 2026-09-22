/**
 * diagnose/index.js — GEO/SEO site diagnosis orchestration
 * ============================================================================
 * One call, full evidence pack:
 *   - bootstrap: url → site key → loadSite({autoInit}) (first call creates the site)
 *   - fetch: homepage (+ optional extra pages), robots.txt, sitemap, 404 probe
 *   - domain: DNS / TLS certificate / WHOIS (free, Node built-ins)
 *   - parse: cheerio content profile (meta / H1..H6 / JSON-LD / images / links …)
 *   - fingerprint: CMS / framework / platform / CDN / server
 *   - checks: dimensioned pass/warn/fail/info list (see checks.js)
 * Everything fails softly: network errors are recorded, never throw.
 */

const { siteKeyFromUrl, loadSite } = require('../site');
const { fetchPage } = require('./fetch');
const { parsePage } = require('./parse');
const { fingerprint } = require('./fingerprint');
const { dnsProbe } = require('./dns');
const { parseRobots } = require('./robots');
const { probeSitemaps } = require('./sitemap');
const { buildChecks } = require('./checks');

const SITEMAP_CANDIDATES = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'];

/** Dedupe + same-host filter for a URL list, keeping canonical hrefs. */
function cleanUrls(urls, baseUrl) {
  const rootHost = (() => {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return '';
    }
  })();
  const rootPath = (() => {
    try {
      return new URL(baseUrl).pathname.replace(/\/+$/, '');
    } catch {
      return '';
    }
  })();
  const out = [];
  const seen = new Set();
  for (const u of urls || []) {
    let x = null;
    try {
      x = new URL(u, baseUrl);
      x.hash = '';
      x.search = '';
    } catch {
      continue;
    }
    const c = x.href;
    const path = x.pathname.replace(/\/+$/, '');
    if (x.hostname !== rootHost || path === rootPath || path === '' || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

/**
 * Sample representative pages from a (possibly huge) sitemap without crawling it all.
 * Strategy: article-like URLs (containing /yyyy/mm/dd/) first, then the rest;
 * group by first path segment and take at most one per group, up to `max`.
 */
function clusterSample(urls, baseUrl, max) {
  const cands = cleanUrls(urls, baseUrl);
  const articleRe = /\/(\d{4})\/(\d{2})\/(\d{2})\//;
  const ordered = [...cands.filter((u) => articleRe.test(u)), ...cands.filter((u) => !articleRe.test(u))];
  const seen = new Set();
  const out = [];
  for (const u of ordered) {
    let seg = '';
    try {
      seg = new URL(u).pathname.split('/').filter(Boolean)[0] || '';
    } catch {
      /* keep seg = '' */
    }
    const key = seg || u;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

/** Fallback when no sitemap exists: sample a few internal links from the homepage. */
const SKIP_RESOURCE_EXT = /\.(gif|jpe?g|png|webp|svg|ico|css|js|woff2?|ttf|eot|mp4|webm|pdf|zip)(?:[?#]|$)/i;
function linksFallback(rootParsed, baseUrl, max) {
  if (!rootParsed || !rootParsed.links || !rootParsed.links.samples) return [];
  const hrefs = rootParsed.links.samples
    .map((s) => s.href)
    .filter((h) => h && !SKIP_RESOURCE_EXT.test(h));
  const cands = cleanUrls(hrefs, baseUrl);
  return cands.slice(0, max);
}

/**
 * @param {{url:string, siteKey?:string, extraPages?:string[], maxPages?:number}} opts
 *        maxPages: cap on representative pages fetched (default 4; the site is
 *        sampled, never fully crawled)
 * @returns {Promise<object>} { ok, site_key, site_dir, domain, url, _bootstrap?,
 *          evidence: { rootPage, robots, sitemap, dns, fingerprint, pages, probe404 },
 *          checks: [...] }
 */
async function runDiagnosis({ url, siteKey, extraPages = [], maxPages = 4 } = {}) {
  if (!url) throw new Error('diagnose_site requires url');
  const parsed = siteKeyFromUrl(url);
  const key = siteKey || parsed.key;
  const S = loadSite(key, { autoInit: true, domain: parsed.domain });

  const evidence = {};

  // ---- homepage (determines the canonical final base) ----
  const rootPage = await fetchPage(url);
  evidence.rootPage = rootPage;
  const baseUrl = rootPage.finalUrl || url;

  // ---- parallel: robots / sitemap / 404 probe / domain intelligence ----
  const robotsUrl = new URL('/robots.txt', baseUrl).href;
  const rand = `__geo_probe_${Math.random().toString(36).slice(2, 8)}__`;
  const notFoundUrl = new URL(`/${rand}`, baseUrl).href;

  const [robotsRes, notFoundRes, dnsInfo] = await Promise.all([
    fetchPage(robotsUrl, { timeoutMs: 10000 }),
    fetchPage(notFoundUrl, { timeoutMs: 8000 }),
    dnsProbe(parsed.domain),
  ]);

  evidence.robots =
    robotsRes.status === 200
      ? parseRobots(robotsRes.body || '')
      : { exists: false, sitemaps: [], groups: [], raw: '', httpStatus: robotsRes.status };
  evidence.probe404 = notFoundRes;
  evidence.dns = dnsInfo;

  const sitemapCandidates = evidence.robots.sitemaps.length
    ? evidence.robots.sitemaps
    : SITEMAP_CANDIDATES;
  evidence.sitemap = await probeSitemaps(sitemapCandidates, baseUrl);

  // ---- homepage parse + fingerprint (needed early for link fallback) ----
  evidence.rootParsed = rootPage.error ? null : parsePage(rootPage.body, baseUrl);
  evidence.fingerprint = fingerprint(rootPage.headers || {}, rootPage.body || '');

  // ---- representative pages: sample, never crawl the whole site ----
  // priority: user-specified extraPages → sitemap cluster sample → homepage link fallback
  const cap = Math.max(1, maxPages);
  let rep = cleanUrls(extraPages, baseUrl).slice(0, cap);
  if (rep.length < cap && evidence.sitemap.found && evidence.sitemap.urls.length) {
    rep = rep.concat(clusterSample(evidence.sitemap.urls, baseUrl, cap - rep.length));
  }
  if (rep.length < Math.min(2, cap)) {
    for (const u of linksFallback(evidence.rootParsed, baseUrl, 2)) {
      if (!rep.includes(u)) rep.push(u);
      if (rep.length >= Math.min(2, cap)) break;
    }
  }

  const pages = [];
  for (const p of rep.slice(0, cap)) {
    const res = await fetchPage(p, { timeoutMs: 12000 });
    pages.push({
      url: p,
      status: res.status,
      finalUrl: res.finalUrl,
      redirects: res.redirects,
      ttfbMs: res.ttfbMs,
      bodyLength: res.bodyLength,
      parsed: res.error ? null : parsePage(res.body, p),
      error: res.error || null,
    });
  }
  evidence.pages = pages;

  // ---- checks ----
  const rootForChecks = {
    ...(evidence.rootParsed || {}),
    title: evidence.rootParsed && evidence.rootParsed.title,
    meta: evidence.rootParsed && evidence.rootParsed.meta,
    canonical: evidence.rootParsed && evidence.rootParsed.canonical,
    viewport: evidence.rootParsed && evidence.rootParsed.viewport,
    lang: evidence.rootParsed && evidence.rootParsed.lang,
    charset: evidence.rootParsed && evidence.rootParsed.charset,
    robotsMeta: evidence.rootParsed && evidence.rootParsed.robotsMeta,
    headers: rootPage.headers,
    status: rootPage.status,
    finalUrl: baseUrl,
    redirects: rootPage.redirects,
    ttfbMs: rootPage.ttfbMs,
    bodyLength: rootPage.bodyLength,
    mixedContent: evidence.rootParsed ? evidence.rootParsed.mixedContent : 0,
  };
  const checks = buildChecks({
    url: baseUrl,
    root: rootForChecks,
    rootPage: rootForChecks,
    fingerprint: evidence.fingerprint,
    dns: dnsInfo,
    robots: evidence.robots,
    sitemap: evidence.sitemap,
    probe404: notFoundRes,
  });

  return {
    ok: true,
    site_key: key,
    site_dir: S.siteDir,
    domain: parsed.domain,
    url: baseUrl,
    ...(S._bootstrap ? { _bootstrap: S._bootstrap } : {}),
    evidence: {
      rootPage: {
        status: rootPage.status,
        finalUrl: baseUrl,
        redirects: rootPage.redirects,
        ttfbMs: rootPage.ttfbMs,
        bodyLength: rootPage.bodyLength,
        error: rootPage.error || null,
        headers: rootPage.headers,
      },
      robots: evidence.robots,
      sitemap: evidence.sitemap,
      dns: dnsInfo,
      fingerprint: evidence.fingerprint,
      pages: pages.map((p) => ({
        url: p.url,
        status: p.status,
        finalUrl: p.finalUrl,
        redirects: p.redirects,
        ttfbMs: p.ttfbMs,
        bodyLength: p.bodyLength,
        error: p.error || null,
      })),
      probe404: { status: notFoundRes.status, finalUrl: notFoundRes.finalUrl },
      homepage: evidence.rootParsed,
    },
    checks,
  };
}

module.exports = { runDiagnosis, cleanUrls, clusterSample, linksFallback };
