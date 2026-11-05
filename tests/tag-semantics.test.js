/**
 * G18 tag/category semantics gate (2026-11-05 incident)
 * ============================================================================
 * Locks in:
 *   - the exact accident replay: `ai-ask` (Insight) on the Algolia site-search
 *     comparison, plus `search-recommend` (a CATEGORY slug) used as a tag
 *   - product-brand tags from another product line are hard failures
 *   - genuinely cross-domain articles (body evidence) and neutral tags pass
 *   - a product-line category contradicting the article domain is a hard failure
 *   - G18 rows stay ALWAYS HARD for an already-published article (wp_post_id>0):
 *     the isPublished demotion loop must not turn them advisory
 *
 * No database writes: the gate-integration test monkey-patches t.db.withConn.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const REPO = require('path').resolve(__dirname, '..');
process.env.SITES_ROOT = process.env.SITES_ROOT || '/Users/tim/tengence/geo-workspace';

const {
  checkTagSemantics, primaryDomain, CATEGORY_SLUGS, TAG_DOMAIN,
} = require(REPO + '/packages/geo-sdk/check/tag-semantics');

const ALGOLIA = {
  title: 'Algolia 替代方案：7 个站内搜索选项对比',
  keyword: 'Algolia站内搜索替代',
  excerpt: '对比 Typesense、Meilisearch、OpenSearch、Elasticsearch 与通智搜索共 7 个站内搜索选项的部署形态与语义能力',
  body: '站内搜索 召回 排序 Elasticsearch Algolia 站内检索 倒排索引 查询理解',
};

test('accident replay: ai-ask on an Algolia site-search article FAILs', () => {
  const r = checkTagSemantics({ ...ALGOLIA, tags: ['ai-ask'], category: 'search-recommend' });
  assert.equal(r.ok, false);
  assert.equal(r.domain, 'SEARCH');
  assert.deepEqual(r.mismatches.map((m) => m.tag), ['ai-ask']);
  assert.equal(r.mismatches[0].tagDomain, 'INSIGHT');
});

test('accident replay: a category slug used as a tag FAILs', () => {
  const r = checkTagSemantics({ ...ALGOLIA, tags: ['search-recommend', 'site-search'] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.pseudoTags, ['search-recommend']);
  assert.ok(CATEGORY_SLUGS.has('geo-ai-search'));
});

test('accident replay: generic INSIGHT words in the body do NOT excuse ai-ask', () => {
  // The real Algolia article mentions reports/ROI/funnels in passing. Those
  // generic words must not be accepted as cross-domain evidence for an
  // ownership tag — only title/keyword/excerpt count.
  const r = checkTagSemantics({
    ...ALGOLIA,
    body: '站内搜索 召回 排序 Elasticsearch；报表 看板 归因 漏斗 ROI 数据分析 指标字典 语义层',
    tags: ['ai-ask'], category: 'search-recommend',
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatches.map((m) => m.tag), ['ai-ask']);
});

test('fixed taxonomy PASSes', () => {
  const r = checkTagSemantics({
    ...ALGOLIA, tags: ['tengence-search', 'site-search', 'comparison'],
    category: 'search-recommend',
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.domain, 'SEARCH');
});

test('GEO article with GEO tags PASSes; unrelated INSIGHT brand tag FAILs', () => {
  const geo = {
    title: '2026 GEO 工具对比：怎么被 AI 答案引用',
    keyword: 'GEO工具对比',
    excerpt: '对比 GEO 工具的 AI 搜索可见性、引用率监测与生成式引擎优化能力',
    body: 'GEO 生成式引擎优化 引用率 可见性 AI Overviews Perplexity',
    category: 'geo-ai-search',
  };
  assert.equal(checkTagSemantics({ ...geo, tags: ['tengence-geo', 'geo-seo', 'comparison'] }).ok, true);
  const bad = checkTagSemantics({ ...geo, tags: ['tengence-geo', 'ai-ask'] });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.mismatches.map((m) => m.tag), ['ai-ask']);
});

test('genuine cross-domain body evidence tolerates a strong tag', () => {
  const r = checkTagSemantics({
    title: 'AI 搜索引用率怎么做？生成式引擎优化提升品牌可见性',
    keyword: 'GEO 引用率',
    excerpt: 'GEO 可见性、AI Overviews、Perplexity 与 ChatGPT 的引用机制与零点击趋势',
    body: 'GEO 引用率 可见性 AI 搜索；站内搜索 站内检索 召回 向量 RAG 查询理解 Elasticsearch',
    tags: ['tengence-geo', 'vector-search', 'rag'],
    category: 'geo-ai-search',
  });
  assert.ok(r.domain, 'domain must be determinable');
  assert.equal(r.ok, true, r.reason);
});

test('neutral tags and an ambiguous domain never block', () => {
  const r = checkTagSemantics({
    title: '2026 年工具选型清单', keyword: '', excerpt: '一份清单',
    tags: ['comparison', 'pricing'], category: 'product-solutions',
  });
  assert.equal(r.domain, null);
  assert.equal(r.ok, true);
  assert.equal(TAG_DOMAIN['comparison'], undefined);
});

test('empty tag list FAILs', () => {
  const r = checkTagSemantics({ ...ALGOLIA, tags: [] });
  assert.equal(r.ok, false);
  assert.equal(r.tagsEmpty, true);
});

test('product category contradicting the article domain FAILs', () => {
  const r = checkTagSemantics({
    title: '出海品牌 GEO：怎么进入 ChatGPT / Perplexity 的推荐答案',
    keyword: '出海品牌GEO',
    excerpt: 'AI 搜索可见性与引用率：GEO 生成式引擎优化怎么让品牌被引用',
    body: 'GEO 引用率 可见性 AI 搜索 生成式引擎',
    tags: ['tengence-geo', 'geo-seo', 'b2b-export'],
    category: 'search-recommend',
  });
  assert.equal(r.domain, 'GEO');
  assert.match(r.categoryConflict || '', /search-recommend/);
  assert.equal(r.ok, false);
});

test('primaryDomain requires a 2-term lead; otherwise AMBIG', () => {
  assert.equal(primaryDomain({}).domain, null);
  assert.equal(primaryDomain({ title: '一份通用清单' }).domain, null);
  assert.equal(primaryDomain({ title: 'GEO 与 AI 搜索可见性、引用率、生成式引擎优化' }).domain, 'GEO');
});

test('taxonomy lookup failure is advisory, never a content failure', () => {
  const r = checkTagSemantics({ tags: [], taxonomyResolved: false });
  assert.equal(r.ok, true);
  assert.equal(r.resolved, false);
  assert.match(r.reason, /advisory/);
});

test('checkArticle: G18 rows are ALWAYS HARD even when the article is already published', async () => {
  const t = require(REPO + '/packages/geo-sdk');
  const orig = t.db.withConn;
  const origLoad = t.site.loadSite;
  // Keep this test independent of SITES_ROOT (npm test uses examples/, single
  // runs use the workspace): the DB is mocked, so loadSite only has to provide
  // a default language and a non-existent siteDir for the file fallbacks.
  t.site.loadSite = () => ({ site: { languages: { default: 'zh-hans' } }, siteDir: '/tmp/g18-no-such-site' });
  const body = [
    '# Algolia 替代方案：7 个站内搜索选项对比', '',
    '> **摘要**：对比 7 个站内搜索选项的部署形态与语义能力。', '',
    '## 一、选型维度', '',
    '站内搜索、站内检索、召回、倒排索引、查询理解、Elasticsearch、Algolia、OpenSearch、Typesense、Meilisearch、向量检索与 RAG。'.repeat(6), '',
    '## 二、迁移路径', '',
    '站内搜索 召回 排序 检索 分词 同义词 精排 粗排 向量 查询理解 零结果 P95。'.repeat(6), '',
    '## 数据来源', '',
    '- [Algolia 文档](https://www.algolia.com/doc/guides/getting-started/quick-start/)', '',
    '## 常见问题', '',
    '**问题一？** 答案一。', '',
    '## 關鍵要點', '',
    '- 要点一', '',
  ].join('\n');
  const fakeQuery = async (sql) => {
    if (sql.includes('a.research_md')) {
      return [[{ content_longtext: body, research_md: null, featured_image: null,
                 seo: null, geo: null, status: 'publish', wp_post_id: 2711,
                 plan_focus_keyword: 'Algolia站内搜索替代' }]];
    }
    if (sql.includes('p.tags AS plan_tags')) {
      // current (published) row carries the accident taxonomy
      return [[{ lang: 'zh-hans', article_title: 'Algolia 替代方案：7 个站内搜索选项对比',
                 article_excerpt: ALGOLIA.excerpt, tax_body: body,
                 plan_title: 'Algolia 替代方案：7 个站内搜索选项对比',
                 focus_keyword: 'Algolia站内搜索替代',
                 plan_tags: '["ai-ask","search-recommend"]', plan_category: 'search-recommend' }]];
    }
    return [[]]; // internal-link targets / research brief lookups
  };
  t.db.withConn = async (fn) => fn({ query: fakeQuery });
  try {
    const report = await t.check.checkArticle({ slug: 'algolia-alternatives-for-site-search', site: 'www_tengence_com' });
    const g18 = report.rows.filter((r) => String(r[0]).includes('G18'));
    assert.equal(g18.length, 4, 'four G18 rows are emitted');
    assert.ok(g18.every((r) => r[4] === true), 'every G18 row is alwaysHard');
    assert.ok(g18.every((r) => r[3] === false), 'isPublished must NOT demote G18 rows to advisory');
    assert.equal(report.isPublished, true, 'precondition: mocked article is already on WP');
    assert.equal(report.tagSemantics.ok, false);
    assert.equal(report.ok, false, 'the gate blocks publishing');
    assert.deepEqual(report.tagSemantics.pseudoTags, ['search-recommend']);
    assert.deepEqual(report.tagSemantics.mismatches.map((m) => m.tag), ['ai-ask']);
  } finally {
    t.db.withConn = orig;
    t.site.loadSite = origLoad;
  }
});
