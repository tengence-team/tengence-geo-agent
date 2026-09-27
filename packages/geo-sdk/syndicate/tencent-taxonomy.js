'use strict';
/**
 * Tencent Cloud taxonomy resolver (tengence-geo-sdk/syndicate/tencent-taxonomy)
 * ============================================================================
 * Turns OUR article taxonomy (the blog's category slug, stored in article_plan)
 * into Tencent Cloud's own 分类 id (payload field `classifyIds`), using the
 * platform dictionary cached in the channel_taxonomy table.
 *
 * Scope note — CATEGORY ONLY, unlike juejin-taxonomy which does both:
 *   Tencent Cloud exposes NO full tag dictionary. `tag/search` is a keyword SEARCH
 *   (it returns whatever matches the keyword, not a fixed word list), so there is
 *   nothing to cache. Tags are therefore resolved live per publish by
 *   syndicate/tencent.js `resolveTagIds()`, and this module deliberately does not
 *   touch them. Categories DO have a fixed dictionary (24 items, scene 1 = 文章)
 *   and that is what lives here.
 *
 * Why a dictionary instead of a per-site mapping file:
 *   the platform's taxonomy is platform knowledge, not site knowledge. Caching it
 *   once (platform-scoped) means EVERY site publishes to Tencent Cloud with no
 *   config file of its own — portability. Sites may still override via an OPTIONAL
 *   <siteDir>/tencent-taxonomy.json, but nothing requires it.
 *
 * Resolution chain (each layer falls through to the next; publishing NEVER fails
 * for a missing category — Tencent Cloud does not require classifyIds at all, see
 * `check-article-classify-manager` → hasUpdateArticlePrivilege):
 *
 *   category (classifyIds, platform max 3 — we resolve exactly one, deterministically)
 *     1. built-in / site aliases  our slug → platform category NAME → dict id
 *     2. our slug as a NAME          (a site may name a category after the platform's)
 *     3. fuzzy contains match       normalized name contains / is contained
 *     4. the default NAME            (人工智能) → dict id
 *     5. env TENCENT_CLASSIFY_IDS
 *     6. the dictionary's first category (name order)
 *     7. hard-coded 人工智能 id (2)
 *
 * Infix matching (layer 3) runs IN MEMORY over the 24-item dictionary: no SQL index
 * can serve a `contains` search (see db/sqlite-schema.js).
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');

const t = require('../index');
const repo = require('../db/channel-taxonomy');
const tencent = require('./tencent');

const PLATFORM = 'tencent';

/** Hard-coded last-resort id: Tencent Cloud's 人工智能 category (id 2). */
const FALLBACK_CLASSIFY_ID = 2;
const DEFAULT_CATEGORY_NAME = '人工智能';
const FUZZY_MIN_LEN = 2;
const FUZZY_MIN_RATIO = 0.4;

/**
 * Built-in aliases: OUR category slug → the platform's category NAME.
 * Kept in code (shipped with the SDK), deliberately NOT a per-site file.
 *
 * Rationale for each mapping (Tencent Cloud's 24 文章类目, verified 2026-09-27):
 *   search-recommend   → 算法      检索/召回/排序是推荐系统的技术内核
 *   geo-ai-search      → 人工智能  GEO 与生成式搜索，属 AI 应用侧
 *   data-growth        → 大数据    数据驱动增长，平台无「数据分析」类目，大数据最近
 *   product-solutions  → 架构设计  方案类内容讲落地架构
 *   product-guides     → 后端      实操/接入指南，后端开发者是主要读者
 *   industry-insights  → 人工智能  行业洞察围绕 AI 搜索演进
 *   case-studies       → 架构设计  案例讲真实系统的设计与取舍
 */
const CATEGORY_ALIASES = {
  'search-recommend': '算法',
  'geo-ai-search': '人工智能',
  'data-growth': '大数据',
  'product-solutions': '架构设计',
  'product-guides': '后端',
  'industry-insights': '人工智能',
  'case-studies': '架构设计',
};

/**
 * Generic aliases: a normalized KEYWORD token (any site, zh/en) → the platform's
 * category NAME. This layer is what lets an unrelated site resolve without any
 * per-site alias entry; it matches single slug tokens, never substrings, so short
 * keys such as "ai" cannot match "explain".
 *
 * NOTE: Tencent Cloud's 24 categories are cloud/engineering oriented — there is no
 * 营销/运营/产品 class. Terms with no honest counterpart (seo 之外的一部分、电商、
 * 增长) are intentionally absent so they fall through to the default rather than
 * being force-fitted into an unrelated category.
 */
