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
    title: (row && (row.title || null)) || null,
    articleId: article ? article.id : null,
    state,
    planStatus: row ? row.plan_status || null : null,
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
      // the state filter is applied AFTER the SQL limit (state is derived, not a
      // column), so a small limit would silently return "no queued rows"
      limit: wanted ? Math.max(Number(limit) || 0, 5000) : limit,
    });
    const mapped = rows.map((r) => toArticleState(r, appId));
    const filtered = wanted ? mapped.filter((r) => wanted.includes(r.state)) : mapped;
    return filtered.slice(0, Number(limit) || DEFAULT_LIMIT);
  };
  return injected ? run(injected) : conn.withConn(run);
}

/**
 * Re-derive the plan_status COLUMN from the article row (mirror only, no article
 * writes). Only this module may touch plan_status; reconcile and maintenance
 * passes call this instead of writing the column themselves.
 * @param {{appId:number, slug:string, lang:string, conn?:object}} args
 */
async function syncPlanMirror({ appId, slug, lang, conn: injected } = {}) {
  if (!slug) throw new Error('articleState.syncPlanMirror requires slug');
  const l = requireLang(lang, slug);
  const run = async (c) => {
    const row = await repo.selectOne(c, appId, slug, l);
    if (!row) return { updated: false, reason: 'not-found' };
    const st = deriveState({
      planStatus: row.plan_status,
      article: row.article_id ? { id: row.article_id, status: row.article_status, wp_post_id: row.article_wp_post_id } : null,
    });
    if (st === row.plan_status) return { updated: false, state: st };
    await repo.updatePlanStatus(c, appId, slug, l, st);
    return { updated: true, state: st, from: row.plan_status };
  };
  return injected ? run(injected) : conn.withConn(run);
}

/** WP permalink → link-space language (the only reliable per-language signal). */
function langFromLink(link) {
  if (!link) return null;
  const s = String(link);
  if (s.includes('/zh-hans/')) return 'zh-hans';
  if (s.includes('/zh-hant/')) return 'zh-hant';
  return 'en';
}

/** WP date ("2026-10-08T09:29:16" / RFC3339) → DB stamp "YYYY-MM-DD HH:MM:SS" (site local). */
function wpStamp(date) {
  return String(date || '').replace('T', ' ').slice(0, 19);
}

function sameStamp(a, b) {
  return wpStamp(a) === wpStamp(b);
}

/** WP post status → the single article state it implies. */
const WP_STATUS_STATE = {
  publish: STATE.PUBLISHED,
  future: STATE.PUBLISHED,
  private: STATE.PUBLISHED,
  draft: STATE.QUEUED,
  pending: STATE.QUEUED,
};

/**
 * WordPress-truth reconciliation — the answer to "both tables agree with each other
 * but both disagree with WordPress". article_state.audit() only compares the plan
 * mirror against the article row, so a state that is wrong in BOTH columns is
 * invisible to it; only the platform can settle that. This pass therefore takes the
 * live WP post set as input and, for every plan row that has an article row, matches
 * the post of ITS OWN language (article.wp_post_id first, plan.wp_post_id second,
 * slug|lang index last) and then:
 *
 *   1. articles.status  ← the derived state of the real WP status (via setState)
 *   2. articles.published_at ← the real WP post date (never the execution moment)
 *   3. plan.wp_post_id / plan.published_at ← mirror columns, per language
 *   4. plan_status ← re-derived through syncPlanMirror
 *
 * Upgrades are automatic; a DOWNGRADE (DB says published, WordPress says draft) is
 * only reported, never applied, unless allowDowngrade is explicitly passed — WP being
 * right is the default assumption, but silently un-publishing rows is not.
 *
 * @param {{appId:number, wpPosts:Array<{id:number,slug:string,status:string,link?:string,date?:string}>,
 *          dryRun?:boolean, allowDowngrade?:boolean, conn?:object}} args
 */
