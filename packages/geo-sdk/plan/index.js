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

const fs = require('fs');
const path = require('path');
const repo = require('../db/plan');
const { TABLES } = require('../db/schema');
const { withConn } = require('../db/connection');

/** Default tenant: process-level APP_ID env var (default 1); SQLite single-file
 * multi-tenant isolation is by app_id */
const DEFAULT_APP_ID = () => Number(process.env.APP_ID || 1);

const MATRIX_COLUMNS = 13; // | code | slug | title | keyword | volume | competition | intent | type | words | batch | category | tags | status |

/** matrix status legend → plan_status */
const MATRIX_STATUS = { '✅': 'published', '🕐': 'queued', '📝': 'written', '🆕': 'todo' };

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
// import-source parsing
// ---------------------------------------------------------------------------

/** Parse the §6.1–6.7 matrix tables of "内容发布计划.md" (13-column table rows) */
function parseMatrix(mdPath) {
  if (!fs.existsSync(mdPath)) return { rows: [], warned: [] };
  const lines = fs.readFileSync(mdPath, 'utf8').split('\n');
  const rows = [];
  const warned = [];
  for (const line of lines) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // strip the leading/trailing empty segments (| at both ends)
    if (cells[0] === '') cells.shift();
    if (cells.length && cells[cells.length - 1] === '') cells.pop();
    if (cells.length !== MATRIX_COLUMNS) continue;
    const [code, slug, title, keyword, volume, competition, intent, type, words, batch, category, tagStr, status] = cells;
    // skip header rows (code/slug are column names) and separator rows (---)
    if (!slug || /^-+$/.test(slug) || slug === 'slug' || !code || /^-+$/.test(code) || code === '编号') continue;
    if (!slug) {
      if (code) warned.push(`Matrix row ${code} (${title}) is missing a slug; will be backfilled by the queue/taxonomy`);
      continue;
    }
    const tags = tagStr
      ? tagStr.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      : [];
    rows.push({
      slug,
      matrix_code: code || null,
      title: title || null,
      focus_keyword: keyword && keyword !== '—' ? keyword : null,
      keyword_volume: /^\d/.test(volume) ? parseInt(volume.replace(/,/g, ''), 10) : null,
      keyword_competition: competition && competition !== '—' ? competition : null,
      search_intent: intent || null,
      content_type: type || null,
      target_word_count: /^\d/.test(words) ? parseInt(words, 10) : null,
      publish_batch: /^\d/.test(batch) ? parseInt(batch, 10) : null,
      category: category || null,
      tags,
      plan_status: MATRIX_STATUS[status] || null,
      hub_cluster: CATEGORY_CLUSTER[category] || null,
    });
  }
  return { rows, warned };
}

/** Parse publish-queue.json (queue runtime facts: schedule/status/timestamps) */
function parseQueue(queuePath) {
  if (!fs.existsSync(queuePath)) return { items: [], meta: {} };
  const q = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  const items = (q.items || []).map((it) => ({
    slug: it.slug,
    publish_order: it.seq || 0,
    matrix_code: it.code || null,
    title: it.title || null,
    // focus_keyword: queue-only topics (no matrix row) carry their keyword here;
    // upsert() skips null values, so a missing field never wipes a matrix keyword
    focus_keyword: it.focus_keyword || null,
    target_word_count: it.words || null,
    category: it.category || it.dir || null,
    tags: Array.isArray(it.tags) ? it.tags : [],
    wp_post_id: it.wp_post_id || null,
    plan_status: it.status === 'published' ? 'published' : (it.status === 'queued' ? 'queued' : null),
    queued_at: it.queued_at || null,
    published_at: it.published_at ? it.published_at.slice(0, 19).replace('T', ' ') : null,
    notes: it.note || null,
    hub_cluster: CATEGORY_CLUSTER[it.category || it.dir] || null,
  }));
  return { items, meta: { skip_dates: q.skip_dates || [], per_day: q.per_day, note: q.note } };
}

/** Whether the article is already ingested (since 2026-09-20: DB is the single
 * authority; written = articles already has a row) */
function mdExists(bySlug, slug) {
  return bySlug.has(slug);
}

// ---------------------------------------------------------------------------
// service API
// ---------------------------------------------------------------------------

/** List (for db-query --plan) */
async function list({ appId = DEFAULT_APP_ID(), status, batch, cluster, category, nodeType, limit } = {}) {
  return withConn((conn) => repo.list(conn, appId, { status, batch, cluster, category, nodeType, limit }));
}

/** Single-row lookup */
async function get(slug, { appId = DEFAULT_APP_ID() } = {}) {
  return withConn((conn) => repo.getBySlug(conn, appId, slug));
}

/** Lookup by article_id (the publish chain reverses category/tags) */
async function getByArticleId(articleId, { appId = DEFAULT_APP_ID() } = {}) {
  return withConn((conn) => repo.getByArticleId(conn, appId, articleId));
}

