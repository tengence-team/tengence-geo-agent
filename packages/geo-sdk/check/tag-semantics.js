/**
 * Tag / category semantics for the publish gate (G18, 2026-11-05)
 * ============================================================================
 * Why this exists: the 2026-11 batch generated tags from **category templates**
 * instead of from each article's topic. `algolia-alternatives-for-site-search`
 * (a site-search engine comparison) shipped with `ai-ask` (natural-language BI,
 * a Tengence Insight capability), and `plan.tags` also carried `search-recommend`
 * — a *category* slug. The old gate only checked "tags non-empty / whitelisted /
 * category matches plan", so every one of those defects was formally green.
 *
 * This module is a **pure function** (no DB, no site, no I/O) so the rule is
 * unit-testable and can be reused by checkArticle, the CLI and backfill scans.
 * `checkArticle` turns its verdict into ALWAYS-HARD rows (5th row element true):
 * even an already-published article being re-published is blocked, because a
 * mismatched tag is a live taxonomy defect, not a legacy formatting artifact.
 *
 * Decision chain (conservative on purpose — a false block stops the daily publish):
 *   1. Derive the article's primary domain from title + focus keyword + excerpt.
 *      Top domain must lead the runner-up by >= 2 distinct evidence terms,
 *      otherwise the domain is AMBIG and the cross-domain rule is skipped.
 *   2. Hard: any tag slug that is actually a category slug (pseudo-tag).
 *   3. Hard: a STRONG tag whose domain differs from the primary domain is only
 *      tolerated when the article body carries >= 2 distinct evidence terms of
 *      that tag's domain (a genuinely cross-domain article).
 *   4. Neutral tags (comparison / pricing / ecommerce / saas / b2b-export ...)
 *      are never mapped to a domain and therefore never blocked.
 *   5. Optional: product-line category vs primary domain conflict. Product
 *      categories (geo-ai-search / search-recommend / data-growth) must not
 *      contradict a primary domain that all strong tags agree on. Editorial
 *      shape categories (industry-insights / product-solutions / case-studies /
 *      product-guides) are intentionally exempt.
 * ============================================================================
 */

'use strict';

const DOMAINS = ['GEO', 'SEARCH', 'INSIGHT'];

/** Category slugs that must never appear in a tag list (2026-11-05 incident). */
const CATEGORY_SLUGS = new Set([
  'geo-ai-search', 'data-growth', 'search-recommend', 'product-solutions',
  'industry-insights', 'case-studies', 'product-guides',
]);

/** Product-line categories carry a domain; shape categories do not. */
const CATEGORY_DOMAIN = {
  'geo-ai-search': 'GEO',
  'search-recommend': 'SEARCH',
  'data-growth': 'INSIGHT',
};

/**
 * Tags with an unambiguous product capability meaning. Everything absent from
 * this map is neutral (topic / format / audience) and never triggers G18.
 */
const STRONG_DOMAIN_TAGS = {
  GEO: [
    'tengence-geo', 'geo-seo', 'geo-monitoring', 'geo-diagnosis', 'schema-markup',
    'entity-authority', 'international-seo', 'technical-seo', 'core-web-vitals',
    'ai-content-disclosure',
  ],
  SEARCH: [
    'tengence-search', 'search-system', 'site-search', 'query-understanding',
    'vector-search', 'rag', 'ranking-algorithm', 'recommendation-system',
  ],
  INSIGHT: [
    'tengence-insight', 'ai-ask', 'report-automation', 'data-analytics',
    'funnel-analysis', 'user-segmentation', 'user-profile', 'user-data',
    'ab-testing',
  ],
};
const TAG_DOMAIN = {};
for (const d of DOMAINS) for (const t of STRONG_DOMAIN_TAGS[d]) TAG_DOMAIN[t] = d;

/**
 * Ownership tags assert *which product the article belongs to / which product
 * capability it is about*, not a loose topic: the three brand tags plus each
 * product's exclusive capability names (`ai-ask` = natural-language BI in
 * Insight, `site-search`/`query-understanding` = Search, `geo-monitoring` =
 * GEO ...). Body boilerplate ("About Tengence") and generic data vocabulary
 * ("report", "funnel", "retrieval") must never be accepted as rebuttal
 * evidence for these — otherwise the exact 2026-11-05 accident (`ai-ask` on
 * an Algolia comparison) slips through. Only the headline counts.
 *
 * Scope validated against the 570-row corpus: adding `search-system` /
 * `vector-search` / `funnel-analysis` here would flag 8 more slugs whose bodies
 * genuinely discuss those techniques, so they stay ordinary strong tags.
 */
const OWNERSHIP_TAGS = new Set([
  'tengence-geo', 'tengence-search', 'tengence-insight',
  'ai-ask', 'report-automation', 'site-search', 'query-understanding',
  'geo-monitoring', 'geo-diagnosis',
]);

