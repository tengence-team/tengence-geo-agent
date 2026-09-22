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
  const images = { count: 0, missingAlt: 0, lazy: 0, srcs: [] };
  $('img').each((i, el) => {
    images.count++;
    const src = $(el).attr('src') || $(el).attr('data-src') || '';
    const alt = $(el).attr('alt');
    if (alt === undefined || alt === null || alt === '') images.missingAlt++;
    if ($(el).attr('loading') === 'lazy' || $(el).attr('data-src')) images.lazy++;
    if (images.srcs.length < 20 && src) images.srcs.push(src);
  });

  // ---- links ----
  const links = { total: 0, internal: 0, external: 0, nofollow: 0, emptyText: 0, samples: [] };
  $('a[href]').each((i, el) => {
    links.total++;
    const href = $(el).attr('href');
    const rel = ($(el).attr('rel') || '').split(/\s+/).filter(Boolean);
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (sameHost(href)) links.internal++;
    else links.external++;
    if (rel.includes('nofollow')) links.nofollow++;
    if (!text) links.emptyText++;
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
      if (scripts.srcs.length < 20) scripts.srcs.push(src);
    }
  });
  const stylesheets = $('link[rel="stylesheet"]').length;

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

  // ---- forms / iframes / video / audio ----
  const forms = $('form').length;
  const iframes = $('iframe').length;

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
      srcs: images.srcs,
    },
    links: {
      total: links.total,
      internal: links.internal,
      external: links.external,
      nofollow: links.nofollow,
      emptyText: links.emptyText,
      samples: links.samples,
    },
    scripts: { count: scripts.count, blocking: scripts.blocking, srcs: scripts.srcs },
    stylesheets,
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
    blockquotes,
    lists,
    forms,
    iframes,
    httpResources: httpResources.slice(0, 20),
    mixedContent: httpResources.length,
  };
}

module.exports = { parsePage, collectTypes };
