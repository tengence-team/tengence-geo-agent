'use strict';
/**
 * GSC Search Analytics API wrapper (read-only)
 * ============================================================================
 * Docs: https://developers.google.com/webmasters/v1/searchanalytics/query
 *   POST https://searchconsole.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query
 * Scope: https://www.googleapis.com/auth/webmasters (or webmasters.readonly)
 *
 * Why this exists: the submission chain (submitSitemap / inspectUrl) covers
 * "how do I get indexed", but Search Analytics is the ONLY source for clicks,
 * impressions, CTR and average position — i.e. "is the site actually getting
 * traffic, and from which queries / on which pages". It is also the only Google
 * source for page-level data (Bing dropped GetPages / GetTrafficStats on
 * 2026-08-31, so Bing can no longer answer that question at all).
 *
 * Data lag: Google finalises a day's data 2–3 days later, so the default window
 * ends 3 days ago instead of today (querying today returns an empty or partial
 * response).
 * ============================================================================
 */
const { gFetch } = require('./http');

const HOST = 'https://searchconsole.googleapis.com';

/** Dimensions accepted by the Search Analytics API */
const DIMENSIONS = [
  'query',
  'page',
  'date',
  'country',
  'device',
  'searchAppearance',
];

function endpoint(siteUrl) {
  return `${HOST}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
}

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Default window: [today - lagDays - (days - 1), today - lagDays] (inclusive).
 * lagDays defaults to 3 because GSC data is finalised 2–3 days late.
 */
function defaultRange(days = 28, lagDays = 3) {
  const end = new Date();
  end.setDate(end.getDate() - lagDays);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  return { startDate: ymd(start), endDate: ymd(end) };
}

/** Raw query (returns clicks / impressions / ctr / position per dimension key) */
async function searchAnalytics({
  siteUrl,
  token,
  startDate,
  endDate,
  dimensions = ['query'],
  rowLimit = 100,
  startRow = 0,
  type = 'web',
  dataState = 'all',
  dimensionFilterGroups,
  proxy = null,
}) {
  const bad = dimensions.filter((d) => !DIMENSIONS.includes(d));
  if (bad.length) {
    throw new Error(`Unsupported Search Analytics dimension(s): ${bad.join(', ')} (allowed: ${DIMENSIONS.join(', ')})`);
  }
  const body = { startDate, endDate, dimensions, rowLimit, startRow, type };
  if (dataState) body.dataState = dataState;
  if (dimensionFilterGroups) body.dimensionFilterGroups = dimensionFilterGroups;

  const res = await gFetch(endpoint(siteUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    proxy,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`searchAnalytics failed ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

/**
 * Flatten the API's { keys: [...], clicks, impressions, ctr, position } rows into
 * named objects, e.g. { query: 'geo', clicks: 3, impressions: 40, ctr: 0.075, position: 8.2 }
 */
function normalizeRows(resp, dimensions) {
  return (resp.rows || []).map((r) => {
    const o = {};
    dimensions.forEach((d, i) => {
      o[d] = r.keys ? r.keys[i] : null;
    });
    o.clicks = r.clicks;
    o.impressions = r.impressions;
    o.ctr = r.ctr;
    o.position = r.position;
    return o;
  });
}

module.exports = { DIMENSIONS, endpoint, defaultRange, searchAnalytics, normalizeRows, ymd };
