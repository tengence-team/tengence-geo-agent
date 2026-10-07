/**
 * Term & author multilingual display-name domain (tengence-geo-sdk/wp/termnames)
 * ============================================================================
 * The domain logic behind the plugin's /tengence/v1/term-names and /author-names
 * REST endpoints (tengence-wordpress-plugin modules/multilingual/RestTermNames.php):
 *   - GET    /term-names                       list (optional ?taxonomy=)
 *   - GET    /term-names/{taxonomy}/{slug}     single read
 *   - PUT    /term-names/{taxonomy}/{slug}     set (idempotent UPSERT, "" clears a language)
 *   - DELETE /term-names/{taxonomy}/{slug}     delete (?lang= removes one language)
 *   - POST   /term-names/batch                 batch set (merge semantics, per-item failures)
 *   - GET    /author-names                     author list (names + display_names)
 *   - GET    /author-names/{id}                author single read
 *   - PUT    /author-names/{id}                author set
 *   - DELETE /author-names/{id}                author delete (?lang=)
 *   - POST   /author-names/batch               author batch set
 *
 * Language keys: the plugin stores en / zh-hans / zh-hant and silently drops any
 * other key. Since 2026-10-07 the geo DB stores the SAME codes (zh-hans / zh-hant / en)
 * directly — the former LANG_MAP (zh-cn→zh-hans, en-us→en, zh-hk→zh-hant) was removed;
 * normalizeLang / normalizeNames are kept as pass-through identity for API stability.
 *
 * siteKey: optional in every function — geo-cli bins pass nothing (the process
 * argv carries --site); MCP tools pass the resolved site key explicitly.
 * ============================================================================
 */

const { pluginApi } = require('./plugin');

const TAXONOMIES = ['category', 'post_tag'];

/**
 * Identity pass-through (kept for API stability; language codes are unified:
 * zh-hans / zh-hant / en everywhere).
 * @param {string} lang
 * @returns {string}
 */
function normalizeLang(lang) {
  return lang;
}

/**
 * Normalize a {lang: name} map: every key through normalizeLang.
 * @param {Record<string,string>|null|undefined} names
 * @returns {Record<string,string>}
 */
function normalizeNames(names) {
  if (!names || typeof names !== 'object') return {};
  const out = {};
  for (const [lang, name] of Object.entries(names)) {
    out[normalizeLang(lang)] = name;
  }
  return out;
}

/** Validate the taxonomy; throws a clear Error on anything but category / post_tag. */
function requireTaxonomy(taxonomy) {
  if (!TAXONOMIES.includes(taxonomy)) {
    throw new Error(`taxonomy must be one of ${TAXONOMIES.join(' / ')} (got: ${taxonomy})`);
  }
  return taxonomy;
}

/** Validate the slug is non-empty after trimming. */
function requireSlug(slug) {
  if (typeof slug !== 'string' || !slug.trim()) {
    throw new Error('slug is required (the WP term slug)');
  }
  return slug;
}

/** Validate the author id is a positive integer. */
function requireAuthorId(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`author id must be a positive integer (got: ${id})`);
  }
  return n;
}

// ---------- term names ----------

/**
 * List the multilingual display-name table for WP categories & tags.
 * @param {{siteKey?:string, taxonomy?:string}} [opts]
 * @returns {Promise<object>} {category: {...}, post_tag: {...}} (only configured terms)
 */
async function listTermNames({ siteKey, taxonomy } = {}) {
  if (taxonomy) requireTaxonomy(taxonomy);
  const q = taxonomy ? `?taxonomy=${taxonomy}` : '';
  const res = await pluginApi(`/term-names${q}`, { siteKey });
  return (res && res.data) || {};
}

/**
 * Read the multilingual display names of ONE term.
 * @param {{siteKey?:string, taxonomy:string, slug:string}} opts
 * @returns {Promise<object>} {taxonomy, slug, original_name, names}
 */
async function getTermName({ siteKey, taxonomy, slug } = {}) {
  requireTaxonomy(taxonomy);
  requireSlug(slug);
  const res = await pluginApi(`/term-names/${requireTaxonomy(taxonomy)}/${encodeURIComponent(requireSlug(slug))}`, { siteKey });
  return (res && res.data) || {};
}

/**
 * Set (UPSERT) the multilingual display names of ONE term. Partial update: only the
 * passed language keys change; an empty string clears that language.
 * @param {{siteKey?:string, taxonomy:string, slug:string, names:Record<string,string>}} opts
 * @returns {Promise<object>} {taxonomy, slug, original_name, names}
 */
