/**
 * standards resolution layer + bilingual GEO-block parsing
 * ============================================================================
 * Locks in:
 *   - standards.listStandards / readStandard / getSkeleton / buildDraftBrief
 *   - the base+supplement merge (supplement never replaces the base)
 *   - parseGeoBlocks recognizes the EN block headings (Key Takeaways / FAQ /
 *     Data Sources / Summary / Q: / A:) used by the English skeletons
 *   - MCP registry exposes 78 tools; standards are served via geo://standard/* resources
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const t = require('../packages/geo-sdk');
const { parseGeoBlocks, buildPostHtml } = require('../packages/geo-sdk/content/md');
const { tools, registry } = require('../packages/geo-mcp/tools/registry');
const { computeSubstance, isNonSpecificPage, isGenericPadding } = require('../packages/geo-sdk/check');

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

// ==================== G17-4/5/6 substantive-content gate (2026-11-04) ====================
// Pure-function tests for the gate that separates "skeleton-only / hollow" articles
// from developed ones. The 42-article batch (2026-11-04 accident) passed citations +
// length floor but was empty under the semantic standard: sections were 1–2 sentences
// and the citation block was 7/7 Wikipedia + platform homepages.

const zhSec = (n) => '这是该小节的展开内容，包含可核验的事实、具体数据与决策性结论。'.repeat(n);
const enWords = (n) => Array(n).fill('substantive').join(' ');

test('computeSubstance (zh skeleton): 1–2 sentence sections → far below 50% expansion', () => {
  const md = `# T\n\n## 一、什么是 GEO\n\nGEO 是生成式引擎优化。\n\n## 二、为什么重要\n\n因为 AI 概览引用来源。\n\n## 三、如何实施\n\n需要结构化数据。\n\n## 四、衡量效果\n\n用 Search Console 跟踪。\n\n## 五、常见误区\n\n不要堆砌关键词。\n\n## Key Takeaways\n\n- 要点\n\n## 数据来源\n\n- [Wikipedia](https://en.wikipedia.org/wiki/Search_engine_optimization)\n- [OpenAI](https://openai.com/)\n- [Perplexity](https://www.perplexity.ai/)\n- [Anthropic](https://docs.anthropic.com/en/docs/)\n- [Hugging Face](https://huggingface.co/)\n- [Google](https://developers.google.com/search/docs)\n- [Wikipedia LLM](https://en.wikipedia.org/wiki/Large_language_model)\n`;
  const s = computeSubstance(md, 'zh-hans');
  assert.equal(s.contentTotal, 5, 'fixed blocks must be excluded from content sections');
  assert.equal(s.contentOk, 0, '1–2 sentence sections are below the 150-char floor');
  assert.equal(s.itemTotal, 7);
  assert.equal(s.genericItems, 7, 'Wikipedia articles + platform homepages/landings = all padding');
  assert.ok(s.contentOk / s.contentTotal < 0.5, 'skeleton must fail the ≥50% expansion ratio');
});

test('computeSubstance (zh): developed sections pass; data-source block without padding passes', () => {
  const md = `# T\n\n## 一、市场现状\n\n${zhSec(30)}\n\n## 二、实施路径\n\n${zhSec(30)}\n\n## 三、效果衡量\n\n${zhSec(30)}\n\n## 四、风险与对策\n\n${zhSec(30)}\n\n## 五、选型建议\n\n${zhSec(30)}\n\n## 总结\n\n一句话收尾。\n\n## 数据来源\n\n1. [Perplexity 官方爬虫文档](https://docs.perplexity.ai/guides/perplexitybot)：说明 robots.txt 行为。\n2. [Perplexity Help Center](https://www.perplexity.ai/help-center/zh-CN/articles/10354969-perplexity-ruhe-zunxun-robots-txt)：具体文章页。\n3. [某行业报告页](https://example.com/reports/geo-2026)：具体数据。\n`;
  const s = computeSubstance(md, 'zh-hans');
  assert.equal(s.contentTotal, 5);
  assert.equal(s.contentOk, 5, 'all developed sections reach the 150-char floor');
  assert.equal(s.itemTotal, 3);
  assert.equal(s.genericItems, 0, 'deep on-topic docs pages are NOT generic padding');
  assert.ok(s.contentOk / s.contentTotal >= 0.5);
});

test('computeSubstance (en boundary): checklist with short but real sections → fails 50% ratio', () => {
  // The en geo-diagnostic-audit-checklist (id 562) pattern: 10 content sections of
  // 40–60 words each → 2/10 = 20% expanded.
  const md = ['# T', '', '## 1. Section A', '', 'Check item description with why it matters and what to do.', '',
    '## 2. Section B', '', 'Check item description with why it matters and what to do.', '',
    '## 3. Section C', '', 'Check item description with why it matters and what to do.', '',
    '## 4. Section D', '', 'Check item description with why it matters and what to do.', '',
    '## 5. Section E', '', 'Check item description with why it matters and what to do.', '',
    '## 6. Section F', '', 'Check item description with why it matters and what to do.', '',
    '## 7. Section G', '', 'Check item description with why it matters and what to do.', '',
    '## 8. Section H', '', 'Check item description with why it matters and what to do.', '',
    '## 9. Section I', '', 'Check item description with why it matters and what to do.', '',
    '## 10. Section J', '', 'Check item description with why it matters and what to do.', '',
    '## Key Takeaways', '', '- one', '', '## Data Sources', '',
    '1. [Ahrefs](https://ahrefs.com/blog/seo-audit/)', ''].join('\n');
  const s = computeSubstance(md, 'en');
  assert.equal(s.contentTotal, 10);
  assert.equal(s.contentOk, 0, '11-word sections are far below the 80-word floor');
  assert.ok(s.contentOk / s.contentTotal < 0.5, 'short-but-real checklist must fail the ratio (562 pattern)');
});

test('computeSubstance (en): sections at/above 80 words count as expanded', () => {
  const md = `# T\n\n## 1. One\n\n${enWords(80)}\n\n## 2. Two\n\n${enWords(79)}\n\n## 3. Three\n\n${enWords(85)}\n`;
  const s = computeSubstance(md, 'en');
  assert.equal(s.contentTotal, 3);
  assert.equal(s.contentOk, 2, '80 words counts, 79 does not');
  assert.ok(s.contentOk / s.contentTotal >= 0.5);
});

test('computeSubstance: no data-source block → G17-6 n/a (itemTotal < 3)', () => {
  const md = `# T\n\n## 一、内容\n\n${zhSec(30)}\n\n## 二、内容\n\n${zhSec(30)}\n`;
  const s = computeSubstance(md, 'zh-hans');
  assert.equal(s.itemTotal, 0);
  // G17-6 row ok-condition: srcItemTotal < 3 → pass (n/a), mirrors the check row formula
  assert.ok(s.itemTotal < 3 || s.genericItems / s.itemTotal < 0.7);
});

test('computeSubstance: zh 150-char floor — below fails, 150+ passes', () => {
  const one = '这是一个用于测试字数阈值的中文句子，内容足够长以观察边界行为。'; // 31 chars
  const mdLo = `# T\n\n## 一、节\n\n${one}${one}${one}${one}${one.slice(0, 20)}\n`; // 124+20=144 chars
  const mdHi = `# T\n\n## 一、节\n\n${one}${one}${one}${one}${one}\n`; // 155 chars
  assert.equal(computeSubstance(mdLo, 'zh-hans').contentOk, 0);
  assert.equal(computeSubstance(mdHi, 'zh-hans').contentOk, 1);
});

test('isGenericPadding: Wikipedia article (any depth) and platform homepages are padding; deep docs pages are not', () => {
  assert.equal(isGenericPadding('https://en.wikipedia.org/wiki/Search_engine_optimization'), true);
  assert.equal(isGenericPadding('https://www.perplexity.ai/'), true);
  assert.equal(isGenericPadding('https://docs.anthropic.com/en/docs/'), true);
  assert.equal(isGenericPadding('https://docs.perplexity.ai/guides/perplexitybot'), false, 'deep on-topic docs page is a specific citation');
  assert.equal(isGenericPadding('https://openai.com/chatgpt/overview/'), true, 'landing page');
  assert.equal(isGenericPadding('https://ahrefs.com/blog/seo-audit/'), false, 'unrelated domain deep page');
});

test('isNonSpecificPage: homepage / level-1 channel / level-2 landing blocked; deep pages allowed', () => {
  assert.equal(isNonSpecificPage('https://www.perplexity.ai/'), true);
  assert.equal(isNonSpecificPage('https://developers.google.com/search/docs'), true, 'level-2 landing');
  assert.equal(isNonSpecificPage('https://openai.com/chatgpt/overview/'), true, 'landing keyword segment');
  assert.equal(isNonSpecificPage('https://docs.perplexity.ai/guides/perplexitybot'), false);
  assert.equal(isNonSpecificPage('https://www.tengence.com/zh-hans/blog/article/best-geo-tools-comparison-2026/'), false);
});

test('MCP registry: exposes 78 tools — standards moved to geo://standard/* resources, 17 channel tools, 8 wechat tools, 2 GSC read tools, 2 translation tools, 10 term/author-name tools', () => {
  // The count grows with every new domain tool; if it changes, update this number and
  // add the corresponding per-domain assertion below (do not just bump blindly).
  assert.equal(tools.length, 78, 'expected 78 tools (standards as resources, channel + wechat + csdn/aliyun + gsc read + taxonomy + translation + term/author names + site_geo_plan_skill + audit)');
  // standards are exposed as MCP resources, not tools (capability-surface refactor) — assert no legacy
  // tool leaks back.
  for (const n of ['standards_list', 'standards_read']) {
    assert.ok(!registry.has(n), `deleted standards tool ${n} must not be registered`);
  }
  for (const n of ['site_geo_plan_skill', 'article_draft']) {
    assert.ok(registry.has(n), `registry missing ${n}`);
  }
  for (const n of ['channel_list', 'channel_publish', 'channel_plan_next', 'channel_plan_mark', 'channel_style_get', 'channel_check']) {
    assert.ok(registry.has(n), `registry missing ${n}`);
  }
  for (const n of ['channel_schedule_list', 'channel_schedule_get', 'channel_schedule_set', 'channel_schedule_del', 'channel_publish_due', 'channel_audit_check', 'channel_plan_status']) {
    assert.ok(registry.has(n), `registry missing ${n}`);
  }
  for (const n of ['wechat_status', 'wechat_sync_progress']) {
    assert.ok(registry.has(n), `registry missing ${n}`);
  }
  for (const n of ['wechat_mass_preview', 'wechat_mass_send', 'wechat_mass_status', 'wechat_article_delete', 'wechat_draft_publish', 'wechat_stats', 'wechat_draft_update']) {
    assert.ok(registry.has(n), `registry missing ${n}`);
  }
  for (const n of ['search_gsc_stats', 'search_gsc_inspect']) {
    assert.ok(registry.has(n), `registry missing ${n}`);
  }
  for (const n of ['csdn_status', 'csdn_article_delete', 'channel_plan_reconcile', 'channel_taxonomy_list']) {
    assert.ok(registry.has(n), `registry missing ${n}`);
  }
  for (const n of ['article_terms_sync']) {
    assert.ok(registry.has(n), `registry missing ${n}`);
  }
  for (const n of ['translation_glossary_get', 'check_translation']) {
    assert.ok(registry.has(n), `registry missing ${n}`);
  }
  for (const n of ['term_names_list', 'term_name_get', 'term_name_set', 'term_name_delete', 'term_names_batch']) {
    assert.ok(registry.has(n), `registry missing ${n}`);
  }
  for (const n of ['author_names_list', 'author_name_get', 'author_name_set', 'author_name_delete', 'author_names_batch']) {
    assert.ok(registry.has(n), `registry missing ${n}`);
  }
  // every tool has the run contract
  for (const tool of tools) {
    assert.equal(typeof tool.run, 'function', `${tool.name} has no run()`);
    assert.ok(tool.inputSchema, `${tool.name} has no inputSchema`);
  }
});
