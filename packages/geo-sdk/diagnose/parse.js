/**
 * diagnose/parse.js — cheerio-based page analysis
 * ============================================================================
 * Extracts the content-side signals used by the GEO/SEO diagnosis:
 * title / meta / canonical / hreflang / OG / Twitter / robots / charset / lang /
 * viewport / H1..H6 structure / images (alt, lazy) / links (internal/external,
 * nofollow) / scripts & stylesheets (render-blocking estimate) / JSON-LD /
 * mixed-content resources / text volume / quote & list signals.
 */

const cheerio = require('cheerio');
const { createHash } = require('crypto');

/** Fingerprint a text body: sha1 of the normalized first 400 chars (case-folded, no whitespace).
 *  Used for cross-page near-duplicate detection; short/boilerplate bodies hash identical
 *  to each other but are filtered by word-count in the caller. */
function bodyFingerprint(text) {
  const norm = String(text || '')
    .slice(0, 400)
    .toLowerCase()
    .replace(/\s+/g, '');
  return norm ? createHash('sha1').update(norm).digest('hex').slice(0, 16) : '';
}

/** Recursively collect @type values from JSON-LD documents. */
function collectTypes(node, acc = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => collectTypes(n, acc));
  } else if (node && typeof node === 'object') {
    const t = node['@type'];
    if (t) {
      if (Array.isArray(t)) t.forEach((x) => acc.push(String(x)));
      else acc.push(String(t));
    }
    for (const v of Object.values(node)) collectTypes(v, acc);
  }
  return acc;
}

/**
 * @param {string} html
 * @param {string} baseUrl used for internal/external link classification
 * @returns {object} structured page profile
 */
