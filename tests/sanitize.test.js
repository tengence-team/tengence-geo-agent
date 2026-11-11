'use strict';
/**
 * syndicate/sanitize — the deterministic pre-send rewrite layer
 * ============================================================================
 * Locks in the 2026-11-11 fix: the unattended publish path (channel_publish_due →
 * Mode A) sends the raw DB body, which carries the brand block, the CTA block and
 * conversion links. The hard styleCheck gate rejects those, so nothing was sent
 * for 5 days (juejin 3/80 candidates passed, csdn 2/88). sanitize() removes
 * exactly what styleCheck rejects, driven by the SAME styles/*.yaml rules.
 *
 * These tests are the contract:
 *   - every class of blocker the gate reported is removed
 *   - the body still PASSES styleCheck afterwards (the pairing is airtight)
 *   - content the platform allows survives (article links for juejin / third-party
 *     citations / images), so sanitize never over-strips into a hollow article
 *   - sanitize is idempotent (running it twice must not change the body)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const sanitize = require('../packages/geo-sdk/syndicate/sanitize');
const styleCheck = require('../packages/geo-sdk/syndicate/styleCheck');

const FIXTURE = [
  '## 一、选型结论',
  '',
  '站内搜索的核心是把查询理解、召回与排序拆开治理。可参考[搜索系统选型](/blog/article/search-system-selection/)的对比，',
  '也可以看第三方文档 https://www.algolia.com/doc/guides/getting-started/what-is-algolia/ 。',
  '',
  '![架构图](https://www.tengence.com/blog/static/images/2026/08/image-20260827174230258.webp)',
  '',
  '## 二、成本对比',
  '',
  '| 方案 | 适用规模 | 备注 |',
  '| 自建 | 500-2000人 | 免费试用30天 |',
  '',
  '## 关于通智云',
  '',
  '[通智搜索](https://www.tengence.com/tengence-search)是 AI 驱动的站内检索方案。',
  '',
  '## 相关阅读',
  '',
  '- [企业知识库搜索：文档检索场景的落地方案](/zh-hans/blog/article/enterprise-knowledge-base-search/)',
  '- [搜索 ROI 与贡献转化评估](/zh-hans/blog/article/search-roi-measurement/)',
  '',
  '## 数据来源',
  '',
  '1. [Algolia 官方文档《What is Algolia》](https://www.algolia.com/doc/guides/getting-started/what-is-algolia/)：确认其为托管式检索 API。',
  '',
  '## 立即行动',
  '',
  '- <a href="https://console.tengence.com/login">免费试用通智云</a>',
  '- <a href="https://www.tengence.com/contact-us">免费预约专家咨询和诊断</a>',
  '- <a href="https://www.tengence.com/tengence-geo">了解通智 GEO</a>',
  '',
  '## 三、落地步骤',
  '',
  '先盘清 30 天的请求量与零结果率，再选一个可观测模块做两周对照实验。',
].join('\n');

test('juejin: brand + CTA blocks and conversion links are removed, body then PASSES the gate', () => {
  const before = styleCheck.check({ platform: 'juejin', body: FIXTURE });
  assert.equal(before.ok, false, 'fixture must be rejected BEFORE sanitize (regression baseline)');
  assert.ok(before.errors.some((e) => e.includes('关于通智云')));
  assert.ok(before.errors.some((e) => e.includes('console.tengence.com/login') || e.includes('转化链接')));

  const out = sanitize.sanitizeBody({ platform: 'juejin', body: FIXTURE });
  const body = out.body;
  assert.ok(!body.includes('关于通智云'), 'brand section removed');
  assert.ok(!body.includes('立即行动'), 'CTA section removed');
  assert.ok(!body.includes('免费试用'), 'banned phrase removed');
  assert.ok(!body.includes('console.tengence.com'), 'conversion link gone');
  assert.ok(!body.includes('/contact-us'), 'contact-us landing link gone');
  // editorial content the platform allows MUST survive
  assert.ok(body.includes('/blog/article/search-system-selection/'), 'article-page link kept for juejin');
  assert.ok(body.includes('https://www.algolia.com/doc/guides'), 'third-party citation kept');
  assert.ok(body.includes('blog/static/images/2026/08'), 'site image kept');
  assert.ok(body.includes('| 自建 | 500-2000人 |'), 'table structure survives');

  const after = styleCheck.check({ platform: 'juejin', body });
  assert.equal(after.ok, true, `sanitized body must pass the gate: ${after.errors.join(' / ')}`);
});

test('csdn: zero-link rule → every hyperlink degrades to text, images stay, gate passes', () => {
  const before = styleCheck.check({ platform: 'csdn', body: FIXTURE });
  assert.equal(before.ok, false);

  const out = sanitize.sanitizeBody({ platform: 'csdn', body: FIXTURE });
  const body = out.body;
  assert.ok(!/(?<!\!)\[[^\]]*\]\(http/.test(body), 'no markdown hyperlinks left (images exempt)');
  assert.ok(!body.includes('https://www.algolia.com'), 'third-party URL removed (CSDN zero-link)');
  assert.ok(!body.includes('<a '), 'no <a> tags left');
  assert.ok(body.includes('![架构图](https://www.tengence.com/blog/static/'), 'images are exempt and must stay');
  assert.ok(body.includes('Algolia 官方文档《What is Algolia》'), 'citation keeps its title, only the URL goes');
  assert.ok(body.includes('企业知识库搜索'), '相关阅读 becomes a plain-text list');

  const after = styleCheck.check({ platform: 'csdn', body });
  assert.equal(after.ok, true, `sanitized body must pass the gate: ${after.errors.join(' / ')}`);
});

test('same rules apply to aliyun and tencent (tencent removeAllLinks)', () => {
  for (const platform of ['aliyun', 'tencent']) {
    const out = sanitize.sanitizeBody({ platform, body: FIXTURE });
    assert.ok(!out.body.includes('关于通智云'), `${platform}: brand block removed`);
    const after = styleCheck.check({ platform, body: out.body });
    assert.equal(after.ok, true, `${platform}: ${after.errors.join(' / ')}`);
  }
  const tencent = sanitize.sanitizeBody({ platform: 'tencent', body: FIXTURE });
  const noImages = tencent.body.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  assert.ok(!noImages.includes('https://www.tengence.com'), 'tencent removes brand links entirely (images exempt)');
  assert.ok(!tencent.body.includes('相关阅读'), 'tencent removeBlocks includes 相关阅读');
});

test('residual sweep: banned phrases hidden in table cells and code fences are removed too', () => {
  const body = [
    '## 示例',
    '',
    '| 方案 | 备注 |',
    '| 自建 | 免费试用30天 |',
    '',
    '```text',
    '├── 关于我们',
    '└── 文章',
    '```',
    '',
    '结尾段落。',
  ].join('\n');
  const out = sanitize.sanitizeBody({ platform: 'juejin', body });
  assert.ok(!out.body.includes('免费试用'), 'table-cell phrase removed');
  assert.ok(!out.body.includes('关于我们'), 'code-fence phrase removed');
  assert.ok(out.body.includes('| 自建 |'), 'table row keeps its shape');
  assert.equal(styleCheck.check({ platform: 'juejin', body: out.body }).ok, true);
});

test('unwrapping a link must not CREATE a banned phrase (了解[通智 GEO](url) case)', () => {
  const body = '通智 GEO 做法见文末，了解[通智 GEO](https://www.tengence.com/tengence-geo)如何把双引擎合并。';
  const out = sanitize.sanitizeBody({ platform: 'juejin', body });
  assert.ok(!out.body.includes('了解通智 GEO'), 'link label no longer forms the banned block phrase');
  assert.equal(styleCheck.check({ platform: 'juejin', body: out.body }).ok, true);
});

test('over-length bodies are trimmed under the platform maxChars', () => {
  const section = (i) => `## 章节 ${i}\n\n${'技术说明与数据论证。'.repeat(220)}\n`;
  const big = Array.from({ length: 9 }, (_, i) => section(i)).join('\n');
  assert.ok(big.length > 15000);
  const out = sanitize.sanitizeBody({ platform: 'juejin', body: big });
  assert.ok([...out.body].length <= 15000, `trimmed to ${[...out.body].length} chars`);
  assert.equal(styleCheck.check({ platform: 'juejin', body: out.body }).ok, true);
});

test('idempotent: sanitizing an already-sanitized body changes nothing', () => {
  for (const platform of ['juejin', 'csdn']) {
    const once = sanitize.sanitizeBody({ platform, body: FIXTURE });
    const twice = sanitize.sanitizeBody({ platform, body: once.body });
    assert.equal(twice.body, once.body, `${platform}: second pass must be a no-op`);
  }
});

test('unknown platform is a hard error, never a silent pass-through', () => {
  assert.throws(() => sanitize.sanitizeBody({ platform: 'nope', body: 'x' }), /Unknown platform/);
});
