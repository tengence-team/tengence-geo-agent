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
 *   - GET /posts/{id}/meta  reads all 21 SEO/GEO meta keys (no prefix; arrays/objects decoded)
 *   - PUT /posts/{id}/meta  batch write (body {"meta": {...}}; absent fields stay unchanged)
 *
 * Article-body attributes (title / excerpt / featured image / publish + update time) are a
 * separate endpoint on purpose: PUT /posts/{id}/attributes.
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
 * @param {string} [siteKey] explicit site key (MCP tools pass the resolved one);
 *   defaults to the CLI --site argument / 'tengence' (geo-cli convention)
 * @returns {{siteKey:string, baseUrl:string, siteId:string, secret:string}}
 * @throws when TENGENCE_SITE_ID / TENGENCE_SECRET are missing (no fallback)
 */
function pluginTarget(siteKey) {
  const SITE = siteKey ? loadSite(siteKey) : loadSite();
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
 * @param {{method?:string, body?:any, timeout?:number, siteKey?:string}} [options]
 *        siteKey: explicit site key — required when the caller is not a geo-cli bin
 *        (no --site in argv), e.g. MCP tool calls
 * @returns {Promise<any>} the response body's data or the full response; throws on non-2xx
 */
async function pluginApi(endpoint, options = {}) {
  const { method = 'GET', body = null, timeout = 60000, siteKey } = options;
  const { baseUrl, siteId, secret } = pluginTarget(siteKey);
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
async function getPostMeta(postId, options = {}) {
  const res = await pluginApi(`/posts/${postId}/meta`, { siteKey: options.siteKey });
  const meta = res && res.data && res.data.meta;
  return meta && typeof meta === 'object' ? meta : {};
}

/**
 * Batch-write a single article's meta (plugin API; empty object skipped)
 * @param {number|string} postId the article ID
 * @param {object} meta unprefixed-key meta object
 * @returns {Promise<object>} the latest meta after writing
 */
async function updatePostMeta(postId, meta, options = {}) {
  if (!meta || typeof meta !== 'object' || Object.keys(meta).length === 0) {
    return getPostMeta(postId, options);
  }
  const res = await pluginApi(`/posts/${postId}/meta`, { method: 'PUT', body: { meta }, siteKey: options.siteKey });
  const updated = res && res.data && res.data.meta;
  return updated && typeof updated === 'object' ? updated : {};
}

/**
 * Set an article's publish / update time via the plugin post-attributes API.
 * Endpoint: PUT /posts/{id}/attributes  (attributes v1, plugin-side).
 *
 * Why this exists: `post_modified` has NO official WordPress writer.
 * wp_update_post() forwards to wp_insert_post(), which for updates forces
 * post_modified to current_time() (wp-includes/post.php:4789) and discards any
 * passed value; /wp/v2 declares `modified` readonly; and no filter in wp-includes
 * can intervene. A translation therefore could never be given its source zh-cn
 * article's update time through the native API. The plugin endpoint writes the
 * value and then READS IT BACK, failing loudly if it did not stick — so this can
 * never silently degrade into "wrote now instead of the requested time".
 *
 * @param {number|string} postId the WP article ID
 * @param {{date?:string, modified?:string}} dates
 *        each field optional; 'YYYY-MM-DD HH:MM:SS' or 'YYYY-MM-DDTHH:MM:SS'
 * @param {{siteKey?:string}} [options]
 * @returns {Promise<object>} plugin API response
 */
async function setPostDates(postId, dates = {}, options = {}) {
  const body = {};
  if (dates.date) body.date = String(dates.date).replace('T', ' ');
  if (dates.modified) body.modified = String(dates.modified).replace('T', ' ');
  if (Object.keys(body).length === 0) {
    throw new Error('setPostDates requires at least one of date / modified');
  }
  return pluginApi(`/posts/${postId}/attributes`, { method: 'PUT', body, siteKey: options.siteKey });
}

/**
 * Read an article's publish / update time (plugin attributes API, GET).
 * @param {number|string} postId the WP article ID
 * @param {{siteKey?:string}} [options]
 * @returns {Promise<{date:string, date_gmt:string, modified:string, modified_gmt:string, status:string, slug:string}>}
 */
async function getPostDates(postId, options = {}) {
  const res = await pluginApi(`/posts/${postId}/attributes`, { method: 'GET', siteKey: options.siteKey });
  const data = res && res.data ? res.data : res;
  return (data && data.attributes) || {};
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

module.exports = { pluginTarget, pluginApi, getPostMeta, updatePostMeta, setPostLanguage, setPostDates, getPostDates, toPluginLanguage, findPostByLanguage };
