const test = require('node:test');
const assert = require('node:assert');
const rb = require('../packages/geo-sdk/content/research-brief');

test('missingInBrief: only reports URLs the brief does not carry', () => {
  const cites = [
    { title: 'A', url: 'https://a.example/x' },
    { title: 'B', url: 'https://b.example/y' },
    { title: 'C', url: 'https://c.example/z' },
  ];
  const miss = rb.missingInBrief(cites, 'brief mentions https://a.example/x only');
  assert.deepEqual(miss.map((m) => m.url), ['https://b.example/y', 'https://c.example/z']);
  assert.deepEqual(rb.missingInBrief(cites, cites.map((c) => c.url).join(' ')), []);
});

test('bodyCitations: reads the body 数据来源 block, ignoring items without a url', () => {
  const md = [
    '# T',
    '',
    '## 数据来源',
    '',
    '- [官方文档](https://developers.google.com/search/docs/appearance/ai-features)',
    '- 没有链接的一条',
    '- [年报](https://example.com/annual-report-2026)',
    '',
    '## FAQ',
    '',
    '**问：x**',
    '答。',
  ].join('\n');
  const cites = rb.bodyCitations(md);
  assert.equal(cites.length, 2);
  assert.deepEqual(cites.map((c) => c.url), [
    'https://developers.google.com/search/docs/appearance/ai-features',
    'https://example.com/annual-report-2026',
  ]);
});

test('backfill: appended section makes every body citation traceable (gate parity)', () => {
  // The row that used to fail the B2 ledger: brief exists but carries none of the cited URLs.
  const body = [
    '## 数据来源',
    '- [McKinsey](https://www.mckinsey.com/industries/retail/our-insights/x)',
    '- [Netflix TechBlog](https://netflixtechblog.com/)',
  ].join('\n');
  const cites = rb.bodyCitations(body);
  const brief = '# research brief\n\n行业博客、媒体报道若干。\n';
  const miss = rb.missingInBrief(cites, brief);
  assert.equal(miss.length, 2);
});
