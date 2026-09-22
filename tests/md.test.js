/**
 * content/md — publish pre-guard unit tests (node:test, zero dependencies)
 * ============================================================================
 * Batch 8 added two guards to markdownToHtml "before handing off to marked":
 *   ① holdRawHtml — pulls out MerPress's Mermaid blocks, immune to "CommonMark HTML
 *     blocks terminate on a blank line"
 *   ② fixCjkBold  — fixes marked/CommonMark's CJK-bold defect (closing ** before a
 *     punctuation mark, immediately followed by a CJK char → never closes)
 * Neither guard changes normal writing, so the output for existing articles is
 * byte-identical (verified with three dry-runs).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  markdownToHtml,
  composeBody,
  buildPostHtml,
  parseGeoBlocks,
  syncGeoFromMarkdown,
  parseFrontMatter,
  extractCitationFromItem,
  fixCjkBold,
  holdRawHtml,
  restoreRawHtml,
  mapOutsideFences,
  removeImageByUrl,
} = require('../packages/geo-sdk/content/md');

// ==================== ① fixCjkBold ====================

test('fixCjkBold: closing ** preceded by a Chinese punctuation mark, followed by a CJK char → rewritten to <strong>', () => {
  assert.equal(fixCjkBold('**A：**建立健全'), '<strong>A：</strong>建立健全');
  assert.equal(
    fixCjkBold('**并查集算法（Union-Find）**发挥着关键作用'),
    '<strong>并查集算法（Union-Find）</strong>发挥着关键作用'
  );
  assert.equal(fixCjkBold('**结尾标点，**然后汉字'), '<strong>结尾标点，</strong>然后汉字');
});

test('fixCjkBold: bold that already closes correctly stays untouched (closing ** before a CJK char)', () => {
  assert.equal(fixCjkBold('中文**粗体**后续'), '中文**粗体**后续');
  assert.equal(fixCjkBold('**正常加粗**的用例'), '**正常加粗**的用例');
});

test('fixCjkBold: ** inside inline code and fenced code blocks is never touched (masked data / SQL literals)', () => {
  const src = '手机号 `138****5678`，SQL 里写 `**A：**建` 不当粗体。\n\n```sql\nUPDATE t SET p = \'****\';\n```\n\n正文 **A：**建';
  const out = fixCjkBold(src);
  assert.ok(out.includes('`138****5678`'), 'inline-code 138****5678 should be kept');
  assert.ok(out.includes('`**A：**建`'), '** inside inline code should not be rewritten');
  assert.ok(out.includes("UPDATE t SET p = '****';"), '**** inside the fence should be kept');
  assert.ok(out.includes('正文 <strong>A：</strong>建'), 'body outside the fence should be rewritten');
});

test('mapOutsideFences: fenced blocks pass through verbatim; fn applies only outside', () => {
  const src = 'a**x**\n```\nb**y**\n```\nc**z**';
  const out = mapOutsideFences(src, (s) => s.replace(/\*\*(.+?)\*\*/g, '[$1]'));
  assert.equal(out, 'a[x]\n```\nb**y**\n```\nc[z]');
});

// ==================== ② holdRawHtml / restoreRawHtml ====================

const MERPRESS_WITH_BLANK = `<!-- wp:merpress/mermaidjs -->
<div class="wp-block-merpress-mermaidjs diagram-source-mermaid"><pre class="mermaid">graph TD
    A[用户标签体系] --> A1[基础属性]

    A --> A2[行为属性]
</pre></div>
<!-- /wp:merpress/mermaidjs -->`;

test('holdRawHtml: pulls out the whole block and replaces it with a placeholder (MerPress comment block)', () => {
  const md = `前言\n\n${MERPRESS_WITH_BLANK}\n\n后置`;
  const { md: held, blocks } = holdRawHtml(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0], MERPRESS_WITH_BLANK);
  assert.ok(/XZRAWHOLD0XZZ/.test(held), 'should contain the placeholder');
  assert.ok(!held.includes('<pre class="mermaid">'), 'the raw block should not remain in the text to parse');
});