/** Register / update a row (idempotent; field-merge semantics live in the repository) */
async function upsert(record, { appId = DEFAULT_APP_ID() } = {}) {
  if (!record || !record.slug) throw new Error('plan.upsert requires record.slug');
  return withConn((conn) => repo.upsert(conn, appId, record));
}

/** Status transition (the single write entry for status) */
async function updateStatus(slug, fields, { appId = DEFAULT_APP_ID() } = {}) {
  if (!slug) throw new Error('plan.updateStatus requires slug');
  return withConn((conn) => repo.updateStatus(conn, appId, slug, fields));
}

/** After a draft push succeeds: written → queued, backfill article_id / wp_post_id / queued_at */
async function markQueued(slug, { articleId, wpPostId, queuedAt } = {}, { appId = DEFAULT_APP_ID() } = {}) {
  const ts = queuedAt || new Date();
  return updateStatus(slug, {
    plan_status: 'queued',
    article_id: articleId,
    wp_post_id: wpPostId,
    queued_at: ts instanceof Date ? ts.toISOString().slice(0, 19).replace('T', ' ') : ts,
  }, { appId });
}

/** After promotion succeeds: queued → published, backfill wp_post_id / published_url / published_at */
async function markPublished(slug, { wpPostId, publishedUrl, publishedAt } = {}, { appId = DEFAULT_APP_ID() } = {}) {
  const ts = publishedAt || new Date();
  return updateStatus(slug, {
    plan_status: 'published',
    wp_post_id: wpPostId,
    published_url: publishedUrl,
    published_at: ts instanceof Date ? ts.toISOString().slice(0, 19).replace('T', ' ') : ts,
  }, { appId });
}

/** Backfill the featured-image path after image acquisition (2026-09-20: writes
 * articles.featured_image; the plan column retired) */
