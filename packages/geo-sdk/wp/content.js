/**
 * Generic WordPress content operations (wp domain)
 * ============================================================================
 * Design (2026-11-28, docs-publishing batch):
 *   This module knows only two things: a **target** (site + post_type) and a
 *   **payload** (plain WP fields). It deliberately has NO Content Profile, NO
 *   post-type allowlist and NO per-type branching — the caller decides what to
 *   write, this layer only writes it. Blog-specific conventions (categories,
 *   tags, GEO block templates) stay in the blog orchestration layer.
 *
 *   The legacy `posts.js` remains the post-only facade used by the existing
 *   blog publish chain; new callers should use this module so a doc, page or
 *   any other REST-exposed post type goes through the same code path.
 *
 * Coverage:
 *   restBase(postType)      wp/v2/types lookup, cached per post type
 *   list / get / findBySlug / create / update / remove
 *   attributes(id, fields)  plugin post-attributes API (title/slug/status/parent/menu_order/...)
 *   setLanguage / getMeta / saveMeta
 *   tree()                  hierarchy assembled from parent + menu_order for any hierarchical type
 * ============================================================================
 */

const { api } = require('./request');
const plugin = require('./plugin');

const EXCLUDED_TYPES = new Set(['attachment', 'revision', 'nav_menu_item']);

/** Guard against a typo silently creating content of the wrong type. */
function assertType(postType) {
  if (!postType || typeof postType !== 'string') {
    throw new Error('content: postType is required (e.g. "post", "page", "tengence_doc")');
  }
  if (EXCLUDED_TYPES.has(postType)) {
    throw new Error(`content: ${postType} is not a writable content type`);
  }
  if (!/^[a-z0-9_-]{1,32}$/i.test(postType)) {
    throw new Error(`content: invalid postType "${postType}"`);
  }
  return postType;
}

const restBaseCache = new Map();

/**
 * Resolve a post type to its REST base (`wp/v2/types` is public).
 * Falls back to the type name itself when the type is not exposed.
 * @param {string} postType
 * @param {{siteKey?:string}} [options]
 * @returns {Promise<string>}
 */
async function restBase(postType, options = {}) {
  const type = assertType(postType);
  if (restBaseCache.has(type)) return restBaseCache.get(type);
  let base = type;
  try {
    const types = await api('/types', { siteKey: options.siteKey });
    if (types && types[type] && types[type].rest_base) base = types[type].rest_base;
  } catch (e) {
    // /types unavailable → keep the type name; the request below will report the real error
  }
  restBaseCache.set(type, base);
  return base;
}

async function listItems(params = {}, options = {}) {
  const { postType = 'post', ...rest } = params;
  const base = await restBase(postType, options);
  return api(`/${base}?${new URLSearchParams(rest).toString()}`, { siteKey: options.siteKey });
}

async function get(id, params = {}, options = {}) {
  const { postType = 'post', ...rest } = params;
  const base = await restBase(postType, options);
  const qs = new URLSearchParams(rest).toString();
  return api(`/${base}/${id}${qs ? `?${qs}` : ''}`, { siteKey: options.siteKey });
}

/**
 * Exact slug lookup inside one post type.
 * WP scopes slugs per post type, so the same slug may legitimately exist for
 * different languages of the same type — callers that need language scoping
 * must further filter with the plugin language lookup.
 */
async function findBySlug(slug, options = {}) {
  const { postType = 'post', status, parent, lang } = options;
  const params = { slug, context: 'edit' };
  if (status) params.status = status;
  if (parent !== undefined) params.parent = parent;
  const rows = await listItems({ postType, ...params }, options);
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;
  if (!lang) return list[0];
  // Native REST does not expose the plugin's language taxonomy, so resolve the
  // language-specific IDs through the plugin and intersect.
  const localized = await plugin.listPostsByLanguage(slug, lang, { ...options, postType });
  const ids = new Set(localized.map((p) => p.id));
  return list.find((r) => ids.has(r.id)) || null;
}

async function create(fields = {}, options = {}) {
  // `meta` is passed through as a normal WP field: WP accepts any meta key that the
  // site has registered for this post type (show_in_rest => true) and silently drops
  // the rest. No type or key knowledge lives here.
  const { postType = 'post', ...body } = fields;
  const base = await restBase(postType, options);
  return api(`/${base}`, { method: 'POST', body, siteKey: options.siteKey });
}