test('holdRawHtml: a bare MerPress block without comment wrappers is also extracted', () => {
  const bare = '<div class="wp-block-merpress-mermaidjs"><pre class="mermaid">graph TD\n  A-->B\n</pre></div>';
  const { blocks } = holdRawHtml(`前后\n\n${bare}`);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0], bare);
});

test('holdRawHtml: zero changes when there is no MerPress block', () => {
  const md = '# 标题\n\n普通段落 `code` **bold**';
  const { md: held, blocks } = holdRawHtml(md);
  assert.equal(held, md);
  assert.deepEqual(blocks, []);
});

test('restoreRawHtml: returns as-is with empty blocks', () => {
  const html = '<p>XZRAWHOLD0XZZ</p>';
  assert.equal(restoreRawHtml(html, []), html);
  assert.equal(restoreRawHtml(html, undefined), html);
});

// ==================== ③ end-to-end markdownToHtml ====================

test('markdownToHtml: a Mermaid block containing a blank line stays intact (CommonMark would truncate it pre-fix)', () => {
  const html = markdownToHtml(`前言段落。\n\n${MERPRESS_WITH_BLANK}\n\n后置段落。`);
  assert.ok(html.includes('<pre class="mermaid">'), 'the Mermaid container should be kept');
  assert.ok(html.includes('<!-- /wp:merpress/mermaidjs -->'), 'the block-end comment should be kept');
  assert.ok(
    /<pre class="mermaid">[\s\S]*A --> A2\[行为属性\][\s\S]*<\/pre>/.test(html),
    'nodes after the blank line should still be inside <pre>'
  );
  assert.ok(html.includes('<p>后置段落。</p>'), 'content after the block should render normally');
  assert.ok(!html.includes('XZRAWHOLD'), 'no placeholder should remain');
});

test('markdownToHtml: end-to-end fix of the CJK-bold defect, no literal ** remains', () => {
  const html = markdownToHtml('这个过程中，**并查集算法（Union-Find）**发挥着关键作用。');
  assert.ok(html.includes('<strong>并查集算法（Union-Find）</strong>'));
  assert.ok(!html.includes('**'), 'no literal ** should remain');
});

test('markdownToHtml: tables still render per GFM (regression guard)', () => {
  const html = markdownToHtml('| 分类 | 内容 |\n| --- | --- |\n| 基础属性 | 个人信息 |');
  assert.ok(html.includes('<table>') && html.includes('<th>分类</th>') && html.includes('<td>个人信息</td>'));
});

test('markdownToHtml: empty input is safe', () => {
  assert.equal(markdownToHtml(''), '');
  assert.equal(markdownToHtml(null), '');
  assert.equal(markdownToHtml(undefined), '');
});

// ==================== ④ composeBody (materialization at publish time, plan C) ====================

const GEO = {
  key_takeaways: ['要点一', '要点二'],
  qa_pairs: [
    { question: '问题一', answer: '纯文本答案' },
    { question: '问题二', answer: '<p>HTML 答案</p>' },
  ],
};

test('composeBody: takeaways land before the first body H2 (when the lead is a plain paragraph)', () => {
  const html = markdownToHtml('# 标题\n\n结论段直接给答案。\n\n## 第一节\n\n正文。');
  const out = composeBody(html, GEO);
  const iLead = out.indexOf('结论段直接给答案');
  const iTake = out.indexOf('<h2>关键要点</h2>');
  const iSec1 = out.indexOf('第一节');
  assert.ok(iLead > -1 && iTake > -1 && iSec1 > -1);
  assert.ok(iLead < iTake, 'takeaways should follow the lead paragraph');
  assert.ok(iTake < iSec1, 'takeaways should precede the first body H2');
});

test('composeBody: when the first section is a "导语" H2, takeaways defer to after the lead section', () => {
  const html = markdownToHtml('# 标题\n\n## 导语\n\n导语内容。\n\n## 第一节\n\n正文。');
  const out = composeBody(html, GEO);
  const iLeadSec = out.indexOf('导语内容');
  const iTake = out.indexOf('<h2>关键要点</h2>');
  const iSec1 = out.indexOf('第一节');
  assert.ok(iLeadSec < iTake, 'takeaways should follow the lead section');
  assert.ok(iTake < iSec1, 'takeaways should precede the second section');
});