async function setTermName({ siteKey, taxonomy, slug, names } = {}) {
  requireTaxonomy(taxonomy);
  requireSlug(slug);
  const res = await pluginApi(
    `/term-names/${requireTaxonomy(taxonomy)}/${encodeURIComponent(requireSlug(slug))}`,
    { method: 'PUT', body: { names: normalizeNames(names) }, siteKey }
  );
  return (res && res.data) || {};
}

/**
 * Delete the multilingual display names of ONE term. lang omitted → whole entry;
 * lang given → only that language is removed.
 * @param {{siteKey?:string, taxonomy:string, slug:string, lang?:string}} opts
 * @returns {Promise<object>} {taxonomy, slug, removed}
 */
async function deleteTermName({ siteKey, taxonomy, slug, lang } = {}) {
  requireTaxonomy(taxonomy);
  requireSlug(slug);
  const q = lang ? `?lang=${encodeURIComponent(normalizeLang(lang))}` : '';
  const res = await pluginApi(
    `/term-names/${requireTaxonomy(taxonomy)}/${encodeURIComponent(requireSlug(slug))}${q}`,
    { method: 'DELETE', siteKey }
  );
  return (res && res.data) || {};
}

/**
 * Batch-set multilingual display names for many terms.
 * @param {{siteKey?:string, category?:Record<string,Record<string,string>>, post_tag?:Record<string,Record<string,string>>}} opts
 *        keyed by term slug → {lang: name}
 * @returns {Promise<object>} {updated, failed}
 */
async function batchTermNames({ siteKey, category, post_tag } = {}) {
  const body = {};
  for (const tax of TAXONOMIES) {
    const map = tax === 'category' ? category : post_tag;
    if (map) {
      body[tax] = {};
      for (const [slug, names] of Object.entries(map)) {
        body[tax][slug] = normalizeNames(names);
      }
    }
  }
  const res = await pluginApi('/term-names/batch', { method: 'POST', body, siteKey });
  return (res && res.data) || {};
}

// ---------- author names ----------

/**
 * List the multilingual display names for all WP authors.
 * @param {{siteKey?:string}} [opts]
 * @returns {Promise<object>} {names: {id: {lang: name}}, display_names: {id: original}}
 */
async function listAuthorNames({ siteKey } = {}) {
  const res = await pluginApi('/author-names', { siteKey });
  return (res && res.data) || {};
}

/**
 * Read the multilingual display names of ONE WP author.
 * @param {{siteKey?:string, id:number}} opts
 * @returns {Promise<object>} {id, display_name, names}
 */
async function getAuthorName({ siteKey, id } = {}) {
  const res = await pluginApi(`/author-names/${requireAuthorId(id)}`, { siteKey });
  return (res && res.data) || {};
}

/**
 * Set (UPSERT) the multilingual display names of ONE WP author. Partial update;
 * an empty string clears that language.
 * @param {{siteKey?:string, id:number, names:Record<string,string>}} opts
 * @returns {Promise<object>} {id, display_name, names}
 */
async function setAuthorName({ siteKey, id, names } = {}) {
  const res = await pluginApi(
    `/author-names/${requireAuthorId(id)}`,
    { method: 'PUT', body: { names: normalizeNames(names) }, siteKey }
  );
  return (res && res.data) || {};
}

/**
 * Delete the multilingual display names of ONE WP author. lang omitted → whole entry;
 * lang given → only that language is removed.
 * @param {{siteKey?:string, id:number, lang?:string}} opts
 * @returns {Promise<object>} {id, removed}
 */
async function deleteAuthorName({ siteKey, id, lang } = {}) {
  const q = lang ? `?lang=${encodeURIComponent(normalizeLang(lang))}` : '';
  const res = await pluginApi(`/author-names/${requireAuthorId(id)}${q}`, { method: 'DELETE', siteKey });
  return (res && res.data) || {};
}

/**
 * Batch-set multilingual display names for many WP authors.
 * @param {{siteKey?:string, authors:Record<string,Record<string,string>>}} opts
 *        author id (numeric string) → {lang: name}
 * @returns {Promise<object>} {updated, failed}
 */
async function batchAuthorNames({ siteKey, authors } = {}) {
  const body = {};
  for (const [id, names] of Object.entries(authors || {})) {
    body[id] = normalizeNames(names);
  }
  const res = await pluginApi('/author-names/batch', { method: 'POST', body, siteKey });
  return (res && res.data) || {};
}

module.exports = {
  normalizeLang,
  normalizeNames,
  requireTaxonomy,
  requireSlug,
  requireAuthorId,
  listTermNames,
  getTermName,
  setTermName,
  deleteTermName,
  batchTermNames,
  listAuthorNames,
  getAuthorName,
  setAuthorName,
  deleteAuthorName,
  batchAuthorNames,
};
