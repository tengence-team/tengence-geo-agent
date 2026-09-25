'use strict';
/**
 * Juejin taxonomy resolver (tengence-geo-sdk/syndicate/juejin-taxonomy)
 * ============================================================================
 * Turns OUR article taxonomy (the blog's category/tag slugs, stored in
 * article_plan) into the PLATFORM's own category_id / tag_ids, using the
 * platform dictionary cached in the channel_taxonomy table.
 *
 * Why a dictionary instead of a per-site mapping file:
 *   the platform's taxonomy is platform knowledge, not site knowledge. Caching it
 *   once (platform-scoped) means EVERY site publishes to Juejin with no config file
 *   of its own — portability. Sites may still override via an OPTIONAL
 *   <siteDir>/juejin-taxonomy.json, but nothing requires it.
 *
 * Resolution chain (each layer falls through to the next; publishing NEVER fails
 * for a missing category/tag — Juejin rejects an article without both, err_no 1002/1003):
 *
 *   category
 *     1. built-in / site aliases  our slug → platform category NAME → dict id
 *     2. our slug as a NAME          (a site may name a category after the platform's)
 *     3. the default NAME            (人工智能) → dict id
 *     4. env JUEJIN_CATEGORY_ID
 *     5. the dictionary's first category (name order)
 *     6. hard-coded 人工智能 id
 *
 *   tags (up to 5, deduped, in order)
 *     1. exact platform name match on our tag slug
 *     2. built-in / site alias      our slug → platform tag NAME(S) → dict id
 *     3. token aliases              generic keyword → platform tag NAME(S) → dict id
 *        (this layer is what makes OTHER sites work without any alias entry)
 *     4. fuzzy contains match       normalized name contains / is contained
 *     5. env JUEJIN_TAG_ID
 *     6. the dictionary's first tag
 *     7. hard-coded 人工智能 id
 *
 * Infix matching (layers 4) runs IN MEMORY over the small dictionary: no SQL index
 * can serve a `contains` search (see db/sqlite-schema.js).
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');

const t = require('../index');
const repo = require('../db/channel-taxonomy');
const juejin = require('./juejin');

const PLATFORM = 'juejin';

/** Hard-coded last-resort ids (Juejin's 人工智能 category / tag). */
const FALLBACK_CATEGORY_ID = '6809637773935378440';
const FALLBACK_TAG_ID = '6809640642101116936';
const DEFAULT_CATEGORY_NAME = '人工智能';
const DEFAULT_TAG_NAME = '人工智能';
const MAX_TAGS = 5;
const FUZZY_MIN_LEN = 3;
const FUZZY_MIN_RATIO = 0.4;

/**
 * Built-in aliases: OUR category slug → the platform's category NAME.
 * Kept in code (shipped with the SDK), deliberately NOT a per-site file.
 */
const CATEGORY_ALIASES = {
  'search-recommend': '人工智能',
  'geo-ai-search': '人工智能',
  'industry-insights': '人工智能',
  'case-studies': '人工智能',
  'product-solutions': '后端',
  'product-guides': '后端',
  'data-growth': '后端',
};

/**
 * Built-in aliases: OUR tag slug → the platform's tag NAME(S), most relevant first.
 * Terms absent from the platform word list (推荐系统/电商/出海/向量/大模型/RAG) are
 * mapped to their nearest existing tag (算法/产品/LLM/AIGC/人工智能). Slugs not listed
 * here fall through to the generic token layer, then to fuzzy, then to the default.
 */
const TAG_ALIASES = {
  'technical-solutions': ['架构', '后端'],
  'geo-seo': ['SEO'],
  'search-system': ['搜索引擎'],
  'data-analytics': ['数据分析'],
  'tengence-search': ['搜索引擎'],
  'tengence-geo': ['人工智能'],
  'conversion-optimization': ['增长黑客'],
  'recommendation-system': ['算法'],
  'user-data': ['数据分析'],
  'technical-seo': ['SEO'],
  'schema-markup': ['SEO'],
  'international-seo': ['SEO'],
  'entity-authority': ['人工智能'],
  'geo-monitoring': ['人工智能'],
  'ai-content-disclosure': ['AIGC'],
  'ai-transformation': ['AIGC'],
  'api-integration': ['后端'],
  'implementation-guide': ['后端'],
  'core-web-vitals': ['前端'],
  'rag': ['LLM'],
  'vector-search': ['LLM'],
  'ecommerce': ['产品'],
};

/**
 * Generic aliases: a normalized KEYWORD token (any site, zh/en) → the platform's
 * tag NAME(S). This layer is what lets an unrelated site resolve without any
 * per-site alias entry; it matches single slug tokens, never substrings, so short
 * keys such as "ai" cannot match "explain".
 */
