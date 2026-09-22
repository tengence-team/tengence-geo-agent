/**
 * Image redline & scoring — unit tests (node:test, zero dependencies)
 * ============================================================================
 * Pins the behavior of tengence-geo-sdk/images/redline.js. These are the
 * regression net for the single source of truth of the "image redline" rules:
 * changing a rule requires changing the expectations here first, avoiding silent
 * drift.
 *
 *   npm test            # run everything
 *   node --test tests/
 * ============================================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const redline = require('../packages/geo-sdk/images/redline');
const {
  sanitizeQuery,
  shortenQuery,
  redLineCheck,
  scoreCandidate,
  buildFileName,
  BRAND_BLOCKLIST,
  REJECT_KEYWORDS,
  MIN_WIDTH,
} = redline;

test('sanitizeQuery: strips full/half-width punctuation, collapses whitespace, trims', () => {
  assert.equal(sanitizeQuery('SEO 搜索引擎优化，数据分析！'), 'SEO 搜索引擎优化 数据分析');
  assert.equal(sanitizeQuery('  a   b  '), 'a b');
  assert.equal(sanitizeQuery('a-b/c|d'), 'a b c d');
  assert.equal(sanitizeQuery('2024-2025 — 趋势'), '2024 2025 趋势');
  assert.equal(sanitizeQuery('“智能”与‘搜索’'), '智能 与 搜索');
});

test('sanitizeQuery: empty / non-string input returns an empty string (no throw)', () => {
  assert.equal(sanitizeQuery(''), '');
  assert.equal(sanitizeQuery(undefined), '');
  assert.equal(sanitizeQuery(null), '');
  assert.equal(sanitizeQuery(12345), '12345');
});

test('shortenQuery: truncates by words, default 5 words', () => {
  assert.equal(shortenQuery('一 二 三 四 五 六 七', 5), '一 二 三 四 五');
  assert.equal(shortenQuery('一 二 三 四 五 六 七', 3), '一 二 三');
  assert.equal(shortenQuery('a,b,c,d', 2), 'a b');
  assert.equal(shortenQuery('a b c d e f g'), 'a b c d e');
});

test('redLineCheck: brand block-list hit (incl. Chinese brands and sourceUrl)', () => {
  assert.deepEqual(
    redLineCheck({ alt: 'Google office desk', author: 'X', sourceUrl: '', width: 2000, height: 1200 }),
    { ok: false, reason: 'brand/Logo block-list hit: google' }
  );
  assert.deepEqual(
    redLineCheck({ alt: '华为门店', author: 'X', sourceUrl: '', width: 2000, height: 1200 }),
    { ok: false, reason: 'brand/Logo block-list hit: 华为' }
  );
  assert.equal(
    redLineCheck({ alt: 'desk', author: 'X', sourceUrl: 'https://unsplash.com/nike', width: 2000, height: 1200 }).ok,
    false
  );
});

test('redLineCheck: rejected-style hit (3D / UI screenshots)', () => {
  assert.deepEqual(
    redLineCheck({ alt: '3D render of cubes', author: 'X', sourceUrl: '', width: 2000, height: 1200 }),
    { ok: false, reason: 'rejected style hit: 3d' }
  );
  assert.equal(
    redLineCheck({ alt: 'user interface dashboard', author: 'X', sourceUrl: '', width: 2000, height: 1200 }).ok,
    false
  );
});

test('redLineCheck: size and aspect boundaries', () => {
  assert.deepEqual(
    redLineCheck({ alt: 'office', author: 'X', sourceUrl: '' }),
    { ok: false, reason: 'missing size info' }
  );
  assert.deepEqual(
    redLineCheck({ alt: 'office', author: 'X', sourceUrl: '', width: 1000, height: 800 }),
    { ok: false, reason: `width insufficient 1000<${MIN_WIDTH}` }
  );
  // aspect = 1.0 (square) → too narrow
  assert.equal(redLineCheck({ alt: 'office', author: 'X', sourceUrl: '', width: 2000, height: 2000 }).ok, false);
  // aspect = 3.0 → too wide
  assert.equal(redLineCheck({ alt: 'office', author: 'X', sourceUrl: '', width: 3000, height: 1000 }).ok, false);
  // boundary: exactly 1.3 passes; 1.299 fails
  assert.equal(redLineCheck({ alt: 'office', author: 'X', sourceUrl: '', width: 1300, height: 1000 }).ok, true);
  assert.equal(redLineCheck({ alt: 'office', author: 'X', sourceUrl: '', width: 1299, height: 1000 }).ok, false);
  // width exactly at the minimum 1200 passes
  assert.equal(redLineCheck({ alt: 'office desk', author: 'A', sourceUrl: '', width: 1200, height: 800 }).ok, true);
});

test('scoreCandidate: size tiers + platform weights + relevance + attribution', () => {
  // 2000px(20) + unsplash(20) + query hit(20) + attribution(6)
  assert.equal(scoreCandidate({ platform: 'unsplash', width: 2000, height: 1200, alt: 'office', author: 'A' }, 'office'), 66);
  // 1300px(14) + pexels(14) + no hit + no attribution
  assert.equal(scoreCandidate({ platform: 'pexels', width: 1300, height: 900, alt: 'desk', author: '' }, 'office'), 28);
  // 1200px(8) + pixabay(10) + hit(20) + attribution(6)
  assert.equal(scoreCandidate({ platform: 'pixabay', width: 1200, height: 800, alt: 'workspace', author: 'B' }, 'workspace'), 44);
  // unknown platform counts as 10; alt is case-insensitive
  assert.equal(scoreCandidate({ platform: 'unknown', width: 1920, height: 1080, alt: 'Office Desk', author: 'C' }, 'office'), 56);
});

test('buildFileName: semantic slug naming, no-slug fallback to img-<id>', () => {
  assert.equal(buildFileName('my-article-slug', { id: 1 }, 'webp'), 'my-article-slug.webp');
  assert.equal(buildFileName('My Slug!!', { id: 1 }, 'webp'), 'my-slug.webp');
  assert.equal(buildFileName('a--b---c', { id: 9 }, 'webp'), 'a-b-c.webp');
  assert.equal(buildFileName('', { id: 42 }, 'jpg'), 'img-42.jpg');
  assert.equal(buildFileName(null, { id: 42 }, 'webp'), 'img-42.webp');
  // empty after sanitization → fallback to img-<id>
  assert.equal(buildFileName('!!!', { id: 7 }, 'webp'), 'img-7.webp');
});

test('redline word lists: non-empty and all lowercase English/Chinese (hits rely on lowercased includes)', () => {
  assert.ok(BRAND_BLOCKLIST.length > 50);
  assert.ok(REJECT_KEYWORDS.length > 10);
  for (const w of REJECT_KEYWORDS) {
    assert.equal(w, w.toLowerCase(), `REJECT_KEYWORDS should be lowercase: ${w}`);
  }
});