const TOKEN_ALIASES = {
  // AI
  ai: ['人工智能'],
  aigc: ['人工智能'],
  llm: ['人工智能'],
  gpt: ['人工智能'],
  chatgpt: ['人工智能'],
  rag: ['人工智能'],
  vector: ['人工智能'],
  embedding: ['人工智能'],
  nlp: ['人工智能'],
  ml: ['人工智能'],
  'machine-learning': ['人工智能'],
  人工智能: ['人工智能'],
  机器学习: ['人工智能'],
  深度学习: ['人工智能'],
  大模型: ['人工智能'],
  AIGC: ['人工智能'],
  // search / ranking
  search: ['算法'],
  recommend: ['算法'],
  recommendation: ['算法'],
  algorithm: ['算法'],
  ranking: ['算法'],
  搜索: ['算法'],
  推荐: ['算法'],
  算法: ['算法'],
  // data
  data: ['大数据'],
  analytics: ['大数据'],
  bigdata: ['大数据'],
  数据分析: ['大数据'],
  大数据: ['大数据'],
  database: ['数据库'],
  数据库: ['数据库'],
  'data-visualization': ['大数据'],
  visualization: ['大数据'],
  数据可视化: ['大数据'],
  // engineering
  architecture: ['架构设计'],
  架构: ['架构设计'],
  backend: ['后端'],
  api: ['后端'],
  后端: ['后端'],
  frontend: ['前端'],
  前端: ['前端'],
  crawler: ['后端'],
  crawl: ['后端'],
  爬虫: ['后端'],
  monitor: ['运维'],
  monitoring: ['运维'],
  automation: ['运维'],
  运维: ['运维'],
  ops: ['运维'],
  devops: ['运维'],
  security: ['安全'],
  安全: ['安全'],
  cloud: ['云计算'],
  云计算: ['云计算'],
  iot: ['物联网'],
  物联网: ['物联网'],
  blockchain: ['区块链'],
  区块链: ['区块链'],
  os: ['操作系统'],
  操作系统: ['操作系统'],
  test: ['测试'],
  测试: ['测试'],
  network: ['网络与通信'],
  网络与通信: ['网络与通信'],
  video: ['音视频'],
  audio: ['音视频'],
  音视频: ['音视频'],
  'programming-language': ['编程语言'],
  编程语言: ['编程语言'],
  hardware: ['硬件'],
  硬件: ['硬件'],
  lowcode: ['低代码'],
  低代码: ['低代码'],
  client: ['客户端'],
  客户端: ['客户端'],
  mobile: ['客户端'],
  news: ['新闻资讯'],
  新闻资讯: ['新闻资讯'],
  career: ['职业发展'],
  职业发展: ['职业发展'],
  'open-source': ['开发工具'],
  opensource: ['开发工具'],
  tooling: ['开发工具'],
  开发工具: ['开发工具'],
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
  const file = path.join(siteDir, 'tencent-taxonomy.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`[tencent-taxonomy] ignoring malformed ${file}: ${e.message}`);
    return null;
  }
}

/** Merge the site override on top of the built-in alias tables (site wins). */
function mergeAliases(override) {
  const rekey = (obj, keyFn) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[keyFn(k)] = Array.isArray(v) ? v : [v];
    return out;
  };
  const builtin = { category: CATEGORY_ALIASES, token: TOKEN_ALIASES };
  const site = {
    category: (override && override.category) || {},
    token: (override && override.tokenAliases) || {},
  };
  return {
    category: rekey({ ...builtin.category, ...site.category }, norm),
    token: rekey({ ...builtin.token, ...site.token }, nameKey),
    defaultCategory: (override && override.defaultCategory) || DEFAULT_CATEGORY_NAME,
  };
}

/** Build the in-memory lookup index from dictionary rows. */
function buildIndex(rows) {
  return rows.map((r) => ({
    id: String(r.external_id),
    name: r.name,
    key: nameKey(r.name),
    heat: r.extra && r.extra.articleNum ? r.extra.articleNum : 0,
  }));
}

/**
 * Fetch the platform's category dictionary and cache it into channel_taxonomy.
 * @returns {Promise<{platform:string, categories:number, inserted:number, updated:number, syncedAt:string}>}
 */
async function syncTencentTaxonomy() {
  const appId = Number(process.env.APP_ID || 1);
  const categories = await tencent.listClassify();
  const syncedAt = nowString();
  const items = (Array.isArray(categories) ? categories : [])
    .filter((c) => c && c.id != null && c.name)
    .map((c) => ({
      external_id: String(c.id),
      name: String(c.name),
      extra: { articleNum: Number(c.articleNum || 0) },
    }));
  let stats = { inserted: 0, updated: 0 };
  await t.db.withConn(async (conn) => {
    stats = await repo.upsertMany(conn, appId, PLATFORM, 'category', items, syncedAt);
  });
  return { platform: PLATFORM, categories: items.length, ...stats, syncedAt };
}

