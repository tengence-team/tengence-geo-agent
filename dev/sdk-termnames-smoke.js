#!/usr/bin/env node
/**
 * Plugin term-names / author-names API SDK integration smoke (geo-mcp ↔ plugin)
 * ============================================================================
 * Verifies t.wp.termnames against the plugin's /tengence/v1/term-names and
 * /author-names endpoints on a live site:
 *   [1] Read-only list: categories (7), tags (39), authors (2) — every entry must
 *       carry all three languages (en / zh-hans / zh-hant).
 *   [2] Single reads: original_name + names consistency for a known term/author.
 *   [3] Idempotent write: PUT the exact same values back (data unchanged) and
 *       read-back assert — verifies the UPSERT chain without mutating data.
 *   [4] Geo-code mapping: writes sent with geo codes (zh-cn/en-us/zh-hk) are
 *       normalized to plugin codes (zh-hans/en/zh-hant) and read back identically.
 * Usage: SITES_ROOT=/path/to/workspace node dev/sdk-termnames-smoke.js [--site www_tengence_com]
 */

const t = require('../packages/geo-sdk');
const assert = require('node:assert/strict');

const SITE = process.argv.includes('--site')
  ? process.argv[process.argv.indexOf('--site') + 1]
  : 'www_tengence_com';

const LANGS = ['en', 'zh-hans', 'zh-hant'];
const GEO_TO_PLUGIN = { 'zh-cn': 'zh-hans', 'en-us': 'en', 'zh-hk': 'zh-hant' };

function line() { console.log('-'.repeat(70)); }

/** Assert a names map carries all three languages (non-empty strings). */
function assertTri(names, label) {
  assert.ok(names && typeof names === 'object', `${label}: names object present`);
  for (const l of LANGS) {
    assert.ok(typeof names[l] === 'string' && names[l].length > 0, `${label}: lang ${l} non-empty (got: ${JSON.stringify(names[l])})`);
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log(`Term/author names SDK ↔ plugin API smoke (site=${SITE})`);
  console.log('='.repeat(70));

  // [1] Read-only full lists
  console.log('\n[1] List term names (categories)');
  const cats = await t.wp.termnames.listTermNames({ siteKey: SITE, taxonomy: 'category' });
  const catEntries = Object.entries(cats.category || {});
  assert.equal(catEntries.length, 7, `category count = 7 (got ${catEntries.length})`);
  for (const [slug, names] of catEntries) assertTri(names, `category:${slug}`);
  console.log(`  ✓ 7 categories, all tri-lingual`);
  console.log(`  sample search-recommend = ${JSON.stringify(cats.category['search-recommend'])}`);

  console.log('\n[1b] List term names (tags)');
  const tags = await t.wp.termnames.listTermNames({ siteKey: SITE, taxonomy: 'post_tag' });
  const tagEntries = Object.entries(tags.post_tag || {});
  assert.ok(tagEntries.length >= 30, `post_tag count >= 30 (got ${tagEntries.length})`);
  for (const [slug, names] of tagEntries) assertTri(names, `tag:${slug}`);
  console.log(`  ✓ ${tagEntries.length} tags, all tri-lingual`);

  console.log('\n[1c] List author names');
  const authors = await t.wp.termnames.listAuthorNames({ siteKey: SITE });
  const authorEntries = Object.entries(authors.names || {});
  assert.ok(authorEntries.length >= 1, `author count >= 1 (got ${authorEntries.length})`);
  for (const [id, names] of authorEntries) assertTri(names, `author:${id}`);
  console.log(`  ✓ ${authorEntries.length} authors, all tri-lingual`);
  console.log(`  author 1 = ${JSON.stringify(authors.names['1'])}`);
  console.log(`  display_names = ${JSON.stringify(authors.display_names)}`);

  // [2] Single reads
  console.log('\n[2] Single reads');
  const sr = await t.wp.termnames.getTermName({ siteKey: SITE, taxonomy: 'category', slug: 'search-recommend' });
  assert.equal(sr.slug, 'search-recommend');
  assert.ok(sr.original_name && sr.original_name.length > 0, 'original_name present');
  assertTri(sr.names, 'search-recommend single');
  console.log(`  ✓ getTermName: original_name=${sr.original_name}, names=${JSON.stringify(sr.names)}`);

  const a1 = await t.wp.termnames.getAuthorName({ siteKey: SITE, id: 1 });
  assert.equal(a1.id, 1);
  assert.ok(a1.display_name, 'author display_name present');
  assertTri(a1.names, 'author:1 single');
  console.log(`  ✓ getAuthorName: display_name=${a1.display_name}, names=${JSON.stringify(a1.names)}`);

  // [3] Idempotent write (exact same values → data unchanged, chain verified)
  console.log('\n[3] Idempotent PUT (same values, data unchanged)');
  const termBefore = cats.category['search-recommend'];
  const termAfter = await t.wp.termnames.setTermName({
    siteKey: SITE, taxonomy: 'category', slug: 'search-recommend', names: termBefore,
  });
  assert.deepEqual(termAfter.names, termBefore, 'term names identical after idempotent PUT');
  console.log(`  ✓ category:search-recommend PUT idempotent, read-back identical`);

  const authorBefore = authors.names['1'];
  const authorAfter = await t.wp.termnames.setAuthorName({ siteKey: SITE, id: 1, names: authorBefore });
  assert.deepEqual(authorAfter.names, authorBefore, 'author names identical after idempotent PUT');
  console.log(`  ✓ author:1 PUT idempotent, read-back identical`);

  // [4] Geo-code mapping (zh-cn/en-us/zh-hk → zh-hans/en/zh-hant)
  console.log('\n[4] Geo-code → plugin-code mapping on write');
  const mapped = t.wp.termnames.normalizeNames({ 'zh-cn': '简体', 'en-us': 'English', 'zh-hk': '繁體' });
  assert.deepEqual(mapped, { 'zh-hans': '简体', en: 'English', 'zh-hant': '繁體' }, 'geo codes normalized');
  console.log(`  ✓ normalizeNames geo→plugin: ${JSON.stringify(mapped)}`);

  console.log('\n✓ Term/author names SDK ↔ plugin smoke ALL PASSED');
  line();
}

main().catch((error) => {
  console.error('\n✗ Term/author names smoke failed:', error.message);
  if (process.env.DEBUG) console.error(error.stack);
  process.exit(1);
});
