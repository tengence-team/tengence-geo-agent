/**
 * diagnose/sitemap.js — sitemap discovery & parsing (regex-based XML, zero deps)
 * ============================================================================
 * Probes candidate URLs in order; understands <sitemapindex> (recurses into the
 * first child to grab representative URLs) and <urlset>. Always bounded.
 */

const { fetchPage } = require('./fetch');

const LOC_RE = /<loc>\s*([^<]+?)\s*<\/loc>/gi;

function extractLocs(xml) {
  const out = [];
  let m;
  while ((m = LOC_RE.exec(xml || '')) !== null) out.push(m[1].trim());
  return out;
}

/**
 * @param {string[]} candidates absolute or relative sitemap URLs
 * @param {string} baseUrl
 * @param {{maxUrls?:number, timeoutMs?:number}} [opts]
 */
async function probeSitemaps(candidates, baseUrl, { maxUrls = 200, timeoutMs = 12000 } = {}) {
  const out = {
    found: false,
    type: null,
    urlCount: 0,
    urls: [],
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
      const locs = extractLocs(body);
      out.found = true;
      out.type = 'index';
      out.sitemaps = locs.slice(0, 50);
      out.urlCount = locs.length;
      // recurse into the first child sitemap to collect representative URLs
      if (locs.length) {
        const sub = await fetchPage(locs[0], { timeoutMs });
        if (sub.status === 200) {
          const urls = extractLocs(sub.body);
          out.urls = urls.slice(0, maxUrls);
          out.urlCount = Math.max(out.urlCount, urls.length);
        }
      }
      break;
    }
    if (/<urlset/i.test(body)) {
      const urls = extractLocs(body);
      out.found = true;
      out.type = 'urlset';
      out.urls = urls.slice(0, maxUrls);
      out.urlCount = urls.length;
      break;
    }
    out.errors.push(`${u}: not a sitemap (no <urlset>/<sitemapindex>)`);
  }
  return out;
}

module.exports = { probeSitemaps, extractLocs };