function parsePage(html, baseUrl) {
  const $ = cheerio.load(html || '');
  let host = null;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    host = '';
  }
  const sameHost = (href) => {
    try {
      return new URL(href, baseUrl).hostname.toLowerCase() === host;
    } catch {
      return false;
    }
  };

  // ---- meta ----
  const meta = {};
  $('meta').each((i, el) => {
    const key =
      $(el).attr('name') || $(el).attr('property') || $(el).attr('http-equiv') || '';
    const content = $(el).attr('content') || '';
    const k = key.toLowerCase();
    if (k && !(k in meta)) meta[k] = content;
  });

  // ---- head elements ----
  const canonical = $('link[rel="canonical"]').attr('href') || null;
  const hreflang = [];
  $('link[rel="alternate"][hreflang]').each((i, el) => {
    hreflang.push({ hreflang: $(el).attr('hreflang'), href: $(el).attr('href') });
  });
  const robotsMeta = meta.robots || null;
  const charset =
    $('meta[charset]').attr('charset') ||
    (/charset=([\w-]+)/i.exec(meta['content-type'] || '') || [])[1] ||
    null;
  const lang = $('html').attr('lang') || null;
  const viewport = meta.viewport || null;

  // ---- headings ----
  const headings = {};
  for (const h of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    const samples = [];
    let count = 0;
    let nonEmpty = 0;
    $(h).each((i, el) => {
      count++;
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t) {
        nonEmpty++;
        if (samples.length < 5) samples.push(t);
      }
    });
    headings[h] = { count, nonEmpty, samples };
  }

  // ---- images ----
  const images = { count: 0, missingAlt: 0, lazy: 0, webp: 0, avif: 0, missingSize: 0, srcs: [] };
  $('img').each((i, el) => {
    images.count++;
    const src = $(el).attr('src') || $(el).attr('data-src') || '';
    const alt = $(el).attr('alt');
    // 仅「无 alt 属性」计缺失；alt="" 是装饰/图标图的合法语义（WCAG 1.1.1），不计缺失。
    // 此前把 alt="" 也计为缺失，会误伤大量合规的装饰图（如 Next/SEO 站点图标）。
    if (alt === undefined || alt === null) images.missingAlt++;
    if ($(el).attr('loading') === 'lazy' || $(el).attr('data-src')) images.lazy++;
    const ext = (src.split('?')[0].split('.').pop() || '').toLowerCase();
    if (ext === 'webp') images.webp++;
    if (ext === 'avif') images.avif++;
    if (!$(el).attr('width') && !$(el).attr('height')) images.missingSize++;
    if (images.srcs.length < 100 && src) images.srcs.push(src);
  });

  // ---- links ----
  const links = { total: 0, internal: 0, external: 0, nofollow: 0, emptyText: 0, queryParam: 0, hashOnly: 0, samples: [] };
  $('a[href]').each((i, el) => {
    links.total++;
    const href = $(el).attr('href');
    const rel = ($(el).attr('rel') || '').split(/\s+/).filter(Boolean);
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (sameHost(href)) links.internal++;
    else links.external++;
    if (rel.includes('nofollow')) links.nofollow++;
    if (!text) links.emptyText++;
    // faceted-URL signal: internal links carrying query params (filter/sort/pagination)
    // or hash-only links (no distinct content) — both dilute crawl budget & duplicate risk.
    if (sameHost(href)) {
      try {
        const u = new URL(href, 'https://x');
        if (u.search) links.queryParam++;
        if (u.hash && !u.search && (u.pathname === '/' || u.pathname === '')) links.hashOnly++;
      } catch {
        /* non-URL href (e.g. javascript:) ignored */
      }
    }
    if (links.samples.length < 20 && href) links.samples.push({ href, text, nofollow: rel.includes('nofollow') });
  });

  // ---- scripts & stylesheets ----
  const scripts = { count: 0, blocking: 0, srcs: [] };
  $('script').each((i, el) => {
    scripts.count++;
    const src = $(el).attr('src');
    if (src) {
      if (!$(el).attr('defer') && !$(el).attr('async') && !$(el).attr('type')?.includes('application/ld+json')) {
        scripts.blocking++;
      }
      if (scripts.srcs.length < 100) scripts.srcs.push(src);
    }
  });
  const stylesheets = { count: 0, srcs: [] };
  $('link[rel="stylesheet"]').each((i, el) => {
    stylesheets.count++;
    const href = $(el).attr('href');
    if (href && stylesheets.srcs.length < 50) stylesheets.srcs.push(href);
  });

  // ---- Subresource Integrity (SRI) presence on external script/link tags ----
  const sri = { scripts: 0, scriptsWithIntegrity: 0, links: 0, linksWithIntegrity: 0 };
  $('script[src]').each((i, el) => {
    sri.scripts++;
    if ($(el).attr('integrity')) sri.scriptsWithIntegrity++;
  });
  $('link[rel="stylesheet"][href]').each((i, el) => {
    sri.links++;
    if ($(el).attr('integrity')) sri.linksWithIntegrity++;
  });

  // ---- resource hints & pagination (SEO/performance signals) ----
  const resourceHints = [];
  $('link[rel="preconnect"], link[rel="preload"], link[rel="dns-prefetch"]').each((i, el) => {
    const href = $(el).attr('href');
    if (href) resourceHints.push({ rel: $(el).attr('rel'), href });
  });
  const relPrevNext = [];
  $('link[rel="prev"], link[rel="next"]').each((i, el) => {
    relPrevNext.push({ rel: $(el).attr('rel'), href: $(el).attr('href') });
  });

  // ---- author byline (E-E-A-T signal) ----
  const authorMeta = meta.author || null;
  let bylineText = null;
  $('[class*="author"], [class*="byline"], [rel="author"]').each((i, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t && t.length > 1 && t.length < 80 && !bylineText) bylineText = t;
  });
  const byline = authorMeta || bylineText || null;

  // ---- JSON-LD ----
  const jsonld = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      jsonld.push(JSON.parse($(el).contents().text() || '{}'));
    } catch {
      /* invalid JSON-LD is itself a finding */
    }
  });
  const jsonldTypes = collectTypes(jsonld);

  // ---- mixed content & resource counts ----
  const httpResources = [];
  const resourceRe = /(?:src|href)\s*=\s*["'](http:\/\/[^"'#]+)/gi;
  let mm;
  while ((mm = resourceRe.exec(html)) !== null) {
    httpResources.push(mm[1]);
  }

  // ---- text volume & content signals ----
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const blockquotes = $('blockquote').length;
  const lists = $('ul').length + $('ol').length;

  // ---- Q&A / answer-block signals (quoteable structure for AI engines) ----
  const qaSignals = {
    faqText: /faq|常见问题|questions?\s*(and|&)\s*answers/i.test(bodyText.slice(0, 3000)),
    details: $('details, summary').length,
    questionHeadings: 0,
    samples: [],
  };
  for (const h of ['h2', 'h3']) {
    for (const t of (headings[h] && headings[h].samples) || []) {
      if (/[?？]/.test(t)) {
        qaSignals.questionHeadings++;
        if (qaSignals.samples.length < 4) qaSignals.samples.push(t.slice(0, 60));
      }
    }
  }

  // ---- forms / iframes / video / audio ----
  const forms = $('form').length;
  const iframes = $('iframe').length;

  // ---- word count (CJK chars + latin words; the "78 words" shell test) ----
  const cjkChars = (bodyText.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const latinWords = (
    bodyText.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[a-zA-Z0-9]+(?:['-][a-zA-Z0-9]+)*/g) || []
  ).length;
  const wordCount = cjkChars + latinWords;

  // ---- analytics / statistics scripts (legacy UA- is a real "dead signal") ----
  const htmlLower = html.toLowerCase();
  const analytics = [];
  const ANALYTIC_RULES = [
    { name: 'GA4', kind: 'ga4', re: /googletagmanager\.com\/gtag\/js|gtag\(/i },
    { name: 'Universal Analytics (UA-)', kind: 'ua-legacy', re: /google-analytics\.com\/analytics\.js|ga\('create'|_trackPageview|ua-\d{4,}-\d+/i },
    { name: '百度统计', kind: 'baidu', re: /hm\.baidu\.com\/hm\.js/i },
    { name: 'CNZZ 站长统计', kind: 'cnzz', re: /v1\.cnzz\.com|w\.cnzz\.com|cnzz\.com\/z\.js/i },
    { name: 'Matomo/Piwik', kind: 'matomo', re: /matomo\.js|piwik\.js/i },
  ];
  for (const r of ANALYTIC_RULES) {
    const mm = r.re.exec(htmlLower);
    if (mm) analytics.push({ name: r.name, kind: r.kind, sample: mm[0].slice(0, 80) });
  }

  // ---- viewport details (user-scalable=no hurts mobile usability signal) ----
  const userScalableNo = /user-scalable\s*=\s*(no|0)/i.test(viewport || '');

  // ---- language switcher: in-page links pointing at other language versions ----
  // A "real" i18n site offers humans an in-page switch, complementing hreflang.
  const langLinks = [];
  const langRefs = new Set(hreflang.map((x) => String(x.href || '').replace(/\/+$/, '')));
  for (const s of (links.samples || [])) {
    const clean = String(s.href || '').replace(/\/+$/, '');
    if (langRefs.has(clean) && langLinks.length < 10) langLinks.push(clean);
  }
  const langSwitcher = { found: langLinks.length > 0, links: langLinks };

  // ---- third-party resource hosts (analytics/CDN/embeds — privacy & risk audit) ----
  const thirdPartyHosts = [];
  const externalHosts = [];
  {
    // 站点注册域（host 的 eTLD+1，如 www.tengence.com → tengence.com）：同站子域
    // （console./static./m. 等）不算第三方，避免自有服务被误报为隐私/供应链风险。
    const siteHost = host.split('.').slice(-2).join('.');
    const seen = new Set();
    const push = (h) => {
      if (!h) return;
      const hh = String(h).toLowerCase();
      if (hh === siteHost || hh.endsWith('.' + siteHost)) return; // 同站子域/主域
      if (!seen.has(hh)) {
        seen.add(hh);
        thirdPartyHosts.push(hh);
      }
    };
    for (const s of (scripts.srcs || [])) {
      try {
        if (new URL(s, baseUrl).hostname !== host) push(new URL(s, baseUrl).hostname);
      } catch { /* relative/void — same host by construction */ }
    }
    for (const s of (links.samples || [])) {
      if (s.nofollow || !s.href) continue;
      try {
        const h2 = new URL(s.href, baseUrl).hostname;
        if (h2 !== host) {
          push(h2);
          if (externalHosts.length < 30 && !externalHosts.includes(h2)) externalHosts.push(h2);
        }
      } catch { /* noop */ }
    }
  }

  return {
    title: $('title').first().text().replace(/\s+/g, ' ').trim() || null,
    meta,
    canonical,
    hreflang,
    robotsMeta,
    charset,
    lang,
    viewport,
    headings,
    images: {
      count: images.count,
      missingAlt: images.missingAlt,
      missingAltPct: images.count ? Math.round((images.missingAlt / images.count) * 100) : 0,
      lazy: images.lazy,
      webp: images.webp,
      avif: images.avif,
      missingSize: images.missingSize,
      modernPct: images.count ? Math.round(((images.webp + images.avif) / images.count) * 100) : 0,
      missingSizePct: images.count ? Math.round((images.missingSize / images.count) * 100) : 0,
      srcs: images.srcs,
    },
    links: {
      total: links.total,
      internal: links.internal,
      external: links.external,
      nofollow: links.nofollow,
      emptyText: links.emptyText,
      queryParam: links.queryParam,
      hashOnly: links.hashOnly,
      samples: links.samples,
    },
    scripts: { count: scripts.count, blocking: scripts.blocking, srcs: scripts.srcs },
    stylesheets,
    sri,
    resourceHints,
    relPrevNext,
    byline,
    qaSignals,
    externalHosts,
    jsonld: { count: jsonld.length, types: jsonldTypes, samples: jsonld.slice(0, 3) },
    og: {
      title: meta['og:title'] || null,
      description: meta['og:description'] || null,
      image: meta['og:image'] || null,
      type: meta['og:type'] || null,
      url: meta['og:url'] || null,
      site_name: meta['og:site_name'] || null,
      locale: meta['og:locale'] || null,
    },
    twitter: {
      card: meta['twitter:card'] || null,
      title: meta['twitter:title'] || null,
      description: meta['twitter:description'] || null,
      image: meta['twitter:image'] || null,
    },
    textLength: bodyText.length,
    bodyText: bodyText.slice(0, 10000),
    wordCount,
    cjkChars,
    latinWords,
    bodyFingerprint: bodyFingerprint(bodyText),
    blockquotes,
    lists,
    forms,
    iframes,
    analytics,
    userScalableNo,
    langSwitcher,
    thirdPartyHosts,
    httpResources: httpResources.slice(0, 20),
    mixedContent: httpResources.length,
  };
}

module.exports = { parsePage, collectTypes, bodyFingerprint };
