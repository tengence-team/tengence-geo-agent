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
const { buildSeoGeoMeta, langToOgLocale, parseFaqFromBody } = require('../packages/geo-sdk/content/meta');

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
    'seo_og_locale',
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

test('parseFaqFromBody: traditional heading (常見問題) and H3 question rows both parse', () => {
  // 2026-10-11: the fallback missed the traditional heading and the `### Q：` H3
  // notation used by translated bodies — 56 translation pages lost geo_qa_pairs.
  const json = parseFaqFromBody(
    '## 常見問題\n\n### 為什麼要這麼久？\n\n通常 **14 天**。\n\n### MDE 怎麼定？\n\n由業務收益倒推。\n'
  );
  const parsed = JSON.parse(json);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].question, '為什麼要這麼久？');
  assert.match(parsed[0].answer, /14 天/);
  assert.equal(parsed[0].answer.includes('**'), false, 'answer is plain text');
  // traditional heading with the bold 问： notation
  const json2 = parseFaqFromBody('## 常見問題\n\n> **問：測試要多久？**\n>\n> 答：十四天。');
  const parsed2 = JSON.parse(json2);
  assert.equal(parsed2[0].question, '測試要多久？');
  assert.equal(parsed2[0].answer, '<p>十四天。</p>', 'blockquote markers and the 答： prefix are stripped from the answer');
});

test('langToOgLocale maps language codes to Open Graph locales', () => {
  assert.equal(langToOgLocale('zh-hans'), 'zh_CN');
  assert.equal(langToOgLocale('zh-cn'), 'zh_CN');
  assert.equal(langToOgLocale('en'), 'en_US');
  assert.equal(langToOgLocale('en-us'), 'en_US');
  assert.equal(langToOgLocale('zh-hant'), 'zh_HK');
  assert.equal(langToOgLocale('zh-hk'), 'zh_HK');
  // unknown / empty falls back to the site default zh_CN
  assert.equal(langToOgLocale('unknown'), 'zh_CN');
  assert.equal(langToOgLocale(null), 'zh_CN');
  assert.equal(langToOgLocale(undefined), 'zh_CN');
});

test('seo_og_locale is derived from the language argument (zh-hans/en/zh-hant)', () => {
  assert.equal(buildSeoGeoMeta(ARTICLE, CONFIG, {}, 'zh-hans').seo_og_locale, 'zh_CN');
  assert.equal(buildSeoGeoMeta(ARTICLE, CONFIG, {}, 'en').seo_og_locale, 'en_US');
  assert.equal(buildSeoGeoMeta(ARTICLE, CONFIG, {}, 'zh-hant').seo_og_locale, 'zh_HK');
});

test('seo_og_locale defaults to zh_CN when no language is supplied', () => {
  const meta = buildSeoGeoMeta(ARTICLE, CONFIG);
  assert.equal(meta.seo_og_locale, 'zh_CN');
});

test('seo_og_locale falls back to article.lang when the lang arg is omitted', () => {
  const meta = buildSeoGeoMeta({ ...ARTICLE, lang: 'en' }, CONFIG, {});
  assert.equal(meta.seo_og_locale, 'en_US');
});

test('seo_og_locale is always emitted (overrides the WP plugin zh_CN default)', () => {
  // even when existingMeta already has a wrong locale, the language-derived value wins
  const existing = { seo_og_locale: 'zh_CN' };
  const meta = buildSeoGeoMeta(ARTICLE, CONFIG, existing, 'en');
  assert.equal(meta.seo_og_locale, 'en_US');
});
