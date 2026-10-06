/**
 * WordPress taxonomy read/resolve (wp domain)
 * ============================================================================
 * Why this module exists (2026-10-06):
 *   `publish_update_fields` could already WRITE categories/tags, but only as raw
 *   WP term IDs. Nothing in the SDK could (a) turn a human-readable term slug
 *   (what the plan table and the archived Markdown actually carry) into an ID,
 *   or (b) read back which terms a post really has. So translated articles were
 *   published with an empty tag set and nobody could verify or repair it without
 *   hand-rolling raw /wp/v2 calls.
 *
 * Everything here goes through the same authenticated wp/v2 exit as posts.js —
 * no direct database access, no side channels.
 *
 * Term ID vs slug: WP core stores only IDs on a post. Slugs are the stable,
 * human-readable key we use in the plan table (`article_plan.category/tags`)
 * and in article front matter, so slug is the canonical input everywhere below.
 * ============================================================================
 */

const { api, apiAll } = require('./request');

/** Cached per-process term dictionaries, keyed by taxonomy then siteKey. */
const dictCache = new Map();

/**
 * WP REST exposes taxonomies under a plural endpoint name that is NOT a plain
 * `taxonomy + 's'`: post_tag -> tags, category -> categories.
 */
const TERM_ENDPOINT = { category: 'categories', post_tag: 'tags' };

/**
 * List every term of a taxonomy (id <-> slug <-> name), auto-paginated.
 * @param {'category'|'post_tag'} taxonomy
 * @param {{siteKey?:string, fresh?:boolean}} [options]
 * @returns {Promise<Array<{id:number,slug:string,name:string,count:number}>>}
 */
async function listTerms(taxonomy, options = {}) {
  const { siteKey, fresh } = options || {};
  const key = `${taxonomy}::${siteKey || 'default'}`;
  if (!fresh && dictCache.has(key)) return dictCache.get(key);

  const rows = await apiAll(
    TERM_ENDPOINT[taxonomy] || taxonomy,
    { hide_empty: 'false', orderby: 'slug', order: 'asc' },
    { siteKey }
  );
  const list = (rows || []).map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    count: r.count,
  }));
  dictCache.set(key, list);
  return list;
}

/** Drop the cached dictionaries (after terms are created/renamed). */
function clearCache() {
  dictCache.clear();
}

/**
 * Resolve a mixed list of term identifiers to WP term IDs.
 * Accepts numeric IDs (passed through) and slugs (looked up, created if absent).
 *
 * @param {Array<number|string>} input term IDs and/or slugs
 * @param {object} opts
 * @param {'category'|'post_tag'} opts.taxonomy
 * @param {boolean} [opts.create] create a term when the slug does not exist yet
 * @param {string}  [opts.siteKey]
 * @returns {Promise<{ids:number[], created:string[], unknown:string[], resolved:Array}>}
 */
async function resolveTermIds(input, opts) {
  const { taxonomy, create = false, siteKey } = opts || {};
  const terms = await listTerms(taxonomy, { siteKey });
  const bySlug = new Map(terms.map((t) => [t.slug, t]));

  const ids = [];
  const created = [];
  const unknown = [];
  const resolved = [];

  for (const raw of input || []) {
    if (raw === null || raw === undefined || raw === '') continue;

    // numeric id — trust it as-is (it is what WP stores)
    if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
      const id = Number(raw);
      ids.push(id);
      resolved.push({ input: raw, id, via: 'id' });
      continue;
    }

    const slug = String(raw).trim();
    const hit = bySlug.get(slug);
    if (hit) {
      ids.push(hit.id);
      resolved.push({ input: raw, id: hit.id, name: hit.name, via: 'slug' });
      continue;
    }

    if (!create) {
      unknown.push(slug);
      continue;
    }

    // create: POST /wp/v2/{endpoint} {name: slug} — WP slugifies the name, and for
    // an ASCII slug the resulting slug equals the input, so the round trip is stable.
    const made = await api(`/${TERM_ENDPOINT[taxonomy] || taxonomy}`, {
      method: 'POST',
      siteKey,
      body: { name: slug },
    });
    bySlug.set(made.slug, { id: made.id, slug: made.slug, name: made.name });
    ids.push(made.id);
    created.push(made.slug);
    resolved.push({ input: raw, id: made.id, name: made.name, via: 'created' });
  }

  return { ids: [...new Set(ids)], created, unknown, resolved };
}

/**
 * Read the terms actually attached to a post, as {id, slug, name} objects.
 * @param {number} postId
 * @param {{siteKey?:string}} [options]
 */
async function getPostTerms(postId, options = {}) {
  const { siteKey } = options || {};
  const post = await api(`/posts/${postId}?_fields=id,categories,tags`, { siteKey });
  const [cats, tags] = await Promise.all([
    listTerms('category', { siteKey }),
    listTerms('post_tag', { siteKey }),
  ]);
  const catById = new Map(cats.map((t) => [t.id, t]));
  const tagById = new Map(tags.map((t) => [t.id, t]));
  const pick = (ids, dict) => (ids || []).map((id) => dict.get(id) || { id, slug: `?${id}`, name: `?${id}` });

  return {
    categories: pick(post.categories, catById),
    tags: pick(post.tags, tagById),
  };
}

/**
 * Read another post's taxonomy so it can be mirrored onto a translation.
 * Thin wrapper over getPostTerms — named separately because "copy the source
 * article's classification" is the intent at every call site.
 *
 * @param {number} srcPostId
 * @param {{siteKey?:string}} [options]
 * @returns {Promise<{category_slugs:string[], tag_slugs:string[], categories:Array, tags:Array}>}
 */
async function getTermsForCopy(srcPostId, options = {}) {
  const t = await getPostTerms(srcPostId, options);
  return {
    category_slugs: t.categories.map((c) => c.slug),
    tag_slugs: t.tags.map((c) => c.slug),
    categories: t.categories,
    tags: t.tags,
  };
}

module.exports = {
  listTerms,
  resolveTermIds,
  getPostTerms,
  getTermsForCopy,
  clearCache,
};
