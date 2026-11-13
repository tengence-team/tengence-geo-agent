/**
 * Article plan service domain (plan domain) — the single read/write entry of the
 * whole pipeline
 * ============================================================================
 * Service layer for the Hub & Spoke article planning / publishing plan table:
 *   - The repository (SQL) lives in db/plan.js; this file does orchestration
 *     (connections, import merging, allow-lists, validation).
 *   - Exposed externally as t.plan (see ../index.js).
 *
 * Data flow (post-refactor):
 *   publish-draft.js   plan.get(slug) → category/tags; on draft-push success → plan.markQueued
 *   publish-from-db.js plan.getByArticleId(articleId) → category/tags; direct publish → plan.markPublished
 *   promote-daily.js   plan.nextDue() → candidates; on promotion → plan.markPublished
 *   image-acquire.js   plan.setFeaturedImage(slug, url)
 *   taxonomy.js        plan.verify() / plan.categoryWhitelist() / plan.tagWhitelist()
 *   db-query.js        plan.list() (--plan view)
 *
 * The queue = this table itself (plan_status='queued' AND wp_post_id not null,
 * ordered by publish_order ascending); scheduling params per_day / skip_dates live
 * in the publish node of config/wordpress.yaml (not in the DB).
 * ============================================================================
 */

const repo = require('../db/plan');
const articleState = require('../article-state');
const { TABLES } = require('../db/schema');
const { withConn } = require('../db/connection');

/** Default tenant: process-level APP_ID env var (default 1); SQLite single-file
 * multi-tenant isolation is by app_id */
const DEFAULT_APP_ID = () => Number(process.env.APP_ID || 1);

/** category slug → hub cluster letter (for hub-row annotation; C/D, E/F, G share) */
const CATEGORY_CLUSTER = {
  'geo-ai-search': 'A',
  'industry-insights': 'B',
  'search-recommend': 'C',
  'data-growth': 'E',
  'product-solutions': 'G',
  'product-guides': 'G',
  'case-studies': 'G',
};

// ---------------------------------------------------------------------------
// NOTE (2026-10-07): this module used to parse two CONTROL-PLANE documents —
// 《内容发布计划.md》(a 13-column matrix table whose status column was an emoji
// legend ✅/🕐/📝/🆕) and publish-queue.json — and replay them over the plan table
// on every import. That is forbidden now: a prose document is not a data source,
// and replaying one silently rewound live rows (35 genuinely published rows were
// flipped back to queued) and clobbered DB-edited topic fields.
//
// The plan table IS the single source of truth. New/changed rows arrive as
// STRUCTURED input: plan.upsert(record, { lang }) or plan_import{ rows[] }. Any
// markdown → structured conversion happens OUTSIDE the API (AI / a one-off
// migration script under dev/), never inside it.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// service API
// ---------------------------------------------------------------------------

/** List (for db-query --plan) */
async function list({ appId = DEFAULT_APP_ID(), status, batch, cluster, category, nodeType, limit, lang } = {}) {
  return withConn((conn) => repo.list(conn, appId, { status, batch, cluster, category, nodeType, limit, lang }));
}

/** Single-row lookup. Pass { lang } to target one language (defaults to any/first). */
async function get(slug, { appId = DEFAULT_APP_ID(), lang } = {}) {
  return withConn((conn) => repo.getBySlug(conn, appId, slug, lang));
}

/** Lookup by article_id (the publish chain reverses category/tags) */
async function getByArticleId(articleId, { appId = DEFAULT_APP_ID(), lang } = {}) {
  return withConn((conn) => repo.getByArticleId(conn, appId, articleId, lang));
}

/**
 * Register / update a row (idempotent; field-merge semantics live in the repository).
 * Keyed on (app_id, slug, lang) — pass { lang:'en' } to create/update a translation row.
 */
async function upsert(record, { appId = DEFAULT_APP_ID(), lang } = {}) {
  if (!record || !record.slug) throw new Error('plan.upsert requires record.slug');
  return withConn((conn) => repo.upsert(conn, appId, record, { lang }));
}

