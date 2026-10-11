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
const { fetchPage, parseCookieFlags, getRequestStats, resetRequestStats } = require('./fetch');
const { parsePage } = require('./parse');
const { fingerprint } = require('./fingerprint');
const { dnsProbe } = require('./dns');
const { parseRobots, detectRobotsConflicts } = require('./robots');
const { probeSitemaps, languageDistribution } = require('./sitemap');
const { probeRange } = require('./probeRange');
const { aiReachability, probeLlms, probeLanguages, robotsAiBlocks, countWords } = require('./aiBots');
const { alpnProbe } = require('./proto');
const { buildChecks } = require('./checks');
const { probeLangHomepages, check404Localization, i18nCoverage } = require('./i18n');
const { probeCdnHits, probeCachePolicy, probeHttp3, parseCspPolicy, probeImageTypes } = require('./cdn');
const { probeSubdomains, probeMobileRedirect, checkSanUsage, probeExternalResources } = require('./infra');
const { probeExposure } = require('./exposure');

const SITEMAP_CANDIDATES = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'];
const DEFAULT_LANG_PREFIXES = ['en', 'zh-hans', 'zh-hant'];

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
 * @param {{url:string, siteKey?:string, extraPages?:string[], maxPages?:number,
 *          deep?:boolean, maxRequests?:number}} opts
 *        maxPages: cap on representative pages fetched (default 4; the site is
 *        sampled, never fully crawled)
 *        deep: true = run the full probe set (subdomains / exposure / cache-hit
 *        sampling / i18n homepages …). false = skip every probe that would add
 *        network load beyond the classic pack; zero-request pure-parsing checks
 *        (CSP, SAN, robots conflicts, sitemap language distribution…) still run.
 *        maxRequests: total outbound request budget across the whole run
 *        (redirects counted). When the budget is exhausted, remaining optional
 *        probes are skipped and recorded in evidence.budget.
 * @returns {Promise<object>} { ok, site_key, site_dir, domain, url, _bootstrap?,
 *          evidence: { rootPage, robots, sitemap, dns, fingerprint, pages, probe404, … },
 *          checks: [...] }
 */