const TOKEN_ALIASES = {
  ai: ['人工智能'],
  aigc: ['AIGC'],
  gpt: ['ChatGPT'],
  chatgpt: ['ChatGPT'],
  llm: ['LLM'],
  rag: ['LLM'],
  vector: ['LLM'],
  embedding: ['LLM'],
  semantic: ['LLM'],
  nlp: ['NLP'],
  ml: ['机器学习'],
  'machine-learning': ['机器学习'],
  'knowledge-graph': ['机器学习'],
  search: ['搜索引擎'],
  seo: ['SEO'],
  geo: ['搜索引擎'],
  recommend: ['算法'],
  recommendation: ['算法'],
  algorithm: ['算法'],
  ranking: ['排序算法'],
  data: ['数据分析'],
  analytics: ['数据分析'],
  bigdata: ['大数据'],
  database: ['数据库'],
  'data-visualization': ['数据可视化'],
  visualization: ['数据可视化'],
  crawler: ['爬虫'],
  crawl: ['爬虫'],
  architecture: ['架构'],
  backend: ['后端'],
  frontend: ['前端'],
  api: ['后端'],
  ecommerce: ['产品'],
  growth: ['增长黑客'],
  marketing: ['运营'],
  operations: ['运营'],
  monitor: ['运维'],
  monitoring: ['运维'],
  automation: ['运维'],
  'open-source': ['开源'],
  opensource: ['开源'],
  人工智能: ['人工智能'],
  机器学习: ['机器学习'],
  深度学习: ['深度学习'],
  大模型: ['LLM'],
  AIGC: ['AIGC'],
  搜索: ['搜索引擎'],
  推荐: ['算法'],
  算法: ['算法'],
  数据分析: ['数据分析'],
  大数据: ['大数据'],
  数据可视化: ['数据可视化'],
  数据库: ['数据库'],
  爬虫: ['爬虫'],
  架构: ['架构'],
  后端: ['后端'],
  前端: ['前端'],
  运维: ['运维'],
  增长: ['增长黑客'],
  电商: ['产品'],
};

