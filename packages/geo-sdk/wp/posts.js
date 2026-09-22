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
async function findBySlug(slug) {
  const posts = await api('/posts?slug=' + encodeURIComponent(slug));
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
 */
async function get(id, query = '') {
  return api(`/posts/${id}${query}`);
}

/**
 * Update the article body (POST /posts/{id}; meta is stripped — use saveMeta)
 * @param {number|string} id
 * @param {object} data WP article fields (should not contain meta)
 */
async function update(id, data) {
  const { meta, ...body } = data || {};
  if (meta !== undefined) {
    console.warn('[wp.posts.update] meta now goes through the plugin API; the WP meta field is ignored (use saveMeta)');
  }
  return api(`/posts/${id}`, { method: 'POST', body });
}

/**
 * Create an article body (POST /posts; meta is stripped — use saveMeta)
 * @param {object} data WP article fields (should not contain meta)
 */
async function create(data) {
  const { meta, ...body } = data || {};
  if (meta !== undefined) {
    console.warn('[wp.posts.create] meta now goes through the plugin API; the WP meta field is ignored (use saveMeta)');
  }
  return api('/posts', { method: 'POST', body });
}

/**
 * Read an article's SEO/GEO meta (plugin API; unprefixed keys, arrays/objects decoded)
 * @param {number|string} id
 * @returns {Promise<object>} meta object ({} when empty)
 */
async function getMeta(id) {
  return plugin.getPostMeta(id);
}

/**
 * Write an article's SEO/GEO meta (plugin API; empty object skipped)
 * @param {number|string} id
 * @param {object} meta unprefixed-key meta object
 * @returns {Promise<object>} the latest meta after writing
 */
async function saveMeta(id, meta) {
  return plugin.updatePostMeta(id, meta);
}

module.exports = { findBySlug, get, list, update, create, getMeta, saveMeta };