// Fixed scaffolding blocks. Every article carries an "About Tengence" section
// listing all three product lines; counting it as topic evidence made the
// cross-domain exemption meaningless (2026-11-05 regression).
const BOILERPLATE_HEAD = /^(?:Key Takeaways|FAQ|About|Related Reading|Data Sources|Get Started|References|關鍵要點|常見問題|关于|關於|相關閱讀|資料來源|立即行动|立即行動|参考文献|关键要点|常见问题|相关阅读|数据来源|资料来源|摘要|总结|结语|结论|Conclusion|Summary|Table of Contents|目录|快速开始|Quick Start|Related Resources)/;

/** Body with scaffolding sections removed — topic evidence only. */
function topicBody(md) {
  const out = [];
  let inBoilerplate = false;
  for (const line of String(md || '').split('\n')) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) { inBoilerplate = BOILERPLATE_HEAD.test(h[1].trim()); continue; }
    if (!inBoilerplate) out.push(line);
  }
  return out.join('\n');
}

/**
 * Distinct evidence terms per domain. Covers zh-hans / zh-hant / en so a
 * translation row can be judged with the same rule as its zh-hans source.
 * Scoring counts DISTINCT terms, not occurrences, so a single repeated word
 * cannot manufacture a domain.
 */
const DOMAIN_EVIDENCE = {
  GEO: [
    'GEO', '生成式引擎', '產生式引擎', 'AI 搜索', 'AI搜索', 'AI 搜尋', 'AI搜尋',
    'AI 答案', 'AI答案', '被引用', '引用率', '引用機制', '引用机制', '可見性', '可见性',
    '可見度', '可见度', 'AI Overviews', 'Perplexity', 'ChatGPT', 'Gemini', 'LLM',
    '大模型', '外鏈', '外链', 'Schema', '結構化數據', '结构化数据', '品牌聲量',
    '品牌声量', '出海', '獨立站', '独立站', 'hreflang', 'AI 引用', '答案引擎',
    '零點擊', '零点击', 'SEO', '收錄', '收录', 'SERP', 'AI 摘要', '搜尋引擎最佳化',
    'generative engine', 'AI search', 'AI answer', 'AI Answers', 'cited', 'citation',
    'citations', 'visibility', 'answer engine', 'zero-click', 'backlink',
    'structured data', 'brand mention', 'AI visibility',
  ],
  SEARCH: [
    '站內搜索', '站内搜索', '站內檢索', '站内检索', '站內搜尋', '搜索框', '搜尋框',
    '搜索系统', '搜索系統', '搜尋系統', '召回', '倒排', '分詞', '分词', '同義詞',
    '同义词', '精排', '粗排', '向量', 'RAG', '查詢理解', '查询理解', '聯想詞',
    '联想词', '零結果', '零结果', 'P95', 'Elasticsearch', 'Algolia', 'OpenSearch',
    'Typesense', 'Meilisearch', '推薦系統', '推荐系统', '推薦位', '推荐位',
    '搜索體驗', '搜索体验', '搜尋體驗', '搜索中台', '知識庫搜索', '知识库搜索',
    '搜索 API', '混合檢索', '混合检索', '語義檢索', '语义检索', 'MCP', '檢索', '检索',
    'site search', 'enterprise search', 'search API', 'inverted index', 'tokenizer',
    'synonym', 'recall', 'ranking', 'vector search', 'query understanding',
    'autocomplete', 'zero results', 'hybrid search', 'semantic search',
    'relevance tuning', 'search engine',
  ],
  INSIGHT: [
    '問數', '问数', '自然語言查詢', '自然语言查询', 'NL2SQL', 'BI', '報表', '报表',
    '看板', '歸因', '归因', '留存', '用戶分群', '用户分群', '畫像', '画像', 'A/B',
    'AB 測試', 'AB 测试', '數據分析', '数据分析', '數據平台', '数据平台',
    '業務數據', '业务数据', '數據接入', '数据接入', '語義層', '语义层',
    '指標字典', '指标字典', '漏斗', 'ROI', '轉化分析', '转化分析', '人群分析',
    '路徑分析', '路径分析', '報表自動化', '报表自动化',
    'natural language query', 'NL2SQL', 'dashboard', 'attribution', 'retention',
    'cohort', 'user segmentation', 'A/B test', 'data analytics', 'data platform',
    'semantic layer', 'metric dictionary', 'funnel', 'ROI', 'conversion analysis',
    'report automation',
  ],
};

/** Distinct evidence terms of `domain` present in `text` (case-insensitive). */
function evidenceHits(domain, text) {
  const hay = String(text || '').toLowerCase();
  return (DOMAIN_EVIDENCE[domain] || []).filter((w) => hay.includes(w.toLowerCase()));
}

/**
 * Primary domain from the article's headline material.
 * @returns {{domain:string|null, scores:Object}} null when ambiguous/undetermined
 */
