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
  mermaidFencesToMerpress,
  merpressBlockHtml,
  MERPRESS_BLOCK_OPEN,
  MERPRESS_BLOCK_CLOSE,
  fixMermaidLabelQuotes,
  mermaidBareParenIssues,
  geoBlockLabels,
  isTakeawaysHeading,
  isFaqHeading,
  h2List,
  removeImageByUrl,
  stripInlineMarkdown,
  // 2026-10-06: internal-link language prefix + CTA layout helpers
  langToPrefix,
  normalizeInternalArticleLinks,
  normalizeCtaBlock,
  articlePrefixIssues,
  ctaPipeIssues,
  normalizeArticleUrlForCompare,
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

// ==================== ④b language-aware materialization (2026-10-06 zh-hant duplicate incident) ====================
// Live symptom: /zh-hant/blog/article/<slug>/ showed TWO "key takeaways" sections —
// the first one Simplified with its `**` markdown printed literally — and a second
// Simplified FAQ appended at the very end of the body (after the CTA).
// Root cause: every idempotency check in composeBody, the landing anchors in
// insertFaq and the copy emitted by renderTakeaways / renderFaq were Simplified-only
// (or Simplified + English), so a Traditional body matched nothing and the fallback
// added a second, Simplified copy of both blocks.
// These tests pin: (a) Traditional bodies are recognised as already carrying the
// blocks, (b) when the fallback does run it writes the article's own language, and
// (c) takeaway items render their inline Markdown exactly like the visible body.

const ZH_HK_MD = [
  '# 標題',
  '',
  '> **摘要**：一句摘要。',
  '',
  '導言段落。',
  '',
  '## 關鍵要點',
  '',
  '- **GEO 是新渠道**：說明一。',
  '- **CITE 四槓桿**：說明二。',
  '',
  '## 一、正文節',
  '',
  '正文。',
  '',
  '## 常見問題',
  '',
  '> **問：問題一？**',
  '>',
  '> 答：答案一。',
  '',
  '---',
  '',
  '## 關於通智雲',
  '',
  '品牌段落。',
  '',
  '## 相關閱讀',
  '',
  '- [連結](https://example.com/a)',
  '',
  '## 資料來源',
  '',
  '1. [來源](https://example.com/b)：說明。',
  '',
  '## 立即行動',
  '',
  '[免費試用](https://console.example.com/login)',
].join('\n');

test('buildPostHtml(zh-hant): a Traditional body is NOT injected a second time (no Simplified duplicate)', () => {
  const geo = syncGeoFromMarkdown(ZH_HK_MD, {}).geo;
  const html = buildPostHtml(ZH_HK_MD, geo, 'zh-hant');
  const heads = h2List(html);
  assert.equal(heads.filter((h) => isTakeawaysHeading(h.text)).length, 1, 'exactly one takeaways block');
  assert.equal(heads.filter((h) => isFaqHeading(h.text)).length, 1, 'exactly one FAQ block');
  assert.ok(!html.includes('关键要点'), 'no Simplified takeaways heading');
  assert.ok(!html.includes('常见问题'), 'no Simplified FAQ heading');
  assert.equal((html.match(/\*\*/g) || []).length, 0, 'no unrendered ** left in the HTML');
});

test('buildPostHtml(zh-hant): the fallback writes Traditional copy and lands before 關於通智雲', () => {
  const geo = {
    key_takeaways: ['**要點**：說明。'],
    qa_pairs: [{ question: '問題？', answer: '答案。' }],
  };
  const md = [
    '# 標題', '', '導言。', '',
    '## 一、節', '', '正文。', '',
    '## 關於通智雲', '', '品牌。', '',
    '## 相關閱讀', '', '- [x](https://example.com)', '',
    '## 資料來源', '', '1. [s](https://example.com/s)：說明。', '',
    '## 立即行動', '', '[CTA](https://example.com/cta)',
  ].join('\n');
  const html = buildPostHtml(md, geo, 'zh-hant');
  const iFaq = html.indexOf('<h2>常見問題</h2>');
  const iTake = html.indexOf('<h2>關鍵要點</h2>');
  const iAbout = html.indexOf('關於通智雲');
  const iCta = html.indexOf('立即行動');
  assert.ok(iTake > -1 && iTake < html.indexOf('一、節'), 'takeaways precede the first body H2');
  assert.ok(iFaq > -1, 'FAQ block is materialized');
  assert.ok(iFaq < iAbout, 'FAQ precedes 關於通智雲');
  assert.ok(iFaq < iCta, 'FAQ precedes the CTA (regression: it used to append after it)');
  assert.ok(html.includes('<p><strong>問：問題？</strong></p>'), 'Traditional "問：" prefix');
  assert.ok(html.includes('<p>答：答案。</p>'), 'Traditional "答：" prefix');
  assert.ok(
    html.includes('<li><strong>要點</strong>：說明。</li>'),
    'takeaway items render inline Markdown bold (was printed as literal ** before)'
  );
  assert.equal((html.match(/\*\*/g) || []).length, 0, 'no literal ** anywhere');
});

