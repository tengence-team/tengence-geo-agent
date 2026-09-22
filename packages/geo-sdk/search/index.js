'use strict';
/**
 * Google inclusion-submission domain (tengence-geo-sdk/search) unified exit
 * ============================================================================
 * High-level capabilities:
 *   discoverSiteUrl   auto-discover the real siteUrl (sites.list; no manual
 *                     sc-domain / url-prefix entry)
 *   submitSitemap     submit/refresh a sitemap
 *   listSitemaps      list submitted sitemaps and their status
 *   inspectUrl        URL Inspection single-URL inclusion query (read-only)
 *   notifyIndexing    Indexing API notification (guarded by
 *                     GOOGLE_INDEXING_API_ENABLED)
 *   collectSampleUrls fetch a sitemap and sample URLs from it (for batch status checks)
 *
 * All network calls are wrapped by the upper-layer CLI in try/catch; failures only
 * log and never block the publish chain.
 * ============================================================================
 */
const { loadSite } = require('../site');
const auth = require('./auth');
const sitemap = require('./sitemap');
const inspect = require('./inspect');
const indexing = require('./indexing');
const indexnow = require('./indexnow');
const baidu = require('./baidu');
const { gFetch } = require('./http');

const SCOPE = 'https://www.googleapis.com/auth/webmasters';

let siteUrlCache = null;
function resetCache() {
  siteUrlCache = null;
  auth.resetCache();
}

/** Auto-discover the site's siteUrl in GSC (domain property sc-domain:xxx or URL prefix) */
async function discoverSiteUrl(site) {
  if (siteUrlCache) return siteUrlCache;
  const token = await auth.getAccessToken(site, SCOPE);
  const res = await gFetch('https://www.googleapis.com/webmasters/v3/sites', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 403) {
      const email = auth.loadServiceAccount(site).client_email;
      throw new Error(
        `The service account has no access to any GSC site (HTTP 403). In Google Search Console, add ${email} as a "full" user (Settings → Users and permissions → Add user).`
      );
    }
    throw new Error(`sites.list failed ${res.status}: ${text}`);
  }
  const json = JSON.parse(text);
  const entries = (json.siteEntry || []).map((e) => e.siteUrl);
  if (entries.length === 0) {
    const email = auth.loadServiceAccount(site).client_email;
    throw new Error(
      `The service account has not been granted any GSC site. In GSC, add ${email} as a "full" user.`
    );
  }
  const domain = (site.site && site.site.domain) || process.env.SITE_DOMAIN || 'tengence.com';
  const matched = entries.find((u) => u.includes(domain)) || entries[0];
  siteUrlCache = matched;
  return matched;
}

/** Submit/refresh a sitemap (feedPath takes the full sitemap URL) */
async function submitSitemap(site, sitemapUrl) {
  const siteUrl = await discoverSiteUrl(site);
  const token = await auth.getAccessToken(site, SCOPE);
  return sitemap.submitSitemap({ siteUrl, sitemapUrl, token });
}

/** List submitted sitemaps and their status */
async function listSitemaps(site) {
  const siteUrl = await discoverSiteUrl(site);
  const token = await auth.getAccessToken(site, SCOPE);
  return sitemap.listSitemaps({ siteUrl, token });
}

/** Single-URL inclusion/indexing status (URL Inspection API) */
async function inspectUrl(site, inspectionUrl) {
  const siteUrl = await discoverSiteUrl(site);
  const token = await auth.getAccessToken(site, SCOPE);
  return inspect.inspectUrl({ siteUrl, inspectionUrl, token });
}

/** Fetch a sitemap XML and extract the <loc> list (sunk into sitemap.js 2026-09-20;
 * forwarded here to keep the exit stable) */
const fetchSitemapUrls = (sitemapUrl) => sitemap.fetchSitemapUrls(sitemapUrl);

/** Recursively fetch a sitemap (sitemap index → child sitemaps flattened, deduped)
 * (sunk into sitemap.js 2026-09-20; forwarded) */
const fetchAllSitemapUrls = (sitemapUrl, seen, out) => sitemap.fetchAllSitemapUrls(sitemapUrl, seen, out);

/** Fetch a submitted sitemap and sample URLs from it (article URLs preferred) */
async function collectSampleUrls(site, limit = 50) {
  const siteUrl = await discoverSiteUrl(site);
  const token = await auth.getAccessToken(site, SCOPE);
  const maps = await sitemap.listSitemaps({ siteUrl, token });
  const urls = [];
  for (const m of maps) {
    const feed = m.path || m.sitemapUrl || m.url;
    if (!feed) continue;
    try {
      urls.push(...(await sitemap.fetchSitemapUrls(feed)));
    } catch (e) {
      // a single sitemap fetch failure doesn't affect the others
    }
    if (urls.length >= limit) break;
  }
  const articles = urls.filter((u) => u.includes('/blog/article/'));
  return (articles.length ? articles : urls).slice(0, limit);
}

/** Indexing API notification (guarded by a switch) */
async function notifyIndexing(site, url) {
  if (process.env.GOOGLE_INDEXING_API_ENABLED !== '1') {
    throw new Error(
      'Indexing API is not enabled (GOOGLE_INDEXING_API_ENABLED != "1"). The API officially supports only JobPosting / BroadcastEvent; blog articles are an unofficial use — know the risk before enabling.'
    );
  }
  const token = await auth.getAccessToken(site, indexing.SCOPE);
  return indexing.notify(token, url);
}

module.exports = {
  SCOPE,
  auth,
  resetCache,
  discoverSiteUrl,
  submitSitemap,
  listSitemaps,
  inspectUrl,
  fetchSitemapUrls,
  fetchAllSitemapUrls,
  collectSampleUrls,
  notifyIndexing,
  indexnow,
  baidu,
};
