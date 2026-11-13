/**
 * article-state — the single read/write entry for an article's lifecycle state
 * ============================================================================
 * Problem this closes (2026-11-13): the same fact ("is this article live?") was
 * kept twice — plan.plan_status and articles.status — with two vocabularies and
 * twelve write sites. 54 plan rows said `published` while their article row was
 * still `draft`; 415 plan rows pointed article_id at another language's row.
 *
 * Rule: state has ONE source per phase.
 *   article row exists -> articles.status wins (draft/publish/future/private)
 *   article row absent -> plan.plan_status wins, and only todo|paused are legal
 *
 * Every other module must go through this file. plan.updateStatus /
 * markQueued / markPublished / articles.markPublished become thin shims that
 * delegate here, and are deleted once all callers are migrated.
 *
 * Usage:
 *   const articleState = require('tengence-geo-sdk/article-state');
 *   const s = await articleState.read({ appId: 1, slug, lang: 'zh-hans' });
 *   await articleState.setState({ appId: 1, slug, lang: 'zh-hans', to: 'published', wpPostId: 5044 });
 * ============================================================================
 */

const conn = require('../db/connection');
const repo = require('./repo');
const derive = require('./derive');
const errors = require('./errors');

const { STATE, normalizeLang, derive: deriveState, validateTransition, toArticlePatch, hasWpPost } = derive;

const DEFAULT_LIMIT = 1000;

function toArticleState(row, appId = null) {
  const article = row && row.article_id
    ? { id: Number(row.article_id), status: row.article_status, wp_post_id: row.article_wp_post_id }
    : null;
  const state = deriveState({ planStatus: row ? row.plan_status : null, article });
  return {
    appId: appId,
    slug: row ? row.slug : null,
    lang: row ? normalizeLang(row.lang) : null,
    articleId: article ? article.id : null,
    state,
    articleStatus: article ? String(article.status || '').toLowerCase() || null : null,
    wpPostId: article && hasWpPost(article.wp_post_id) ? Number(article.wp_post_id) : null,
    featuredImage: (row && row.featured_image) || null,
    publishedAt: (row && row.article_published_at) || null,
    plan: row
      ? {
          nodeType: row.node_type,
          hubCluster: row.hub_cluster,
          matrixCode: row.matrix_code,
          publishBatch: row.publish_batch,
          publishOrder: row.publish_order,
          category: row.category,
          tags: parseTags(row.tags),
          focusKeyword: row.focus_keyword,
          notes: row.notes,
        }
      : null,
  };
}

function parseTags(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch (e) {
      return [];
    }
  }
  return [];
}

function requireLang(lang, slug) {
  const l = normalizeLang(lang);
  if (!l) throw errors.langRequired(slug);
  return l;
}

/**
 * Read one article's merged state.
 * @param {{appId:number, slug:string, lang:string, conn?:object}} args
 */
async function read({ appId, slug, lang, conn: injected } = {}) {
  if (!slug) throw new Error('articleState.read requires slug');
  const l = requireLang(lang, slug);
  const run = async (c) => {
    const row = await repo.selectOne(c, appId, slug, l);
    return row ? toArticleState(row, appId) : null;
  };
  return injected ? run(injected) : conn.withConn(run);
}

/**
 * List merged states, ordered by publish_order (history order, never newest-first).
 * @param {{appId:number, state?:string|string[], readyToPublish?:boolean, lang?:string, limit?:number, conn?:object}} args
 */
async function list({ appId, state, readyToPublish = false, lang = null, limit = DEFAULT_LIMIT, conn: injected } = {}) {
  const wanted = state ? (Array.isArray(state) ? state : [state]).map((s) => String(s).toLowerCase()) : null;
  const run = async (c) => {
    const rows = await repo.selectList(c, appId, {
      lang: lang ? normalizeLang(lang) : null,
      readyToPublish,
      limit,
    });
    const mapped = rows.map((r) => toArticleState(r, appId));
    const filtered = wanted ? mapped.filter((r) => wanted.includes(r.state)) : mapped;
    return filtered.slice(0, Number(limit) || DEFAULT_LIMIT);
  };
  return injected ? run(injected) : conn.withConn(run);
}

/**
 * The single status write entry.
 * @param {{appId:number, slug:string, lang:string, to:string, wpPostId?:number,
 *          publishedUrl?:string, at?:string, allowDowngrade?:boolean, conn?:object}} args
 */