test('buildPostHtml(en): the fallback copy is English, never Simplified Chinese', () => {
  const geo = {
    key_takeaways: ['**Point** one.'],
    qa_pairs: [{ question: 'Why?', answer: 'Because.' }],
  };
  const md = [
    '# Title', '', 'Lead.', '',
    '## 1. Section', '', 'Body.', '',
    '## About TENGENCE Cloud', '', 'Brand.', '',
    '## Get Started', '', '[CTA](https://example.com/cta)',
  ].join('\n');
  const html = buildPostHtml(md, geo, 'en');
  assert.ok(html.includes('<h2>Key Takeaways</h2>'));
  assert.ok(html.includes('<h2>FAQ</h2>'));
  assert.ok(html.includes('<p><strong>Q: Why?</strong></p>'));
  assert.ok(html.includes('<p>A: Because.</p>'));
  assert.ok(!html.includes('关键要点') && !html.includes('常见问题'), 'no Simplified copy on an English page');
  assert.ok(html.indexOf('<h2>FAQ</h2>') < html.indexOf('About TENGENCE Cloud'), 'FAQ lands before "About"');
});

test('buildPostHtml(zh-hans): omitted lang is unchanged legacy behaviour', () => {
  const geo = { key_takeaways: ['要点一'], qa_pairs: [{ question: '问题一', answer: '答案一' }] };
  const md = '# 标题\n\n导言。\n\n## 第一节\n\n正文。';
  const html = buildPostHtml(md, geo);
  assert.ok(html.includes('<h2>关键要点</h2>'));
  assert.ok(html.includes('<h2>常见问题</h2>'));
  assert.ok(html.includes('<p><strong>问：问题一</strong></p>'));
  assert.equal(html, buildPostHtml(md, geo, 'zh-hans'), 'explicit zh-hans === omitted lang');
});

test('composeBody(zh-hant): idempotent — the Traditional blocks are never doubled', () => {
  const geo = syncGeoFromMarkdown(ZH_HK_MD, {}).geo;
  const once = buildPostHtml(ZH_HK_MD, geo, 'zh-hant');
  const twice = composeBody(once, geo, 'zh-hant');
  assert.equal(twice, once, 're-running the fallback on a Traditional body is byte-identical');
});

test('composeBody: numbered / 解答-style FAQ headings also suppress injection', () => {
  const geo = { key_takeaways: ['要点'], qa_pairs: [{ question: 'q', answer: 'a' }] };
  for (const heading of ['## 五、常見問題', '## 常見問題解答', '## 常见问题（FAQ）']) {
    const out = composeBody(
      markdownToHtml(`# 標題\n\n## 第一節\n\n正文。\n\n${heading}\n\n手寫內容。`),
      geo,
      'zh-hant'
    );
    assert.ok(out.includes('手寫內容'), 'the handwritten section survives');
    assert.equal(
      (out.match(/<h2>[^<]*(常見問題|常见问题)[^<]*<\/h2>/g) || []).length,
      1,
      `exactly one FAQ section for "${heading}"`
    );
  }
});

