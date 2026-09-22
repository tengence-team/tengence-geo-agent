/**
 * buildSeoGeoMeta output contract (batch E: meta now goes through the plugin API)
 * ============================================================================
 * Since 2026-09-16, SEO/GEO meta is read/written via the plugin API
 * (tengence/v1/posts/{id}); this test pins buildSeoGeoMeta's output contract:
 *   1. keys have no tengence_ prefix (seo_meta_title / geo_qa_pairs / …), matching
 *      the plugin API;
 *   2. no more _yoast_* dead keys (Yoast inactive, the WP native API silently drops
 *      them);
 *   3. geo_qa_pairs / geo_citations / geo_key_takeaways / seo_meta_keywords are all
 *      **real arrays** (not JSON strings);
 *   4. "empty values never overwrite the live values" follows pickMeta: existingMeta
 *      is in the plugin-API format (no prefix).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSeoGeoMeta, parseFaqFromBody } = require('../packages/geo-sdk/content/meta');

const ARTICLE = { title: 'AI 搜索优化指南 | Tengence', content: '正文内容。' };
const CONFIG = {
  seo: {
    title: '自定义 SEO 标题',
    meta_description: '这是一段用于测试的 SEO 描述。',
    keywords: ['关键词一', '关键词二'],
    focus_keyword: 'AI 搜索优化',
  },
  geo: {
    ai_summary: '本文摘要。',
    key_takeaways: ['要点一', '要点二'],
    qa_pairs: [{ question: '问题一？', answer: '答案一。' }],
    citations: [{ url: 'https://example.com/a', title: '来源A' }],
  },
  tags: ['AI'],
};

test('keys have no prefix and no _yoast dead keys', () => {
  const meta = buildSeoGeoMeta(ARTICLE, CONFIG);
  const keys = Object.keys(meta).sort();

  assert.deepEqual(keys, [
    'geo_ai_summary',
    'geo_citations',
    'geo_key_takeaways',
    'geo_qa_pairs',
    'seo_meta_description',
    'seo_meta_keywords',
    'seo_meta_title',
  ]);
  assert.ok(!keys.some((k) => k.includes('_yoast_') || k.startsWith('tengence_')));
});

test('array fields are all real arrays (not JSON strings)', () => {
  const meta = buildSeoGeoMeta(ARTICLE, CONFIG);

  assert.ok(Array.isArray(meta.geo_qa_pairs), 'geo_qa_pairs should be an array');
  assert.deepEqual(meta.geo_qa_pairs, CONFIG.geo.qa_pairs);

  assert.ok(Array.isArray(meta.geo_citations), 'geo_citations should be an array');
  assert.equal(meta.geo_citations.length, 1);

  assert.ok(Array.isArray(meta.geo_key_takeaways), 'geo_key_takeaways should be an array');
  assert.ok(Array.isArray(meta.seo_meta_keywords), 'seo_meta_keywords should be an array');
});

test('seo_meta_title is the base title with the "| Tengence" suffix removed', () => {
  const meta = buildSeoGeoMeta(ARTICLE, CONFIG);
  assert.equal(meta.seo_meta_title, 'AI 搜索优化指南');
});

test('empty values never overwrite the live ones (existingMeta unprefixed keys)', () => {
  const existing = {
    seo_meta_description: '线上已有描述',
    geo_ai_summary: '线上已有摘要',
    geo_key_takeaways: ['线上要点'],
  };
  const meta = buildSeoGeoMeta(
    { title: '无配置文章', content: '' },
    {}, // no seo/geo config
    existing
  );

  assert.equal(meta.seo_meta_description, '线上已有描述', 'empty description should keep the live value');
  assert.equal(meta.geo_ai_summary, '线上已有摘要', 'empty summary should keep the live value');
  assert.deepEqual(meta.geo_key_takeaways, ['线上要点'], 'empty takeaways should keep the live value');
});

test('parseFaqFromBody fallback produces an array-form qa_pairs', () => {
  const article = {
    title: '含 FAQ 的文章',
    content: '## 常见问题\n\n**问：问题A？**\n答案A。\n\n**问：问题B？**\n答案B。',
  };
  const meta = buildSeoGeoMeta(article, {});

  assert.ok(Array.isArray(meta.geo_qa_pairs), 'fallback FAQ should be an array');
  assert.equal(meta.geo_qa_pairs.length, 2);
  assert.equal(meta.geo_qa_pairs[0].question, '问题A？');
  assert.match(meta.geo_qa_pairs[0].answer, /答案A/);
});

test('parseFaqFromBody returns a valid JSON array (consumable by the plugin API qa type)', () => {
  const json = parseFaqFromBody('## 常见问题\n\n**问：Q？**\nA。');
  const parsed = JSON.parse(json);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed[0].question, 'Q？');
});