/**
 * Status transition — COMPATIBILITY SHIM (2026-11-13 status unification).
 * plan_status is no longer an independent fact: it is routed to
 * articleState.setState(), which derives and stores the truth on the ARTICLE row.
 * Only non-status columns (published_url / notes / article_id / queued_at and the
 * plan-side wp_post_id mirror that nextDue() reads) are written here.
 */
async function updateStatus(slug, fields, { appId = DEFAULT_APP_ID(), lang } = {}) {
  if (!slug) throw new Error('plan.updateStatus requires slug');
  const { plan_status: to, published_at: at, ...rest } = fields || {};
  if (to) {
    await articleState.setState({
      appId, slug, lang, to,
      wpPostId: fields.wp_post_id === undefined ? null : fields.wp_post_id,
      at,
    });
  }
  if (Object.keys(rest).length) {
    return withConn((conn) => repo.updateStatus(conn, appId, slug, rest, { lang }));
  }
  return { updated: Boolean(to), via: 'article-state' };
}

/**
 * After a draft push succeeds: written → queued. The state itself lives on the
 * article row (article-state); the plan row keeps only the queue mirror columns
 * (article_id / wp_post_id / queued_at) that nextDue() reads.
 */
async function markQueued(slug, { articleId, wpPostId, queuedAt } = {}, { appId = DEFAULT_APP_ID(), lang } = {}) {
  const ts = queuedAt || new Date();
  const stamp = ts instanceof Date ? ts.toISOString().slice(0, 19).replace('T', ' ') : ts;
  await articleState.setState({ appId, slug, lang, to: 'queued', wpPostId: wpPostId || null });
  const mirror = { queued_at: stamp };
  if (articleId !== undefined && articleId !== null) mirror.article_id = articleId;
  if (wpPostId !== undefined && wpPostId !== null) mirror.wp_post_id = wpPostId;
  const res = await withConn((conn) => repo.updateStatus(conn, appId, slug, mirror, { lang }));
  return { updated: true, via: 'article-state', mirror: res };
}

/**
 * After promotion succeeds: queued → published. State is written to the article
 * row (article-state); the plan row keeps wp_post_id / published_url for reporting.
 */
async function markPublished(slug, { wpPostId, publishedUrl, publishedAt } = {}, { appId = DEFAULT_APP_ID(), lang } = {}) {
  const ts = publishedAt || new Date();
  const stamp = ts instanceof Date ? ts.toISOString().slice(0, 19).replace('T', ' ') : ts;
  await articleState.setState({ appId, slug, lang, to: 'published', wpPostId: wpPostId || null, publishedUrl, at: stamp });
  const mirror = {};
  if (wpPostId !== undefined && wpPostId !== null) mirror.wp_post_id = wpPostId;
  if (publishedUrl) mirror.published_url = publishedUrl;
  const res = Object.keys(mirror).length
    ? await withConn((conn) => repo.updateStatus(conn, appId, slug, mirror, { lang }))
    : { updated: false };
  return { updated: true, via: 'article-state', mirror: res };
}

/**
 * Backfill the featured-image path after image acquisition. Delegates to
 * article-state.setFeaturedImage(), which HEAD-probes the URL (200 + image/*)
 * before writing and mirrors into all three language rows by default.
 */
async function setFeaturedImage(slug, url, { appId = DEFAULT_APP_ID(), lang = null, probe = null } = {}) {
  const r = await articleState.setFeaturedImage({ appId, slug, url, lang, probe });
  return { affectedRows: r.affectedRows, slug, head: r.head };
}

/**
 * Reconcile-side heal of articles.status so it mirrors the plan / WP truth. This is
 * the permanent fix for the "articles.status untrustworthy" defect: previously only
 * the publish pipeline (markPublished) ever wrote the column, so posts published
 * outside it — e.g. directly in WP — were stranded at 'draft'.
 *
 * Self-gating: it reads the current row first and only writes when status (and, when
 * applicable, wp_post_id) actually differs, so an unchanged row is never churned.
 * Runs for every iterated plan row (not just plan_status changes), because the plan
 * table can be correct while articles.status is independently drifted.
 *
 * Keyed by article_id when present (exact FK), else slug+lang, else slug-only, so a
 * slug whose languages have differing publish states never bleeds one language's
 * status onto another row. Only SETs (never clears) wp_post_id, to avoid dropping
 * valid data.
 *
 * @returns {Promise<{changed:boolean, from:?string}>}
 */
