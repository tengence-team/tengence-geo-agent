/**
 * Article gate-check domain (tengence-geo-sdk/check)
 * ============================================================================
 * Sunk down from commands/check-article.js on 2026-09-20: **check rules, copy, and
 * pass/fail thresholds all preserved verbatim**. The CLI
 * (packages/geo-cli/bin/check-article.js) is now just "parse args → call
 * checkArticle → render the report → exit with the right code".
 *
 * Check dimensions:
 *   word count (per article type via TYPE_RANGES / DIR_TYPE) · banned words ·
 *   Tengence misdescribed as a "search engine" · FAQ answers with an A: prefix ·
 *   front-matter seo four fields · featured-image hard check ·
 *   meta_description length · takeaways/FAQ item counts and materialization · bold
 *   questions · class=/<details> · citation-source dual channel
 *   (body reverse-parsed citations + body data-source block; homepage/level-1
 *   channel pages hard-checked) · pre-writing research brief (AGENTS.md §9 mandatory
 *   gate) · H2 numbering continuity / H3 affiliation · opening summary blockquote ·
 *   trailing bold remnant (soft warning).
 *
 * Conventions:
 *   - Requiring this file has zero side effects; checkArticle lazily loadSite()s.
 *   - No process.exit: exit codes and rendering are the caller's (CLI) job.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const { buildPostHtml, parseGeoBlocks, parseFrontMatter } = require('../content/md');

/**
 * Article gate check
 * @param {{slug:string, dir?:string, type?:string|null}} opts
 *   - slug  article slug (articles table / data/inbox fallback)
 *   - dir   directory name (word-count range inferred from the directory when --type
 *           is not explicit; default industry-insights)
 *   - type  T1..T7 (hard word-count check by type range when explicitly declared)
 * @returns {Promise<{ok:boolean, slug:string, rows:Array<[string,string,boolean,boolean]>,
 *                    warns:string[], research:boolean, researchSource:string|null, counts:object}>}
 *   each rows item [label, value, ok, soft]: soft=true means it's informational only
 *   and does not affect the exit code.
 */
