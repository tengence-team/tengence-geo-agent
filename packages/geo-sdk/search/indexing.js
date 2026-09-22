'use strict';
/**
 * Indexing API wrapper (guarded by a switch, disabled by default)
 * ============================================================================
 * Docs: https://developers.google.com/search/apis/indexing-api/v3/reference/rest/v3/UrlNotifications/publish
 *   POST https://indexing.googleapis.com/v3/urlNotifications:publish
 * Scope: https://www.googleapis.com/auth/indexing
 *
 * ⚠️ Officially only JobPosting / BroadcastEvent are supported; blog articles are an
 *    unofficial use and abuse can get the account demoted — off by default
 *    (enabled only with GOOGLE_INDEXING_API_ENABLED=1).
 * ============================================================================
 */
const API = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
const SCOPE = 'https://www.googleapis.com/auth/indexing';
const { gFetch } = require('./http');

/** Notify Google that a URL was updated/deleted (requires the switch explicitly on) */
async function notify(token, url, type = 'URL_UPDATED') {
  const res = await gFetch(API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url, type }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`indexing.publish failed ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

module.exports = { notify, SCOPE };