async function reconcileWithWp({ appId, wpPosts = [], dryRun = true, allowDowngrade = false, conn: injected } = {}) {
  if (!Array.isArray(wpPosts) || !wpPosts.length) {
    throw new Error('reconcileWithWp requires a non-empty wpPosts list (refusing to reconcile on empty WP data)');
  }
  const run = async (c) => {
    const rows = await repo.selectList(c, appId, { limit: 5000 });
    const byId = new Map(wpPosts.map((p) => [Number(p.id), p]));
    const bySlugLang = new Map();
    for (const p of wpPosts) {
      const l = langFromLink(p.link);
      if (l && p.slug) bySlugLang.set(`${p.slug}|${l}`, p);
    }
    const report = {
      dryRun,
      total_rows: rows.length,
      checked: 0,
      matched: 0,
      state_fixed: [],
      published_at_fixed: 0,
      plan_wp_post_fixed: 0,
      plan_published_at_fixed: 0,
      downgrades_skipped: [],
      unmatched: [],
    };

    for (const r of rows) {
      if (!r.article_id) continue; // plan-only rows: state is todo/paused by definition
      report.checked += 1;
      const lang = normalizeLang(r.lang);
      const awp = Number(r.article_wp_post_id) || 0;
      const pwp = Number(r.plan_wp_post_id) || 0;
      let wp = awp ? byId.get(awp) : pwp ? byId.get(pwp) : null;
      let viaFallback = false;
      if (!wp) {
        wp = bySlugLang.get(`${r.slug}|${lang}`) || null;
        viaFallback = true;
      }
      if (!wp) {
        report.unmatched.push({ slug: r.slug, lang, articleWp: awp || null, planWp: pwp || null, reason: 'no-wp-post' });
        continue;
      }
      if (wp.slug !== r.slug) {
        report.unmatched.push({ slug: r.slug, lang, wpSlug: wp.slug, wpPostId: Number(wp.id), reason: 'slug-mismatch' });
        continue;
      }
      // The post id must belong to THIS row's language: a zh-hans row pointing at an
      // /en/ or /zh-hant/ permalink is a stale pointer (report only — rewriting it could
      // silently change what a later publish picks up).
      const wpLang = langFromLink(wp.link);
      if (wpLang && wpLang !== lang) {
        (report.lang_mismatch = report.lang_mismatch || []).push({
          slug: r.slug,
          lang,
          wpPostId: Number(wp.id),
          wpLang,
          wpStatus: wp.status,
          articleWp: awp || null,
          planWp: pwp || null,
        });
        continue;
      }
      const expected = WP_STATUS_STATE[String(wp.status || '').toLowerCase()];
      if (!expected) {
        report.unmatched.push({ slug: r.slug, lang, wpStatus: wp.status, reason: 'unknown-wp-status' });
        continue;
      }
      report.matched += 1;
      const current = deriveState({
        planStatus: r.plan_status,
        article: { id: Number(r.article_id), status: r.article_status, wp_post_id: r.article_wp_post_id },
      });
      const at = expected === STATE.PUBLISHED ? wpStamp(wp.date) : null;
      const wpPostId = Number(wp.id);

      const isDowngrade = current === STATE.PUBLISHED && expected !== STATE.PUBLISHED;
      if (current !== expected) {
        if (isDowngrade && !allowDowngrade) {
          report.downgrades_skipped.push({ slug: r.slug, lang, from: current, to: expected, wpStatus: wp.status });
          continue; // leave the row (and its mirror) untouched
        }
        if (!dryRun) {
          await setState({ appId, slug: r.slug, lang, to: expected, wpPostId, at, allowDowngrade: true, conn: c });
        }
        report.state_fixed.push({ slug: r.slug, lang, from: current, to: expected, wpStatus: wp.status, viaFallback });
      } else if (expected === STATE.PUBLISHED && !sameStamp(r.article_published_at, at)) {
        // published_at must be the real WP publish moment, never the moment we ran.
        if (!dryRun) {
          await setState({ appId, slug: r.slug, lang, to: STATE.PUBLISHED, wpPostId, at, allowDowngrade: true, conn: c });
        }
        report.published_at_fixed += 1;
      }

      // Mirror columns on the plan row (per language — never slug-wide).
      if (pwp !== wpPostId) {
        if (!dryRun) await repo.updatePlanFields(c, appId, r.slug, lang, { wp_post_id: wpPostId });
        report.plan_wp_post_fixed += 1;
      }
      const planStamp = String(r.plan_published_at || '');
      if (expected === STATE.PUBLISHED && (!sameStamp(planStamp, at) || planStamp.includes('T'))) {
        // one-off: legacy rows carried "YYYY-MM-DDTHH:MM:SS"; normalize to the DB format
        if (!dryRun) await repo.updatePlanFields(c, appId, r.slug, lang, { published_at: at });
        report.plan_published_at_fixed += 1;
      }
      if (!dryRun) await syncPlanMirror({ appId, slug: r.slug, lang, conn: c });
    }
    return report;
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

/** HEAD probe — single implementation lives in geo-sdk/util.js (see probeCover). */
async function defaultProbe(url, opts = {}) {
  const verdict = await require('../util').probeCover(url, opts);
  if (!verdict || verdict.ok) return verdict || { ok: true };
  return { ...verdict, reason: `cover ${verdict.reason}` };
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
      } else {
        // no article of its own language → the cross-language link is a lie: null it
        await repo.clearPlanArticleLink(c, appId, item.slug, item.lang);
        fixed.fkNulled = (fixed.fkNulled || 0) + 1;
      }
    }
    // drift repair: the plan column is a mirror, so bring it back in line with the
    // article row. (Fixing the CAUSE — an article that should be live — needs the WP
    // truth and therefore `plan sync`, never a blind article write.)
    let mirrored = 0;
    for (const item of report.drift) {
      const r = await syncPlanMirror({ appId, slug: item.slug, lang: item.lang, conn: c });
      if (r && r.updated) mirrored += 1;
    }
    fixed.driftMirrored = mirrored;
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
  syncPlanMirror,
  reconcileWithWp,
  langFromLink,
  wpStamp,
  derive: deriveState,
  validateTransition,
  defaultProbe,
  errors,
  repo,
};