function primaryDomain({ title = '', keyword = '', excerpt = '' } = {}) {
  const head = [title, keyword, excerpt].filter(Boolean).join(' | ');
  if (!String(head).trim()) return { domain: null, scores: {} };
  const scores = {};
  for (const d of DOMAINS) scores[d] = evidenceHits(d, head).length;
  const ranked = DOMAINS.slice().sort((a, b) => scores[b] - scores[a]);
  const top = ranked[0], second = ranked[1];
  if (scores[top] === 0 || scores[top] - scores[second] < 2) {
    return { domain: null, scores };
  }
  return { domain: top, scores };
}

/**
 * Full G18 verdict.
 * @param {Object} p
 * @param {string[]} p.tags              effective tag slugs (plan row, zh-hans fallback)
 * @param {string}  [p.title]            headline material — preferably the zh-hans source
 * @param {string}  [p.keyword]          plan.focus_keyword
 * @param {string}  [p.excerpt]          article excerpt
 * @param {string}  [p.body]             body markdown (first ~3k chars are enough)
 * @param {string}  [p.category]         product-line / shape category slug
 * @param {boolean} [p.taxonomyResolved] false when the taxonomy lookup itself failed
 * @returns {{ok:boolean, resolved:boolean, tagsEmpty:boolean, domain:string|null,
 *            scores:Object, pseudoTags:string[], mismatches:Array,
 *            categoryConflict:string|null, reason:string}}
 */
function checkTagSemantics({
  tags = [], title = '', keyword = '', excerpt = '', body = '',
  category = '', taxonomyResolved = true,
} = {}) {
  const list = Array.isArray(tags) ? tags.map(String) : [];
  const pseudoTags = list.filter((t) => CATEGORY_SLUGS.has(t));

  // A failed taxonomy lookup is an infrastructure fault, not a content defect.
  // Report it loudly (checkArticle adds a warning) but never block the publish.
  if (!taxonomyResolved) {
    return {
      ok: true, resolved: false, tagsEmpty: false, domain: null, scores: {},
      pseudoTags, mismatches: [], categoryConflict: null,
      reason: 'taxonomy lookup unavailable — G18 advisory (infrastructure fault, not a content defect)',
    };
  }

  const { domain, scores } = primaryDomain({ title, keyword, excerpt });
  const head = [title, keyword, excerpt].filter(Boolean).join(' | ');
  // Topic-only body: boilerplate sections are excluded so an "About Tengence"
  // capability list cannot manufacture cross-domain evidence.
  const core = String(topicBody(body)).slice(0, 3000);
  const full = [head, core].filter(Boolean).join(' | ');
  const mismatches = [];
  if (domain) {
    for (const t of list) {
      const td = TAG_DOMAIN[t];
      if (!td || td === domain) continue;
      // Ownership tags assert product ownership: headline evidence only, never body.
      const ev = evidenceHits(td, OWNERSHIP_TAGS.has(t) ? head : full);
      if (ev.length < 2) {
        mismatches.push({ tag: t, tagDomain: td, articleDomain: domain, evidence: ev.slice(0, 3) });
      }
    }
  }

  // Category vs primary domain: only product-line categories are checked, and
  // only when every strong tag agrees on the same domain (unambiguous signal).
  let categoryConflict = null;
  const catDom = CATEGORY_DOMAIN[category];
  if (domain && catDom && catDom !== domain) {
    const strong = list.map((t) => TAG_DOMAIN[t]).filter(Boolean);
    if (strong.length >= 2 && strong.every((d) => d === domain)) {
      const ev = evidenceHits(catDom, core);
      if (ev.length < 2) categoryConflict = category + '(' + catDom + ') vs ' + domain;
    }
  }

  const tagsEmpty = list.length === 0;
  const ok = !tagsEmpty && pseudoTags.length === 0 && mismatches.length === 0 && !categoryConflict;
  const bits = [];
  if (tagsEmpty) bits.push('tags empty');
  if (pseudoTags.length) bits.push('category-slug pseudo-tags: ' + pseudoTags.join(', '));
  if (mismatches.length) {
    bits.push('domain mismatch: ' + mismatches.map((m) =>
      `${m.tag}[${m.tagDomain}] on ${m.articleDomain} article (evidence ${m.evidence.join('/') || 'none'})`
    ).join('; '));
  }
  if (categoryConflict) bits.push('category conflict: ' + categoryConflict);
  return {
    ok, resolved: true, tagsEmpty, domain, scores, pseudoTags, mismatches,
    categoryConflict, reason: bits.length ? bits.join(' | ') : 'tags match article topic',
  };
}

module.exports = {
  checkTagSemantics, primaryDomain, evidenceHits, topicBody,
  CATEGORY_SLUGS, CATEGORY_DOMAIN, STRONG_DOMAIN_TAGS, TAG_DOMAIN, DOMAIN_EVIDENCE, DOMAINS, OWNERSHIP_TAGS,
};
