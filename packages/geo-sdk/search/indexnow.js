'use strict';
/**
 * IndexNow submission wrapper (Bing / Yandex / Naver / Seznam joint inclusion
 * protocol)
 * ============================================================================
 * Docs: https://www.indexnow.org/documentation
 *   POST https://api.indexnow.org/indexnow
 *   body: { host, key, keyLocation, urlList } (≤ 10000 per request)
 * Ownership proof: https://<host>/<key>.txt must be reachable (key is 32-char hex).
 * A 200/202 return means accepted (not "indexed"; indexing takes hours to days).
 * Network reuses ./http's gFetch (HTTPS_PROXY tunnel + timeout).
 * ============================================================================
 */
const { gFetch } = require('./http');

const API = 'https://api.indexnow.org/indexnow';

/** Submit a batch of URLs (max 10000 per request) */
async function submitUrls({ host, key, keyLocation, urlList }) {
  if (!host || !key || !Array.isArray(urlList) || urlList.length === 0) {
    throw new Error('Incomplete IndexNow params: need host + key + a non-empty urlList');
  }
  const res = await gFetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host, key, keyLocation, urlList }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`IndexNow submission failed HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return { httpStatus: res.status, count: urlList.length };
}

module.exports = { submitUrls, API };