test('composeBody: FAQ lands before "关于Tengence" (end of body, before the CTA)', () => {
  const html = markdownToHtml('# 标题\n\n## 第一节\n\n正文。\n\n## 关于Tengence\n\n品牌段落。\n\n**立即行动**\n[CTA](https://example.com)');
  const out = composeBody(html, GEO);
  const iFaq = out.search(/<h2>[^<]*常见问题<\/h2>/);
  const iAbout = out.indexOf('关于Tengence');
  const iCta = out.indexOf('立即行动');
  assert.ok(iFaq > -1);
  assert.ok(iFaq < iAbout, 'FAQ should precede "关于Tengence"');
  assert.ok(iFaq < iCta, 'FAQ should precede the CTA');
});

test('composeBody: a placeholder comment takes precedence over the default landing spot', () => {
  const md = '# 标题\n\n## 导语\n\n导语内容。\n\n<!-- tengence-faq -->\n\n## 第一节\n\n正文。\n\n## 关于Tengence\n\n品牌。';
  const out = composeBody(markdownToHtml(md), GEO);
  const iFaq = out.search(/<h2>[^<]*常见问题<\/h2>/);
  const iSec1 = out.indexOf('第一节');
  assert.ok(iFaq > -1 && iFaq < iSec1, 'FAQ should land at the placeholder comment (before the first section)');
});