/** Dictionary statistics for a platform (used by the status/list tooling). */
async function taxonomyStats() {
  const appId = Number(process.env.APP_ID || 1);
  let stats;
  await t.db.withConn(async (conn) => {
    stats = { categories: await repo.count(conn, appId, PLATFORM, 'category') };
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
async function prepareTencentTaxonomy({ siteDir = null, autoSync = true } = {}) {
  const appId = Number(process.env.APP_ID || 1);
  const aliases = mergeAliases(readSiteOverride(siteDir));
  const overrideFile = siteDir ? path.join(siteDir, 'tencent-taxonomy.json') : null;

  let rows = [];
  await t.db.withConn(async (conn) => {
    rows = await repo.list(conn, appId, { platform: PLATFORM, kind: 'category' });
  });

  let synced = null;
  if (!rows.length && autoSync && process.env.TENCENT_COOKIE) {
    try {
      synced = await syncTencentTaxonomy();
      await t.db.withConn(async (conn) => {
        rows = await repo.list(conn, appId, { platform: PLATFORM, kind: 'category' });
      });
    } catch (e) {
      console.error(`[tencent-taxonomy] dictionary sync failed, falling back to env ids: ${e.message}`);
    }
  }

  return {
    platform: PLATFORM,
    aliases,
    overrideFile: overrideFile && fs.existsSync(overrideFile) ? overrideFile : null,
    categoryIndex: buildIndex(rows),
    dictEmpty: !rows.length,
    synced,
    env: {
      classifyIds: String(process.env.TENCENT_CLASSIFY_IDS || '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0),
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
 * slug like "ai" cannot swallow a long category name. Among the surviving candidates
 * the platform's most-used category (higher articleNum) wins.
 */
function byFuzzy(index, value) {
  const k = nameKey(value);
  if (k.length < FUZZY_MIN_LEN) return null;
  const candidates = index.filter((e) => {
    if (e.key.length < FUZZY_MIN_LEN) return false;
    if (!(e.key.includes(k) || k.includes(e.key))) return false;
    return Math.min(e.key.length, k.length) / Math.max(e.key.length, k.length) >= FUZZY_MIN_RATIO;
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.heat - a.heat || a.key.length - b.key.length);
  return candidates[0];
}

/**
 * Resolve the platform 分类 id from our category slug.
 * @returns {{id:number, name:string|null, origin:string}}
 */
function matchCategory(ctx, categorySlug) {
  const slug = norm(categorySlug);
  const candidates = [
    { name: ctx.aliases.category[slug], origin: 'alias' },
    { name: slug, origin: 'exact' },
    // generic token layer: the whole slug first (machine-learning), then each token
    ...(ctx.aliases.token[nameKey(slug)] || []).map((n) => ({ name: n, origin: 'token' })),
    ...tokensOf(slug).flatMap((tk) =>
      (ctx.aliases.token[nameKey(tk)] || []).map((n) => ({ name: n, origin: `token:${tk}` }))
    ),
  ];
  for (const c of candidates) {
    if (!c.name) continue;
    const hit = byName(ctx.categoryIndex, c.name);
    if (hit) return { id: Number(hit.id), name: hit.name, origin: c.origin };
  }
  const fuzzy = byFuzzy(ctx.categoryIndex, slug);
  if (fuzzy) return { id: Number(fuzzy.id), name: fuzzy.name, origin: 'fuzzy' };

  const dflt = byName(ctx.categoryIndex, ctx.aliases.defaultCategory);
  if (dflt) return { id: Number(dflt.id), name: dflt.name, origin: 'default' };
  if (ctx.env.classifyIds.length) return { id: ctx.env.classifyIds[0], name: null, origin: 'env' };
  if (ctx.categoryIndex.length) {
    return { id: Number(ctx.categoryIndex[0].id), name: ctx.categoryIndex[0].name, origin: 'first' };
  }
  return { id: FALLBACK_CLASSIFY_ID, name: null, origin: 'hardcoded' };
}

/**
 * The public consumer: turn our (category, tags, keywords) into what
 * publishTencent needs. Synchronous — the caller preloads the context with
 * prepareTencentTaxonomy. `tags`/`keywords` are accepted for signature symmetry
 * with juejin-taxonomy but are NOT used: Tencent tags are resolved live by
 * syndicate/tencent.js (see the scope note at the top of this file).
 * @returns {{classifyIds:number[], classifyName:string|null, classifyOrigin:string, dictEmpty:boolean}}
 */
function resolveFromContext(ctx, { category = null } = {}) {
  const cat = matchCategory(ctx, category);
  return {
    classifyIds: cat.id ? [cat.id] : [],
    classifyName: cat.name,
    classifyOrigin: cat.origin,
    dictEmpty: !!ctx.dictEmpty,
  };
}

/** Convenience: prepare + resolve in one call (CLI / tests / one-off). */
async function resolveTencentTaxonomy({ category, siteDir, autoSync = true } = {}) {
  const ctx = await prepareTencentTaxonomy({ siteDir, autoSync });
  return { ...resolveFromContext(ctx, { category }), dictEmpty: ctx.dictEmpty, synced: ctx.synced };
}

module.exports = {
  PLATFORM,
  CATEGORY_ALIASES,
  TOKEN_ALIASES,
  FALLBACK_CLASSIFY_ID,
  DEFAULT_CATEGORY_NAME,
  syncTencentTaxonomy,
  taxonomyStats,
  prepareTencentTaxonomy,
  resolveFromContext,
  resolveTencentTaxonomy,
  matchCategory,
};