async function healArticleStatus({ appId, planRow, state, wpPostId, dryRun = false }) {
  // Root-cause fix #3 (2026-11-13): keyed on (slug, lang), NOT planRow.article_id.
  // article_id is shared by all three language rows on 415 rows, so the old lookup
  // kept repairing whichever language happened to sit there (1197 was never reached).
  // The write itself goes through article-state.
  const lang = repo.normalizeLang(planRow.lang) || 'zh-hans';
  const cur = await articleState.read({ appId, slug: planRow.slug, lang });
  if (!cur || !cur.articleId) return { changed: false, from: null };
  const wpDiffers = wpPostId != null && String(cur.wpPostId || '') !== String(wpPostId);
  if (cur.state === state && !wpDiffers) return { changed: false, from: cur.articleStatus };
  // published is terminal: a WP-less row must never rewind a live article to draft
  if (state === 'written' && cur.state === 'published') return { changed: false, from: cur.articleStatus };
  if (dryRun) return { changed: true, from: cur.articleStatus };
  try {
    await articleState.setState({ appId, slug: planRow.slug, lang, to: state, wpPostId, allowDowngrade: true });
  } catch (e) {
    return { changed: false, from: cur.articleStatus, error: e.code || e.message };
  }
  return { changed: true, from: cur.articleStatus };
}

/** Derive a geo language code from a WP post's permalink (the language prefix is the
 * only reliable signal: /zh-hans/ → zh-hans, /zh-hant/ → zh-hant, bare → en). */
function langFromLink(link) {
  if (!link) return null;
  if (link.includes('/zh-hans/')) return 'zh-hans';
  if (link.includes('/zh-hant/')) return 'zh-hant';
  return 'en';
}

/** Normalize a plan/DB language code into the link-space code used by {@link langFromLink}. */
function toLinkLang(lang) {
  if (!lang) return null;
  const l = String(lang).trim().toLowerCase();
  if (l === 'zh-cn' || l === 'zh-hans') return 'zh-hans';
  if (l === 'zh-hk' || l === 'zh-hant') return 'zh-hant';
  if (l === 'en-us' || l === 'en') return 'en';
  return l;
}

/** Queue candidates: the articles due next (for promote-daily; count may include overshoot) */
async function nextDue({ count = 1, skipSlugs = [], appId = DEFAULT_APP_ID() } = {}) {
  return withConn((conn) => repo.nextDue(conn, appId, { count, skipSlugs }));
}

// ---------------------------------------------------------------------------
// allow-lists (DB categories / tags tables = the allow-list source of truth after
// taxonomy.yaml retired)
// ---------------------------------------------------------------------------

/** Category allow-list [{slug, name, description}] */
async function categoryWhitelist({ appId = DEFAULT_APP_ID() } = {}) {
  return withConn(async (conn) => {
    const [rows] = await conn.query(
      `SELECT slug, name, description FROM ${TABLES.categories} WHERE app_id = ? ORDER BY slug`,
      [appId]
    );
    return rows;
  });
}

/** Tag allow-list [{slug, name, description}] */
async function tagWhitelist({ appId = DEFAULT_APP_ID() } = {}) {
  return withConn(async (conn) => {
    const [rows] = await conn.query(
      `SELECT slug, name, description FROM ${TABLES.tags} WHERE app_id = ? ORDER BY slug`,
      [appId]
    );
    return rows;
  });
}

// ---------------------------------------------------------------------------
// one-time import (phase 1 ≈128 articles + 7 hub rows)
// ---------------------------------------------------------------------------

/**
 * Plan-table maintenance (idempotent). Since 2026-10-07 this reads NO files: the
 * plan table is the single source of truth and every row change arrives as
 * structured input (plan.upsert / plan_import{ rows[] }). What is left is pure
 * DB hygiene:
 *   1. backfill article_id / title / wp_post_id / published_url (matched by
 *      slug+lang against the articles table)
 *   2. reconcile plan_status from articles facts (never from a file)
 *   3. assign a publish_order to rows that still lack one
 *   4. backfill featured_image from article_images / articles
 *   5. seed hub rows once (from the categories table)
 * @param {object} site loadSite() return value (only site.site.site.domain is used)
 * @param {object} opts { domain }
 */
