'use strict';
/**
 * WeChat title matching (2026-11-13)
 * ============================================================================
 * The WeChat draft/publish APIs only give us `titles` — no slug. To map a
 * platform message back to channel_plan rows we have to compare the blog
 * article title with the WeChat news_item title.
 *
 * Two real-world problems make a naive `===` useless:
 *   1. the same article title is rendered differently in WeChat
 *      ("GEO优化技术原理：AI搜索算法深度解析" vs "GEO 优化技术原理：AI 搜索算法深度解析");
 *   2. the same title can legitimately appear twice (re-post), so a match must
 *      be UNIQUE to be trusted — a tie is reported, never written.
 *
 * normalizeTitle() therefore NFKC-folds (full-width → half-width), drops all
 * whitespace and punctuation, and lowercases. Matching is exact-on-normalized
 * first, then a long-prefix fallback (WeChat truncates long titles in some
 * listings), and only when the candidate set is unique.
 * ============================================================================
 */

/** Normalize a title for comparison: NFKC → strip whitespace & punctuation → lowercase. */
function normalizeTitle(input) {
  return String(input == null ? '' : input)
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[：:？?！!，,。.、·\-—_~"'“”‘’`（）()【】[\]{}<>《》…]/g, '')
    .toLowerCase();
}

/** Prefix length used by the fallback match (WeChat truncates very long titles). */
const PREFIX_LEN = 16;

/**
 * Build a title index from platform entries.
 * @param {Array<{titles:string[], payload:any}>} entries
 * @returns {{exact:Map<string, any[]>, prefix:Map<string, any[]>}}
 */
function buildTitleIndex(entries) {
  const exact = new Map();
  const prefix = new Map();
  const push = (map, key, payload) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(payload);
  };
  for (const e of entries || []) {
    for (const raw of (e && e.titles) || []) {
      const n = normalizeTitle(raw);
      if (!n) continue;
      push(exact, n, e.payload);
      if (n.length > PREFIX_LEN) push(prefix, n.slice(0, PREFIX_LEN), e.payload);
    }
  }
  return { exact, prefix };
}

/**
 * Look a title up in an index built by buildTitleIndex().
 * @returns {{hit:boolean, unique:boolean, matches:any[], via:'exact'|'prefix'|null}}
 *   `hit` says something matched; `unique` says exactly ONE distinct payload
 *   matched — only a unique hit may be written to the DB.
 */
function lookupTitle(index, title) {
  if (!index) return { hit: false, unique: false, matches: [], via: null };
  const n = normalizeTitle(title);
  if (!n) return { hit: false, unique: false, matches: [], via: null };
  const exact = index.exact.get(n);
  if (exact && exact.length) {
    const distinct = Array.from(new Set(exact));
    return { hit: true, unique: distinct.length === 1, matches: exact, via: 'exact' };
  }
  // Fallback for truncated titles: WeChat's list view cuts long titles, so a query
  // may be SHORTER than the stored title. Match on the first PREFIX_LEN chars,
  // still requiring a unique hit.
  if (n.length >= PREFIX_LEN) {
    const pre = index.prefix.get(n.slice(0, PREFIX_LEN));
    if (pre && pre.length) {
      const distinct = Array.from(new Set(pre));
      return { hit: true, unique: distinct.length === 1, matches: pre, via: 'prefix' };
    }
  }
  return { hit: false, unique: false, matches: [], via: null };
}

/**
 * Split articles into "already sitting in the draft box" vs "needs a new message".
 * A title that matches SEVERAL drafts counts as NOT duplicate (conservative: better
 * one extra message than silently swallowing someone else's article).
 * Pure: takes [{slug,title}] + draft-box items [{media_id,titles}], changes nothing.
 * @returns {{dup:Array<{slug:string,title:string,mediaId:string}>, kept:Array<Object>}}
 */
function partitionByDrafts(articles, drafts) {
  const index = buildTitleIndex((drafts || []).map((d) => ({ titles: d.titles, payload: d.media_id })));
  const dup = [];
  const kept = [];
  for (const a of articles) {
    const m = lookupTitle(index, a.title);
    if (m.hit && m.unique) dup.push({ slug: a.slug, title: a.title, mediaId: m.matches[0] });
    else kept.push(a);
  }
  return { dup, kept };
}

module.exports = { normalizeTitle, buildTitleIndex, lookupTitle, partitionByDrafts, PREFIX_LEN };