async function setFeaturedImage(slug, url, { appId = DEFAULT_APP_ID() } = {}) {
  return withConn(async (conn) => {
    const [r] = await conn.query(
      `UPDATE ${TABLES.articles} SET featured_image = ? WHERE app_id = ? AND slug = ?`,
      [url, appId, slug]
    );
    return { affectedRows: r.affectedRows, slug };
  });
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
 * Dual-source merged import (idempotent, upsert by slug; the taxonomy.yaml source
 * retired 2026-09-20):
 *   matrix ("内容发布计划.md" §6.1–6.7) → publish-queue.json (overrides schedule/status/timestamps)
 * Finally backfills article_id / title / published_url / featured_image (matched by
 * slug against the articles table).
 * @param {object} site loadSite() return value
 * @param {object} opts { matrixPath, queuePath, domain } defaults auto-derived
 */
async function importPlan(site, opts = {}) {
  const matrixPath = opts.matrixPath || path.join(site.siteDir, 'plan/2026/内容发布计划.md');
  const queuePath = opts.queuePath || path.join(site.siteDir, 'plan/2026/publish-queue.json');
  const domain = opts.domain || (site.site.site && site.site.site.domain);
  const articleUrl = (slug) => `https://www.${domain}/blog/article/${slug}/`;

  const appId = Number(process.env.APP_ID || 1);

  // 1. parse both sources
  const { rows: matrixRows, warned: matrixWarned } = parseMatrix(matrixPath);
  const { items: queueItems, meta: queueMeta } = parseQueue(queuePath);

  const report = {
    matrix_rows: matrixRows.length,
    queue_items: queueItems.length,
    matrix_warned: matrixWarned,
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
      // 2. matrix (first, providing topic info)
      for (const row of matrixRows) {
        await repo.upsert(conn, appId, row);
      }

      // 3. queue (overrides schedule/status/timestamps/word-count/code — runtime facts)
      for (const item of queueItems) {
        await repo.upsert(conn, appId, item);
      }

      // 5. backfill article_id / title / wp_post_id / published_url / featured_image by slug
      const [articles] = await conn.query(
        `SELECT id, slug, title, wp_post_id, status FROM ${TABLES.articles} WHERE app_id = ?`,
        [appId]
      );
      const bySlug = new Map(articles.map((a) => [a.slug, a]));
      const [planRows] = await conn.query(
        `SELECT id, slug, title, article_id, wp_post_id, plan_status FROM ${TABLES.articlePlan} WHERE app_id = ? AND node_type = 'spoke'`,
        [appId]
      );
      for (const p of planRows) {
        const a = bySlug.get(p.slug);
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
          await repo.updateStatus(conn, appId, p.slug, patch);
          report.article_linked += 1;
        }
      }

      // 5.5 full plan_status recomputation (authority priority: queue → matrix →
      //     articles/taxonomy inference)
      //     todo=not written | written=ingested (articles has a row) | queued=WP
      //     draft pushed (wp_post_id not null)
      //     published=WP promoted (articles.status='publish')
      const queueStatus = new Map(queueItems.map((i) => [i.slug, i.plan_status]));
      const matrixStatus = new Map(matrixRows.map((r) => [r.slug, r.plan_status]));
      for (const p of planRows) {
        let st;
        if (queueStatus.has(p.slug) && queueStatus.get(p.slug)) {
          st = queueStatus.get(p.slug);
        } else if (matrixStatus.has(p.slug) && matrixStatus.get(p.slug)) {
          st = matrixStatus.get(p.slug);
        } else {
          const a = bySlug.get(p.slug);
          if (a && a.status === 'publish') st = 'published';
          else if (a && a.wp_post_id) st = 'queued';
          else st = mdExists(bySlug, p.slug) ? 'written' : 'todo';
        }
        // strictness: pending (draft not pushed) with md → written; without md → todo
        if (st === 'queued' && !p.wp_post_id) {
          st = mdExists(bySlug, p.slug) ? 'written' : 'todo';
        }
        // published is terminal: publish-queue.json / the matrix are one-time import
        // seeds, so a stale file status must never rewind a row the DB already
        // published — a rewind would let promote-daily publish the same article twice.
        if (p.plan_status === 'published' && st !== 'published') st = 'published';
        const urlPatch = st === 'published' && !p.published_url ? articleUrl(p.slug) : null;
        if (st !== p.plan_status || urlPatch) {
          await repo.updateStatus(conn, appId, p.slug, {
            plan_status: st,
            ...(urlPatch ? { published_url: urlPatch } : {}),
          });
          if (urlPatch) report.published_url_filled += 1;
        }
      }

      // 5.7 complete publish_order: non-queue rows (unassigned) get ordered after the
      //     queue, by matrix_code, so promote-daily first publishes the "43 freshly
      //     written queue items", then the legacy drafts (idempotent: existing nonzero
      //     orders are kept)
      const queueSlugs = new Set(queueItems.map((i) => i.slug));
      let nextOrder = queueItems.reduce((m, i) => Math.max(m, i.publish_order || 0), 0) + 1;
      const needOrder = planRows
        .filter((p2) => !queueSlugs.has(p2.slug) && (p2.publish_order || 0) === 0)
        .sort(
          (a, b) =>
            (a.matrix_code || 'zzz').localeCompare(b.matrix_code || 'zzz') ||
            a.slug.localeCompare(b.slug)
        );
      for (const p2 of needOrder) {
        await repo.upsert(conn, appId, { slug: p2.slug, publish_order: nextOrder++ });
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
          await repo.upsert(conn, appId, {
            slug: c.slug,
            node_type: 'hub',
            hub_cluster: CATEGORY_CLUSTER[c.slug] || null,
            title: `${c.name}枢纽页`,
            category: c.slug,
            plan_status: 'paused',
            notes: '类目枢纽页（Hub & Spoke 拓扑标注，非文章，不参与发布队列）',
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

  // 8. aggregate created/updated (a fully precise post-import comparison against
  //    matrix+queue+taxonomy counts is hard; instead count rows present after the
  //    slug-set merge)
  const expectedSlugs = new Set([
    ...matrixRows.map((r) => r.slug),
    ...queueItems.map((i) => i.slug),
  ]);
  const allPlan = await list({ appId });
  report.total_plan_rows = allPlan.length;
  report.expected_slugs = expectedSlugs.size;
  report.not_in_plan = [...expectedSlugs].filter((s) => !allPlan.some((p) => p.slug === s));
  report.queue_meta = queueMeta;

  return report;
}

// ---------------------------------------------------------------------------
// validation (plan-layer local validation; WP-side consistency is done by taxonomy.js
// based on this table)
// ---------------------------------------------------------------------------

/**
 * Validate: ① plan category/tags are all on the allow-list; ② local md exists
 * (mandatory for written/queued/published); ③ published/queued rows have a non-empty
 * wp_post_id; ④ published rows have a non-empty published_url.
 * @returns {Promise<{ok:boolean, errors:string[], stats:object}>}
 */
async function verify({ appId = DEFAULT_APP_ID() } = {}) {
  const errors = [];
  const site = require('../site/config').loadSite();
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
    if (['written', 'queued', 'published'].includes(r.plan_status) && r.category) {
      if (!mdExists(site, r.slug, r.category)) {
        errors.push(`${r.slug}: local md missing (${r.category}/${r.slug}.md)`);
      }
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

    const wp = wpBySlug.get(p.slug);
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
    if (!changed) {
      report.unchanged += 1;
      continue;
    }
    if (!dryRun) {
      await updateStatus(p.slug, { plan_status: to, ...patch }, { appId });
    }
    report.updated.push({
      slug: p.slug,
      from: p.plan_status,
      to,
      wp_post_id: patch.wp_post_id || p.wp_post_id || null,
      ...(patch.published_url ? { published_url: patch.published_url } : {}),
    });
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
  // parsing (tests/debugging)
  parseMatrix, parseQueue, mdExists,
};
