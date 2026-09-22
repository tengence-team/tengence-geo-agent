/**
 * Markdown processing (content domain)
 * ============================================================================
 * Converges the Markdown-related logic previously scattered across scripts:
 *   - publish-from-db.js's toPlainText / makeDescription / markdownToHtml /
 *     extractImageUrls / extractFirstImage / removeFirstImage
 *   - save-article-to-db.js's stripFrontMatter / extractTitle
 *
 * The single Markdown engine: marked (consistent with the main publish chain; the
 * Python bypass script was rewritten in Node).
 *
 * Off-site link rendering rules (the original articleRenderer from publish-from-db.js):
 *   off-site links automatically get target="_blank" rel="noopener noreferrer";
 *   on-site (the site domain and its subdomains), anchors, relative paths, and
 *   mailto/tel are never touched.
 *
 * ⚠️ marked.use() is called once at module load; calling it repeatedly wraps the
 *    renderer methods layer by layer.
 * ============================================================================
 */

const marked = require('marked');
const yaml = require('js-yaml');
const { loadSite } = require('../site/config');

// ==================== site domain (lazy cache) ====================

let cachedDomain;

/** Site domain: SITE_DOMAIN from .env wins, falling back to config/site.yaml's site.domain */
function siteDomain() {
  if (cachedDomain === undefined) {
    const SITE = loadSite();
    cachedDomain =
      process.env.SITE_DOMAIN ||
      (SITE.site && SITE.site.site && SITE.site.site.domain) ||
      '';
  }
  return cachedDomain;
}

/**
 * Decide whether a link is off-site.
 * On-site (the site domain and its subdomains), anchors, relative paths, and
 * mailto/tel are all treated as internal.
 */