async function importPlan(site, opts = {}) {
  const domain = opts.domain || (site.site.site && site.site.site.domain);
  const articleUrl = (slug) => `https://www.${domain}/blog/article/${slug}/`;

  const appId = Number(process.env.APP_ID || 1);

  const report = {
    created: 0,
    updated: 0,
    article_linked: 0,
    published_url_filled: 0,
    featured_filled: 0,
    hub_rows: 0,
    missing_article: [],
  };

  await withConn(async (conn) => {
    await conn.beginTransaction();
    try {
      // 5. backfill article_id / title / wp_post_id / published_url / featured_image by slug+lang
      //    Keyed on (slug, lang): all three languages share one slug, so a slug-only map
      //    would collapse them into whichever row was read last and let one language's
      //    facts (status / wp_post_id) bleed onto another's plan row.
      const [articles] = await conn.query(
        `SELECT id, slug, lang, title, wp_post_id, status FROM ${TABLES.articles} WHERE app_id = ?`,
        [appId]
      );
      const bySlugLang = new Map(articles.map((a) => [`${a.slug}::${repo.normalizeLang(a.lang)}`, a]));
      const [planRows] = await conn.query(
        `SELECT id, slug, lang, title, article_id, wp_post_id, plan_status FROM ${TABLES.articlePlan} WHERE app_id = ? AND node_type = 'spoke'`,
        [appId]
      );
      for (const p of planRows) {
        const a = bySlugLang.get(`${p.slug}::${repo.normalizeLang(p.lang)}`);
        if (!a) {
          if (p.plan_status === 'published' || p.plan_status === 'queued') {
            report.missing_article.push(p.slug);
          }
          continue;
        }
        const patch = { article_id: a.id };
        if (!p.title && a.title) patch.title = a.title;
        if (!p.wp_post_id && a.wp_post_id) patch.wp_post_id = a.wp_post_id;
        if (p.plan_status === 'published' && !p.published_url) {
          patch.published_url = articleUrl(p.slug);
          report.published_url_filled += 1;
        }
        if (Object.keys(patch).length) {
          await repo.updateStatus(conn, appId, p.slug, patch, { lang: repo.normalizeLang(p.lang) });
          report.article_linked += 1;
        }
      }

      // 5.5 plan_status is a MIRROR now (2026-11-13 status unification): the article
      //     row is the truth. Re-derive with the SAME rules the service uses and let
      //     article-state own the column write — this file no longer sets plan_status.
      for (const p of planRows) {
        const a = bySlugLang.get(`${p.slug}::${repo.normalizeLang(p.lang)}`);
        const st = articleState.derive({
          planStatus: p.plan_status,
          article: a ? { status: a.status, wp_post_id: a.wp_post_id } : null,
        });
        if (st !== p.plan_status) {
          const r = await articleState.syncPlanMirror({ appId, slug: p.slug, lang: repo.normalizeLang(p.lang) });
          if (r && r.updated) report.status_mirrored = (report.status_mirrored || 0) + 1;
        }
        if (st === 'published' && !p.published_url) {
          await repo.updateStatus(conn, appId, p.slug, { published_url: articleUrl(p.slug) }, {
            lang: repo.normalizeLang(p.lang),
          });
          report.published_url_filled += 1;
        }
      }

      // 5.7 complete publish_order: rows still at 0 are appended after the highest
      //     existing order (idempotent: existing nonzero orders are kept). Order now
      //     comes from the table itself — the queue file that used to seed it is gone.
      let nextOrder =
        planRows.reduce((m, p3) => Math.max(m, p3.publish_order || 0), 0) + 1;
      const needOrder = planRows
        .filter((p2) => (p2.publish_order || 0) === 0)
        .sort((a, b) => a.slug.localeCompare(b.slug));
      for (const p2 of needOrder) {
        // same (slug, lang) keying: never assign an order to the zh-hans row by mistake
        await repo.upsert(conn, appId, { slug: p2.slug, publish_order: nextOrder++ },
          { lang: repo.normalizeLang(p2.lang) });
      }

      // 6. featured_image: back-looked-up from article_images (position='featured') or config
      for (const p of planRows) {
        if (p.article_id == null) continue;
        const [feat] = await conn.query(
          `SELECT COALESCE(ai.local_url, ai.original_url) AS url
           FROM ${TABLES.articleImages} ai
           LEFT JOIN ${TABLES.images} i ON ai.image_id = i.id
           WHERE ai.article_id = ? AND ai.app_id = ? AND ai.position = 'featured'
           LIMIT 1`,
          [p.article_id, appId]
        );
        let url = feat.length ? feat[0].url : null;
        if (!url) {
          // 2026-09-20: config table retired; featured_image falls back to the articles column
          const [arts] = await conn.query(
            `SELECT featured_image FROM ${TABLES.articles} WHERE id = ? AND app_id = ? LIMIT 1`,
            [p.article_id, appId]
          );
          url = arts.length ? arts[0].featured_image : null;
        }
        if (url) {
          await conn.query(
            `UPDATE ${TABLES.articles} SET featured_image = ? WHERE id = ? AND app_id = ?`,
            [url, p.article_id, appId]
          );
          report.featured_filled += 1;
        }
      }

      // 7. hub rows (7 category hub pages; paused = not part of the publish queue)
      const hubCount = await conn.query(
        `SELECT COUNT(*) n FROM ${TABLES.articlePlan} WHERE app_id = ? AND node_type = 'hub'`,
        [appId]
      );
      if (!hubCount[0][0].n) {
        const [categories] = await conn.query(
          `SELECT slug, name FROM ${TABLES.categories} WHERE app_id = ? ORDER BY slug`,
          [appId]
        );
        for (const c of categories) {
          const hub = await repo.upsert(conn, appId, {
            slug: c.slug,
            node_type: 'hub',
            hub_cluster: CATEGORY_CLUSTER[c.slug] || null,
            title: `${c.name}枢纽页`,
            category: c.slug,
            notes: '类目枢纽页（Hub & Spoke 拓扑标注，非文章，不参与发布队列）',
          });
          // hub rows are pre-writing holds, so `paused` is the legal plan-only state —
          // set it through the single entry rather than in the INSERT.
          await articleState.setState({
            appId, slug: c.slug, lang: repo.normalizeLang(hub && hub.lang) || 'zh-hans', to: 'paused', conn,
          });
          report.hub_rows += 1;
        }
      } else {
        report.hub_rows = hubCount[0][0].n;
      }

      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    }
  });

  // 8. row census. There is no external slug set to compare against any more: the
  //    table is the source of truth, so this is just a count.
  const allPlan = await list({ appId });
  report.total_plan_rows = allPlan.length;

  return report;
}

