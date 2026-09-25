'use strict';
/**
 * Search Console sitemap API wrapper
 * ============================================================================
 * Docs: https://developers.google.com/webmaster-tools/v3/sitemaps
 *   - submit  PUT  /webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}
 *   - list    GET  /webmasters/v3/sites/{siteUrl}/sitemaps
 *   - get     GET  /webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}
 * feedpath takes the sitemap's full URL (URL-encoded).
 * ============================================================================
 */
const SITEMAP_TIMEOUT_MS = 30000;
const API = 'https://www.googleapis.com/webmasters/v3';
const enc = (s) => encodeURIComponent(s);
const { gFetch } = require('./http');

/** Submit (or refresh) a sitemap */
async function submitSitemap({ siteUrl, sitemapUrl, token, proxy = null }) {
  const url = `${API}/sites/${enc(siteUrl)}/sitemaps/${enc(sitemapUrl)}`;
  const res = await gFetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    proxy,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`sitemaps.submit failed ${res.status}: ${text}`);
  }
  return { ok: true, httpStatus: res.status, siteUrl, sitemapUrl };
}

/** List the site's submitted sitemaps and their status */
async function listSitemaps({ siteUrl, token, proxy = null }) {
  const url = `${API}/sites/${enc(siteUrl)}/sitemaps`;
  const res = await gFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    proxy,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`sitemaps.list failed ${res.status}: ${text}`);
  }
  const json = JSON.parse(text);
  return Array.isArray(json.sitemap) ? json.sitemap : [];
}

/** Fetch a sitemap XML and extract the <loc> list (index / leaf not distinguished;
 * the caller decides the flattening strategy) */
async function fetchSitemapUrls(sitemapUrl) {
  // A first (cold) hit on the sitemap index of this site measures ~7s and the
  // recursive child fetches stack on top, so the 10s default aborts intermittently.
  const res = await gFetch(sitemapUrl, {
    headers: { 'User-Agent': 'tengence-geo-submitter/1.0' },
  }, SITEMAP_TIMEOUT_MS);
  const text = await res.text();
  if (!res.ok) throw new Error(`Sitemap fetch failed ${res.status}: ${sitemapUrl}`);
  return [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

/**
 * Recursively fetch a sitemap (supports sitemap index → child-sitemap flattening),
 * returning the deduped actual URL list.
 * Judgment: when one layer's loc all point to .xml (or contain "sitemap"), it's
 * treated as an index and recursion continues; otherwise the pages are real.
 */
async function fetchAllSitemapUrls(sitemapUrl, seen = new Set(), out = []) {
  if (seen.has(sitemapUrl)) return [...new Set(out)];
  seen.add(sitemapUrl);
  const urls = await fetchSitemapUrls(sitemapUrl);
  const looksLikeIndex =
    urls.length > 0 && urls.every((u) => /\.xml(\?|$)/i.test(u) || /sitemap/i.test(u));
  if (looksLikeIndex) {
    for (const u of urls) {
      await fetchAllSitemapUrls(u, seen, out);
    }
  } else {
    out.push(...urls);
  }
  return [...new Set(out)];
}

module.exports = { submitSitemap, listSitemaps, fetchSitemapUrls, fetchAllSitemapUrls };