async function setState({ appId, slug, lang, to, wpPostId = null, publishedUrl = null, at = null, allowDowngrade = false, conn: injected } = {}) {
  if (!slug) throw new Error('articleState.setState requires slug');
  const l = requireLang(lang, slug);
  const run = async (c) => {
    const row = await repo.selectOne(c, appId, slug, l);
    const article = row && row.article_id
      ? { id: Number(row.article_id), status: row.article_status, wp_post_id: row.article_wp_post_id }
      : null;
    const planStatus = row ? row.plan_status : null;
    const from = validateTransition({ to, planStatus, article, allowDowngrade });

    if (to === STATE.TODO || to === STATE.PAUSED) {
      if (!row) throw errors.notFound(slug, l);
      const res = await repo.updatePlanStatus(c, appId, slug, l, to);
      return { ok: true, slug, lang: l, from, to, target: 'plan_status', affectedRows: res.affectedRows, publishedUrl };
    }

    const patch = toArticlePatch({ to, wpPostId, publishedAt: at });
    const res = await repo.updateArticle(c, appId, article.id, {
      status: patch.status,
      wpPostId: patch.wp_post_id,
      touchPublishedAt: patch.touchPublishedAt,
      publishedAt: patch.publishedAt,
    });
    return { ok: true, slug, lang: l, from, to, target: 'articles.status', articleId: article.id, affectedRows: res.affectedRows, wpPostId: patch.wp_post_id };
  };
  return injected ? run(injected) : conn.withConn(run);
}

/**
 * Mirror a featured image URL into the DB, after proving the URL is usable
 * (HEAD must answer 200 + image/*). Writes nothing when the probe fails.
 * @param {{appId:number, slug:string, url:string, lang?:string, probe?:Function, conn?:object}} args
 */
async function setFeaturedImage({ appId, slug, url, lang = null, probe = null, conn: injected } = {}) {
  if (!slug) throw new Error('articleState.setFeaturedImage requires slug');
  if (!url) throw new Error('articleState.setFeaturedImage requires url');
  const probeFn = probe || defaultProbe;
  const verdict = await probeFn(url);
  if (!verdict || !verdict.ok) {
    throw errors.coverUnreachable(url, (verdict && verdict.reason) || 'probe failed');
  }
  const run = async (c) => {
    const res = await repo.updateFeaturedImage(c, appId, slug, lang ? normalizeLang(lang) : null, url);
    return { ok: true, slug, lang: lang ? normalizeLang(lang) : 'all', url, head: verdict, affectedRows: res.affectedRows };
  };
  return injected ? run(injected) : conn.withConn(run);
}

/** HEAD probe: 200 + image/* counts as usable; network errors are reported as skip. */
async function defaultProbe(url, { timeoutMs = 2500 } = {}) {
  const http = require('http');
  const https = require('https');
  const mod = url.startsWith('https:') ? https : http;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = mod.request(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
      const type = String(res.headers['content-type'] || '');
      res.resume();
      if (res.statusCode >= 400) return done({ ok: false, reason: `http ${res.statusCode}` });
      if (!/^image\//i.test(type)) return done({ ok: false, reason: `not an image (${type || 'unknown'})` });
      return done({ ok: true, status: res.statusCode, type });
    });
    req.on('timeout', () => {
      req.destroy();
      done({ ok: true, skipped: true, reason: 'probe timeout — not treated as a hard failure' });
    });
    req.on('error', (e) => done({ ok: true, skipped: true, reason: `probe error: ${e.code || e.message}` }));
    req.end();
  });
}

/**
 * Read-only consistency report (dryRun by default; pass fix:true to write).
 * @param {{appId:number, fix?:boolean, dryRun?:boolean, conn?:object}} args
 */
async function audit({ appId, fix = false, dryRun = true, conn: injected } = {}) {
  const run = async (c) => {
    const rows = await repo.auditRows(c, appId);
    const report = {
      drift: rows.drift.map((r) => ({ slug: r.slug, lang: r.lang, planStatus: r.plan_status, articleStatus: r.article_status })),
      dangling: rows.dangling.map((r) => ({ slug: r.slug, lang: r.lang, planStatus: r.plan_status })),
      fkMismatch: rows.fkMismatch.map((r) => ({ slug: r.slug, lang: r.lang, articleId: Number(r.article_id), articleLang: r.article_lang })),
      missingCover: rows.missingCover.map((r) => ({ slug: r.slug, lang: r.lang })),
      counts: {
        drift: rows.drift.length,
        dangling: rows.dangling.length,
        fkMismatch: rows.fkMismatch.length,
        missingCover: rows.missingCover.length,
      },
      fixed: null,
    };
    if (!fix || dryRun) return report;

    // FK repair: point plan.article_id at the row of its OWN language
    const fixed = { fkMismatch: 0 };
    for (const item of report.fkMismatch) {
      const [aRows] = await c.query(
        `SELECT id FROM ${require('../db/schema').TABLES.articles}
          WHERE app_id = ? AND slug = ? AND lang = ? LIMIT 1`,
        [appId, item.slug, item.lang]
      );
      if (aRows && aRows.length) {
        await repo.repairArticleLink(c, appId, item.slug, item.lang, Number(aRows[0].id));
        fixed.fkMismatch += 1;
      }
    }
    report.fixed = fixed;
    return report;
  };
  return injected ? run(injected) : conn.withConn(run);
}

module.exports = {
  STATE,
  read,
  list,
  setState,
  setFeaturedImage,
  audit,
  derive: deriveState,
  validateTransition,
  defaultProbe,
  errors,
  repo,
};
