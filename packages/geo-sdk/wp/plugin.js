/**
 * Tengence plugin REST API client (wp domain extension)
 * ============================================================================
 * Background (2026-09-16): article SEO/GEO metadata was previously written via the
 * WP native API (the meta field of /wp/v2/posts/{id}). WP only accepts meta keys the
 * plugin has registered; unregistered keys (e.g. _yoast_*) are silently dropped;
 * and /wp/v2's view context doesn't return meta, so reading live original values was
 * never reliable.
 *
 * Now unified on the plugin config API (/wp-json/tengence/v1/posts/{id}):
 *   - GET /posts/{id}  reads all 21 SEO/GEO meta keys (no prefix; arrays/objects decoded)
 *   - PUT /posts/{id}  batch write (body {"meta": {...}}; absent fields stay unchanged)
 * Auth: X-Tengence-Site-Id + X-Tengence-Secret (not WP Basic Auth).
 *
 * Credentials: TENGENCE_SITE_ID / TENGENCE_SECRET in sites/<site>/.env; endpoint:
 * TENGENCE_API_URL (defaults to /wp-json/tengence/v1 under WP_API_URL or WP_URL).
 * ============================================================================
 */

const { loadSite } = require('../site/config');
const { request } = require('./request');

/**
 * Resolve the plugin API target
 * @returns {{siteKey:string, baseUrl:string, siteId:string, secret:string}}
 * @throws when TENGENCE_SITE_ID / TENGENCE_SECRET are missing (no fallback)
 */
function pluginTarget() {
  const SITE = loadSite();
  const siteId = process.env.TENGENCE_SITE_ID;
  const secret = process.env.TENGENCE_SECRET;
  const wpUrl = process.env.WP_URL || '';
  const wpApiUrl = process.env.WP_API_URL || `${wpUrl}/wp-json`;

  if (!siteId || !secret) {
    throw new Error(
      `Missing plugin API credentials: set TENGENCE_SITE_ID / TENGENCE_SECRET in sites/${SITE.siteKey}/.env`
    );
  }
  if (!wpUrl && !process.env.TENGENCE_API_URL) {
    throw new Error(
      `Missing plugin API endpoint: set TENGENCE_API_URL (or WP_URL) in sites/${SITE.siteKey}/.env`
    );
  }

  const base = process.env.TENGENCE_API_URL || `${wpApiUrl.replace(/\/$/, '')}/tengence/v1`;
  return {
    siteKey: SITE.siteKey,
    baseUrl: base.replace(/\/$/, ''),
    siteId,
    secret,
  };
}

/**
 * Plugin API request (endpoints relative to /tengence/v1)
 * @param {string} endpoint e.g. '/posts/993'
 * @param {{method?:string, body?:any, timeout?:number}} [options]
 * @returns {Promise<any>} the response body's data or the full response; throws on non-2xx
 */
async function pluginApi(endpoint, options = {}) {
  const { method = 'GET', body = null, timeout = 60000 } = options;
  const { baseUrl, siteId, secret } = pluginTarget();

  const res = await request(`${baseUrl}${endpoint}`, {
    method,
    body,
    timeout,
    headers: {
      Accept: 'application/json',
      'X-Tengence-Site-Id': siteId,
      'X-Tengence-Secret': secret,
    },
  });

  if (!res.ok) {
    const detail = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    throw new Error(`plugin ${method} ${endpoint} failed: ${res.status} ${detail}`);
  }
  return res.data;
}

/**
 * Read a single article's full SEO/GEO meta (plugin-API normalized format)
 * @param {number|string} postId the article ID
 * @returns {Promise<object>} meta object (unprefixed keys; {} when empty)
 */
async function getPostMeta(postId) {
  const res = await pluginApi(`/posts/${postId}`);
  const meta = res && res.data && res.data.meta;
  return meta && typeof meta === 'object' ? meta : {};
}

/**
 * Batch-write a single article's meta (plugin API; empty object skipped)
 * @param {number|string} postId the article ID
 * @param {object} meta unprefixed-key meta object
 * @returns {Promise<object>} the latest meta after writing
 */
async function updatePostMeta(postId, meta) {
  if (!meta || typeof meta !== 'object' || Object.keys(meta).length === 0) {
    return getPostMeta(postId);
  }
  const res = await pluginApi(`/posts/${postId}`, { method: 'PUT', body: { meta } });
  const updated = res && res.data && res.data.meta;
  return updated && typeof updated === 'object' ? updated : {};
}

/**
 * geo language code → plugin language taxonomy code (multilingual v1).
 * @param {string} lang geo DB language code (zh-cn / en-us / zh-hk)
 * @returns {string} plugin taxonomy code (zh-hans / en / zh-hant)
 */
function toPluginLanguage(lang) {
  const map = { 'zh-cn': 'zh-hans', 'en-us': 'en', 'zh-hk': 'zh-hant' };
  return map[lang] || 'zh-hans';
}

/**
 * Set an article's language + translation group via the plugin language API.
 * Endpoint: PUT /posts/{id}/language  (multilingual v1, plugin-side).
 * @param {number|string} postId the WP article ID
 * @param {{language:string, translationGroup?:string|null}} opts
 *        language is the geo DB code (mapped internally to the plugin taxonomy)
 * @returns {Promise<object>} plugin API response
 */
async function setPostLanguage(postId, { language, translationGroup = null } = {}) {
  const body = { language: toPluginLanguage(language || 'zh-cn') };
  if (translationGroup) body.translation_group = translationGroup;
  return pluginApi(`/posts/${postId}/language`, { method: 'PUT', body });
}

/**
 * Look up a WP article by slug + language via the plugin multilingual query API
 * (GET /language/posts?slug=&lang=). The same slug may exist once per language on
 * the WP side, so the native WP slug lookup is ambiguous for translations — this
 * is the disambiguation endpoint the plugin v1 exposes.
 * @param {string} slug
 * @param {string} lang geo language code (zh-cn|en-us|zh-hk)
 * @returns {Promise<object|null>} the matching post (plugin response shape) or null
 *   when the plugin API is unavailable (pre-multilingual plugin) / not found
 */
async function findPostByLanguage(slug, lang) {
  const code = toPluginLanguage(lang || 'zh-cn');
  const res = await pluginApi(`/language/posts?slug=${encodeURIComponent(slug)}&lang=${code}`);
  const list = res && res.data ? (Array.isArray(res.data) ? res.data : [res.data]) : [];
  return list.length ? list[0] : null;
}

module.exports = { pluginTarget, pluginApi, getPostMeta, updatePostMeta, setPostLanguage, toPluginLanguage, findPostByLanguage };