test('geoBlockLabels: language resolution (Traditional / English / fallback)', () => {
  assert.equal(geoBlockLabels('zh-hant').takeaways, '關鍵要點');
  assert.equal(geoBlockLabels('zh-hant').faq, '常見問題');
  assert.equal(geoBlockLabels('en').takeaways, 'Key Takeaways');
  assert.equal(geoBlockLabels('en').faq, 'FAQ');
  assert.equal(geoBlockLabels(undefined).takeaways, '关键要点');
  assert.equal(geoBlockLabels('zh-CN').takeaways, '关键要点');
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
  assert.equal(r.faq[0].answer, 'SEO 面向排名，GEO 面向被 AI 引用。', 'the 答： prefix is stripped (renderFaq re-adds it) and the answer is plain text (no <p>)');
  assert.equal(r.faq[1].question, '多久能看到效果？');
  assert.equal(r.faq[1].answer, '通常 8 到 12 周。');
});

// ==================== ④.5 GEO metadata must be plain text ====================
// Decided 2026-10-06: geo_key_takeaways / geo_qa_pairs / geo_ai_summary are emitted
// verbatim by the plugin as JSON-LD (ItemList.name, FAQPage.acceptedAnswer.text) and
// as the meta-description fallback. Anything Markdown-shaped there leaks to search
// engines / AI answer engines as literal characters, so extraction normalizes it.

test('stripInlineMarkdown: drops Markdown markers and tags, keeps the text', () => {
  assert.equal(stripInlineMarkdown('**底座共用、策略分离**：数据共用。'), '底座共用、策略分离：数据共用。');
  assert.equal(stripInlineMarkdown('见[技术指南](https://example.com/a)一节'), '见技术指南一节');
  assert.equal(stripInlineMarkdown('保留 `JSON-LD` 与 __加粗__'), '保留 JSON-LD 与 加粗');
  assert.equal(stripInlineMarkdown('<p>第一段</p><p>第二段</p>'), '第一段\n\n第二段');
  assert.equal(stripInlineMarkdown('a < b & c'), 'a < b & c', 'a bare "<" is not a tag');
  assert.equal(stripInlineMarkdown('增长率 <5%，>10%'), '增长率 <5%，>10%', 'a tag regex anchored on a letter must not eat "<5%"');
  // every remaining inline form (defect found 2026-10-06: 5 rows still carried `` ` ``)
  assert.equal(stripInlineMarkdown('写 `DigitalSourceType` = `TrainedAlgorithmicMedia`'), '写 DigitalSourceType = TrainedAlgorithmicMedia');
  assert.equal(stripInlineMarkdown('## 小节标题'), '小节标题');
  assert.equal(stripInlineMarkdown('#1 原因'), '#1 原因', 'no space after the hash → not a heading');
  assert.equal(stripInlineMarkdown('- 第一条\n- 第二条'), '第一条\n第二条');
  assert.equal(stripInlineMarkdown('正文\n\n---\n\n后面'), '正文\n\n后面');
});

test('parseGeoBlocks: takeaways / answers / summary come out as plain text', () => {
  const md = [
    '> **摘要**：见[技术指南](https://example.com/a)的 `crawl` 段。',
    '',
    '## 关键要点',
    '',
    '- **结论先行**：先做诊断，再谈优化。',
    '- 引用 [Google 文档](https://developers.google.com/x) 并保留 `JSON-LD`。',
    '',
    '## 常见问题',
    '',
    '> **问：多久见效？**',
    '>',
    '> 答：通常 **8–12 周**。',
    '>',
    '> 第二段带 <strong>标签</strong>。',
    '',
  ].join('\n');
  const r = parseGeoBlocks(md);
  assert.equal(r.summary, '见技术指南的 crawl 段。');
  assert.deepEqual(r.takeaways, ['结论先行：先做诊断，再谈优化。', '引用 Google 文档 并保留 JSON-LD。']);
  assert.equal(r.faq[0].question, '多久见效？');
  assert.equal(r.faq[0].answer, '通常 8–12 周。\n\n第二段带 标签。', 'paragraphs are preserved as plain text, not concatenated');
  assert.equal(JSON.stringify(r).includes('**'), false);
  assert.equal(/<\/?(?:p|strong)>/.test(JSON.stringify(r)), false);
});