async function runDiagnosis({ url, siteKey, extraPages = [], maxPages = 4, deep = true, maxRequests = 700 } = {}) {
  if (!url) throw new Error('diagnose_site requires url');
  const parsed = siteKeyFromUrl(url);
  const key = siteKey || parsed.key;
  const S = loadSite(key, { autoInit: true, domain: parsed.domain });

  resetRequestStats();
  const requestsUsed = () => getRequestStats().get + getRequestStats().head;
  const budgetLeft = () => Math.max(0, maxRequests - requestsUsed());
  const budgetOk = () => requestsUsed() < maxRequests;

  const evidence = {};

  // ---- homepage (determines the canonical final base) ----
  const rootPage = await fetchPage(url);
  evidence.rootPage = rootPage;
  const baseUrl = rootPage.finalUrl || url;

  // When a WAF hijacks the homepage (final response left the target host, e.g.
  // jumped to waf.xxx.com/verification), infrastructure probes (robots/sitemap/
  // llms/langs/AI crawlers) must still target the ORIGINAL site, not the
  // challenge domain — otherwise every GEO probe "succeeds" against a WAF page.
  const probeBase = (() => {
    try {
      if (new URL(url).hostname.toLowerCase() !== new URL(baseUrl).hostname.toLowerCase()) {
        return url;
      }
    } catch {
      /* keep baseUrl */
    }
    return baseUrl;
  })();

  // ---- parallel: robots / sitemap / 404 probe / domain intelligence ----
  const robotsUrl = new URL('/robots.txt', probeBase).href;
  const rand = `__geo_probe_${Math.random().toString(36).slice(2, 8)}__`;
  const notFoundUrl = new URL(`/${rand}`, probeBase).href;

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
  evidence.sitemap = await probeSitemaps(sitemapCandidates, probeBase);

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

  // ---- GEO/scale evidence pack (parallel, all soft-fail) ----
  const hostForAlpn = (() => {
    try {
      return new URL(probeBase).hostname;
    } catch {
      return '';
    }
  })();
  const [scaleRes, aiRes, llmsRes, langRes, protoRes] = await Promise.all([
    evidence.sitemap.found && evidence.sitemap.urls.length
      ? probeRange(evidence.sitemap.urls, { concurrency: 8, maxUrls: 500 })
      : Promise.resolve({ total: 0, ok200: 0, errorCount: 0, statusDist: {}, failures: [], abnormal: [], okUrls: [] }),
    aiReachability(url, {
      baselineWords: (evidence.rootParsed && evidence.rootParsed.wordCount) || 0,
    }),
    probeLlms(probeBase),
    probeLanguages(probeBase),
    hostForAlpn ? alpnProbe(hostForAlpn) : Promise.resolve({ protocol: null, alpn: false }),
  ]);
  evidence.scale = scaleRes;
  evidence.aiBots = aiRes;
  evidence.llms = llmsRes;
  evidence.langs = langRes;
  evidence.proto = protoRes;
  evidence.aiBlocksGeo = robotsAiBlocks(evidence.robots, 'geo');
  evidence.aiBlocksSeo = robotsAiBlocks(evidence.robots, 'seo');

  // ---- language prefixes declared by the site (from root hreflang, minus x-default) ----
  const langPrefixes = [
    ...new Set(
      (evidence.rootParsed && evidence.rootParsed.hreflang || [])
        .map((x) => String(x.hreflang || '').toLowerCase())
        .filter((t) => t && t !== 'x-default'),
    ),
  ];
  if (!langPrefixes.length) langPrefixes.push(...DEFAULT_LANG_PREFIXES);

  // ---- static-asset sample for cache-policy / image-format probes (same origin first) ----
  const staticAssets = [];
  {
    const rp = evidence.rootParsed || {};
    const origin = (() => {
      try {
        return new URL(probeBase).origin;
      } catch {
        return '';
      }
    })();
    const pool = [...((rp.scripts && rp.scripts.srcs) || []), ...((rp.images && rp.images.srcs) || [])];
    for (const u of pool) {
      try {
        if (new URL(u, probeBase).origin === origin) staticAssets.push(new URL(u, probeBase).href);
      } catch {
        /* noop */
      }
      if (staticAssets.length >= 4) break;
    }
    if (staticAssets.length < 2) staticAssets.push(...pool.slice(0, 2).map((u) => new URL(u, probeBase).href));
  }
  const imgSample = ((evidence.rootParsed && evidence.rootParsed.images && evidence.rootParsed.images.srcs) || [])
    .map((s) => { try { return new URL(s, probeBase).href; } catch { return null; } })
    .filter(Boolean)
    .slice(0, 2);
  // external-host reachability: probe the third-party hosts found in the page
  // (script/iframe/link origins), so a page that loads no external scripts still
  // gets its outbound hosts checked
  const extSample = ((evidence.rootParsed && evidence.rootParsed.thirdPartyHosts) || [])
    .map((h) => { try { return new URL('https://' + h).href; } catch { return null; } })
    .filter(Boolean)
    .slice(0, 2);

  // ---- extended probe pack (deep=true): parallel, bounded by the request budget.
  //      Every probe is HEAD-first / soft-fail; if the budget is nearly gone the
  //      whole pack is skipped (the classic pack still produced a valid report). ----
  const DEEP_NEEDED = 25; // rough headroom so probes don't starve the budget mid-run
  const runDeep = deep && budgetLeft() >= DEEP_NEEDED;
  let deepResults = null;
  if (runDeep) {
    const [cdnHits, i18n, subdomains, mobile, exposure, cachePolicy, imgTypes, extHealth] =
      await Promise.allSettled([
        probeCdnHits(baseUrl, {
          samples: 3,
          firstSample: { headers: rootPage.headers, status: rootPage.status, ttfbMs: rootPage.ttfbMs },
        }),
        probeLangHomepages(baseUrl, (evidence.rootParsed && evidence.rootParsed.hreflang) || []),
        probeSubdomains(String(parsed.domain).replace(/^www\./, '')),
        probeMobileRedirect(String(parsed.domain).replace(/^www\./, '')),
        probeExposure(probeBase),
        probeCachePolicy(staticAssets),
        probeImageTypes(imgSample),
        probeExternalResources(extSample),
      ]);
    deepResults = {
      cdnHits: cdnHits.status === 'fulfilled' ? cdnHits.value : { error: cdnHits.reason && cdnHits.reason.message },
      i18n: i18n.status === 'fulfilled' ? i18n.value : { error: i18n.reason && i18n.reason.message },
      subdomains: subdomains.status === 'fulfilled' ? subdomains.value : { error: subdomains.reason && subdomains.reason.message },
      mobile: mobile.status === 'fulfilled' ? mobile.value : { error: mobile.reason && mobile.reason.message },
      exposure: exposure.status === 'fulfilled' ? exposure.value : { error: exposure.reason && exposure.reason.message },
      cachePolicy: cachePolicy.status === 'fulfilled' ? cachePolicy.value : { error: cachePolicy.reason && cachePolicy.reason.message },
      imgTypes: imgTypes.status === 'fulfilled' ? imgTypes.value : { error: imgTypes.reason && imgTypes.reason.message },
      external: extHealth.status === 'fulfilled' ? extHealth.value : { error: extHealth.reason && extHealth.reason.message },
    };
  }
  const deepEv = deepResults || {};

  // ---- zero-request computations (run regardless of deep; pure parsing/derivation) ----
  evidence.cnameChain = dnsInfo.cnameChain;
  evidence.http3 = probeHttp3(rootPage.headers || {});
  evidence.csp = parseCspPolicy(
    rootPage.headers && (rootPage.headers['content-security-policy'] || rootPage.headers['Content-Security-Policy']),
    rootPage.headers && (rootPage.headers['content-security-policy-report-only'] || rootPage.headers['Content-Security-Policy-Report-Only']),
  );
  evidence.robotsConflicts = detectRobotsConflicts(evidence.robots);
  evidence.sitemapLangDist = languageDistribution(evidence.sitemap.urls, langPrefixes);
  evidence.i18nCoverage = i18nCoverage(evidence.sitemap.urls, langPrefixes);
  evidence.lang404 = check404Localization(
    notFoundRes.status === 404 && !notFoundRes.error ? parsePage(notFoundRes.body || '', notFoundUrl) : null,
  );
  evidence.sanUsage = dnsInfo.certificate
    ? await checkSanUsage(dnsInfo.certificate, parsed.domain).catch(() => ({ sans: [], used: [], unused: [] }))
    : { sans: [], used: [], unused: [] };
  {
    const rp = evidence.rootParsed || {};
    const firstImg = (rp.images && rp.images.srcs && rp.images.srcs[0]) || null;
    const h1 = rp.headings && rp.headings.h1 && rp.headings.h1.samples && rp.headings.h1.samples[0];
    evidence.lcpCandidate = {
      detail: firstImg || h1
        ? `候选: ${h1 ? 'H1「' + h1.slice(0, 30) + '」' : ''}${firstImg ? ' + 首图 ' + new URL(firstImg, probeBase).pathname.slice(0, 40) : ''}（DOM 顺序估算，非 RUM 实测）`
        : '无首屏元素样本',
    };
  }
  evidence.requestStats = getRequestStats();
  evidence.budget = {
    maxRequests,
    used: requestsUsed(),
    deepRan: !!runDeep,
    deepSkipped: !runDeep && deep ? '预算不足（used=' + requestsUsed() + '）' : !deep ? 'deep=false' : null,
  };

  // ---- TTFB samples across repeated homepage fetches (for the stability check) ----
  evidence.ttfbSamples = [rootPage.ttfbMs, ...((deepEv.cdnHits && deepEv.cdnHits.samples) || []).map((s) => s.ttfbMs)].filter((v) => typeof v === 'number' && v > 0);

  // ---- merge deep results into evidence (checks read them from here) ----
  Object.assign(evidence, deepEv);

  // ---- cross-page title / meta duplication (the "all titles identical" check) ----
  const titleMeta = { titles: [], descriptions: [], titleSet: new Set(), descSet: new Set() };
  const pagesForCompare = [evidence.rootParsed, ...pages.map((p) => p.parsed)].filter(Boolean);
  for (const pg of pagesForCompare) {
    if (pg.title) {
      titleMeta.titles.push(pg.title);
      titleMeta.titleSet.add(pg.title);
    }
    const d = (pg.meta && pg.meta.description) || '';
    if (d) {
      titleMeta.descriptions.push(d);
      titleMeta.descSet.add(d);
    }
  }
  titleMeta.uniqueTitles = titleMeta.titleSet.size;
  titleMeta.uniqueDescs = titleMeta.descSet.size;
  titleMeta.pagesCompared = pagesForCompare.length;
  evidence.titleMeta = titleMeta;

  // ---- cross-page body near-duplicate detection (fingerprint on real-content pages) ----
  // Only pages with meaningful content (wordCount > 200) participate — WAF challenge
  // pages / thin shells are excluded by construction, so they cannot create false dupes.
  const bodyFinger = (p) => (p && p.bodyFingerprint && p.wordCount > 200 ? p.bodyFingerprint : null);
  const dupGroups = [];
  const seen = new Set();
  const fpMap = new Map(); // fingerprint -> [page names]
  const nameOf = (p, fallback) => {
    try {
      return new URL(p.url || p.canonical || fallback).pathname || fallback;
    } catch {
      return fallback;
    }
  };
  const contentPages = [
    { p: evidence.rootParsed, n: '/' },
    ...pages.map((x) => ({ p: x.parsed, n: nameOf(x, x.url) })),
  ].filter((x) => x.p && bodyFinger(x.p));
  for (const { p, n } of contentPages) {
    const f = bodyFinger(p);
    if (!f || seen.has(f)) continue;
    seen.add(f);
    const peers = contentPages.filter((x) => bodyFinger(x.p) === f);
    if (peers.length > 1) dupGroups.push({ fingerprint: f, wordCount: p.wordCount, pages: peers.map((x) => x.n) });
  }
  evidence.contentDup = {
    groups: dupGroups,
    duplicatePages: dupGroups.reduce((a, g) => a + g.pages.length, 0),
    pagesCompared: contentPages.length,
  };

  // ---- cookie flags (Set-Cookie from the final response) ----
  evidence.cookieFlags = parseCookieFlags(rootPage.rawCookies || []);

  // ---- checks ----
  const reqHost = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  const finalHost = (() => {
    try {
      return new URL(baseUrl).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
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
    // WAF / anti-bot interception: the final response left the target host
    // (e.g. jumped to a waf.xxx.com verification page) — headless fetching got
    // a challenge page, not the real site content.
    wafIntercepted: !!(reqHost && finalHost && reqHost !== finalHost),
  };
  const checks = buildChecks({
    url: baseUrl,
    probeBase,
    root: rootForChecks,
    rootPage: rootForChecks,
    fingerprint: evidence.fingerprint,
    dns: dnsInfo,
    robots: evidence.robots,
    sitemap: evidence.sitemap,
    probe404: notFoundRes,
    scale: scaleRes,
    aiBots: aiRes,
    llms: llmsRes,
    langs: langRes,
    proto: protoRes,
    aiBlocksGeo: evidence.aiBlocksGeo,
    aiBlocksSeo: evidence.aiBlocksSeo,
    titleMeta: titleMeta,
    contentDup: evidence.contentDup,
    cookieFlags: evidence.cookieFlags,
    pages: pages,
    // ---- extended check inputs (zero-request + deep probes) ----
    cnameChain: evidence.cnameChain,
    http3: evidence.http3,
    csp: evidence.csp,
    robotsConflicts: evidence.robotsConflicts,
    sitemapLangDist: evidence.sitemapLangDist,
    i18nCoverage: evidence.i18nCoverage,
    lang404: evidence.lang404,
    sanUsage: evidence.sanUsage,
    ttfbSamples: evidence.ttfbSamples,
    lcpCandidate: evidence.lcpCandidate,
    cdnHits: deepEv.cdnHits,
    cachePolicy: deepEv.cachePolicy,
    i18n: deepEv.i18n,
    subdomains: deepEv.subdomains,
    mobileRedirect: deepEv.mobile,
    exposure: deepEv.exposure,
    imgTypes: deepEv.imgTypes,
    externalHealth: deepEv.external,
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
      scale: scaleRes,
      aiBots: aiRes,
      llms: llmsRes,
      langs: langRes,
      proto: protoRes,
      aiBlocksGeo: evidence.aiBlocksGeo,
      aiBlocksSeo: evidence.aiBlocksSeo,
      titleMeta: titleMeta,
      contentDup: evidence.contentDup,
      cookieFlags: evidence.cookieFlags,
      cnameChain: evidence.cnameChain,
      http3: evidence.http3,
      csp: evidence.csp,
      robotsConflicts: evidence.robotsConflicts,
      sitemapLangDist: evidence.sitemapLangDist,
      i18nCoverage: evidence.i18nCoverage,
      lang404: evidence.lang404,
      sanUsage: evidence.sanUsage,
      ttfbSamples: evidence.ttfbSamples,
      lcpCandidate: evidence.lcpCandidate,
      requestStats: evidence.requestStats,
      budget: evidence.budget,
      deep: deepResults ? {
        cdnHits: deepEv.cdnHits,
        cachePolicy: deepEv.cachePolicy,
        i18n: deepEv.i18n,
        subdomains: deepEv.subdomains,
        mobile: deepEv.mobile,
        exposure: deepEv.exposure,
        imgTypes: deepEv.imgTypes,
        external: deepEv.external,
      } : null,
    },
    checks,
  };
}

module.exports = { runDiagnosis, cleanUrls, clusterSample, linksFallback };
