'use strict';
/**
 * URL Inspection API wrapper (read-only)
 * ============================================================================
 * Docs: https://developers.google.com/search/apis/url-inspection-api/reference/rest/v1/urlInspection.index/inspect
 *   POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect
 * Scope: https://www.googleapis.com/auth/webmasters (or webmasters.readonly)
 * Quota: 2000/day/resource.
 * Returns coverage of verdict, coverageState, googleCanonical, indexingState,
 * lastCrawlTime etc.
 * ⚠️ The host must be searchconsole.googleapis.com (www.googleapis.com has no such
 *    endpoint and returns 404).
 * ============================================================================
 */
const API = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const { gFetch } = require('./http');

/** Query a single URL's inclusion/indexing status */
async function inspectUrl({ siteUrl, inspectionUrl, token, languageCode = 'zh-CN' }) {
  const res = await gFetch(API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inspectionUrl, siteUrl, languageCode }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`urlInspection failed ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

module.exports = { inspectUrl };