test('buildPostHtml: plain-text metadata in the fallback block still renders as bullets, and the body keeps its own bold', () => {
  // body without a takeaways block → the block is materialized from the metadata
  const md = '# 标题\n\n## 一、正文\n\n正文。\n';
  const geo = syncGeoFromMarkdown(md, { key_takeaways: [], qa_pairs: [] }).geo;
  geo.key_takeaways = ['**结论**：先做诊断。'];
  const html = buildPostHtml(md, geo, 'zh-hans');
  assert.ok(html.includes('<h2>关键要点</h2>'));
  assert.ok(html.includes('<li>'), 'takeaways fallback still renders a list');
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

// ==================== ⑨ mermaidFencesToMerpress (2026-10-06) ====================
//
// Live problem: whether a Mermaid diagram renders depends on TWO gates, and the
// first implementation only satisfied one of them.
//   1. the class — both front ends key off `pre.mermaid` /
//      `.wp-block-merpress-mermaidjs`; `<pre><code class="language-mermaid">` falls
//      into the plain code-block branch and leaves raw source on the page;
//   2. the Gutenberg block delimiter — the `merpress/merpress` plugin's block.json
//      declares `script` / `viewScript`, and WordPress enqueues those only for
//      blocks that are actually rendered, i.e. `has_block('merpress/mermaidjs')`
//      must be true. No delimiter ⇒ nothing ever calls `mermaid.run()`.
//
// ★ The first diagnosis (same day) claimed the class was the whole story and that
// zh-hans post 570 "renders" while its zh-hant / en translations (1658 / 1652) do
// not. Refuted live: post 570 had `anyBlock = 0` too. All six affected posts
// (523/570/1587/1593/1652/1658) enqueued no mermaid asset until the delimiter was
// added. The class alone never rendered anything.

const MERMAID_FENCE_MD = [
  '这个过程中，**并查集算法**发挥着关键作用。',
  '',
  '```mermaid',
  'graph TD',
  '    A[自然人A] --> B[节点1]',
  '    B --> C["标签 <含尖括号> & 符号"]',
  '```',
  '',
  '### 1.3 核心概念',
  '',
  '正文继续。',
].join('\n');

test('mermaidFencesToMerpress: ```mermaid fence → MerPress block (with diagram-source-mermaid)', () => {
  const out = mermaidFencesToMerpress(MERMAID_FENCE_MD);
  assert.ok(
    out.includes('<div class="wp-block-merpress-mermaidjs diagram-source-mermaid">'),
    'should produce the MerPress block container'
  );
  assert.ok(out.includes('<pre class="mermaid">'), 'must be pre.mermaid — the only form the front end accepts');
  assert.ok(!out.includes('language-mermaid'), 'no plain code-block class may remain');
  assert.ok(!out.includes('```mermaid'), 'the fence should be fully consumed');
});

test('mermaidFencesToMerpress: emits the Gutenberg block delimiter (the plugin asset gate)', () => {
  const out = mermaidFencesToMerpress(MERMAID_FENCE_MD);
  assert.ok(out.includes(MERPRESS_BLOCK_OPEN), 'missing <!-- wp:merpress/mermaidjs --> — has_block() stays false');
  assert.ok(out.includes(MERPRESS_BLOCK_CLOSE), 'missing the closing delimiter');
  assert.equal(
    (out.match(/<!--\s*wp:merpress\/mermaidjs\s*-->/g) || []).length,
    (out.match(/<!--\s*\/wp:merpress\/mermaidjs\s*-->/g) || []).length,
    'delimiters must be balanced'
  );
  // the delimiter must sit on its own line, outside the div — WP's block parser
  // and wpautop both key off that
  assert.ok(
    /\n<!-- wp:merpress\/mermaidjs -->\n<div class="wp-block-merpress-mermaidjs diagram-source-mermaid">/.test(out),
    'the open delimiter must immediately precede the div on its own line'
  );
  assert.ok(
    /<\/pre><\/div>\n<!-- \/wp:merpress\/mermaidjs -->/.test(out),
    'the close delimiter must follow the div on its own line'
  );
  // and the whole thing must still be guarded by RAW_HTML_BLOCKS[0]
  assert.ok(holdRawHtml(out).blocks.length === 1, 'the delimited block must be protected as one raw-HTML block');
});

test('merpressBlockHtml: no JSON attributes on the delimiter (all attrs sourced or default)', () => {
  const html = merpressBlockHtml('graph TD\nA-->B');
  assert.ok(html.startsWith(MERPRESS_BLOCK_OPEN), 'must open with the bare delimiter');
  assert.ok(!/<!-- wp:merpress\/mermaidjs \{/.test(html), 'no JSON payload should be serialized');
  assert.ok(html.endsWith(MERPRESS_BLOCK_CLOSE));
});

test('mermaidFencesToMerpress: diagram source is escaped (< & " cannot break the HTML structure)', () => {
  const out = mermaidFencesToMerpress(MERMAID_FENCE_MD);
  assert.ok(out.includes('&lt;含尖括号&gt;'), '< and > in the source must be escaped');
  assert.ok(out.includes('&amp;'), '& in the source must be escaped');
  const inner = out.slice(out.indexOf('<pre class="mermaid">'), out.indexOf('</pre>'));
  assert.ok(!inner.includes('<含尖括号>'), 'no unescaped angle-bracket text');
});

test('mermaidFencesToMerpress: paragraphs outside the fence and other code blocks are untouched', () => {
  const out = mermaidFencesToMerpress(MERMAID_FENCE_MD);
  assert.ok(out.includes('这个过程中，**并查集算法**发挥着关键作用。'), 'markdown outside the fence is kept verbatim');
  assert.ok(out.includes('### 1.3 核心概念'), 'following headings are kept verbatim');

  const other = ['```sql', 'SELECT 1;', '```'].join('\n');
  assert.equal(mermaidFencesToMerpress(other), other, 'non-mermaid fences must stay byte-identical');
});

test('mermaidFencesToMerpress: idempotent (re-running on converted content is a no-op)', () => {
  const once = mermaidFencesToMerpress(MERMAID_FENCE_MD);
  assert.equal(mermaidFencesToMerpress(once), once, 'a second pass must not change anything');
  assert.equal(
    (mermaidFencesToMerpress(once).match(/<!--\s*wp:merpress/g) || []).length,
    1,
    'a second pass must not double the delimiter'
  );
});

test('mermaidFencesToMerpress: info string that is not exactly mermaid (mermaidjs / with args) is not converted', () => {
  for (const lang of ['mermaidjs', 'mermaid {}', 'js', '']) {
    const md = ['```' + lang, 'graph TD', 'A-->B', '```'].join('\n');
    assert.equal(mermaidFencesToMerpress(md), md, `\`\`\`${lang} should not be converted`);
  }
});

test('mermaidFencesToMerpress: case-insensitive; safe on empty input', () => {
  assert.ok(mermaidFencesToMerpress('```MERMAID\ngraph TD\nA-->B\n```').includes('pre class="mermaid"'));
  assert.equal(mermaidFencesToMerpress(''), '');
  assert.equal(mermaidFencesToMerpress(null), '');
  assert.equal(mermaidFencesToMerpress(undefined), '');
});

test('buildPostHtml: end-to-end — a mermaid fence in the body lands as a renderable block', () => {
  const html = buildPostHtml(MERMAID_FENCE_MD);
  assert.ok(html.includes('<pre class="mermaid">'), 'the buildPostHtml exit must already be a MerPress block');
  assert.ok(!html.includes('language-mermaid'), 'no plain code block may remain');
  assert.ok(html.includes('<p>这个过程中，<strong>并查集算法</strong>发挥着关键作用。</p>'), 'paragraphs still render');
});

test('markdownToHtml: deliberately does NOT convert mermaid (shared with WeChat / CSDN syndication)', () => {
  const html = markdownToHtml(MERMAID_FENCE_MD);
  assert.ok(html.includes('language-mermaid'), 'markdownToHtml stays as-is; conversion only happens on the WP write path');
  assert.ok(!html.includes('wp-block-merpress-mermaidjs'), 'channel syndication must not carry the WP-only block');
});

// Regression (2026-10-06): the marker comparison originally used the whole fence
// string against its first character (`close[2][0] === marker` where marker was
// "```"), so the closing fence NEVER matched and got pushed into <pre> — the page
// then showed a literal ``` line inside the diagram. This asserts on a realistic
// multi-line diagram and checks the fence is neither swallowed nor left behind.
const REAL_MD = [
  '这个过程中，**并查集算法（Union-Find）**发挥着关键作用。',
  '',
  '```mermaid',
  'graph TD',
  '    subgraph 現實世界',
  '        A[自然人A]',
  '        B[自然人B]',
  '    end',
  '    subgraph 連通圖抽象',
  '        D[節點1（手機號碼138xxxx5678）]',
  '        K[節點9（MAC地址=ff:ee:dd:cc:bb:aa）]',
  '',
  '        %% 孤立分量（自然人C）',
  '        D -- "強關聯：登入綁定" --> K',
  '    end',
  '    A -->|對應| D',
  '```',
  '',
  '### 1.3 核心概念',
  '',
  '正文继续。',
].join('\n');

test('mermaidFencesToMerpress: the closing fence is consumed, never leaked into <pre>', () => {
  const out = mermaidFencesToMerpress(REAL_MD);
  const inner = out.slice(out.indexOf('<pre class="mermaid">'), out.indexOf('</pre>'));
  assert.ok(inner.length > 0, '<pre> must exist');
  assert.ok(!inner.includes('```'), 'the closing ``` must not end up inside <pre>');
  assert.ok(!inner.includes('```mermaid'), 'the opening fence must not end up inside <pre>');
  // the diagram itself must survive intact: blank lines and all
  assert.ok(inner.includes('subgraph 現實世界'), 'subgraph title kept');
  assert.ok(inner.includes('MAC地址=ff:ee:dd:cc:bb:aa'), 'node label with colons kept');
  assert.ok(inner.includes('%% 孤立分量（自然人C）'), 'comment lines kept');
  assert.ok(inner.includes('D -- &quot;強關聯：登入綁定&quot; --&gt; K'), 'labelled edge kept + escaped');
  assert.ok(!out.includes('```'), 'no fence marker anywhere in the result');
});

test('mermaidFencesToMerpress: content after the closing fence is untouched', () => {
  const out = mermaidFencesToMerpress(REAL_MD);
  assert.ok(out.includes('### 1.3 核心概念'), 'the heading after the diagram must survive');
  assert.ok(out.includes('正文继续。'), 'the paragraph after the diagram must survive');
});

test('buildPostHtml: real-world md produces a valid MerPress block (regression guard)', () => {
  const html = buildPostHtml(REAL_MD);
  const i = html.indexOf('<div class="wp-block-merpress-mermaidjs diagram-source-mermaid">');
  assert.ok(i !== -1, 'MerPress container present');
  const inner = html.slice(i, html.indexOf('</pre>', i));
  assert.ok(!inner.includes('```'), 'no stray fence inside <pre>');
  assert.ok(html.includes('<h3>1.3 核心概念</h3>'), 'the following heading still renders');
  assert.ok(html.includes('正文继续。'), 'the following paragraph still renders');
});

// ==================== ⑩ fixMermaidLabelQuotes / mermaidBareParenIssues (2026-10-06) ====================
//
// Live incident: en post 1652 rendered NOTHING because `D[Node 1 (phone number …)]`
// has a bare paren inside a `[ ]` label — a mermaid lexing error. Probed with the
// mobile site's own mermaid 11.16.1: bare parens break node labels, edge labels
// `|…|` and subgraph titles (both forms); a double-quoted label always parses;
// colons / hashes / hyphens are safe and must be left alone (no churn).

test('fixMermaidLabelQuotes: node label with bare parens gets quoted', () => {
  const out = fixMermaidLabelQuotes('graph TD\n    A[Node 1 (phone)] --> B');
  assert.ok(out.includes('A["Node 1 (phone)"]'), out);
  assert.ok(!out.includes('A[Node 1 (phone)]'));
});

test('fixMermaidLabelQuotes: edge label and subgraph titles (both forms) get quoted', () => {
  const out = fixMermaidLabelQuotes([
    'graph TD',
    '    A -->|linked (strong)| B',
    '    subgraph "World (real)"',
    '        C',
    '    end',
    '    subgraph sg1 [World (real)]',
    '        D',
    '    end',
    '    subgraph World (real)',
    '        E',
    '    end',
  ].join('\n'));
  assert.ok(out.includes('-->|"linked (strong)"|'), out);
  assert.ok(out.includes('subgraph "World (real)"'), out);
  assert.ok(out.includes('subgraph sg1 ["World (real)"]'), out);
  assert.ok(!out.includes('subgraph World (real)'), 'bare subgraph title must be quoted');
});

test('fixMermaidLabelQuotes: safe constructs untouched (evidence-based, no churn)', () => {
  const src = [
    'graph TD',
    '    A[時間 10:30] --> B[tag #1]',
    '    C[節點1（手機號碼）] --> D[自然人]',
    '    E -->|strong-link| F',
    '    G(rounded (kept)) --> H{diamond 10:30}',
  ].join('\n');
  assert.equal(fixMermaidLabelQuotes(src), src, 'colons / hashes / fullwidth parens / hyphens are verified safe');
});

test('fixMermaidLabelQuotes: idempotent', () => {
  const once = fixMermaidLabelQuotes('graph TD\n    A[Node 1 (phone)] -->|x (y)| B\n    subgraph sg [T (u)]\n    end');
  assert.equal(fixMermaidLabelQuotes(once), once);
});

test('fixMermaidLabelQuotes: already-quoted labels never double-quoted', () => {
  const out = fixMermaidLabelQuotes('graph TD\n    A["Node 1 (phone)"] -->|"l (x)"| B');
  assert.ok(out.includes('A["Node 1 (phone)"]'));
  assert.ok(!out.includes('""'));
});

test('mermaidBareParenIssues: detects each failing construct with fence line numbers; clean source passes', () => {
  const bad = [
    '前文。',
    '', '```mermaid', 'graph TD',
    '    A[Node 1 (phone)] --> B',
    '    subgraph sg1 [World (real)]',
    '        C',
    '    end', '```', '',
  ].join('\n');
  const issues = mermaidBareParenIssues(bad);
  assert.equal(issues.length, 2, JSON.stringify(issues));
  assert.equal(issues[0].line, 5);
  assert.equal(issues[1].line, 6);

  assert.deepEqual(mermaidBareParenIssues('前文 (prose parens are fine)。'), []);
  assert.deepEqual(mermaidBareParenIssues('```mermaid\ngraph TD\n    A["ok (quoted)"] --> B\n```'), []);
  assert.deepEqual(mermaidBareParenIssues('```js\ncode (not mermaid)\n```'), [], 'non-mermaid fences ignored');
});

test('mermaidFencesToMerpress: un-parseable label is auto-repaired on the write path', () => {
  const out = mermaidFencesToMerpress('前文。\n\n```mermaid\ngraph TD\n    D[Node 1 (phone number 138xxxx5678)] --> E\n```\n\n后文。');
  assert.ok(out.includes('D[&quot;Node 1 (phone number 138xxxx5678)&quot;]'), 'fixed + escaped into pre.mermaid');
  assert.ok(!out.includes('D[Node 1 (phone'));
  assert.ok(out.includes('后文。'));
});

// ==================== ⑰ internal-link language prefix + CTA layout (2026-10-06) ====================

test('langToPrefix: maps geo codes and plugin codes to URL prefixes', () => {
  assert.equal(langToPrefix('zh-hans'), 'zh-hans');
  assert.equal(langToPrefix('zh-hans'), 'zh-hans');
  assert.equal(langToPrefix('en'), 'en');
  assert.equal(langToPrefix('en'), 'en');
  assert.equal(langToPrefix('zh-hant'), 'zh-hant');
  assert.equal(langToPrefix('zh-hant'), 'zh-hant');
  assert.equal(langToPrefix('unknown'), 'zh-hans'); // safe fallback
});

test('normalizeInternalArticleLinks: bare + wrong-prefix article links get the article language prefix; non-article links untouched', () => {
  const html =
    '<p><a href="https://www.tengence.com/blog/article/content-optimization-tips/" target="_blank">A</a></p>' +
    '<p><a href="https://www.tengence.com/zh-hant/blog/article/foo-bar/">wrong</a> ' +
    '<a href="https://www.tengence.com/en/blog/article/baz/">enus</a> ' +
    '<a href="https://www.tengence.com/contact-us">contact</a> ' +
    '<a href="https://example.com/x">ext</a></p>';
  const out = normalizeInternalArticleLinks(html, 'en');
  assert.ok(out.includes('https://www.tengence.com/en/blog/article/content-optimization-tips/'));
  assert.ok(out.includes('https://www.tengence.com/en/blog/article/foo-bar/'));
  assert.ok(out.includes('https://www.tengence.com/en/blog/article/baz/'));
  assert.ok(out.includes('https://www.tengence.com/contact-us'));
  assert.ok(out.includes('https://example.com/x'));
  assert.ok(!out.includes('/zh-hant/') && !out.includes('/en-us/') && !out.includes('tengence.com/blog/article/'));
  // idempotent
  assert.equal(out, normalizeInternalArticleLinks(out, 'en'));
});

test('normalizeCtaBlock: single / pipe-joined CTA links become a list; prose paragraphs preserved; idempotent', () => {
  const single = normalizeCtaBlock(
    '<h2>立即行动</h2><p><a href="https://www.tengence.com/contact-us" target="_blank">免费预约专家咨询和诊断</a></p>'
  );
  assert.ok(single.includes('<ul>') && single.includes('<li><a href="https://www.tengence.com/contact-us"'));
  assert.equal(single, normalizeCtaBlock(single));

  const pipe = normalizeCtaBlock(
    '<h2>Get Started</h2><p><a href="/a">A</a> | <a href="/b">B</a></p><p>Contact us anytime.</p>'
  );
  assert.ok(pipe.includes('<li><a href="/a">A</a></li>') && pipe.includes('<li><a href="/b">B</a></li>'));
  assert.ok(!pipe.includes(' | '), 'pipe separator removed');
  assert.ok(pipe.includes('<p>Contact us anytime.</p>'), 'prose tail preserved');
  assert.equal(pipe, normalizeCtaBlock(pipe));

  const hk = normalizeCtaBlock('<h2>立即行動</h2><p><a href="/x">X</a> | <a href="/y">Y</a> | <a href="/z">Z</a></p>');
  assert.ok(hk.includes('<li><a href="/x">X</a></li>') && hk.includes('<li><a href="/z">Z</a></li>'));

  const alreadyList = normalizeCtaBlock('<h2>Get Started</h2><ul><li><a href="/a">A</a></li></ul><p>note</p>');
  assert.ok(alreadyList.includes('<ul><li><a href="/a">A</a></li></ul><p>note</p>'), 'already a list — untouched');

  const proseOnly = normalizeCtaBlock('<h2>Get Started</h2><p>Contact us anytime.</p>');
  assert.ok(proseOnly.includes('<p>Contact us anytime.</p>') && !proseOnly.includes('<ul>'), 'no links — untouched');
});

test('articlePrefixIssues: bare / wrong-prefix article links flagged, correct prefix passes', () => {
  assert.equal(articlePrefixIssues('[x](https://www.tengence.com/blog/article/foo/)', 'zh-hans').length, 1);
  assert.equal(articlePrefixIssues('https://www.tengence.com/zh-hant/blog/article/foo/', 'en').length, 1);
  assert.equal(articlePrefixIssues('<a href="https://www.tengence.com/zh-hans/blog/article/foo/">x</a>', 'zh-hans').length, 0);
  assert.equal(articlePrefixIssues('https://www.tengence.com/zh-hant/blog/article/foo/', 'zh-hant').length, 0);
});

test('ctaPipeIssues: links joined by | in the CTA block flagged; lists pass; other blocks ignored', () => {
  assert.equal(ctaPipeIssues('## 立即行动\n\n[a](u) | [b](v)').length, 1);
  assert.equal(ctaPipeIssues('## Get Started\n\n- [a](u)\n- [b](v)').length, 0);
  assert.equal(ctaPipeIssues('## 相关阅读\n\n[x](u) | [y](v)').length, 0, 'related reading pipes not flagged');
});

test('normalizeArticleUrlForCompare: strips any language segment; non-article links unchanged', () => {
  assert.equal(
    normalizeArticleUrlForCompare('https://www.tengence.com/zh-hans/blog/article/foo/'),
    'https://www.tengence.com/blog/article/foo/'
  );
  assert.equal(
    normalizeArticleUrlForCompare('https://www.tengence.com/en/blog/article/foo/'),
    'https://www.tengence.com/blog/article/foo/'
  );
  assert.equal(normalizeArticleUrlForCompare('https://example.com/x'), 'https://example.com/x');
});