async function update(id, fields = {}, options = {}) {
  const { postType = 'post', ...body } = fields;
  const base = await restBase(postType, options);
  return api(`/${base}/${id}`, { method: 'POST', body, siteKey: options.siteKey });
}

/** force=false → trash (reversible); force=true → permanent delete. */
async function remove(id, options = {}) {
  const { postType = 'post', force = false } = options;
  const base = await restBase(postType, options);
  return api(`/${base}/${id}?force=${force ? 'true' : 'false'}`, { method: 'DELETE', siteKey: options.siteKey });
}

/** Plugin attributes: title / excerpt / slug / status / date / modified / featured_media / categories / tags / sticky / parent / menu_order */
async function attributes(id, fields = {}, options = {}) {
  return plugin.updatePostAttributes(id, fields, options);
}

async function setLanguage(id, opts = {}, options = {}) {
  return plugin.setPostLanguage(id, opts, options);
}

async function getMeta(id, options = {}) {
  return plugin.getPostMeta(id, options);
}

async function saveMeta(id, meta, options = {}) {
  return plugin.updatePostMeta(id, meta, options);
}

/**
 * Fetch every node of a hierarchical type and assemble the tree.
 * @param {{postType?:string, status?:string, lang?:string, siteKey?:string}} options
 * @returns {Promise<{flat:Array, tree:Array}>}
 */
async function tree(options = {}) {
  const { postType = 'tengence_doc', status = 'any' } = options;
  const base = await restBase(postType, options);
  const fields = 'id,slug,title,parent,menu_order,status,link,type';
  const rows = await apiAllPages(base, { status, context: 'edit', _fields: fields, per_page: 100 }, options);
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parent && byId.get(node.parent);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortRec = (nodes) => {
    nodes.sort((a, b) => (a.menu_order ?? 0) - (b.menu_order ?? 0) || String(a.slug).localeCompare(String(b.slug)));
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return { flat: rows, tree: roots };
}

async function apiAllPages(base, params, options) {
  const { apiAll } = require('./request');
  return apiAll(base, params, options);
}

/**
 * Publish one content payload: create when absent, update when present.
 * Idempotency key = (postType, slug, language). Nothing type-specific is assumed.
 * @param {object} payload
 *   postType, language, translationGroup, parent, menuOrder, meta, ...WP fields
 * @param {{siteKey?:string}} [options]
 */
async function publish(payload = {}, options = {}) {
  const {
    postType = 'post',
    language,
    translationGroup,
    parent,
    menuOrder,
    meta,
    ...fields
  } = payload;
  assertType(postType);
  if (!fields.slug) throw new Error('content.publish: slug is required (idempotency key)');
  if (!fields.title) throw new Error('content.publish: title is required');

  let existing = null;
  if (language) {
    // Language is part of the identity: the plugin lookup is authoritative, and a
    // sibling in another language must never be reused (same slug is legal per language).
    const candidates = await plugin.listPostsByLanguage(fields.slug, language, { ...options, postType });
    existing = candidates.find((p) => parent === undefined || Number(p.parent) === Number(parent)) || null;
  } else {
    existing = await findBySlug(fields.slug, { postType, status: 'any' });
  }

  const body = { ...fields };
  if (meta && typeof meta === 'object' && Object.keys(meta).length > 0) body.meta = meta;
  if (parent !== undefined) body.parent = parent;
  if (menuOrder !== undefined) body.menu_order = menuOrder;

  let post;
  let created = false;
  if (existing) {
    post = await update(existing.id, { postType, ...body }, options);
  } else {
    post = await create({ postType, ...body }, options);
    created = true;
  }

  if (language) {
    await setLanguage(post.id, { language, translationGroup: translationGroup || null }, options);
    // A freshly created translation may have received a suffixed slug before the
    // language term existed; normalise it now that the language is known.
    if (created && post.slug && post.slug !== fields.slug) {
      await attributes(post.id, { slug: fields.slug }, options);
    }
  }
  // `meta` already travelled with the native create/update body above
  return { id: post.id, created, slug: fields.slug, language: language || null, postType, link: post.link };
}

module.exports = {
  restBase,
  list: listItems,
  get,
  findBySlug,
  create,
  update,
  remove,
  attributes,
  setLanguage,
  getMeta,
  saveMeta,
  tree,
  publish,
};