function isExternalUrl(href) {
  if (!href) return false;
  if (/^(mailto:|tel:|#|\/|\.\/|\.\.\/)/i.test(href)) return false;
  try {
    const host = new URL(href).hostname.toLowerCase();
    const domain = siteDomain();
    if (!domain) return true;
    return !(host === domain || host.endsWith(`.${domain}`));
  } catch (e) {
    return false; // not parseable as a full URL: leave it alone
  }
}

// ==================== Markdown → HTML ====================

const articleRenderer = new marked.Renderer();
articleRenderer.link = function (token) {
  const href = token.href || '';
  const text = this.parser.parseInline(token.tokens);
  const title = token.title ? ` title="${token.title}"` : '';
  if (isExternalUrl(href)) {
    return `<a href="${href}"${title} target="_blank" rel="noopener noreferrer">${text}</a>`;
  }
  return `<a href="${href}"${title}>${text}</a>`;
};
marked.use({ renderer: articleRenderer });

// ==================== pre-publish protections (2026-09-14) ====================
//
// Both protections run "before handing to marked"; after the fix the same marked
// config is still used, and articles that don't contain either construct produce
// byte-identical output.
// Background: §9 of the engineering notes on the "table flattening incident" and the
// source-fix standard procedure.

/** Fenced-code-block marker (``` / ~~~, allows 0-3 spaces of indent) */
const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;

/** Apply fn only to text outside fenced code blocks; fences stay verbatim */
function mapOutsideFences(md, fn) {
  const lines = String(md).split('\n');
  const out = [];
  const buf = [];
  const flush = () => {
    if (buf.length) {
      out.push(fn(buf.join('\n')));
      buf.length = 0;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(FENCE_RE);
    if (!open) {
      buf.push(lines[i]);
      continue;
    }
    flush();
    const marker = open[2][0];
    const block = [lines[i]];
    for (i++; i < lines.length; i++) {
      block.push(lines[i]);
      const close = lines[i].match(FENCE_RE);
      if (close && close[2][0] === marker && close[3].trim() === '') break;
    }
    out.push(block.join('\n'));
  }
  flush();
  return out.join('\n');
}

/** Apply fn only to text outside inline code (`…` / ``…`` stay verbatim) */
function mapOutsideInlineCode(text, fn) {
  return text
    .split(/(`+[^`]*`+)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : fn(seg)))
    .join('');
}

// CJK char / full-width punctuation ranges
const CJK_CHAR = '\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFFEF\\u3000-\\u303F';
// punctuation (CN & EN) right before a closing ** that makes it "unclosable"
const PUNCT_BEFORE_CLOSE = '[，。、；：？！）】》」』”’…—·,.;:?!)\\]}>]';
const CJK_BOLD_RE = new RegExp(`\\*\\*([^*\\n]+?${PUNCT_BEFORE_CLOSE})\\*\\*(?=[${CJK_CHAR}])`, 'g');

/**
 * Fix CommonMark/marked's CJK bold defect.
 * When the text right before the closing `**` is punctuation and the next char is CJK,
 * the closing delimiter doesn't satisfy the "right-flanking" condition → cannot close,
 * and the page shows literal `**`. Example: `**并查集算法（Union-Find）**发挥着`,
 * `**A：**建`.
 * Fix: rewrite such runs as inline <strong>…</strong> (HTML passthrough, render-equivalent).
 * `**` inside fenced code blocks and inline code (e.g. masked phone 138****5678,
 * SQL '****') is left alone.
 */
function fixCjkBold(md) {
  return mapOutsideFences(md, (chunk) =>
    mapOutsideInlineCode(chunk, (text) => text.replace(CJK_BOLD_RE, '<strong>$1</strong>'))
  );
}

/** raw-HTML blocks that need whole-block protection: MerPress's Mermaid blocks */
const RAW_HTML_BLOCKS = [
  /<!--\s*wp:merpress\/mermaidjs\s*-->[\s\S]*?<!--\s*\/wp:merpress\/mermaidjs\s*-->/g,
  /<div\s+class="wp-block-merpress-mermaidjs[^"]*"[\s\S]*?<\/div>/g,
];

const RAW_TOKEN_PREFIX = 'XZRAWHOLD';
const RAW_TOKEN_SUFFIX = 'XZZ';

/**
 * Extract raw-HTML blocks and replace them with pure-alphanumeric placeholders.
 * Why: CommonMark HTML blocks (`<div`-started) terminate at the first blank line →
 * if a MerPress Mermaid block contains a blank line, the block's lower half gets
 * re-parsed as Markdown and broken. Once extracted, marked never sees the block
 * content, so it is immune to the blank-line problem.
 * @returns {{md:string, blocks:string[]}}
 */
function holdRawHtml(md) {
  const blocks = [];
  let out = String(md || '');
  for (const re of RAW_HTML_BLOCKS) {
    out = out.replace(re, (m) => {
      const token = `${RAW_TOKEN_PREFIX}${blocks.length}${RAW_TOKEN_SUFFIX}`;
      blocks.push(m);
      return `\n\n${token}\n\n`;
    });
  }
  return { md: out, blocks };
}

/** Restore placeholders to the original raw-HTML blocks (marked wraps them in <p>; strip that too) */
function restoreRawHtml(html, blocks) {
  if (!blocks || blocks.length === 0) return html;
  const token = `${RAW_TOKEN_PREFIX}(\\d+)${RAW_TOKEN_SUFFIX}`;
  return html
    .replace(new RegExp(`<p>\\s*${token}\\s*</p>\\s*`, 'g'), (m, i) => blocks[Number(i)])
    .replace(new RegExp(token, 'g'), (m, i) => blocks[Number(i)]);
}

/** Markdown → HTML (the exact marked config of the main publish chain + the two pre-publish protections) */
function markdownToHtml(md) {
  marked.setOptions({
    breaks: true,      // newline → <br>
    gfm: true,         // GitHub-flavored Markdown
    tables: true,      // tables enabled
    smartLists: true,  // smarter lists
    mangle: false      // do not escape emails
  });
  const held = holdRawHtml(md || '');
  return restoreRawHtml(marked.parse(fixCjkBold(held.md)), held.blocks);
}

// ==================== publish-time fallback: when md omits the blocks, materialize
// from GEO fields into visible HTML ====================
//
// Background (2026-09-15 research decision, plan C):
//   The "key takeaways / FAQ" blocks used to be injected into `the_content` only by
//   the WP plugin ⇒ they existed only at the render layer. Measured: `post_content`,
//   RSS `content:encoded` and REST `content.rendered` had identical lengths and none
//   contained the two blocks ⇒ syndication / WP export / on-site search / editor /
//   App / Newsletter all missed them; disabling or migrating the plugin silently
//   dropped content, and having the schema without the visible page violates Google's
//   "don't mark up content not visible to readers".
//
// Approach (from 2026-09-16): **the authoring source moved to the Markdown body** —
// summary / takeaways / FAQ are written directly into the .md, reverse-parsed by
// `parseGeoBlocks` / `syncGeoFromMarkdown` back into `geo.*` and written back to the
// DB and WP meta. This function therefore degraded to a **fallback**: it skips
// automatically when the body already contains the blocks (idempotent); it only fills
// them in when the md omits them but the meta has them, so legacy articles (36 live
// re-publishes) never silently lose blocks. The plugin side keeps only the head layer
// (JSON-LD / meta / og / sitemap) and never rewrites the body.
//
// Placement conventions: takeaways sit **after the intro, before the first H2**; FAQ
// sits **at the end of the body, before the CTA** (before "关于 Tengence").
// To customize placement, write the placeholder comment
// `<!-- tengence-takeaways -->` / `<!-- tengence-faq -->` in the body.

/** Takeaways placeholder comment */
const TAKEAWAYS_PLACEHOLDER = /<!--\s*tengence-takeaways\s*-->/;
/** FAQ placeholder comment */
const FAQ_PLACEHOLDER = /<!--\s*tengence-faq\s*-->/;
/** "lead-type" first-section headings: takeaways should follow these, not precede them */
const LEAD_SECTION_RE = /^(导语|引言|导读|前言|摘要|结论)$/;

/** HTML-escape (only for plain-text fields: takeaway items, questions, plain-text answers) */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Strip tags to plain text (only for matching H2 headings) */
function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/** List every <h2> in the html with its char position and heading text */
function h2List(html) {
  const re = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push({ index: m.index, text: stripTags(m[1]) });
  return out;
}

/**
 * Key-takeaways block HTML — **a pure markdown section**, rendered by the theme's
 * default markdown styles, with zero dependency on the plugin or any custom
 * class / inline style (decided 2026-09-15). When syndicated across platforms
 * (WeChat / Zhihu / RSS / HTML→MD conversion), h2/ul/li are all in the common tag
 * subset, so structure and style survive with the content; the head-layer FAQPage
 * JSON-LD is emitted separately by the plugin and unrelated.
 */
function renderTakeaways(items) {
  if (!Array.isArray(items)) return '';
  const lis = items
    .map((x) => String(x == null ? '' : x).trim())
    .filter(Boolean)
    .map((x) => '<li>' + escapeHtml(x) + '</li>')
    .join('\n');
  if (!lis) return '';
  return '<h2>关键要点</h2>\n<ul>\n' + lis + '\n</ul>';
}

/**
 * FAQ block HTML — **a pure markdown section** (heading without a number + each Q&A
 * wrapped in a `>` blockquote, question bolded), rendered by the theme's default
 * markdown styles, with zero dependency on the plugin or any custom class / inline
 * style.
 *
 * Shape: `<h2>常见问题</h2>` + each pair as
 * `<blockquote><p><strong>问：question?</strong></p><p>答：answer</p></blockquote>`.
 * The heading is not numbered ("N、常见问题") — when body subheadings aren't numbered
 * uniformly, a numbered block would look unbalanced against them.
 *
 * Why blockquotes (user decided 2026-09-16): FAQ and the "summary" block used to be
 * plain paragraphs indistinguishable from body prose, so readers couldn't tell at a
 * glance which paragraph was Q&A. With blockquotes, FAQ, body paragraphs and the
 * opening summary (single-paragraph blockquote) are each visually distinct while still
 * being standard markdown (`blockquote` is natively supported in WeChat / Zhihu /
 * RSS / HTML→MD conversion); the Q/A boundary is preserved by the "问：/答：" prefixes.
 *
 * Evolution: `<details>` collapse → visible h3 structure → numbered heading + bold
 * question → plain "问：/答：" paragraphs → **"问：/答：" wrapped in blockquote**
 * (no h3, no class, no inline style, no number).
 *
 * @param {Array<{question:string,answer:string}>} qaPairs
 */
function renderFaq(qaPairs) {
  if (!Array.isArray(qaPairs)) return '';
  const items = [];
  qaPairs.forEach((qa) => {
    if (!qa || !qa.question || !qa.answer) return;
    const q = escapeHtml(String(qa.question).trim());
    const a = String(qa.answer == null ? '' : qa.answer).trim();
    let answerHtml;
    if (/<[a-z][^>]*>/i.test(a)) {
      // legacy HTML answers (~70 are <p>…</p>): merge "答：" into the first <p> to avoid <p> nesting
      answerHtml = a.replace(/^(\s*)<p(\s|>)/i, '$1<p$2答：');
      if (answerHtml === a) answerHtml = '<p>答：</p>\n' + a; // fallback when it doesn't start with <p>
    } else {
      answerHtml = '<p>答：' + escapeHtml(a) + '</p>';
    }
    items.push('<blockquote>\n<p><strong>问：' + q + '</strong></p>\n' + answerHtml + '\n</blockquote>');
  });
  if (!items.length) return '';
  return '<h2>常见问题</h2>\n' + items.join('\n');
}

/** Insert block at html's index (a single-line HTML block) */
function insertAt(html, index, block) {
  return html.slice(0, index) + block + '\n' + html.slice(index);
}

/** Append to the end of the body */
function appendBlock(html, block) {
  return html.replace(/\s*$/, '') + '\n' + block;
}

/**
 * Takeaways landing: ① placeholder comment → ② before the first H2 (if the first
 * section is "lead"-type, defer to before the next) → ③ end of body
 */
function insertTakeaways(html, block) {
  const ph = html.match(TAKEAWAYS_PLACEHOLDER);
  if (ph) return html.slice(0, ph.index) + block + '\n' + html.slice(ph.index + ph[0].length);
  const h2s = h2List(html);
  if (!h2s.length) return appendBlock(html, block);
  let target = h2s[0];
  if (LEAD_SECTION_RE.test(target.text) && h2s.length > 1) target = h2s[1];
  return insertAt(html, target.index, block);
}

/**
 * FAQ landing: ① placeholder comment → ② before "关于 Tengence" → ③ before
 * "相关阅读" → ④ before "数据来源" → ⑤ end of body
 */
function insertFaq(html, block) {
  const ph = html.match(FAQ_PLACEHOLDER);
  if (ph) return html.slice(0, ph.index) + block + '\n' + html.slice(ph.index + ph[0].length);
  const h2s = h2List(html);
  for (const re of [/^关于\s*Tengence/, /^相关阅读/, /^数据来源/, /^About /, /^Related Reading/, /^Data Sources/]) {
    const hit = h2s.find((h) => re.test(h.text));
    if (hit) return insertAt(html, hit.index, block);
  }
  return appendBlock(html, block);
}

/**
 * Publish-time materialization: render the GEO structured fields into visible HTML
 * and drop them into the body (post_content) once.
 *
 * @param {string} html output of markdownToHtml
 * @param {{key_takeaways?: string[], qa_pairs?: Array<{question:string,answer:string}>}} [geo]
 *        the `geo` node of the article config (one of the return values of `t.db.config.getFull()`)
 * @returns {string} the materialized body HTML (returned unchanged when GEO is disabled)
 */
function composeBody(html, geo) {
  let out = String(html || '');
  const g = geo || {};

  // takeaways: skip when the body already has a same-named section (idempotent)
  if (!/<h2>(关键要点|Key Takeaways)<\/h2>/.test(out)) {
    const block = renderTakeaways(g.key_takeaways);
    if (block) out = insertTakeaways(out, block);
  }

  // FAQ: skip when the body already has a "常见问题" section (our materialized block,
  // heading may carry a number like "五、常见问题"), or a hand-written FAQ section
  // (legacy double-write), to avoid duplicate blocks on the same page
  const hasFaqHeading = /<h2>[^<]*(常见问题|FAQ|Frequently Asked Questions)<\/h2>/i.test(out);
  const hasLegacyFaq = h2List(out).some(
    (h) => /常见问题|FAQ|问答|Frequently Asked Questions/.test(h.text) && !/常见问题$/.test(h.text)
  );
  if (!hasFaqHeading && !hasLegacyFaq) {
    const block = renderFaq(g.qa_pairs);
    if (block) out = insertFaq(out, block);
  }

  return out;
}

/**
 * The **single exit** for writing a body into WordPress: Markdown → HTML →
 * materialize the GEO blocks (takeaways / FAQ).
 *
 * ⚠️ Any script that writes a body into WP `post_content` must go through this
 *    function (or equivalently call `composeBody(markdownToHtml(md), geo)` itself);
 *    it must not `markdownToHtml` and write directly.
 *
 * Why converged (2026-09-16 incident): `publish-from-db.js` adopted `composeBody`
 * back in plan C, but `publish-update-article.js` still wrote `markdownToHtml(...)`
 * directly ⇒ updating a body with it wiped the "key takeaways / FAQ" blocks (which
 * only lived in meta and were materialized at publish time), and the failure was
 * silent: the page returned 200, just missing the two blocks. Converging on this
 * function means "whether to materialize" no longer depends on whether the caller
 * remembers; the single test `publish-consistency.test.js` guards it.
 *
 * @param {string} markdown body Markdown (Front Matter already stripped)
 * @param {{key_takeaways?: string[], qa_pairs?: Array<{question:string,answer:string}>}} [geo]
 * @returns {string} body HTML ready to write into WP
 */
function buildPostHtml(markdown, geo) {
  return composeBody(markdownToHtml(markdown), geo || {});
}

// ==================== Markdown → GEO structured fields (reverse parsing) ====================
//
// Background (decided 2026-09-16): **the Markdown body is the single authoring source
// for the GEO blocks**. Summary / key takeaways / FAQ are all written directly into
// the .md, and at publish time this family of functions reverse-parses them back into
// `geo.ai_summary` / `geo.key_takeaways` / `geo.qa_pairs`, then writes back to the DB
// and WP meta (the head-layer FAQPage JSON-LD, plugin and mobile App all read these
// fields).
//
// That way the Markdown itself is a complete distributable draft (syndicating to
// WeChat / Zhihu / other platforms needs no extra materialization), and the DB fields
// never drift from the body — **md is authoritative; meta is auto-written back**.
//
// `composeBody` therefore degraded to a **fallback**: it skips injecting the
// takeaways / FAQ blocks when the body already contains them (idempotent), and only
// fills them in when the md omits them while the meta has them — so legacy articles
// never lose blocks on re-publish.

/** Heading line → heading text (null for non-headings) */
function headingText(line) {
  const m = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
  return m ? m[2].trim() : null;
}

/** Strip decorations like "八、" / "（FAQ）" to get the canonical block name */
function normalizeHeading(text) {
  return String(text)
    .replace(/^[（(]?[一二三四五六七八九十百\d]+[、.．)）]\s*/, '')
    .replace(/[（(]\s*FAQ\s*[）)]/i, '')
    .trim();
}

/** Takeaways block heading (includes legacy numbered forms) */
function isTakeawaysHeading(text) {
  return /^(关键要点|核心要点|要点速览|Key Takeaways)$/.test(normalizeHeading(text));
}

/** FAQ block heading (includes legacy numbered forms) */
function isFaqHeading(text) {
  const t = normalizeHeading(text);
  return t === '常见问题' || t === 'FAQ' || t === 'Frequently Asked Questions' || /常见问题$/.test(t);
}

/** Data-source block heading (## 数据来源, includes legacy numbered forms) */
function isCitationsHeading(text) {
  const n = normalizeHeading(text);
  return n === '数据来源' || n === 'Data Sources';
}

/**
 * Extract { title, url } from one citation item text.
 * Compatible with both notations (legacy articles contain both):
 *   ① Markdown: `[Title](https://…)` (may be wrapped in **)
 *   ② HTML: `<a href="https://…" …>Title</a>` (the publish script adds target=_blank)
 * @param {string} text list-item text (e.g. `1. **[来源](url)**：说明`)
 * @returns {{title:string, url:string}|null}
 */
function extractCitationFromItem(text) {
  const htmlM = /<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(text);
  if (htmlM) {
    const title = stripTags(htmlM[2]).trim();
    const url = htmlM[1].trim();
    if (url && title) return { title, url };
  }
  const mdM = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(text);
  if (mdM) {
    const title = mdM[1].trim();
    const url = mdM[2].trim();
    if (title) return { title, url };
  }
  return null;
}

/** Citation item lines (ordered 1. / unordered - *, with indent tolerance) */
const CITATION_ITEM_RE = /^\s*(?:\d+[.、]|[-*])\s+(.+?)\s*$/;

/**
 * Reverse-parse the three GEO blocks from the Markdown body.
 *
 * Recognized notations (consistent with the generic skeleton
 * `docs/templates/skeletons/howto.md` and the site template
 * `sites/tengence/docs/templates/blog-post.md`):
 *   summary     `> **摘要**：…`
 *   key takeaways `## 关键要点` + `- item`
 *   FAQ         `## 常见问题` + each pair `> **问：…？**` / `> 答：…`
 *
 * @param {string} md body Markdown
 * @returns {{summary:string, takeaways:string[], faq:Array<{question:string,answer:string}>}}
 */
function parseGeoBlocks(md) {
  // Strip HTML comments and fenced code blocks: the writing templates put "notation
  // samples" inside comments / ```; without stripping, samples would be parsed as
  // real blocks into the meta.
  const cleaned = String(md || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*(`{3,}|~{3,})[\s\S]*?^[ \t]*\1[ \t]*$/gm, '');
  const lines = cleaned.split('\n');
  let summary = '';
  const takeaways = [];
  const faq = [];
  const citations = [];
  let section = null; // 'takeaways' | 'faq' | 'citations'
  let current = null; // current Q&A { q: string[], a: string[][] }

  const closeFaq = () => {
    if (!current) return;
    const question = current.q.join(' ').trim();
    const paras = current.a
      .map((p) => p.join(' ').trim())
      .filter(Boolean)
      .map((p) => '<p>' + escapeHtml(p) + '</p>');
    if (question && paras.length) faq.push({ question, answer: paras.join('') });
    current = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const heading = headingText(line);

    if (heading !== null) {
      closeFaq();
      section = isTakeawaysHeading(heading)
        ? 'takeaways'
        : (isFaqHeading(heading) ? 'faq' : (isCitationsHeading(heading) ? 'citations' : null));
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { // separator line ends the section
      closeFaq();
      section = null;
      continue;
    }

    // legacy notation: `**数据来源**` (bold single line, not an H2) also starts the
    // data-source section
    if (/^\s*\*\*(数据来源|Data Sources)\*\*\s*$/.test(line)) {
      closeFaq();
      section = 'citations';
      continue;
    }

    // summary: opening blockquote (first occurrence only) — bold-agnostic (EN/ZH, ** or not)
    if (!summary) {
      const clean = line.replace(/^\s*>+\s?/, '').replace(/\*+/g, '').trim();
      const sm = /^(?:摘要|Summary)\s*[：:]\s*(.+?)\s*$/i.exec(clean);
      if (sm) { summary = sm[1].trim(); continue; }
    }

    if (section === 'takeaways') {
      const li = /^\s*[-*+]\s+(.+?)\s*$/.exec(line);
      if (li) takeaways.push(li[1].trim());
      continue;
    }

    if (section === 'citations') {
      const item = CITATION_ITEM_RE.exec(line);
      if (item) {
        const cit = extractCitationFromItem(item[1]);
        if (cit) citations.push(cit);
      }
      continue;
    }

    if (section === 'faq') {
      const clean = line.replace(/^\s*>+\s?/, '').replace(/\*+/g, '').trim();
      const qm = /^(?:问|Q)\s*[：:]\s*(.+)$/i.exec(clean);
      if (qm) {
        closeFaq();
        current = { q: [qm[1].trim()], a: [] };
        continue;
      }
      if (!current) continue;
      if (!clean) { current.a.push([]); continue; } // an empty `>` separates paragraphs
      const am = /^(?:答|A)\s*[：:]\s*(.*)$/i.exec(clean);
      const answer = (am ? am[1] : clean).trim();
      if (!answer) continue;
      if (!current.a.length) current.a.push([]);
      current.a[current.a.length - 1].push(answer);
    }
  }
  closeFaq();

  return { summary, takeaways, faq, citations };
}

/**
 * **md is authoritative**: override the geo config with the GEO blocks parsed from
 * the body.
 *
 * Rule: blocks present in the md always win (takeaways / FAQ / summary /
 * data-sources → citations); blocks absent keep the meta's existing values ⇒ writing
 * the md alone is enough, the publish chain auto-writes the meta back, and the two
 * never drift.
 *
 * @param {string} md body Markdown
 * @param {object} [geo] existing geo config (DB config.geo or the geo of <slug>.meta.json)
 * @returns {{geo:object, parsed:object, changed:string[]}} changed = field names that
 *   were overridden (with item counts)
 */
function syncGeoFromMarkdown(md, geo = {}) {
  const parsed = parseGeoBlocks(md);
  const out = Object.assign({}, geo || {});
  const changed = [];
  const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

  if (parsed.takeaways.length && !same(out.key_takeaways, parsed.takeaways)) {
    out.key_takeaways = parsed.takeaways;
    changed.push(`key_takeaways(${parsed.takeaways.length} items)`);
  }
  if (parsed.faq.length && !same(out.qa_pairs, parsed.faq)) {
    out.qa_pairs = parsed.faq;
    changed.push(`qa_pairs(${parsed.faq.length} pairs)`);
  }
  if (parsed.summary && out.ai_summary !== parsed.summary) {
    out.ai_summary = parsed.summary;
    changed.push('ai_summary');
  }
  if (parsed.citations.length && !same(out.citations, parsed.citations)) {
    out.citations = parsed.citations;
    changed.push(`citations(${parsed.citations.length} items)`);
  }
  return { geo: out, parsed, changed };
}

// ==================== Markdown → plain text ====================

/** Extract plain text (strip markdown), used to generate the meta description */
function toPlainText(md) {
  return (md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*#+\s*/gm, '')
    .replace(/^\s*---+\s*$/gm, ' ')
    .replace(/>\s?/g, '')
    .replace(/[`~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Generate a meta description from content (first N chars, preferring sentence boundaries) */
function makeDescription(content, maxLen = 150) {
  const text = toPlainText(content);
  if (!text) return '';
  let desc = text.slice(0, maxLen);
  const lastPunct = Math.max(
    desc.lastIndexOf('。'),
    desc.lastIndexOf('，'),
    desc.lastIndexOf('！'),
    desc.lastIndexOf('？')
  );
  if (lastPunct > maxLen * 0.5) desc = desc.slice(0, lastPunct + 1);
  return desc;
}

// ==================== Front Matter / title ====================

/**
 * Parse Front Matter (YAML, via js-yaml).
 *
 * Canonical shape (generic skeleton `docs/templates/skeletons/howto.md`; site
 * instance `sites/tengence/docs/templates/blog-post.md`):
 *   ---
 *   seo:
 *     title: "…"
 *     keywords: ["…", "…"]
 *     meta_description: "…"
 *   featured_image: "https://www.tengence.com/blog/static/images/…/cover.webp"
 *   ---
 *
 * Boundaries (decided 2026-09-17; revised 2026-09-20):
 *   - front matter only holds "meta not rendered in the body": the seo fields +
 *     featured_image; the primary keyword focus_keyword does NOT go into front
 *     matter / the seo object — the article plan table is authoritative;
 *   - summary / key takeaways / FAQ / data sources are body content; the meta copy
 *     of them is reverse-parsed by parseGeoBlocks (body authoritative) and never
 *     goes into front matter;
 *   - publish state (wp_post_id / status) stays out of the md, living in the article
 *     plan / DB.
 *
 * @param {string} content
 * @returns {{data: object|null, content: string}} data = the front-matter object
 *   (null when absent); content = the body (trimmed; returned trimmed as-is when no
 *   front matter)
 */
function parseFrontMatter(content) {
  const text = String(content == null ? '' : content);
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { data: null, content: text.trim() };
  let data = null;
  try {
    data = yaml.load(match[1]);
  } catch (e) {
    // parse failure is treated as no front matter: still strip the front-matter
    // delimiter block (YAML failure must not affect body extraction; body length /
    // render statistics must not include front matter), data set to null meaning the
    // seo fields etc. are unavailable
    return { data: null, content: (match[2] || '').trim() };
  }
  if (!data || typeof data !== 'object') {
    return { data: null, content: (match[2] || '').trim() };
  }
  return { data, content: (match[2] || '').trim() };
}

/**
 * Strip the Front Matter delimiter block (equivalent to parseFrontMatter(md).content;
 * defensive only — local body files should carry front matter per convention, but
 * files without it are unaffected).
 */
function stripFrontMatter(content) {
  return parseFrontMatter(content).content;
}

/** Extract the first H1 title from Markdown body */
function extractTitle(markdown) {
  const match = (markdown || '').match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

// ==================== images ====================

/**
 * Extract Unsplash images from an article (supports both Markdown and HTML notations)
 * @returns {Array<{alt:string, originalUrl:string, fullMatch:string, format:'markdown'|'html'}>}
 */
function extractImageUrls(content) {
  const urls = [];
  const text = content || '';

  const mdRegex = /!\[([^\]]*)\]\((https?:\/\/images\.unsplash\.com\/[^)]+?)\)/g;
  let match;
  while ((match = mdRegex.exec(text)) !== null) {
    urls.push({ alt: match[1], originalUrl: match[2], fullMatch: match[0], format: 'markdown' });
  }

  const htmlRegex = /<img[^>]+src="(https?:\/\/images\.unsplash\.com\/[^"]+)"[^>]*>/g;
  while ((match = htmlRegex.exec(text)) !== null) {
    const altMatch = match[0].match(/alt="([^"]*)"/);
    urls.push({
      alt: altMatch ? altMatch[1] : '',
      originalUrl: match[1],
      fullMatch: match[0],
      format: 'html'
    });
  }

  return urls;
}

/**
 * Extract image URLs from any source (not limited to Unsplash; includes relative /
 * on-site addresses). Used for the "first body image" decision and the Python
 * bypass script's image migration.
 * @returns {Array<{alt:string, originalUrl:string, baseUrl:string, fullMatch:string, format:'markdown'|'html'}>}
 */
function extractAnyImageUrls(content) {
  const urls = [];
  const text = content || '';

  const mdRegex = /!\[([^\]]*)\]\(([^)\s]+?)\)/g;
  let match;
  while ((match = mdRegex.exec(text)) !== null) {
    urls.push({
      alt: match[1],
      originalUrl: match[2],
      baseUrl: match[2].split('?')[0],
      fullMatch: match[0],
      format: 'markdown'
    });
  }

  const htmlRegex = /<img[^>]+src="([^"]+)"[^>]*>/g;
  while ((match = htmlRegex.exec(text)) !== null) {
    const altMatch = match[0].match(/alt="([^"]*)"/);
    urls.push({
      alt: altMatch ? altMatch[1] : '',
      originalUrl: match[1],
      baseUrl: match[1].split('?')[0],
      fullMatch: match[0],
      format: 'html'
    });
  }

  return urls;
}

