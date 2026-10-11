/**
 * diagnose/sitemap.js — sitemap discovery & parsing (regex-based XML, zero deps)
 * ============================================================================
 * Probes candidate URLs in order; understands <sitemapindex> (recurses into ALL
 * child sitemaps so the URL inventory is complete, bounded by maxUrls) and
 * <urlset>. Collects <lastmod> where present. Always bounded.
 */

const { fetchPage } = require('./fetch');

const LOC_RE = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
const LASTMOD_RE = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/gi;

function extractLocs(xml) {
  const out = [];
  let m;
  while ((m = LOC_RE.exec(xml || '')) !== null) out.push(m[1].trim());
  return out;
}

function extractLastmods(xml) {
  const out = [];
  let m;
  while ((m = LASTMOD_RE.exec(xml || '')) !== null) out.push(m[1].trim());
  return out;
}

/**
 * Group sitemap URLs by language prefix (i18n health signal). Returns counts per
 * prefix plus the share of URLs carrying no language prefix at all.
 * @param {string[]} urls
 * @param {string[]} [langPrefixes] e.g. ['zh-hans','zh-hant','en'] — other prefixes are bucketed as 'other'
 * @returns {{ total:number, byLang:Record<string,number>, noPrefix:number, missing: string[] }}
 */
function languageDistribution(urls, langPrefixes = []) {
  const byLang = {};
  for (const p of langPrefixes) byLang[p] = 0;
  let noPrefix = 0;
  for (const u of urls || []) {
    let matched = null;
    try {
      const pathname = new URL(u).pathname;
      for (const p of langPrefixes) {
        if (pathname === '/' + p || pathname.startsWith('/' + p + '/')) {
          matched = p;
          break;
        }
      }
    } catch {
      /* unparsable URL — counts as no-prefix */
    }
    if (matched) byLang[matched]++;
    else noPrefix++;
  }
  const missing = langPrefixes.filter((p) => !byLang[p]);
  return { total: (urls || []).length, byLang, noPrefix, missing };
}

/**
 * @param {string[]} candidates absolute or relative sitemap URLs
 * @param {string} baseUrl
 * @param {{maxUrls?:number, timeoutMs?:number}} [opts]
 */
async function probeSitemaps(candidates, baseUrl, { maxUrls = 1000, timeoutMs = 12000 } = {}) {
  const out = {
    found: false,
    type: null,
    urlCount: 0,
    urls: [],
    lastmods: [],
    sitemaps: [],
    probed: [],
    errors: [],
  };
  for (const cand of candidates || []) {
    let u;
    try {
      u = new URL(cand, baseUrl).href;
    } catch {
      continue;
    }
    out.probed.push(u);
    const res = await fetchPage(u, { timeoutMs });
    if (res.error || res.status !== 200) {
      out.errors.push(`${u}: ${res.error || 'HTTP ' + res.status}`);
      continue;
    }
    const body = res.body || '';
    if (/<sitemapindex/i.test(body)) {
      out.found = true;
      out.type = 'index';
      const locs = extractLocs(body);
      out.sitemaps = locs.slice(0, 50);
      out.urlCount = locs.length;
      // recurse into EVERY child sitemap (a complete inventory is the point of
      // the language-distribution / coverage checks; the first child alone
      // would silently drop whole sections of the site)
      const budget = Math.max(1, maxUrls);
      for (const child of out.sitemaps) {
        if (out.urls.length >= budget) break;
        const sub = await fetchPage(child, { timeoutMs });
        if (sub.status !== 200) {
          out.errors.push(`${child}: HTTP ${sub.status}`);
          continue;
        }
        const urls = extractLocs(sub.body);
        const lastmods = extractLastmods(sub.body);
        for (let k = 0; k < urls.length; k++) {
          if (out.urls.length >= budget) break;
          out.urls.push(urls[k]);
          if (lastmods[k]) out.lastmods.push(lastmods[k]);
        }
      }
      out.urlCount = Math.max(out.urlCount, out.urls.length);
      break;
    }
    if (/<urlset/i.test(body)) {
      const urls = extractLocs(body);
      out.found = true;
      out.type = 'urlset';
      out.urls = urls.slice(0, maxUrls);
      out.urlCount = urls.length;
      out.lastmods = extractLastmods(body).slice(0, maxUrls);
      break;
    }
    out.errors.push(`${u}: not a sitemap (no <urlset>/<sitemapindex>)`);
  }
  return out;
}

module.exports = { probeSitemaps, extractLocs, extractLastmods, languageDistribution };
