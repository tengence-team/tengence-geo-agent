/**
 * standards resolution layer + bilingual GEO-block parsing
 * ============================================================================
 * Locks in:
 *   - standards.listStandards / readStandard / getSkeleton / buildDraftBrief
 *   - the base+supplement merge (supplement never replaces the base)
 *   - parseGeoBlocks recognizes the EN block headings (Key Takeaways / FAQ /
 *     Data Sources / Summary / Q: / A:) used by the English skeletons
 *   - MCP registry exposes the 3 new standards tools (29 total)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const t = require('../packages/geo-sdk');
const { parseGeoBlocks, buildPostHtml } = require('../packages/geo-sdk/content/md');
const { tools, registry } = require('../packages/geo-mcp/tools/registry');

// ==================== standards module ====================

test('standards.listStandards: ships the generic docs and skeletons', () => {
  const names = t.standards.listStandards().map((s) => s.name);
  assert.ok(names.includes('article-writing-standards'), 'missing article-writing-standards');
  assert.ok(names.includes('content-strategy'), 'missing content-strategy');
  assert.ok(names.includes('block-conventions'), 'missing block-conventions');
  assert.ok(names.includes('templates/skeletons/guide'), 'missing guide skeleton');
  assert.ok(names.includes('templates/research-brief'), 'missing research-brief');
});

test('standards.readStandard: returns base text and reports no supplement by default', () => {
  const s = t.standards.readStandard('article-writing-standards');
  assert.ok(s.merged.includes('G1'), 'base should contain the G1–G14 gates');
  assert.equal(s.hasSupplement, false);
});

test('standards.readStandard: unknown name throws UNKNOWN_STANDARD with suggestions', () => {
  assert.throws(
    () => t.standards.readStandard('does-not-exist'),
    (e) => e.code === 'UNKNOWN_STANDARD' && Array.isArray(e.available)
  );
});

test('standards.getSkeleton: known T1–T7 type returns a skeleton with EN block headings', () => {
  const sk = t.standards.getSkeleton('guide');
  assert.ok(sk.includes('## Key Takeaways'), 'skeleton must use the EN Key Takeaways heading');
  assert.ok(sk.includes('## Data Sources'), 'skeleton must use the EN Data Sources heading');
  assert.throws(() => t.standards.getSkeleton('nope'), (e) => e.code === 'UNKNOWN_TYPE');
});

test('standards.buildDraftBrief: bundles skeleton + research brief + writing standard', () => {
  const b = t.standards.buildDraftBrief({ type: 'guide', topic: 'sample' });
  assert.equal(b.ok, true);
  assert.equal(b.type, 'guide');
  assert.ok(b.skeleton.includes('## Key Takeaways'));
  assert.ok(b.research_brief_template.length > 50);
  assert.ok(b.writing_standard.includes('G1'));
  assert.ok(b.block_headings.summary.includes('Summary'));
});

test('standards.readStandard: supplement is merged after the base, never replaces it', () => {
  const dir = t.paths.internalHome();
  const suppDir = path.join(dir, 'standards');
  fs.mkdirSync(suppDir, { recursive: true });
  const target = path.join(suppDir, 'templates', 'research-brief.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const token = 'SITE-SPECIFIC-MARKER-' + Date.now();
  fs.writeFileSync(target, '# research-brief (supplement)\n\n' + token + '\n');
  try {
    const s = t.standards.readStandard('templates/research-brief');
    assert.equal(s.hasSupplement, true);
    assert.ok(s.merged.includes(token), 'supplement content must be appended');
    assert.ok(s.merged.includes('Site-specific Additions'), 'merge must be delimited');
    assert.ok(s.base.length > s.supplement.length, 'base is the larger, authoritative part');
  } finally {
    fs.rmSync(target, { force: true });
  }
});

// ==================== bilingual GEO-block parsing ====================

const EN_BODY = `# Sample Title

> **Summary:** A one-sentence abstract that states the conclusion.

## 1. Lead

An introductory paragraph in English.

## Key Takeaways

- Point one about the topic
- Point two with a claim

## FAQ

> **Q:** What is the sample topic?
> **A:** It is a demonstration of the EN block headings.

## Data Sources

1. [Example source](https://example.com/a)
`;

test('parseGeoBlocks (EN): extracts Summary / Key Takeaways / FAQ / Data Sources', () => {
  const p = parseGeoBlocks(EN_BODY);
  assert.equal(p.summary, 'A one-sentence abstract that states the conclusion.');
  assert.deepEqual(p.takeaways, ['Point one about the topic', 'Point two with a claim']);
  assert.equal(p.faq.length, 1);
  assert.equal(p.faq[0].question, 'What is the sample topic?');
  assert.match(p.faq[0].answer, /It is a demonstration/);
  assert.deepEqual(p.citations, [{ title: 'Example source', url: 'https://example.com/a' }]);
});

test('buildPostHtml (EN): does not double-materialize an existing EN Key Takeaways block', () => {
  const html = buildPostHtml(EN_BODY, {});
  const count = (html.match(/<h2>Key Takeaways<\/h2>/g) || []).length;
  assert.equal(count, 1, 'existing EN Key Takeaways must not be duplicated');
  assert.ok(html.includes('<h2>FAQ</h2>'), 'FAQ section must be present');
});

test('parseGeoBlocks (ZH regression): Chinese headings still parse', () => {
  const zh = '# 标题\n\n> **摘要**：一句话结论。\n\n## 关键要点\n\n- 要点一\n\n## 常见问题\n\n> **问：是什么？**\n> 答：是测试。\n\n## 数据来源\n\n1. [来源](https://example.com/b)\n';
  const p = parseGeoBlocks(zh);
  assert.equal(p.summary, '一句话结论。');
  assert.deepEqual(p.takeaways, ['要点一']);
  assert.equal(p.faq[0].question, '是什么？');
  assert.deepEqual(p.citations, [{ title: '来源', url: 'https://example.com/b' }]);
});

// ==================== MCP registry ====================

test('MCP registry: exposes 37 tools including the 3 standards tools, 4 channel tools and 2 wechat backend tools', () => {
  assert.equal(tools.length, 37, 'expected 37 tools after adding standards_list/read/article_draft + channel_list/publish/plan_next/plan_mark + wechat_status/sync_progress');
  for (const n of ['standards_list', 'standards_read', 'article_draft']) {
    assert.ok(registry.has(n), `registry missing ${n}`);
  }
  for (const n of ['channel_list', 'channel_publish', 'channel_plan_next', 'channel_plan_mark']) {
    assert.ok(registry.has(n), `registry missing ${n}`);
  }
  for (const n of ['wechat_status', 'wechat_sync_progress']) {
    assert.ok(registry.has(n), `registry missing ${n}`);
  }
  // every tool has the run contract
  for (const tool of tools) {
    assert.equal(typeof tool.run, 'function', `${tool.name} has no run()`);
    assert.ok(tool.inputSchema, `${tool.name} has no inputSchema`);
  }
});