/**
 * Get the first body image (compatible with Markdown ![alt](url) and HTML <img>),
 * used to set the featured image.
 */
function extractFirstImage(content) {
  const md = /!\[([^\]]*)\]\((https?:\/\/[^)]+?)\)/.exec(content || '');
  if (md) return { alt: md[1], url: md[2], format: 'markdown', fullMatch: md[0] };
  const html = /<img[^>]+src="([^"]+)"[^>]*>/.exec(content || '');
  if (html) {
    const altM = html[0].match(/alt="([^"]*)"/);
    return { alt: altM ? altM[1] : '', url: html[1], format: 'html', fullMatch: html[0] };
  }
  return null;
}

/** Remove a specific image fragment from the body (after it became the featured image, to avoid duplication). */
function removeFirstImage(content, first) {
  return content.replace(first.fullMatch, '');
}

/** Regex metacharacter escape (URLs contain ? & = + . etc. and must be escaped before building regexes) */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove an entire image from the body by URL (used when the first image becomes the
 * featured image and must be removed from the body).
 *
 * ⚠️ **historical bug (fixed 2026-09-16, proven by WP 289/294/299)**: callers used
 * `` `<img src="${url}"` `` — i.e. only up to the src closing quote, without
 * ` alt="…"` and the closing `>` — as the replacement target; after replacing with
 * an empty string, ` alt="Network technology">` remained. That remnant was then
 * parsed as plain text and escaped, producing visible mojibake in the body:
 * `<p> alt=&quot;Network technology&quot;&gt;</p>`. **The whole tag must be matched.**
 *
 * @param {string} content body (mixed markdown or HTML)
 * @param {{url:string, alt?:string, format?:'html'|'markdown'}} img
 * @returns {string}
 */
