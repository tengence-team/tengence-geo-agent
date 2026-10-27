/**
 * CSDN zero-link gate (2026-10-27)
 * ============================================================================
 * Locks in the new CSDN publishing requirement: a CSDN article body must contain
 * NO hyperlinks of any kind (in-site article pages, product pages, third-party
 * citations, markdown links, bare URLs, <a> tags) — images are explicitly exempt.
 *
 * Two layers are tested:
 *   ① styleCheck.check({platform:'csdn'}) — the hard gate (channel_check) must
 *      ERROR on any link and PASS when only images remain.
 *   ② content/md.stripAllLinks — the shared stripper used by both the server-side
 *      Mode A pipeline (publishCsdn) and the harness Mode B rewrite.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('../packages/geo-sdk');
const { stripAllLinks } = require('../packages/geo-sdk/content/md');

const checkCsdn = (body, title) =>
  t.syndicate.styleCheck.check({ platform: 'csdn', title: title || '测试标题', body });

const hasLinkErr = (r) => r.errors.some((e) => e.includes('禁止任何链接'));

test('CSDN gate: markdown 超链接 → error', () => {
  const r = checkCsdn('正文一段。\n\n详见[通智 GEO](https://www.tengence.com/tengence-geo)。');
  assert.equal(r.ok, false);
  assert.ok(hasLinkErr(r), '应报零链接 error: ' + JSON.stringify(r.errors));
});

test('CSDN gate: 站内文章页链接 → error', () => {
  const r = checkCsdn('延伸[相关文章](https://www.tengence.com/zh-hans/blog/article/geo-trends-2026/)。');
  assert.equal(r.ok, false);
  assert.ok(hasLinkErr(r));
});

test('CSDN gate: 裸 URL → error', () => {
  const r = checkCsdn('参考 https://www.163.com/dy/article/abc.html 的数据。');
  assert.equal(r.ok, false);
  assert.ok(hasLinkErr(r));
});

test('CSDN gate: <a> 标签 → error', () => {
  const r = checkCsdn('点击 <a href="https://example.com">这里</a> 了解。');
  assert.equal(r.ok, false);
  assert.ok(hasLinkErr(r));
});

test('CSDN gate: 仅图片（外链图）不触发零链接 error', () => {
  const r = checkCsdn('![架构图](https://cdn.example.com/x.png)\n\n正文无链接。');
  assert.ok(!hasLinkErr(r), '图片不应触发零链接 error: ' + JSON.stringify(r.errors));
});

test('CSDN gate: 无链接正文 → 零链接维度通过', () => {
  const r = checkCsdn('正文第一段介绍背景。\n\n## 关键要点\n要点一。\n\n## 数据来源\nSensor Tower 报告。');
  assert.ok(!hasLinkErr(r));
});

test('stripAllLinks: markdown 超链接 → 纯文本', () => {
  assert.equal(stripAllLinks('见[通智 GEO](https://x.com/a)。'), '见通智 GEO。');
});

test('stripAllLinks: 裸 URL 删除', () => {
  assert.equal(stripAllLinks('参考 https://x.com/a 的数据。'), '参考 的数据。');
});

test('stripAllLinks: <a> 标签 → 文本', () => {
  assert.equal(stripAllLinks('点击 <a href="https://x.com">这里</a>。'), '点击 这里。');
});

test('stripAllLinks: 图片保留', () => {
  const md = '![图](https://cdn/x.png)';
  assert.equal(stripAllLinks(md), md);
});

test('stripAllLinks: 图片与超链接混排', () => {
  const out = stripAllLinks('![图](https://cdn/x.png)\n\n见[链接](https://y.com)。');
  assert.ok(out.includes('![图](https://cdn/x.png)'), '图片应保留');
  assert.ok(!out.includes('https://y.com'), '超链接应剥离');
  assert.ok(out.includes('链接'), '链接文本应保留');
});