async function checkArticle({ slug, dir = 'industry-insights', type = null, site = null } = {}) {
  const t = require('../index');
  // site context: SITES_ROOT injected via env; app_id from the site .env's APP_ID
  // (default 1); lang from the site's default language. An explicit `site` key (e.g.
  // resolved by the MCP `withSite` helper) wins; when omitted, fall back to the
  // default key so the CLI's single-site convention still works.
  const S = t.site.loadSite(site || undefined);
  const APP_ID = parseInt(process.env.APP_ID || '1', 10);
  const LANG = (S.site && S.site.languages && S.site.languages.default) || 'zh-CN';

  if (!slug) {
    throw new Error('checkArticle requires slug');
  }

  // ===== input: DB is the single authority (content ingested 2026-09-20;
  // <site>/data/inbox is a workspace fallback only) =====
  // mysql2 auto-parses JSON columns into objects; SQLite returns JSON strings — use
  // parseJson uniformly for both shapes
  const parseJson = (s, fb) => { try { if (s && typeof s === 'object') return s; return (s && String(s).trim()) ? JSON.parse(s) : fb; } catch { return fb; } };
  let fm = {};
  let md = '';
  let meta = {}; // meta.json retired (kept for legacy compatibility, always empty)
  let dbArticle = null;
  try {
    dbArticle = await t.db.withConn(async (conn) => {
      const [rows] = await conn.query(
        `SELECT a.content_longtext, a.research_md, a.featured_image, a.seo, a.geo,
                p.focus_keyword AS plan_focus_keyword
           FROM tengence_geo_articles a
           LEFT JOIN tengence_geo_article_plan p
                  ON p.app_id = a.app_id AND p.slug = a.slug AND p.lang = a.lang
          WHERE a.app_id = ? AND a.slug = ? AND a.lang = ? LIMIT 1`,
        [APP_ID, slug, LANG]
      );
      return rows[0] || null;
    });
  } catch (e) { dbArticle = null; }
  if (dbArticle && String(dbArticle.content_longtext || '').trim()) {
    md = dbArticle.content_longtext;
  } else {
    const fallback = path.join(S.siteDir, 'data', 'inbox', LANG, slug + '.md');
    if (fs.existsSync(fallback)) {
      const parsed = parseFrontMatter(fs.readFileSync(fallback, 'utf8'));
      fm = parsed.data || {};
      md = parsed.content || '';
    }
  }
  if (!String(md || '').trim()) {
    throw new Error(`Body not found: articles.content_longtext is empty and data/inbox/${LANG}/${slug}.md does not exist`);
  }
  // effective GEO: body reverse-parse is authoritative; articles.geo is the fallback
  // (for legacy bodies that don't write the three blocks)
  const geo = dbArticle ? parseJson(dbArticle.geo, {}) : (meta.geo || {});
  const qaPairs = (geo && geo.qa_pairs) || [];

  const cn = (md.match(/[一-龥]/g) || []).length;
  const BAD = ['我国', '国内', '海外', '本土', '国外'];
  const hits = BAD.filter((w) => md.includes(w));
  // product-line red line (precise, 2026-09-16): only blocks copy that misdescribes
  // "Tengence product as a search engine"; industry terms like "traditional search
  // engines" / "SEO (search engine optimization)" in GEO/SEO articles are not violations
  const prodAsEngine = (md.match(/Tengence[^。\n，,]{0,12}搜索引擎/g) || []).length;
  const badA = qaPairs.filter((q) => /^A[：:]/.test(String(q.answer || '').trim())).length;

  // seo: articles.seo column wins (front matter retired; legacy fm supported on the
  // file fallback path)
  const fmSeo = (fm && fm.seo && typeof fm.seo === 'object') ? fm.seo : {};
  const seo = Object.keys(fmSeo).length ? fmSeo : (dbArticle ? parseJson(dbArticle.seo, {}) : (meta.seo || {}));
  const mdl = (seo.meta_description || '').length;
  const hasSeoTitle = Boolean((seo.title || '').trim());
  // primary keyword: plan.focus_keyword is authoritative (the articles column
  // retired; seo.focus_keyword is a legacy fallback only)
  const hasFocusKeyword = Boolean(String((dbArticle && dbArticle.plan_focus_keyword) || seo.focus_keyword || '').trim());
  const hasKeywords = Array.isArray(seo.keywords) && seo.keywords.length > 0;
  // featured image (AGENTS.md §5-② completeness gate): the articles.featured_image
  // column is authoritative; no featured image = incomplete, hard publish block
  // (since 2026-09-19, triggered by WP1031).
  const hasFeaturedImage = Boolean(String((dbArticle && dbArticle.featured_image) || fm.featured_image || seo.featured_image || '').trim());

  // Plan C (since 2026-09-15, §2 "FAQ conventions"): key takeaways / FAQ are
  // **written directly into the body**, md authoritative; when the body omits them,
  // meta + composeBody materialize them (legacy articles). Effective value = body
  // when the body writes it, meta otherwise.
  const parsedBlocks = parseGeoBlocks(md);
  const bodyTakeaways = parsedBlocks.takeaways;
  const bodyFaq = parsedBlocks.faq;
  const effTakeaways = bodyTakeaways.length ? bodyTakeaways : (geo.key_takeaways || []);
  const effFaq = bodyFaq.length ? bodyFaq : qaPairs;

  const html = buildPostHtml(md, geo);
  const take = (html.match(/<h2>(关键要点|Key Takeaways)<\/h2>/g) || []).length;
  const faq = (html.match(/<h2>[^<]*(常见问题|FAQ|Frequently Asked Questions)<\/h2>/gi) || []).length;
  const boldQ = (html.match(/<p><strong>(问：|Q:)/g) || []).length;
  const cls = (html.match(/class="/g) || []).length;
  const det = (html.match(/<details/gi) || []).length;

  // ===== citation-source link completeness =====
  // Channel 1: citations reverse-parsed from the body "数据来源" block — every one
  // must have a url (guaranteed by the reverse-parse)
  // Channel 2: the body "数据来源 / 引用来源" block source text — every list item
  // must carry a link (hard check, user-visible); links to homepage/level-1 channel
  // pages are a hard block (AGENTS.md hard requirement: citations must point to a
  // specific page carrying the data)
  const bodyCitations = parsedBlocks.citations || [];
  const legacyCites = (meta.geo && meta.geo.citations) || [];
  const cites = bodyCitations.length ? bodyCitations : legacyCites;
  const CHANNEL_SEGS = new Set(['blog','news','articles','resources','wiki','docs','topics','category','categories','tag','tags','insights','learn','product','products','services','about','help','support','pricing','contact','search','geo']);
  // Non-specific-page judgment (hard violation):
  //  1) homepage: pathname empty or '/' and no specific-post query like ?p=/?page_id=;
  //  2) level-1 channel/category page: pathname of exactly 1 segment and a known
  //     channel name (blog/news/wiki/...), and no specific-post query.
  // Deep specific pages (with ?p= specific post, /slug guide, /Organization, etc.)
  // count as specific pages and are not blocked.
  const isNonSpecificPage = (u) => {
    try {
      const p = new URL(u);
      const seg = p.pathname.replace(/^\/+|\/+$/g, '');
      const segs = seg === '' ? [] : seg.split('/');
      const specificPost = ['p','page_id','id','post','slug','shareId','share_id'].some((k) => p.searchParams.has(k));
      if (segs.length === 0) return !specificPost;                     // homepage (no specific-post query)
      if (segs.length === 1) return CHANNEL_SEGS.has(segs[0]) && !specificPost; // level-1 channel
      return false;                                                    // deep specific page
    } catch { return false; }
  };
  const missCit = cites.filter((c) => !c || !String(c.url || '').trim()); // hard: missing url
  const nonSpecCit = cites.filter((c) => { const u = String(c.url || '').trim(); return u && isNonSpecificPage(u); }); // hard: homepage/channel-level

  // Channel 2: the body "数据来源 / 引用来源" block (compatible with both the bold
  // legacy notation and the new ## heading)
  const srcIdx = md.search(/\*\*(数据来源|Data Sources)\*\*|\*\*(引用来源|References)\*\*|^##\s*(数据来源|Data Sources|引用来源|References)/m);
  let srcItemTotal = 0;
  let srcItemsNoLink = 0;   // hard: list item without any link
  let srcNonSpecItems = 0;   // hard: list item pointing to a homepage/level-1 channel
  if (srcIdx >= 0) {
    const tail = md.slice(srcIdx);
    const end = tail.search(/\n## |\n---+|\n\*\*(相关阅读|Related Reading)\*\*/);
    const block = end >= 0 ? tail.slice(0, end) : tail;
    // a list item's link: Markdown [text](https://...) or HTML <a href>
    // (AGENTS.md says body links are written in Markdown and the publish script adds
    // target=_blank; both notations count)
    const linkUrl = (ln) => {
      const m = ln.match(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/) ||
                ln.match(/<a\s+[^>]*href=["'](https?:\/\/[^"'\s]+)["']/i);
      return m ? m[1] : null;
    };
    for (const ln of block.split('\n')) {
      // ordered-list (1. ) and unordered-list (- / *) items both count as citation
      // items (2026-09-16 addition: previously only 1. was recognized, missing `- `)
      if (/^\s*(?:\d+\.|[-*])\s/.test(ln) || /<li>/.test(ln)) {
        srcItemTotal++;
        const u = linkUrl(ln);
        if (!u) srcItemsNoLink++;
        else if (isNonSpecificPage(u)) srcNonSpecItems++;
      }
    }
  }

  // ===== word count: checked by article type (2026-09-18) =====
  // Type ranges are consistent with sites/tengence/docs/templates/TEMPLATES.md.
  // Explicit --type → hard check on that type's range; not declared → inferred from
  // dir (soft notice only, no block).
  // 2026-09-20 range revision: T4 (case roundups) and T7 (product docs) previously
  // capped at 3500 / 2500 — measured too narrow: multi-industry roundups need
  // "four-section per industry + cross-industry patterns + FAQ", and docs need lists
  // and tables. Deleting whole sections to fit the cap breaks the argument chain and
  // leaves dangling citations (body data deleted but its sources not). Hence widened
  // to T4 [2800,4500] and T7 [1800,3500]; writing prioritizes logical completeness.
  const TYPE_RANGES = {
    T1: [2200, 3200], T2: [3000, 4200], T3: [3200, 4500], T4: [2800, 4500],
    T5: [2600, 3800], T6: [2200, 3200], T7: [1800, 3500],
  };
  const DIR_TYPE = {
    'case-studies': { label: 'T4 case roundup', range: TYPE_RANGES.T4 },
    'product-guides': { label: 'T7 product doc', range: TYPE_RANGES.T7 },
    'industry-insights': { label: 'T1/T5/T6', range: [2200, 3800] },
    'product-solutions': { label: 'T1/T2/T3/T6', range: [2200, 4500] },
  };
  const typeArg = String(type || '').trim().toUpperCase();
  const typeExplicit = Boolean(TYPE_RANGES[typeArg]);
  const typeInfo = typeExplicit
    ? { label: typeArg, range: TYPE_RANGES[typeArg] }
    : (DIR_TYPE[dir] || { label: 'generic', range: [2200, 4500] });
  const wcOk = cn >= typeInfo.range[0] && cn <= typeInfo.range[1];
  const wcLabel = 'Chinese char count (' + typeInfo.label + ' ' + typeInfo.range[0] + '–' + typeInfo.range[1] + ')';

  const rows = [
    // 4th element soft=true means the row is informational only and doesn't affect
    // the exit code (word count inferred from dir when --type is not explicit)
    [wcLabel, cn, wcOk, !typeExplicit],
    ['Banned words hit', hits.length ? hits.join('/') : '0', hits.length === 0],
    ['Tengence misdescribed as "search engine"', prodAsEngine, prodAsEngine === 0],
    ['FAQ answers with A: prefix', badA, badA === 0],
    ['front-matter seo four fields', [hasSeoTitle, hasFocusKeyword, hasKeywords, mdl > 0].filter(Boolean).length + '/4', hasSeoTitle && hasFocusKeyword && hasKeywords && mdl > 0],
    ['front-matter featured_image (featured-image hard check, §5-②)', hasFeaturedImage ? 'present' : 'missing', hasFeaturedImage],
    ['meta_description chars', mdl, mdl >= 165 && mdl <= 175],
    ['takeaway count (body/meta effective)', effTakeaways.length, effTakeaways.length >= 5],
    ['FAQ pair count (body/meta effective)', effFaq.length, effFaq.length >= 5],
    ['materialized takeaways block', take, take === 1],
    ['materialized FAQ block', faq, faq === 1],
    ['bold question count', boldQ, boldQ === effFaq.length],
    ['class= / <details>', cls + ' / ' + det, cls === 0 && det === 0],
    ['citations (body reverse-parsed) with links', cites.length ? (cites.length - missCit.length) + '/' + cites.length : 'none', cites.length === 0 || missCit.length === 0],
    ['body data-source items each with a link', srcItemTotal ? (srcItemTotal - srcItemsNoLink) + '/' + srcItemTotal : 'no block', srcItemTotal === 0 || srcItemsNoLink === 0],
    ['citations banned homepage/channel-level (hard)', cites.length ? (nonSpecCit.length ? nonSpecCit.length + ' violations' : 'none') : 'none', nonSpecCit.length === 0],
    ['body data-source banned homepage/channel-level (hard)', srcItemTotal ? (srcNonSpecItems ? srcNonSpecItems + ' violations' : 'none') : 'no block', srcNonSpecItems === 0],
  ];

  // Soft warnings (no publish block, cleanup advice only; homepage/channel-level
  // citations were upgraded to a hard check on 2026-09-20, see the "banned
  // homepage/channel-level (hard)" rows)
  const warns = [];
  // legacy-compatibility notice: citations still only in meta.json, no body
  // "数据来源" block (post-publish, the body will be authoritative and it will be lost)
  if (legacyCites.length && !bodyCitations.length) {
    warns.push('citations still only live in meta.json (body has no "数据来源" block); after migration, publish uses the body — consider writing the block');
  }

  // ===== pre-writing research brief (AGENTS.md §9: the mandatory research gate
  // before writing the body; upgraded from soft warning to hard check 2026-09-18) =====
  // Based on root AGENTS.md "九、文章写作前研究" and article-writer stage 0: the
  // research brief is the mandatory pre-writing gate artifact; missing blocks publish
  // (hard check, exit code 1). Same lang as the article.
  const researchPath = path.join(S.siteDir, 'data', 'inbox', LANG, slug + '.research.md');
  let hasResearch = fs.existsSync(researchPath);
  let researchSource = hasResearch ? 'file' : null;
  if (!hasResearch) {
    // DB fallback: articles.research_md (brief ingested; the file may be deleted after)
    try {
      hasResearch = await t.db.withConn(async (conn) => {
        const [rows] = await conn.query(
          `SELECT research_md FROM tengence_geo_articles WHERE app_id = ? AND slug = ? AND lang = ? AND research_md IS NOT NULL LIMIT 1`,
          [APP_ID, slug, LANG]
        );
        return rows.length > 0;
      });
      if (hasResearch) researchSource = 'articles.research_md';
    } catch (e) {
      hasResearch = false;
    }
  }
  if (!hasResearch) {
    warns.push('No pre-writing research brief found (file or articles.research_md; AGENTS.md §9: the mandatory pre-writing research gate — missing blocks publish)');
  }
  rows.push(['pre-writing research brief (AGENTS.md §9 mandatory gate)', hasResearch ? (researchSource || 'present') : 'missing', hasResearch]);

  // ===== heading-level soft checks (added 2026-09-16 plan A, no publish block) =====
  // 1. H2 Chinese-numbered continuity (一、二、三… must be continuous, no skipped or
  // repeated numbers)
  const CN_NUM = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
    十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19, 二十: 20,
  };
  const h2Nums = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^##\s*([一二三四五六七八九十]+)、/);
    if (m && CN_NUM[m[1]] != null) h2Nums.push(CN_NUM[m[1]]);
  }
  if (h2Nums.length) {
    const expected = h2Nums.map((_, i) => i + 1);
    if (JSON.stringify(h2Nums) !== JSON.stringify(expected)) {
      warns.push(
        'H2 numbering not continuous / out of order: ' + h2Nums.join('→') +
        ' (expected 1→…→' + h2Nums.length + ', ' + h2Nums.length + ' numbered sections)'
      );
    }
  }

  // 1b. H3 numbering affiliation (X.Y's X must equal the enclosing H2 number,
  // added 2026-09-18, non-blocking)
  {
    let curH2 = null;
    const h3bad = [];
    for (const line of md.split('\n')) {
      const h2m = line.match(/^##\s*([一二三四五六七八九十]+)、/);
      if (h2m && CN_NUM[h2m[1]] != null) { curH2 = CN_NUM[h2m[1]]; continue; }
      if (/^##\s/.test(line)) { curH2 = null; continue; }
      const h3m = line.match(/^#{3,4}\s*(\d+)\.(\d+)/);
      if (h3m && (curH2 == null || parseInt(h3m[1], 10) !== curH2)) {
        h3bad.push(line.trim());
      }
    }
    if (h3bad.length) {
      warns.push('H3 numbering not affiliated with its enclosing H2 (X.Y\'s X should be the current H2 number): ' + h3bad.join(' | '));
    }
  }

  // 2. opening summary blockquote (the first non-empty content after the H1 should
  // be `> **摘要**：…`, the authoring source of the GEO ai_summary)
  const firstContent = md
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && !l.startsWith('<!--'));
  // The documented convention (block-conventions.md / article-writing-standards.md)
  // is `> **Summary:**` with the colon INSIDE the bold; align the warning to that
  // form (also tolerates the colon outside the bold).
  if (!/^>\s*\*\*(摘要|Summary)\s*[：:]\*\*\s*[：:]?/.test(firstContent || '')) {
    warns.push('First content after the H1 is not a "> **摘要**：" blockquote (the authoring source of the GEO ai_summary; consider adding it)');
  }

  // 3. legacy bold remnant at the end of the body (should be upgraded to ## headings;
  // templates / site conventions already upgraded)
  const legacyBold = (md.match(/\*\*(相关阅读|数据来源|立即行动|引用来源|Related Reading|Data Sources|Get Started|References)\*\*/g) || []).length;
  if (legacyBold) {
    warns.push('End-of-body blocks still use the bold notation in ' + legacyBold + ' places (should be upgraded to ## Related Reading / ## Data Sources / ## Get Started)');
  }

  // hard-check summary (soft rows don't affect the result)
  let ok = true;
  for (const [, , rowOk, soft] of rows) {
    if (!rowOk && !soft) ok = false;
  }

  return {
    ok,
    slug,
    rows,
    warns,
    research: hasResearch,
    researchSource,
    counts: { cn },
    // unknown --type notice (CLI rendering; byte-identical to pre-sink-down)
    unknownType: typeArg && !typeExplicit ? typeArg : null,
  };
}

module.exports = { checkArticle };