// ---------------------------------------------------------------------------
// validation (plan-layer local validation; WP-side consistency is done by taxonomy.js
// based on this table)
// ---------------------------------------------------------------------------

/**
 * Validate (DB-only since 2026-10-07): ① plan category/tags are all on the
 * allow-list; ② published/queued rows have a non-empty wp_post_id; ③ published rows
 * have a non-empty published_url.
 *
 * The old ② "local md file exists" check was removed: it made a service function
 * depend on the filesystem AND on loadSite() resolving the site from process.argv,
 * so verify() threw before doing any work whenever it was called programmatically.
 * Whether an article's content exists is a fact of the articles table, not of a
 * directory listing.
 * @returns {Promise<{ok:boolean, errors:string[], stats:object}>}
 */
async function verify({ appId = DEFAULT_APP_ID() } = {}) {
  const errors = [];
  const whitelistCats = new Set((await categoryWhitelist({ appId })).map((c) => c.slug));
  const whitelistTags = new Set((await tagWhitelist({ appId })).map((t) => t.slug));
  const rows = await list({ appId });

  const stats = { total: rows.length, hub: 0, spoke: 0, todo: 0, written: 0, queued: 0, published: 0, paused: 0 };
  for (const r of rows) {
    if (r.node_type === 'hub') { stats.hub += 1; continue; }
    stats.spoke += 1;
    stats[r.plan_status] = (stats[r.plan_status] || 0) + 1;

    if (r.category && !whitelistCats.has(r.category)) {
      errors.push(`${r.slug}: category ${r.category} is not on the allow-list`);
    }
    for (const t of r.tags) {
      if (!whitelistTags.has(t)) errors.push(`${r.slug}: tag ${t} is not on the allow-list`);
    }
    if (['queued', 'published'].includes(r.plan_status) && !r.wp_post_id) {
      errors.push(`${r.slug}: ${r.plan_status} status is missing wp_post_id`);
    }
    if (r.plan_status === 'published' && !r.published_url) {
      errors.push(`${r.slug}: published status is missing published_url`);
    }
  }
  return { ok: errors.length === 0, errors, stats };
}

