/**
 * WordPress article read/write (wp domain)
 * ============================================================================
 * Consolidation note (batch B): pre-refactor /posts reads/writes were scattered
 * across publish-from-db.js (wpAPI('/posts?...') / wpAPI('/posts/{id}', 'POST'))
 * and taxonomy.js (wpRequest('/posts/{id}?context=edit')); the Python sidecar script
 * had its own requests version. Unified into this module, shared by batches B/C.
 *
 * Responsibility split (2026-09-16, batch E):
 *   - article body (title / content / excerpt / status / categories / tags / featured
 *     image) still goes through the WP native API (/wp/v2).
 *   - SEO/GEO meta fields now go through the plugin API (tengence/v1/posts/{id}):
 *       saveMeta(id, meta) / getMeta(id). `create` / `update` no longer accept meta;
 *       any passed-in meta is stripped (anti-misuse).
 * ============================================================================
 */

const { api } = require('./request');
const plugin = require('./plugin');

/**
 * Find an article exactly by slug
 * @param {string} slug
 * @returns {Promise<object|null>} the WP post object on a hit, otherwise null
 */
async function findBySlug(slug, options = {}) {
  const posts = await api(`/posts?slug=` + encodeURIComponent(slug), { siteKey: options.siteKey });
  return Array.isArray(posts) && posts.length > 0 ? posts[0] : null;
}

/**
 * Paginate and fetch all articles (incl. drafts/trash: status=any; for plan-table
 * reconciliation)
 * @param {object} [params] extra query params (e.g. _fields overrides)
 * @returns {Promise<Array>} [{id, slug, status, link, categories:[id], tags:[id], ...}]
 */
async function list(params = {}) {
  const { apiAll } = require('./request');
  return apiAll('posts', { _fields: 'id,slug,status,link,categories,tags,date', status: 'any', ...params });
}

/**
 * Get an article by ID
 * @param {number|string} id
 * @param {string} [query] extra query string, e.g. '?context=edit&_fields=id,slug'
 * @param {{siteKey?:string}} [options] siteKey — required for MCP tool calls
 */
async function get(id, query = '', options = {}) {
  return api(`/posts/${id}${query}`, { siteKey: options.siteKey });
}

/**
 * Update the article body (POST /posts/{id}; meta is stripped — use saveMeta)
 * @param {number|string} id
 * @param {object} data WP article fields (should not contain meta)
 * @param {{siteKey?:string}} [options] siteKey — required for MCP tool calls
 */
async function update(id, data, options = {}) {
  const { meta, ...body } = data || {};
  if (meta !== undefined) {
    console.warn('[wp.posts.update] meta now goes through the plugin API; the WP meta field is ignored (use saveMeta)');
  }
  return api(`/posts/${id}`, { method: 'POST', body, siteKey: options.siteKey });
}

/**
 * Create an article body (POST /posts; meta is stripped — use saveMeta)
 * @param {object} data WP article fields (should not contain meta)
 * @param {{siteKey?:string}} [options] siteKey — required for MCP tool calls
 */
async function create(data, options = {}) {
  const { meta, ...body } = data || {};
  if (meta !== undefined) {
    console.warn('[wp.posts.create] meta now goes through the plugin API; the WP meta field is ignored (use saveMeta)');
  }
  return api('/posts', { method: 'POST', body, siteKey: options.siteKey });
}

/**
 * Read an article's SEO/GEO meta (plugin API; unprefixed keys, arrays/objects decoded)
 * @param {number|string} id
 * @returns {Promise<object>} meta object ({} when empty)
 */
async function getMeta(id, options = {}) {
  return plugin.getPostMeta(id, options);
}

/**
 * Write an article's SEO/GEO meta (plugin API; empty object skipped)
 * @param {number|string} id
 * @param {object} meta unprefixed-key meta object
 * @param {{siteKey?:string}} [options] siteKey — required for MCP tool calls
 * @returns {Promise<object>} the latest meta after writing
 */
async function saveMeta(id, meta, options = {}) {
  return plugin.updatePostMeta(id, meta, options);
}

/**
 * Set an article's language + translation group (plugin multilingual API).
 * @param {number|string} id
 * @param {{language:string, translationGroup?:string|null}} opts geo language code
 * @returns {Promise<object>}
 */
async function setPostLanguage(id, opts) {
  return plugin.setPostLanguage(id, opts);
}

/**
 * Set an article's publish / update time (plugin dates API).
 * The native WP REST API treats `modified` (post_modified) as READONLY, so this
 * plugin endpoint is the only supported way to backdate a post_modified.
 * @param {number|string} id the WP post ID
 * @param {{date?:string, date_gmt?:string, modified?:string, modified_gmt?:string}} dates
 * @param {{siteKey?:string}} [options] siteKey — required for MCP tool calls
 * @returns {Promise<object>} plugin API response ({ id, updated })
 */
async function setPostDates(id, dates, options = {}) {
  return plugin.setPostDates(id, dates, options);
}

/**
 * Read an article's publish / update times (plugin dates API, GET).
 * @param {number|string} id the WP post ID
 * @param {{siteKey?:string}} [options]
 * @returns {Promise<object>} { date, date_gmt, modified, modified_gmt, status, slug }
 */
async function getPostDates(id, options = {}) {
  return plugin.getPostDates(id, options);
}

/**
 * Look up a WP article by slug + language via the plugin multilingual query API
 * (the WP-native slug lookup is ambiguous once the same slug exists per language).
 * @param {string} slug
 * @param {string} lang geo language code
 * @returns {Promise<object|null>}
 */
async function findPostByLanguage(slug, lang) {
  return plugin.findPostByLanguage(slug, lang);
}

module.exports = { findBySlug, get, list, update, create, getMeta, saveMeta, setPostLanguage, setPostDates, getPostDates, findPostByLanguage };
