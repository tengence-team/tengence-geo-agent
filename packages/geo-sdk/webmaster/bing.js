'use strict';
/**
 * Bing Webmaster Tools API wrapper (tengence-geo-sdk/webmaster/bing)
 * ============================================================================
 * Read/write access to the Bing Webmaster (站长) console via the JSON API.
 * Docs: https://learn.microsoft.com/zh-cn/bingwebmaster/api-protocols
 *   Base : https://ssl.bing.com/webmaster/api.svc/json/
 *   Auth : query parameter `apikey=<API_KEY>` on every request (no Authorization
 *          header, no OAuth). API key from Bing Webmaster → Settings → API Access.
 *   Params: GET methods take siteUrl etc. as query params; POST methods take
 *          siteUrl / url / urlList in the JSON body, with apikey in the query.
 *          Responses are wrapped as {"d": …}.
 *   Note : ssl.bing.com is reachable directly from CN networks; the shared gFetch
 *          routes only Google hosts through the proxy, so no proxy config is
 *          needed for Bing.
 *
 * ⚠️ Methods verified live on 2026-09-24 (Microsoft retired the legacy SOAP/POX
 *    protocols on 2026-08-31 and the JSON surface was trimmed; Microsoft now
 *    recommends IndexNow for URL submission):
 *   Available  : GetUserSites / GetQueryStats / GetCrawlIssues /
 *                GetUrlSubmissionQuota (read) · SubmitUrl / SubmitUrlBatch (write)
 *   Removed(404): GetPages / GetSitemaps / GetTrafficStats / GetSiteStats /
 *                GetUrlSubmissionStatus / SubmitSitemap — NOT implemented.
 *
 * Conventions:
 *   - every call takes `apiKey` (falls back to BING_WEBMASTER_API_KEY already
 *     injected into process.env by loadSite);
 *   - siteUrl is discovered from GetUserSites when omitted (matches
 *     process.env.SITE_DOMAIN / site.domain — same auto-discovery as GSC);
 *   - a single failed batch only logs and never blocks the chain (soft-fail).
 * ============================================================================
 */
const { gFetch } = require('../search/http');
const { maskKey, encodeParam, defaultLogPath, loadDoneUrls, logLine } = require('./util');

const API = 'https://ssl.bing.com/webmaster/api.svc/json/';
const TIMEOUT_MS = 10_000;

/** Resolve the API key: explicit param → BING_WEBMASTER_API_KEY (injected by loadSite). */
function resolveKey(apiKey) {
  return apiKey || process.env.BING_WEBMASTER_API_KEY || '';
}

/**
 * Unwrap a Bing API response body: plain JSON array/object is passed through;
 * an ASP.NET-style {"d": …} wrapper is unwrapped.
 */
function unwrap(body) {
  if (body && typeof body === 'object' && !Array.isArray(body) && 'd' in body) return body.d;
  return body;
}