// ---------------------------------------------------------------------------
// three-way reconciliation (WP + local files → plan table; used by plan.js sync)
// ---------------------------------------------------------------------------

/**
 * Correct the plan statuses with WP article status and local md files as authority:
 *   WP status=publish            → published (backfill wp_post_id / published_url / published_at)
 *   WP status=draft/pending/...  → queued (backfill wp_post_id)
 *   WP no valid record + local md exists → written (written, awaiting images)
 *   WP no valid record + local md missing → todo (not written)
 * hub (paused) rows are skipped; category/tag differences are reported but never
 * overwritten (the plan table is the matrix-planning source of truth).
 *
 * @param {object} opts
 *   appId          app ID (default 1)
 *   wpPosts        all WP posts [{slug, id, status, link, date, categories:[id], tags:[id]}]
 *   categoryById   Map(WP category id → slug)
 *   tagById        Map(WP tag id → slug)
 *   localSlugs     local md file slug set (posts + drafts, scanned by the command layer)
 *   dryRun         default true: compute only, no writes; false executes updates
 * @returns {Promise<object>} the reconciliation report
 */
async function reconcile({
  appId = DEFAULT_APP_ID(),
  wpPosts = [],
  categoryById = new Map(),
  tagById = new Map(),
  localSlugs = new Set(),
  dryRun = true,
} = {}) {
  const rows = await list({ appId });
  const wpBySlug = new Map(wpPosts.map((p) => [p.slug, p]));
  // Lang-aware WP index. WP's native slug is ambiguous across translations (the same
  // slug exists once per language); the post `link` carries the language prefix
  // (/zh-hans/, /zh-hant/, bare = en), so we index by slug|lang to match precisely.
  // Without this, a slug with mixed publish states would wrongly inherit one
  // language's WP status onto every language row — for both the plan table and
  // (via healArticleStatus) articles.status.
  const wpBySlugLang = new Map();
  for (const p of wpPosts) {
    const l = langFromLink(p.link);
    if (l && p.slug) wpBySlugLang.set(`${p.slug}|${l}`, p);
  }
  const rowSlugs = new Set(rows.map((r) => r.slug));
  const site = require('../site/config').loadSite();
  const domain = (site.site.site && site.site.site.domain) || 'tengence.com';
  const articleUrl = (slug) => `https://www.${domain}/blog/article/${slug}/`;

  const WP_ACTIVE_STATUS = ['draft', 'pending', 'future', 'private'];
  const report = {
    dryRun,
    total_spoke: 0,
    unchanged: 0,
    updated: [],
    articles_updated: [],
    taxonomy_mismatch: [],
    wp_not_in_plan: [],
  };

  // WP has but plan lacks (non-matrix legacy / missed registration): reported only,
  // never auto-added
  for (const wp of wpPosts) {
    if (!rowSlugs.has(wp.slug)) {
      report.wp_not_in_plan.push({ slug: wp.slug, wp_status: wp.status, wp_post_id: wp.id });
    }
  }

  for (const p of rows) {
    if (p.node_type === 'hub' || p.plan_status === 'paused') continue;
    report.total_spoke += 1;

    // Prefer the lang-matched WP post; fall back to slug-only (preserves historical
    // behaviour for posts whose language can't be derived from the link).
    const langKey = p.lang ? `${p.slug}|${toLinkLang(p.lang)}` : null;
    const wp = (langKey && wpBySlugLang.get(langKey)) || wpBySlug.get(p.slug) || null;
    let to = null;
    const patch = {};

    if (wp && wp.status === 'publish') {
      to = 'published';
      if (p.wp_post_id !== wp.id) patch.wp_post_id = wp.id;
      if (!p.published_url) patch.published_url = articleUrl(p.slug);
      if (!p.published_at && wp.date) patch.published_at = String(wp.date).slice(0, 19).replace('T', ' ');

      // category/tag consistency: reported only, never overwritten (the WP side may
      // diverge from matrix-planning history)
      const wpCats = (wp.categories || []).map((id) => categoryById.get(id)).filter(Boolean);
      const wpTags = (wp.tags || []).map((id) => tagById.get(id)).filter(Boolean);
      if (p.category && wpCats.length && !wpCats.includes(p.category)) {
        report.taxonomy_mismatch.push({ slug: p.slug, field: 'category', plan: p.category, wp: wpCats.join(',') });
      }
      const planTagSet = new Set(Array.isArray(p.tags) ? p.tags : []);
      const wpTagSet = new Set(wpTags);
      const miss = [...planTagSet].filter((t) => !wpTagSet.has(t));
      const extra = wpTags.filter((t) => !planTagSet.has(t));
      if (miss.length || extra.length) {
        report.taxonomy_mismatch.push({
          slug: p.slug,
          field: 'tags',
          plan: Array.isArray(p.tags) ? p.tags.join(',') : '',
          wp: wpTags.join(','),
          plan_missing_in_wp: miss.join(',') || null,
          wp_extra: extra.join(',') || null,
        });
      }
    } else if (wp && WP_ACTIVE_STATUS.includes(wp.status)) {
      to = 'queued';
      if (p.wp_post_id !== wp.id) patch.wp_post_id = wp.id;
    } else {
      // WP has no record (or trash/auto-draft): judged by the local file
      to = localSlugs.has(p.slug) ? 'written' : 'todo';
    }

    if (to === null) continue;
    const changed = to !== p.plan_status || Object.keys(patch).length > 0;
    if (!changed) report.unchanged += 1;

    // Root-cause fix: articles.status was only ever written by the publish pipeline
    // (markPublished), so posts published outside it — e.g. directly in WP — stayed
    // stuck at 'draft', making the field untrustworthy. Mirror the WP/plan truth onto
    // articles.status here. This runs for EVERY iterated row, NOT just plan_status
    // changes: the plan table can already be correct while articles.status is
    // independently drifted, and that drift is exactly what we must repair. Keyed by
    // article_id (exact) then slug+lang, so a slug with mixed-language publish states
    // never bleeds one language's status onto another.
    const articlesWpPostId = wp ? wp.id : null;
    const healedState = to === 'published' ? 'published' : to === 'queued' ? 'queued' : 'written';
    const healed = await healArticleStatus({ appId, planRow: p, state: healedState, wpPostId: articlesWpPostId, dryRun });
    if (healed.changed) {
      report.articles_updated.push({
        slug: p.slug,
        lang: p.lang || null,
        from: healed.from,
        to: healedState,
        wp_post_id: articlesWpPostId,
      });
    }

    if (changed) {
      if (!dryRun) {
        // plan_status is a mirror: state was already written above through article-state.
        // Only non-status mirror columns go straight to the plan row — always with lang.
        if (Object.keys(patch).length) {
          await updateStatus(p.slug, patch, { appId, lang: p.lang || 'zh-hans' });
        }
        await articleState.syncPlanMirror({ appId, slug: p.slug, lang: p.lang || 'zh-hans' });
      }
      report.updated.push({
        slug: p.slug,
        from: p.plan_status,
        to,
        wp_post_id: patch.wp_post_id || p.wp_post_id || null,
        ...(patch.published_url ? { published_url: patch.published_url } : {}),
      });
    }
  }

  return report;
}

module.exports = {
  // repository passthrough
  list, get, getByArticleId, upsert, updateStatus,
  // status transitions
  markQueued, markPublished, setFeaturedImage,
  // queue
  nextDue,
  // allow-lists
  categoryWhitelist, tagWhitelist,
  // import & validation
  importPlan, verify,
  // reconcile sync
  reconcile,
  // (document parsers removed 2026-10-07: the plan table is the only data source;
  //  structured rows go through upsert / importPlan, never through a file)
  // per-platform publishing calendar (workspace-local channel_plan table)
  channel: require('./channel'),
  // auto-publish scheduling rules (workspace-local channel_schedule table) +
  // the unified executor publishDue()
  channelSchedule: require('./channel-schedule'),
};
