/**
 * termnames domain — unit tests (node:test, zero dependencies, no network)
 * ============================================================================
 * Pins the pure logic of tengence-geo-sdk/wp/termnames:
 *   - normalizeLang / normalizeNames (geo → plugin language-code mapping)
 *   - requireTaxonomy / requireSlug / requireAuthorId (parameter validation)
 *   - the domain functions reject bad input BEFORE any HTTP call
 * (endpoint/body construction and the plugin round-trip are covered by the
 * staging e2e smoke run, not here.)
 *
 *   npm test
 * ============================================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const termnames = require('../packages/geo-sdk/wp/termnames');
const { normalizeLang, normalizeNames, requireTaxonomy, requireSlug, requireAuthorId } = termnames;

test('normalizeLang: maps geo codes to plugin codes, passes others through', () => {
  assert.equal(normalizeLang('zh-cn'), 'zh-hans');
  assert.equal(normalizeLang('en-us'), 'en');
  assert.equal(normalizeLang('zh-hk'), 'zh-hant');
  assert.equal(normalizeLang('en'), 'en');
  assert.equal(normalizeLang('zh-hans'), 'zh-hans');
  assert.equal(normalizeLang('fr'), 'fr'); // unknown passes through (plugin drops it server-side)
  assert.equal(normalizeLang(''), '');
  assert.equal(normalizeLang(undefined), undefined);
});

test('normalizeNames: maps every key, preserves values incl. empty-string clear', () => {
  assert.deepEqual(
    normalizeNames({ 'en-us': 'GEO & AI Search', 'zh-cn': 'GEO与AI搜索', 'zh-hk': 'GEO與AI搜尋' }),
    { en: 'GEO & AI Search', 'zh-hans': 'GEO与AI搜索', 'zh-hant': 'GEO與AI搜尋' }
  );
  assert.deepEqual(normalizeNames({ en: 'A', 'zh-hans': 'B' }), { en: 'A', 'zh-hans': 'B' });
  assert.deepEqual(normalizeNames({ 'zh-cn': '' }), { 'zh-hans': '' }); // "" = clear that language
  assert.deepEqual(normalizeNames({}), {});
  assert.deepEqual(normalizeNames(null), {});
  assert.deepEqual(normalizeNames(undefined), {});
  assert.deepEqual(normalizeNames('x'), {});
});

test('requireTaxonomy: accepts category/post_tag only', () => {
  assert.equal(requireTaxonomy('category'), 'category');
  assert.equal(requireTaxonomy('post_tag'), 'post_tag');
  assert.throws(() => requireTaxonomy('author'), /taxonomy must be one of category \/ post_tag/);
  assert.throws(() => requireTaxonomy(undefined), /taxonomy must be one of/);
  assert.throws(() => requireTaxonomy(''), /taxonomy must be one of/);
});

test('requireSlug: non-empty string required', () => {
  assert.equal(requireSlug('geo-ai-search'), 'geo-ai-search');
  assert.equal(requireSlug(' 7 '), ' 7 ');
  assert.throws(() => requireSlug(''), /slug is required/);
  assert.throws(() => requireSlug('   '), /slug is required/);
  assert.throws(() => requireSlug(undefined), /slug is required/);
  assert.throws(() => requireSlug(7), /slug is required/);
});

test('requireAuthorId: positive integer required', () => {
  assert.equal(requireAuthorId(1), 1);
  assert.equal(requireAuthorId('2'), 2);
  assert.throws(() => requireAuthorId(0), /positive integer/);
  assert.throws(() => requireAuthorId(-1), /positive integer/);
  assert.throws(() => requireAuthorId(1.5), /positive integer/);
  assert.throws(() => requireAuthorId('abc'), /positive integer/);
  assert.throws(() => requireAuthorId(undefined), /positive integer/);
});

test('domain functions reject bad input before any HTTP call', async () => {
  await assert.rejects(() => termnames.getTermName({ taxonomy: 'author', slug: 'x' }), /taxonomy must be one of/);
  await assert.rejects(() => termnames.getTermName({ taxonomy: 'category' }), /slug is required/);
  await assert.rejects(() => termnames.listTermNames({ taxonomy: 'author' }), /taxonomy must be one of/);
  await assert.rejects(() => termnames.setTermName({ taxonomy: 'category', names: { en: 'x' } }), /slug is required/);
  await assert.rejects(() => termnames.setTermName({ names: { en: 'x' } }), /taxonomy must be one of/);
  await assert.rejects(() => termnames.deleteTermName({ taxonomy: 'post_tag' }), /slug is required/);
  await assert.rejects(() => termnames.getAuthorName({ id: 0 }), /positive integer/);
  await assert.rejects(() => termnames.setAuthorName({ id: 1.5, names: {} }), /positive integer/);
  await assert.rejects(() => termnames.deleteAuthorName({ id: 'x' }), /positive integer/);
});