/** Serialize query params (apikey first, then the given params), URL-encoded. */
function queryString(apiKey, params = {}) {
  return Object.entries({ apikey: resolveKey(apiKey), ...params })
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeParam(v)}`)
    .join('&');
}

/** Low-level GET (params in query incl. apikey); returns parsed JSON. */
async function apiGet(apiKey, endpoint, params = {}) {
  const url = API + endpoint + (queryString(apiKey, params) ? `?${queryString(apiKey, params)}` : '');
  const res = await gFetch(url, { headers: { Accept: 'application/json' } }, TIMEOUT_MS);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Bing ${endpoint} failed HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Bing ${endpoint} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  return unwrap(json);
}

/**
 * Low-level POST: apikey in the query, business params (siteUrl / url / urlList)
 * in the JSON body per the live API behavior (verified 2026-09-24).
 */
async function apiPost(apiKey, endpoint, params = {}) {
  const url = API + endpoint + (queryString(apiKey) ? `?${queryString(apiKey)}` : '');
  const res = await gFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(params),
  }, TIMEOUT_MS);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Bing ${endpoint} failed HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!text) return {};
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Bing ${endpoint} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  return unwrap(json);
}

/** List the sites the key is verified for (GetUserSites). */
async function listSites({ apiKey } = {}) {
  return apiGet(apiKey, 'GetUserSites');
}

/**
 * Auto-discover the siteUrl for this site: prefer the entry containing the
 * site's domain, fall back to the first verified entry. (mirrors GSC discovery)
 */
async function discoverSiteUrl({ apiKey, domain, siteUrl } = {}) {
  if (siteUrl) return siteUrl;
  const entries = (await listSites({ apiKey })) || [];
  const entriesArr = Array.isArray(entries) ? entries : [];
  // GetUserSites entries are objects carrying a Url field (may also be plain strings)
  const urls = entriesArr
    .map((e) => (typeof e === 'string' ? e : e.Url || e.url || e.SiteUrl || ''))
    .filter(Boolean);
  const want = domain || process.env.SITE_DOMAIN || (process.env.BING_WEBMASTER_SITE_URL || '');
  if (!want && urls.length === 1) return urls[0];
  const matched = urls.find((u) => u.includes(want));
  if (!matched) {
    throw new Error(
      `No Bing Webmaster site matches "${want || '(unknown domain)'}". Verified sites: ${urls.join(', ') || 'none'}`
    );
  }
  return matched;
}

// ---------------- Read (后台数据查询) ----------------

/** GetQueryStats — impressions / clicks / CTR / avg position (optional query filter). */
async function getQueryStats({ apiKey, siteUrl, domain, query } = {}) {
  const s = await discoverSiteUrl({ apiKey, domain, siteUrl });
  return apiGet(apiKey, 'GetQueryStats', { siteUrl: s, query });
}

/** GetCrawlIssues — crawl issue list (empty when the site has none). */
async function getCrawlIssues({ apiKey, siteUrl, domain } = {}) {
  const s = await discoverSiteUrl({ apiKey, domain, siteUrl });
  return apiGet(apiKey, 'GetCrawlIssues', { siteUrl: s });
}

/** GetUrlSubmissionQuota — remaining daily / monthly URL submission quota. */
async function getQuota({ apiKey, siteUrl, domain } = {}) {
  const s = await discoverSiteUrl({ apiKey, domain, siteUrl });
  return apiGet(apiKey, 'GetUrlSubmissionQuota', { siteUrl: s });
}

// ---------------- Write (推送后台) ----------------

/** SubmitUrl — submit a single URL (body: { siteUrl, url }). */
async function submitUrl({ apiKey, siteUrl, url, domain } = {}) {
  if (!url) throw new Error('submitUrl requires a url');
  const s = await discoverSiteUrl({ apiKey, domain, siteUrl });
  return apiPost(apiKey, 'SubmitUrl', { siteUrl: s, url });
}

/** SubmitUrlBatch — batch submit (body: { siteUrl, urlList }; Bing daily quota default 100). */
async function submitUrlBatch({ apiKey, siteUrl, urlList, domain } = {}) {
  if (!Array.isArray(urlList) || urlList.length === 0) {
    throw new Error('submitUrlBatch requires a non-empty urlList');
  }
  const s = await discoverSiteUrl({ apiKey, domain, siteUrl });
  return apiPost(apiKey, 'SubmitUrlBatch', { siteUrl: s, urlList });
}

/**
 * Full incremental submission from a sitemap (--all orchestration): fetch →
 * log dedupe → batched submit → write log. Same contract as search/baidu.
 * @returns {Promise<{total, doneCount, pendingCount, submitted, ok, fail, batches, noPending}>}
 */
async function submitUrlsFromSitemap({ apiKey, siteUrl, domain, sitemapUrl, resubmit = false, limit = 100, logPath } = {}) {
  const { fetchAllSitemapUrls } = require('../search/sitemap');
  const lp = logPath || defaultLogPath('bing');
  const all = await fetchAllSitemapUrls(sitemapUrl);
  let pending = all;
  let doneCount = 0;
  if (!resubmit) {
    const done = loadDoneUrls(lp);
    doneCount = done.size;
    pending = all.filter((u) => !done.has(u));
  }
  const list = pending.slice(0, limit);
  const noPending = list.length === 0;

  const BATCH = 100;
  const stats = { total: all.length, doneCount, pendingCount: pending.length, submitted: list.length, ok: 0, fail: 0, batches: [], noPending };
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const batchNo = i / BATCH + 1;
    try {
      await submitUrlBatch({ apiKey, siteUrl, urlList: batch, domain });
      stats.ok += batch.length;
      stats.batches.push({ no: batchNo, ok: true, count: batch.length });
      logLine({ action: 'submit', batch: batchNo, ok: true, urls: batch.slice(0, 20) }, lp);
    } catch (e) {
      stats.fail += batch.length;
      stats.batches.push({ no: batchNo, ok: false, count: batch.length, error: e.message });
      logLine({ action: 'submit', batch: batchNo, ok: false, error: e.message, urls: batch.slice(0, 20) }, lp);
    }
  }
  return stats;
}

module.exports = {
  API,
  resolveKey,
  maskKey,
  listSites,
  discoverSiteUrl,
  getQueryStats,
  getCrawlIssues,
  getQuota,
  submitUrl,
  submitUrlBatch,
  submitUrlsFromSitemap,
  loadDoneUrls,
  logLine,
  defaultLogPath,
};
