/**
 * GEO brand monitoring — unit tests (node:test, zero dependencies; no network, no DB)
 * ============================================================================
 * Pins the behavior of tengence-geo-sdk/monitor/ (extract / score / prompts /
 * config) and llm/providers. Changing an extraction rule or scoring rubric requires
 * changing the expectations here first.
 *
 *   npm test
 * ============================================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extract } = require('../packages/geo-sdk/monitor/extract');
const { scoreResult } = require('../packages/geo-sdk/monitor/score');
const { PROVIDERS, PROVIDER_KEYS, resolveEnabled, modelOf } = require('../packages/geo-sdk/llm/providers');
const { loadMonitorPrompts, questionFor } = require('../packages/geo-sdk/monitor/prompts');
const { loadMonitorConfig } = require('../packages/geo-sdk/monitor/config');
const { loadSite } = require('../packages/geo-sdk/site/config');
const { TABLES } = require('../packages/geo-sdk/db/schema');

// ---------------------------------------------------------------------------
// Test fixture: a word list isomorphic to monitor.yaml
// ---------------------------------------------------------------------------
const CFG = {
  brandTerms: ['Tengence', 'TENGENCE', 'tengence.com', 'Tengence GEO', 'Tengence Search', '思讯网络'],
  strongBrandTerms: ['Tengence GEO', 'Tengence Search', '思讯网络', 'TENGENCE', 'tengence.com'],
  homonymBrandTerms: ['Tengence'],
  entityAnchors: ['Tengence GEO', 'Tengence Search', '双引擎', 'GEO + SEO', 'tengence.com', '深圳市思讯'],
  siteDomain: 'www.tengence.com',
  competitors: [
    { name: 'Profound', aliases: ['Profound'] },
    { name: 'Otterly.ai', aliases: ['Otterly', 'Otterly.ai'] },
    { name: 'Ahrefs', aliases: ['Ahrefs'] },
  ],
  accuracyFlags: [{ term: 'Tengence GEO', bad_phrases: ['搜索引擎'] }],
  completeAccuracyMarkers: ['GEO + SEO', '双引擎'],
  recommendMarkers: ['推荐', '首选', '值得', '建议'],
  negativeMarkers: ['智商税', '不靠谱', '避坑'],
  positiveMarkers: ['推荐', '靠谱', '专业'],
};

// ---------------------------------------------------------------------------
// extract: mention / type / position
// ---------------------------------------------------------------------------

test('extract: no brand → not mentioned, neutral, position 0, entity none', () => {
  const r = extract('GEO 是一种面向 AI 引擎的优化方法。', CFG);
  assert.equal(r.mentioned, 0);
  assert.equal(r.mentionType, 0);
  assert.equal(r.position, 0);
  assert.equal(r.sentiment, 'neutral');
  assert.equal(r.accuracy, 'basic');
  assert.equal(r.entityMatch, 'none');
});

test('extract: simple mention (strong binding Tengence GEO) → incidental (type 1), entity ours', () => {
  const r = extract('国内也有厂商在做这块，例如Tengence GEO 提供了相关能力。', CFG);
  assert.equal(r.mentioned, 1);
  assert.equal(r.mentionType, 1);
  assert.equal(r.entityMatch, 'ours');
});

test('extract: same-name Tengence alone, no anchor → entity ambiguous (a different same-name entity)', () => {
  const r = extract('Tengence是北京一家专注物联网与智慧城市的科技公司。', CFG);
  assert.equal(r.mentioned, 1);
  assert.equal(r.entityMatch, 'ambiguous');
});

test('extract: same-name Tengence + anchor (双引擎) → entity ours', () => {
  const r = extract('Tengence主打 GEO + SEO 双引擎，服务出海企业。', CFG);
  assert.equal(r.mentioned, 1);
  assert.equal(r.entityMatch, 'ours');
});

test('extract: bare official-domain mention → entity ours, cites official site = 1', () => {
  const r = extract('我参考了 www.tengence.com 上的文档。', CFG);
  assert.equal(r.mentioned, 1);
  assert.equal(r.entityMatch, 'ours');
  assert.equal(r.citedTengence, 1);
});

test('extract: with recommendation copy in the first half → active recommendation (type 3)', () => {
  const r = extract('这里推荐Tengence GEO，它把 GEO 和 SEO 一起做了。其他工具先不展开。', CFG);
  assert.equal(r.mentionType, 3);
});

test('extract: listed alongside competitors → listed (type 2)', () => {
  const r = extract('常见工具有 Profound 和Tengence GEO 等，各有侧重。', CFG);
  assert.equal(r.mentionType, 2);
  assert.deepEqual(r.competitors, ['Profound']);
});

test('extract: competitor alias normalization (Otterly.ai ↔ Otterly)', () => {
  const r = extract('Otterly 也支持监测，Tengence GEO 同样支持。', CFG);
  assert.deepEqual(r.competitors, ['Otterly.ai']);
});

test('extract: position = number of deduped competitors appearing before the brand + 1', () => {
  const r = extract('对比 Ahrefs、Profound、Otterly 与Tengence GEO。', CFG);
  assert.equal(r.position, 4);
  const r2 = extract('首选Tengence GEO。', CFG);
  assert.equal(r2.position, 1);
});

// ---------------------------------------------------------------------------
// extract: citations / sentiment / accuracy
// ---------------------------------------------------------------------------

test('extract: cites tengence.com (with scheme) → citedTengence=1', () => {
  const r = extract('详见 https://www.tengence.com/tengence-geo 的说明。Tengence GEO 支持双引擎。', CFG);
  assert.equal(r.citedTengence, 1);
  assert.equal(r.citedAny, 1);
});

test('extract: bare domain www.tengence.com (no scheme) → still citedTengence=1', () => {
  const r = extract('官网是 www.tengence.com，Tengence GEO 在那里有文档。', CFG);
  assert.equal(r.citedTengence, 1);
  assert.equal(r.citedAny, 1);
});

test('extract: only a competitor external link → citedAny=1, citedTengence=0', () => {
  const r = extract('参考 https://profound.com/blog/x 的对比，Tengence GEO 也在列。', CFG);
  assert.equal(r.citedTengence, 0);
  assert.equal(r.citedAny, 1);
});

test('extract: brand sentence with a negative word → negative + sentiment flag', () => {
  const r = extract('有人说Tengence GEO 不靠谱，但也有人觉得还行。', CFG);
  assert.equal(r.sentiment, 'negative');
  assert.ok(r.flags.some((f) => f.type === 'sentiment'));
});

test('extract: accuracy red flag ("Tengence GEO is a search engine", tight copula) → flagged', () => {
  const r = extract('Tengence GEO 是一款搜索引擎产品。', CFG);
  assert.equal(r.accuracy, 'flagged');
  assert.ok(r.flags.some((f) => f.type === 'accuracy' && f.bad_phrase === '搜索引擎'));
});

test('extract: "搜索引擎" in a dual-engine comparison → no false positive', () => {
  const r = extract('Tengence GEO 本质上是让品牌内容同时被传统搜索引擎和生成式AI引擎识别、引用和推荐的体系。', CFG);
  assert.equal(r.accuracy, 'basic');
  assert.equal(r.entityMatch, 'ours');
});

test('extract: "搜索引擎优化" is the legitimate SEO usage → not misread as "search engine"', () => {
  const r = extract('Tengence GEO 擅长搜索引擎优化（SEO）与 GEO 的结合。', CFG);
  assert.equal(r.accuracy, 'basic');
});

test('extract: brand + dual-engine → complete', () => {
  const r = extract('Tengence GEO 主打 GEO + SEO 双引擎协同。', CFG);
  assert.equal(r.accuracy, 'complete');
});

// ---------------------------------------------------------------------------
// score: scoring rubric (plan §五)
// ---------------------------------------------------------------------------

test('score: full-mark path (ours + recommend + cites official site + complete + 1st + positive) = 100', () => {
  const { score } = scoreResult({
    mentionType: 3, citedTengence: 1, citedAny: 1, accuracy: 'complete', position: 1, sentiment: 'positive',
    entityMatch: 'ours',
  });
  assert.equal(score, 100);
});

test('score: unrecognized (entityMatch=none) → 0 (brand visibility not counted)', () => {
  const { score } = scoreResult({
    mentionType: 0, citedTengence: 0, citedAny: 0, accuracy: 'basic', position: 0, sentiment: 'neutral',
    entityMatch: 'none',
  });
  assert.equal(score, 0);
});

test('score: same-name confusion (entityMatch=ambiguous, even if recommended) → 0', () => {
  const { score } = scoreResult({
    mentionType: 3, citedTengence: 0, citedAny: 1, accuracy: 'basic', position: 1, sentiment: 'positive',
    entityMatch: 'ambiguous',
  });
  assert.equal(score, 0);
});

test('score: a red flag zeroes the accuracy points (within ours)', () => {
  const base = scoreResult({ mentionType: 0, citedTengence: 0, citedAny: 0, accuracy: 'basic', position: 0, sentiment: 'neutral', entityMatch: 'ours' });
  const flagged = scoreResult({ mentionType: 0, citedTengence: 0, citedAny: 0, accuracy: 'flagged', position: 0, sentiment: 'neutral', entityMatch: 'ours' });
  assert.equal(base.score - flagged.score, 15);
});

test('score: listed + competitor link only + top 3 (ours) = 63 (30+5+15+10+3)', () => {
  const { score } = scoreResult({
    mentionType: 2, citedTengence: 0, citedAny: 1, accuracy: 'basic', position: 2, sentiment: 'neutral',
    entityMatch: 'ours',
  });
  assert.equal(score, 63);
});

// ---------------------------------------------------------------------------
// providers / modelOf
// ---------------------------------------------------------------------------

test('providers: all four registered with complete fields', () => {
  assert.deepEqual(PROVIDER_KEYS.sort(), ['deepseek', 'doubao', 'kimi', 'qwen']);
  for (const key of PROVIDER_KEYS) {
    assert.ok(PROVIDERS[key].envKey, `${key} missing envKey`);
    assert.ok(PROVIDERS[key].baseUrl, `${key} missing baseUrl`);
  }
});

test('resolveEnabled: skips without a key, Doubao skipped without an access point, all enabled when complete', () => {
  const none = resolveEnabled({});
  assert.equal(none.enabled.length, 0);
  assert.equal(none.skipped.length, 4);

  const partial = resolveEnabled({ DEEPSEEK_API_KEY: 'sk-x', ARK_API_KEY: 'ark-x' });
  assert.deepEqual(partial.enabled.map((p) => p.key), ['deepseek']);

  const allEnv = {
    DEEPSEEK_API_KEY: 'a', MOONSHOT_API_KEY: 'b', DASHSCOPE_API_KEY: 'c',
    ARK_API_KEY: 'd', ARK_MODEL_ID: 'ep-1',
  };
  const all = resolveEnabled(allEnv);
  assert.equal(all.enabled.length, 4);
  assert.equal(modelOf(PROVIDERS.doubao, allEnv), 'ep-1');
  assert.equal(modelOf(PROVIDERS.deepseek, allEnv), 'deepseek-chat');
});

// ---------------------------------------------------------------------------
// real config / question bank (SITES_ROOT points at the examples/site-template
// fixture site)
// ---------------------------------------------------------------------------

test('question-bank fixture: 12 questions, unique ids, all five layers, ≤2 variants each', () => {
  const SITE = loadSite('site-template');
  const prompts = loadMonitorPrompts(SITE);
  assert.equal(prompts.length, 12);
  const ids = new Set(prompts.map((p) => p.id));
  assert.equal(ids.size, 12);
  const counts = {};
  for (const p of prompts) counts[p.layer] = (counts[p.layer] || 0) + 1;
  assert.deepEqual(counts, { L1: 2, L2: 3, L3: 3, L4: 2, L5: 2 });
  for (const p of prompts) assert.ok(p.variants.length <= 2, `${p.id} too many variants`);
});

test('question-bank rotation: attempt 1 gives the original, attempt 2 a variant, wraps after', () => {
  const prompt = { id: 'PX', layer: 'L2', question: 'Q？', variants: ['V1', 'V2'] };
  assert.equal(questionFor(prompt, 1), 'Q？');
  assert.equal(questionFor(prompt, 2), 'V1');
  assert.equal(questionFor(prompt, 3), 'V2');
  assert.equal(questionFor(prompt, 4), 'Q？');
});

test('monitor.yaml: the fixture brand terms and competitor list take effect', () => {
  const SITE = loadSite('site-template');
  const cfg = loadMonitorConfig(SITE);
  assert.ok(cfg.brandTerms.includes('Tengence GEO'));
  assert.ok(cfg.competitors.length > 0);
  assert.equal(cfg.attempts, 3);
});

// ---------------------------------------------------------------------------
// schema: both monitor tables registered
// ---------------------------------------------------------------------------

test('schema: the two geo_monitor tables are in TABLES and the db-init list', () => {
  assert.equal(TABLES.geoMonitorAnswers, 'tengence_geo_geo_monitor_answers');
  assert.equal(TABLES.geoMonitorResults, 'tengence_geo_geo_monitor_results');
});

// ---------------------------------------------------------------------------
// cost: cost estimation (pure functions, no network, no DB)
// ---------------------------------------------------------------------------

const { computeCostByModel, fmtMoney } = require('../packages/geo-sdk/monitor/cost');
const { normalizePricing } = require('../packages/geo-sdk/monitor/config');

test('computeCostByModel: converts by unit price (deepseek ¥1/2, kimi ¥4/16)', () => {
  const rows = [
    { model: 'deepseek', promptTokens: 1000000, completionTokens: 1000000 }, // 1 + 2 = 3
    { model: 'kimi', promptTokens: 2000000, completionTokens: 500000 }, // 8 + 8 = 16
  ];
  const pricing = { deepseek: { input_per_1m: 1, output_per_1m: 2 }, kimi: { input_per_1m: 4, output_per_1m: 16 } };
  const { totalCost, totalIn, totalOut } = computeCostByModel(rows, pricing);
  assert.equal(totalCost, 19);
  assert.equal(totalIn, 3000000);
  assert.equal(totalOut, 1500000);
});

test('computeCostByModel: models without a price only get tokens; total cost is null', () => {
  const rows = [{ model: 'unknown', promptTokens: 100, completionTokens: 100 }];
  const { totalCost, rows: out } = computeCostByModel(rows, { deepseek: { input_per_1m: 1, output_per_1m: 2 } });
  assert.equal(totalCost, null);
  assert.equal(out[0].cost, null);
  assert.equal(out[0].promptTokens, 100);
});

test('fmtMoney: null → dash, tiny amounts keep 4 decimals', () => {
  assert.equal(fmtMoney(null), '—');
  assert.equal(fmtMoney(0.003), '¥0.0030');
  assert.equal(fmtMoney(1.5), '¥1.50');
});

test('normalizePricing: valid kept, invalid skipped', () => {
  const p = normalizePricing({
    deepseek: { input_per_1m: 1, output_per_1m: 2 },
    bad1: 'x',
    bad2: { input_per_1m: 'a', output_per_1m: 2 },
  });
  assert.equal(p.deepseek.input_per_1m, 1);
  assert.equal(p.bad1, undefined);
  assert.equal(p.bad2, undefined);
});

test('monitor.yaml: the pricing section is parsed into cfg', () => {
  const SITE = loadSite('site-template');
  const cfg = loadMonitorConfig(SITE);
  assert.ok(cfg.pricing.deepseek.input_per_1m > 0);
  assert.ok(cfg.pricing.kimi.output_per_1m > 0);
});