function removeImageByUrl(content, img) {
  const text = String(content || '');
  const url = img && img.url;
  if (!url) return text;
  const esc = escapeRegExp(url);
  if ((img.format || 'markdown') === 'html') {
    // delete the whole tag: <img … src="url" … > ([^>] excludes >, naturally stops at the first closer)
    return text.replace(new RegExp(`<img\\b[^>]*src="${esc}"[^>]*>`, 'gi'), '');
  }
  const escAlt = escapeRegExp(img.alt || '');
  return text.replace(new RegExp(`!\\[${escAlt}\\]\\(${esc}\\)`, 'g'), '');
}

module.exports = {
  siteDomain,
  isExternalUrl,
  markdownToHtml,
  // publish-time materialization (fallback): when the md omits takeaways / FAQ, fill
  // them into the body from meta
  composeBody,
  // md is authoritative: reverse-parse GEO blocks from the body / sync-override the geo config
  parseGeoBlocks,
  syncGeoFromMarkdown,
  extractCitationFromItem,
  // Front Matter: parse (YAML) / strip
  parseFrontMatter,
  stripFrontMatter,
  /** the single exit for writing a body into WP (= markdownToHtml + composeBody) */
  buildPostHtml,
  renderTakeaways,
  renderFaq,
  // pre-publish protections (2026-09-14): exported so unit tests can verify directly
  fixCjkBold,
  holdRawHtml,
  restoreRawHtml,
  mapOutsideFences,
  toPlainText,
  makeDescription,
  extractTitle,
  extractImageUrls,
  extractAnyImageUrls,
  extractFirstImage,
  removeFirstImage,
  removeImageByUrl,
};