test('composeBody: FAQ / takeaways are pure markdown sections (h2/ul/li + FAQ blockquotes), no custom class, no inline style, no <details>', () => {
  const out = composeBody(markdownToHtml('# 标题\n\n## 第一节\n\n正文。'), GEO);
  assert.ok(out.includes('<h2>关键要点</h2>'));
  assert.ok(out.includes('<ul>\n<li>要点一</li>'));
  assert.ok(out.includes('<li>要点二</li>'));
  assert.ok(/<h2>[^<]*常见问题<\/h2>/.test(out));
  assert.ok(out.includes('<p><strong>问：问题一</strong></p>\n<p>答：纯文本答案</p>'), 'plain-text answers use 「问：/答：」 paragraphs with a bold question');
  assert.ok(out.includes('<p><strong>问：问题二</strong></p>\n<p>答：HTML 答案</p>'), 'HTML answers merge into 「答：」 and are kept verbatim');
  // form convention (2026-09-16): each Q&A is wrapped in a <blockquote>, distinct
  // from body paragraphs and the lead summary
  assert.ok(out.includes('<blockquote>\n<p><strong>问：问题一</strong></p>'), 'each FAQ Q&A should be wrapped in a <blockquote>');
  assert.strictEqual((out.match(/<blockquote>/g) || []).length, GEO.qa_pairs.length, 'the number of FAQ blockquotes should equal the qa_pairs count');
  assert.ok(!/<h3>问题一<\/h3>/.test(out), 'FAQ questions no longer use h3');
  assert.ok(!/<i>|<em>/.test(out), 'FAQ must not use italics (i/em)');
  // red line: no plugin custom class / inline style / collapsible tags (rendering
  // must be fully owned by the theme)
  assert.ok(!/class="tengence/i.test(out), 'no tengence-* custom class');
  assert.ok(!/style="/i.test(out), 'no inline style');
  assert.ok(!/<details|<summary/i.test(out), 'no <details>/<summary> collapsibles');
});

test('composeBody: plain-text answers are escaped; questions/takeaways are escaped', () => {
  const out = composeBody(markdownToHtml('# 标题\n\n## 第一节\n\n正文。'), {
    key_takeaways: ['a < b & c'],
    qa_pairs: [{ question: '1 < 2 ?', answer: '是 & 否' }],
  });
  assert.ok(out.includes('a &lt; b &amp; c'));
  assert.ok(out.includes('1 &lt; 2 ?'));
  assert.ok(out.includes('<p>答：是 &amp; 否</p>'));
});

test('composeBody: idempotent — re-publishing never doubles the blocks', () => {
  const html = markdownToHtml('# 标题\n\n## 第一节\n\n正文。');
  const once = composeBody(html, GEO);
  const twice = composeBody(once, GEO);
  assert.equal(twice, once, 're-materializing a body that already contains the blocks should be byte-identical');
  assert.equal((once.match(/<h2>关键要点<\/h2>/g) || []).length, 1);
  assert.equal((once.match(/<h2>[^<]*常见问题<\/h2>/g) || []).length, 1);
});

test('composeBody: when the body already has a handwritten "常见问题" section, no meta FAQ is injected (anti-duplication for legacy dual-write)', () => {
  const html = markdownToHtml('# 标题\n\n## 第一节\n\n正文。\n\n## 常见问题\n\n**Q1：手写问题**\nA：手写答案。');
  const out = composeBody(html, GEO);
  assert.ok(out.includes('手写问题'), 'the handwritten FAQ should be kept');
  assert.ok(!out.includes('问题一'), 'meta "问题一" should not be injected (anti-duplication)');
  assert.ok(out.includes('<h2>关键要点</h2>'), 'takeaways should still be injected');
  assert.equal((out.match(/<h2>[^<]*常见问题<\/h2>/g) || []).length, 1, 'only one FAQ section should remain');
});

test('composeBody: no geo / empty arrays → returns as-is', () => {
  const html = markdownToHtml('# 标题\n\n## 第一节\n\n正文。');
  assert.equal(composeBody(html), html);
  assert.equal(composeBody(html, {}), html);
  assert.equal(composeBody(html, { key_takeaways: [], qa_pairs: [] }), html);
  assert.equal(composeBody(''), '');
});

test('composeBody: without "关于Tengence", FAQ appends to the end of the body (pure markdown section)', () => {
  const html = markdownToHtml('# 标题\n\n## 第一节\n\n正文。');
  const out = composeBody(html, GEO);
  const iBody = out.indexOf('正文。');
  const iFaq = out.search(/<h2>[^<]*常见问题<\/h2>/);
  assert.ok(iFaq > iBody, 'FAQ should append after the body');
});

// ==================== ⑤ parseGeoBlocks / syncGeoFromMarkdown (md is authoritative) ====================
// Decided 2026-09-16: the summary / key-takeaways / FAQ blocks are written directly
// into the Markdown; at publish time they're reverse-parsed into
// geo.ai_summary / geo.key_takeaways / geo.qa_pairs and written back to the DB and
// the WP meta. This group pins "whatever md wrote is whatever meta is".

const MD_FULL = [
  '# 标题',
  '',
  '> **摘要**：一句话给出全文结论，不设悬念。',
  '',
  '导语段。',
  '',
  '## 关键要点',
  '',
  '- 要点一：先做诊断再谈优化。',
  '- 要点二：结构决定可被引用率。',
  '',
  '---',
  '',
  '## 一、正文节',
  '',
  '正文内容。',
  '',
  '## 常见问题',
  '',
  '> **问：GEO 和 SEO 的区别是什么？**',
  '>',
  '> 答：SEO 面向排名，GEO 面向被 AI 引用。',
  '',
  '> **问：多久能看到效果？**',
  '>',
  '> 答：通常 8 到 12 周。',
  '',
  '## 关于Tengence',
  '',
  'Tengence是 AI 时代的企业增长引擎。',
  '',
].join('\n');

test('parseGeoBlocks: parses the summary / takeaways / FAQ blocks', () => {
  const r = parseGeoBlocks(MD_FULL);
  assert.equal(r.summary, '一句话给出全文结论，不设悬念。');
  assert.deepEqual(r.takeaways, ['要点一：先做诊断再谈优化。', '要点二：结构决定可被引用率。']);
  assert.equal(r.faq.length, 2);
  assert.equal(r.faq[0].question, 'GEO 和 SEO 的区别是什么？');
  assert.equal(r.faq[0].answer, '<p>SEO 面向排名，GEO 面向被 AI 引用。</p>', 'the 答： prefix should be stripped (renderFaq re-adds it at render time)');
  assert.equal(r.faq[1].question, '多久能看到效果？');
  assert.equal(r.faq[1].answer, '<p>通常 8 到 12 周。</p>');
});

test('parseGeoBlocks: compatible with legacy numbered headings (八、常见问题) and the (FAQ) suffix', () => {
  const md = '## 八、常见问题（FAQ）\n\n> **问：问题？**\n>\n> 答：答案。\n';
  const r = parseGeoBlocks(md);
  assert.equal(r.faq.length, 1);
  assert.equal(r.faq[0].question, '问题？');
});

test('parseGeoBlocks: no GEO blocks in the body → empty result (never invents)', () => {
  const r = parseGeoBlocks('# 标题\n\n## 一、正文\n\n正文内容。\n');
  assert.deepEqual(r, { summary: '', takeaways: [], faq: [], citations: [] });
});

test('syncGeoFromMarkdown: md is authoritative, overwriting old values in meta', () => {
  const old = {
    ai_summary: '旧摘要',
    key_takeaways: ['旧要点'],
    qa_pairs: [{ question: '旧问题', answer: '<p>旧答案</p>' }],
  };
  const r = syncGeoFromMarkdown(MD_FULL, old);
  assert.equal(r.geo.ai_summary, '一句话给出全文结论，不设悬念。');
  assert.deepEqual(r.geo.key_takeaways, ['要点一：先做诊断再谈优化。', '要点二：结构决定可被引用率。']);
  assert.equal(r.geo.qa_pairs.length, 2);
  assert.deepEqual(r.changed, ['key_takeaways(2 items)', 'qa_pairs(2 pairs)', 'ai_summary']);
});

test('syncGeoFromMarkdown: blocks md didn\'t write keep the meta originals (data never wiped)', () => {
  const old = { key_takeaways: ['仅 meta 有的要点'], qa_pairs: [] };
  const r = syncGeoFromMarkdown('# 标题\n\n正文。\n', old);
  assert.deepEqual(r.geo, old);
  assert.deepEqual(r.changed, []);
});

test('syncGeoFromMarkdown + buildPostHtml: when md already contains both blocks, they are not re-injected (no duplication)', () => {
  const r = syncGeoFromMarkdown(MD_FULL, {});
  const html = buildPostHtml(MD_FULL, r.geo);
  assert.equal((html.match(/<h2>关键要点<\/h2>/g) || []).length, 1);
  assert.equal((html.match(/<h2>[^<]*常见问题<\/h2>/g) || []).length, 1);
  assert.ok(!html.includes('旧要点'), 'old meta values should not appear');
});

test('syncGeoFromMarkdown: idempotent — a second sync produces no changes', () => {
  const first = syncGeoFromMarkdown(MD_FULL, {});
  const second = syncGeoFromMarkdown(MD_FULL, first.geo);
  assert.deepEqual(second.changed, [], 'syncing again after syncing should produce no changes');
  assert.deepEqual(second.geo, first.geo);
});

// ==================== ⑤.5 parseFrontMatter (front matter = seo + featured_image) ====================
// Decided 2026-09-17: front matter only holds meta the body doesn't render (the four
// seo fields + featured_image); the summary/takeaways/FAQ/data-sources are body
// content, and the meta copy is reverse-parsed by parseGeoBlocks, not front matter.

const FM_FULL = [
  '---',
  'seo:',
  '  title: "SEO 标题"',
  '  keywords: ["关键词一", "关键词二"]',
  '  focus_keyword: "聚焦词"',
  '  meta_description: "90–158 字符的 meta 描述"',
  'featured_image: "https://www.tengence.com/blog/static/images/industry-insights/x/cover.jpg"',
  '---',
  '# 标题',
  '',
  '正文。',
].join('\n');

test('parseFrontMatter: parses the four seo fields + featured_image, body stripped correctly', () => {
  const r = parseFrontMatter(FM_FULL);
  assert.equal(r.data.seo.title, 'SEO 标题');
  assert.deepEqual(r.data.seo.keywords, ['关键词一', '关键词二']);
  assert.equal(r.data.seo.focus_keyword, '聚焦词');
  assert.equal(r.data.seo.meta_description, '90–158 字符的 meta 描述');
  assert.equal(r.data.featured_image, 'https://www.tengence.com/blog/static/images/industry-insights/x/cover.jpg');
  assert.equal(r.content, '# 标题\n\n正文。');
});

test('parseFrontMatter: no front matter in the body → data=null, content verbatim', () => {
  const r = parseFrontMatter('# 标题\n\n正文。');
  assert.equal(r.data, null);
  assert.equal(r.content, '# 标题\n\n正文。');
});

test('parseFrontMatter: empty input is safe, no throw', () => {
  assert.deepEqual(parseFrontMatter(''), { data: null, content: '' });
  assert.deepEqual(parseFrontMatter(null), { data: null, content: '' });
});

test('parseFrontMatter: YAML parse failure is treated as no front matter (body kept and free of the front-matter raw text)', () => {
  const r = parseFrontMatter('---\nseo: [broken\n---\n# 标题\n\n正文。');
  assert.equal(r.data, null);
  assert.ok(r.content.includes('# 标题'), 'the body must be fully kept');
  assert.ok(!r.content.includes('seo: [broken'), 'the body must not include the front-matter raw text (word-count basis)');
});

test('parseFrontMatter: a --- divider in the body doesn\'t affect front-matter parsing (takes the first closed block)', () => {
  const r = parseFrontMatter('---\nseo:\n  title: "T"\n---\n# 标题\n\n## 一、正文\n\n---\n\n后续。');
  assert.equal(r.data.seo.title, 'T');
  assert.ok(r.content.includes('## 一、正文'));
});

// ==================== ⑤.6 citations reverse-parse (数据来源 → geo.citations) ====================

const MD_CITATIONS = [
  '# 标题',
  '',
  '正文。',
  '',
  '## 数据来源',
  '',
  '1. **[腾讯新闻](https://new.qq.com/rain/a/20260901A00000)**：报告原文',
  '2. [艾瑞咨询](https://www.iresearch.com.cn/report/2026) —— 数据口径说明',
  '3. <a href="https://www.gartner.com/en/reports/2026">Gartner 报告</a>：英文原文',
  '',
  '## 关于Tengence',
  '',
  '品牌段。',
].join('\n');

test('parseGeoBlocks: the H2 "数据来源" reverse-parses citations (Markdown + HTML notations)', () => {
  const r = parseGeoBlocks(MD_CITATIONS);
  assert.equal(r.citations.length, 3);
  assert.deepEqual(r.citations[0], { title: '腾讯新闻', url: 'https://new.qq.com/rain/a/20260901A00000' });
  assert.deepEqual(r.citations[1], { title: '艾瑞咨询', url: 'https://www.iresearch.com.cn/report/2026' });
  assert.deepEqual(r.citations[2], { title: 'Gartner 报告', url: 'https://www.gartner.com/en/reports/2026' });
});

test('parseGeoBlocks: the legacy bold form "**数据来源**" also reverse-parses', () => {
  const md = '## 一、正文\n\n**数据来源**\n\n1. [来源甲](https://example.com/a)\n- [来源乙](https://example.com/b)';
  const r = parseGeoBlocks(md);
  assert.deepEqual(r.citations, [
    { title: '来源甲', url: 'https://example.com/a' },
    { title: '来源乙', url: 'https://example.com/b' },
  ]);
});

test('parseGeoBlocks: citation items without a link don\'t enter citations (the original text is covered by check-article channel 2)', () => {
  const r = parseGeoBlocks('## 数据来源\n\n1. 纯文本来源说明（无链接）\n');
  assert.deepEqual(r.citations, []);
});

test('extractCitationFromItem: Markdown and HTML notations, no link → null', () => {
  assert.deepEqual(extractCitationFromItem('**[腾讯新闻](https://new.qq.com/a)**：说明'), {
    title: '腾讯新闻',
    url: 'https://new.qq.com/a',
  });
  assert.deepEqual(extractCitationFromItem('<a href="https://x.com/r">Gartner 报告</a>：说明'), {
    title: 'Gartner 报告',
    url: 'https://x.com/r',
  });
  assert.equal(extractCitationFromItem('纯文本来源说明'), null);
  assert.equal(extractCitationFromItem('[无链接文本]'), null);
});

test('syncGeoFromMarkdown: the body "数据来源" overwrites meta.citations (md authoritative)', () => {
  const old = { citations: [{ title: '旧来源', url: 'https://old.example.com' }] };
  const r = syncGeoFromMarkdown(MD_CITATIONS, old);
  assert.equal(r.geo.citations.length, 3);
  assert.deepEqual(r.changed, ['citations(3 items)']);
});

test('syncGeoFromMarkdown: no "数据来源" in the body keeps meta.citations (data never wiped)', () => {
  const old = { citations: [{ title: '仅 meta 的来源', url: 'https://old.example.com' }] };
  const r = syncGeoFromMarkdown('# 标题\n\n正文。\n', old);
  assert.deepEqual(r.geo, old);
  assert.deepEqual(r.changed, []);
});

// ==================== ③ removeImageByUrl (leading image → featured image, then removed from the body) ====================
//
// Regression guard (2026-09-16): the old caller replaced `<img src="${url}"` (up to
// the closing src quote, without ` alt="…"` and the trailing `>`) with an empty
// string, leaving a stray ` alt="…">` that markdown escaped — the body showed
// visible mojibake `<p> alt=&quot;Network technology&quot;&gt;</p>` (WP 289/294/299
// confirmed).

const IMG_URL = 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=1200&q=85';

test('removeImageByUrl: HTML notation must delete the whole tag without leaving an alt tail', () => {
  const md = `# 标题\n\n上文。\n\n---\n\n<img src="${IMG_URL}" alt="Network technology">\n\n### 子节\n\n正文。\n`;
  const out = removeImageByUrl(md, { url: IMG_URL, alt: 'Network technology', format: 'html' });

  assert.ok(!out.includes('<img'), 'the whole <img> tag should be deleted');
  assert.ok(!out.includes('alt='), 'no alt= fragment may remain (key regression point)');
  assert.ok(!out.includes('Network technology'), 'no alt text may remain');
  assert.ok(out.includes('### 子节') && out.includes('上文。'), 'the rest of the body must stay verbatim');

  // end-to-end: the leftover used to become visible mojibake in HTML; this pins
  // that the form no longer exists after conversion
  const html = markdownToHtml(out);
  assert.ok(!/alt=&quot;/.test(html), 'no alt=&quot; mojibake after conversion');
  assert.ok(!/<p>\s*alt=/.test(html), 'no <p> alt=… fragment after conversion');
});

test('removeImageByUrl: markdown notation deletes the whole ![alt](url) block', () => {
  const md = `# 标题\n\n![Network technology](${IMG_URL})\n\n正文。\n`;
  const out = removeImageByUrl(md, { url: IMG_URL, alt: 'Network technology', format: 'markdown' });
  assert.ok(!out.includes('!['), 'the whole markdown image should be deleted');
  assert.ok(!out.includes('unsplash.com'), 'the URL should not remain');
  assert.ok(out.includes('正文。'));
});

test('removeImageByUrl: URLs with regex metacharacters like ? & = + still match exactly (and don\'t delete other images on the page)', () => {
  const other = 'https://images.unsplash.com/photo-1519389950473-47ba0277781c?auto=format&fit=crop&w=1200&q=85';
  const md = `<img src="${IMG_URL}" alt="A">\n\n<img src="${other}" alt="B">\n`;
  const out = removeImageByUrl(md, { url: IMG_URL, alt: 'A', format: 'html' });
  assert.ok(!out.includes('alt="A"'), 'the target image should be deleted');
  assert.ok(out.includes(`src="${other}"`) && out.includes('alt="B"'), 'other images must be kept');
});

test('removeImageByUrl: empty URL returns as-is (guards against empty values clearing the body)', () => {
  const md = '<img src="https://x/y.jpg" alt="A">';
  assert.equal(removeImageByUrl(md, { url: '' }), md);
  assert.equal(removeImageByUrl(md, {}), md);
});