/** Normalize a slug: lowercase, underscores/spaces → dash. */
function norm(slug) {
  return String(slug == null ? '' : slug).trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/** Comparable key for a NAME: strip everything but letters/digits/CJK. */
function nameKey(name) {
  return String(name == null ? '' : name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

/** Split a slug into its dash tokens (Chinese slugs stay one token). */
function tokensOf(slug) {
  return norm(slug).split('-').filter(Boolean);
}

function nowString() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Read the OPTIONAL per-site override file. Absence is normal, never an error. */
function readSiteOverride(siteDir) {
  if (!siteDir) return null;
  const file = path.join(siteDir, 'juejin-taxonomy.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`[juejin-taxonomy] ignoring malformed ${file}: ${e.message}`);
    return null;
  }
}

/** Merge the site override on top of the built-in alias tables (site wins). */
function mergeAliases(override) {
  // Alias keys are normalized so a site may write them with underscores/spaces:
  //   category/tag maps keyed by slug (dash form); token map keyed by the
  //   dash-stripped comparable form, so both "machine-learning" and "machinelearning"
  //   can be looked up from a slug.
  const rekey = (obj, keyFn) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[keyFn(k)] = Array.isArray(v) ? v : [v];
    return out;
  };
  const builtin = {
    category: CATEGORY_ALIASES,
    tag: TAG_ALIASES,
    token: TOKEN_ALIASES,
  };
  const site = {
    category: (override && override.category) || {},
    tag: (override && override.tags) || {},
    token: (override && override.tokenAliases) || {},
  };
  return {
    category: rekey({ ...builtin.category, ...site.category }, norm),
    tag: rekey({ ...builtin.tag, ...site.tag }, norm),
    token: rekey({ ...builtin.token, ...site.token }, nameKey),
    defaultCategory: (override && override.defaultCategory) || DEFAULT_CATEGORY_NAME,
    defaultTag: (override && override.defaultTag) || DEFAULT_TAG_NAME,
  };
}

/** Build the in-memory lookup index from dictionary rows. */
function buildIndex(rows) {
  return rows.map((r) => ({
    id: String(r.external_id),
    name: r.name,
    key: nameKey(r.name),
    heat: r.extra && r.extra.post_article_count ? r.extra.post_article_count : 0,
  }));
}

/**
 * Fetch the platform dictionary and cache it into channel_taxonomy.
 * @returns {Promise<{platform:string, categories:number, tags:number, inserted:number, updated:number, syncedAt:string}>}
 */
async function syncJuejinTaxonomy() {
  const appId = Number(process.env.APP_ID || 1);
  const [categories, tags] = await Promise.all([juejin.listCategories(), juejin.listAllTags()]);
  const syncedAt = nowString();
  let inserted = 0;
  let updated = 0;
  await t.db.withConn(async (conn) => {
    const c = await repo.upsertMany(conn, appId, PLATFORM, 'category', categories, syncedAt);
    const g = await repo.upsertMany(conn, appId, PLATFORM, 'tag', tags, syncedAt);
    inserted = c.inserted + g.inserted;
    updated = c.updated + g.updated;
  });
  return { platform: PLATFORM, categories: categories.length, tags: tags.length, inserted, updated, syncedAt };
}

/** Dictionary statistics for a platform (used by the status/list tooling). */
async function taxonomyStats() {
  const appId = Number(process.env.APP_ID || 1);
  let stats;
  await t.db.withConn(async (conn) => {
    stats = {
      categories: await repo.count(conn, appId, PLATFORM, 'category'),
      tags: await repo.count(conn, appId, PLATFORM, 'tag'),
    };
  });
  return { platform: PLATFORM, ...stats };
}

/**
 * Prepare a resolution context: optional site override + the cached dictionary.
 * Auto-syncs ONCE when the dictionary is empty (unless autoSync is false, e.g. a
 * dry-run that must make no external calls). A sync failure is NEVER fatal — the
 * resolver then falls back to the env ids.
 * @param {{siteDir?:string, autoSync?:boolean}} opts
 */
async function prepareJuejinTaxonomy({ siteDir = null, autoSync = true } = {}) {
  const appId = Number(process.env.APP_ID || 1);
  const aliases = mergeAliases(readSiteOverride(siteDir));
  const overrideFile = siteDir ? path.join(siteDir, 'juejin-taxonomy.json') : null;

  let ctx = null;
  await t.db.withConn(async (conn) => {
    ctx = {
      categoryRows: await repo.list(conn, appId, { platform: PLATFORM, kind: 'category' }),
      tagRows: await repo.list(conn, appId, { platform: PLATFORM, kind: 'tag' }),
    };
  });

  let synced = null;
  if (!ctx.categoryRows.length && !ctx.tagRows.length && autoSync && process.env.JUEJIN_COOKIE) {
    try {
      synced = await syncJuejinTaxonomy();
      await t.db.withConn(async (conn) => {
        ctx = {
          categoryRows: await repo.list(conn, appId, { platform: PLATFORM, kind: 'category' }),
          tagRows: await repo.list(conn, appId, { platform: PLATFORM, kind: 'tag' }),
        };
      });
    } catch (e) {
      console.error(`[juejin-taxonomy] dictionary sync failed, falling back to env ids: ${e.message}`);
    }
  }

  return {
    platform: PLATFORM,
    aliases,
    overrideFile: overrideFile && fs.existsSync(overrideFile) ? overrideFile : null,
    categoryIndex: buildIndex(ctx.categoryRows),
    tagIndex: buildIndex(ctx.tagRows),
    dictEmpty: !ctx.categoryRows.length && !ctx.tagRows.length,
    synced,
    env: {
      categoryId: process.env.JUEJIN_CATEGORY_ID || FALLBACK_CATEGORY_ID,
      tagId: process.env.JUEJIN_TAG_ID || FALLBACK_TAG_ID,
    },
  };
}

/** exact name → index entry */
function byName(index, name) {
  const k = nameKey(name);
  if (!k) return null;
  return index.find((e) => e.key === k) || null;
}

/**
 * Fuzzy (contains either way) → index entry, guarded by a length ratio so a short
 * tag like "Mac" cannot match the long slug "machine-learning". Among the surviving
 * candidates the most-used platform tag (higher post count) wins.
 */
function byFuzzy(index, value) {
  const k = nameKey(value);
  if (k.length < FUZZY_MIN_LEN) return null;
  const candidates = index.filter((e) => {
    if (e.key.length < FUZZY_MIN_LEN) return false;
    if (!(e.key.includes(k) || k.includes(e.key))) return false;
    // "seo" ⊂ "geoseo" (3/6 = 0.5) is a real match; "mac" ⊂ "machinelearning" (3/15 = 0.2) is not
    return Math.min(e.key.length, k.length) / Math.max(e.key.length, k.length) >= FUZZY_MIN_RATIO;
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.heat - a.heat || a.key.length - b.key.length);
  return candidates[0];
}

function firstOf(index) {
  return index.length ? index[0] : null;
}

/**
 * Resolve one platform tag for a source slug/keyword.
 * @returns {{id:string, name:string, origin:string}|null}
 */
function matchTag(ctx, source) {
  const slug = norm(source);
  if (!slug) return null;

  for (const candidate of [
    // 1. the slug already IS a platform tag name
    { name: slug, origin: 'exact' },
    // 2. built-in / site aliases
    ...(ctx.aliases.tag[slug] || []).map((n) => ({ name: n, origin: 'alias' })),
    // 3. generic aliases: the whole slug first (machine-learning), then each token
    ...(ctx.aliases.token[nameKey(slug)] || []).map((n) => ({ name: n, origin: 'token' })),
    ...tokensOf(slug).flatMap((tk) => (ctx.aliases.token[tk] || []).map((n) => ({ name: n, origin: `token:${tk}` }))),
  ]) {
    const hit = byName(ctx.tagIndex, candidate.name);
    if (hit) return { id: hit.id, name: hit.name, origin: candidate.origin };
  }
  // 4. fuzzy contains
  const fuzzy = byFuzzy(ctx.tagIndex, slug);
  if (fuzzy) return { id: fuzzy.id, name: fuzzy.name, origin: 'fuzzy' };
  return null;
}

/**
 * Resolve the platform category_id from our category slug.
 * @returns {{id:string, name:string|null, origin:string}}
 */
function matchCategory(ctx, categorySlug) {
  const slug = norm(categorySlug);
  const candidates = [
    { name: ctx.aliases.category[slug], origin: 'alias' },
    { name: slug, origin: 'exact' },
  ];
  for (const c of candidates) {
    if (!c.name) continue;
    const hit = byName(ctx.categoryIndex, c.name);
    if (hit) return { id: hit.id, name: hit.name, origin: c.origin };
  }
  const dflt = byName(ctx.categoryIndex, ctx.aliases.defaultCategory);
  if (dflt) return { id: dflt.id, name: dflt.name, origin: 'default' };
  if (ctx.env.categoryId) return { id: ctx.env.categoryId, name: null, origin: 'env' };
  const first = firstOf(ctx.categoryIndex);
  if (first) return { id: first.id, name: first.name, origin: 'first' };
  return { id: FALLBACK_CATEGORY_ID, name: null, origin: 'hardcoded' };
}

/**
 * The public consumer: turn our (category, tags, keywords) into what publishJuejin
 * needs. Synchronous — the caller preloads the context with prepareJuejinTaxonomy.
 * @returns {{categoryId:string, categoryName:string|null, tagIds:string[], tagNames:string[],
 *            origins:string[], dictEmpty:boolean}}
 */
function resolveFromContext(ctx, { category = null, tags = [], keywords = [] } = {}) {
  const cat = matchCategory(ctx, category);
  const picked = [];
  const seen = new Set();
  const push = (hit) => {
    if (!hit || seen.has(hit.id) || picked.length >= MAX_TAGS) return;
    seen.add(hit.id);
    picked.push(hit);
  };
  // our article_plan tags first (most reliable signal), then target_keywords
  for (const s of Array.isArray(tags) ? tags : []) push(matchTag(ctx, s));
  for (const s of Array.isArray(keywords) ? keywords : []) push(matchTag(ctx, s));

  let tagIds = picked.map((h) => h.id);
  let tagNames = picked.map((h) => h.name);
  let origins = picked.map((h) => h.origin);
  if (!tagIds.length) {
    const dflt = byName(ctx.tagIndex, ctx.aliases.defaultTag);
    if (dflt) {
      tagIds = [dflt.id];
      tagNames = [dflt.name];
      origins = ['default'];
    } else if (ctx.env.tagId) {
      tagIds = [ctx.env.tagId];
      tagNames = [];
      origins = ['env'];
    } else {
      const first = firstOf(ctx.tagIndex);
      tagIds = [first ? first.id : FALLBACK_TAG_ID];
      tagNames = first ? [first.name] : [];
      origins = [first ? 'first' : 'hardcoded'];
    }
  }

  return {
    categoryId: cat.id,
    categoryName: cat.name,
    categoryOrigin: cat.origin,
    tagIds,
    tagNames,
    origins,
    dictEmpty: !!ctx.dictEmpty,
  };
}

/** Convenience: prepare + resolve in one call (CLI / tests / one-off). */
async function resolveJuejinTaxonomy({ category, tags, keywords, siteDir, autoSync = true } = {}) {
  const ctx = await prepareJuejinTaxonomy({ siteDir, autoSync });
  return { ...resolveFromContext(ctx, { category, tags, keywords }), dictEmpty: ctx.dictEmpty, synced: ctx.synced };
}

module.exports = {
  PLATFORM,
  CATEGORY_ALIASES,
  TAG_ALIASES,
  TOKEN_ALIASES,
  FALLBACK_CATEGORY_ID,
  FALLBACK_TAG_ID,
  DEFAULT_CATEGORY_NAME,
  DEFAULT_TAG_NAME,
  syncJuejinTaxonomy,
  taxonomyStats,
  prepareJuejinTaxonomy,
  resolveFromContext,
  resolveJuejinTaxonomy,
  matchTag,
  matchCategory,
};
