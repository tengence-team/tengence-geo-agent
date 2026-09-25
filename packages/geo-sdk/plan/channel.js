'use strict';
/**
 * Channel publishing-calendar service (plan domain) — t.plan.channel
 * ============================================================================
 * Orchestration over the workspace-local channel_plan table (repo: db/channel-plan):
 *   - importWechatPlan() parses the site's 《微信公众号发布计划.md》 into calendar rows
 *     (wechat keeps a real per-issue calendar; nextDue returns the earliest todo row)
 *   - juejin / devto: the table is a PUBLISH LOG. We NEVER bulk-import the blog plan.
 *     recordPublish() writes one row per slug on each attempt (success → published,
 *     failure → failed) keyed by slug; reconcileFromJuejin() seeds already-published
 *     articles. nextDue() derives the next slug from the blog publish_order, skipping
 *     slugs already published on that platform (failed rows retry).
 *   - list / markStatus / nextDue expose the calendar to CLIs and MCP tools
 *
 * Data flow:
 *   channel-plan.js CLI   list / next / import-wechat / reconcile → this service
 *   channel-publish.js    records each outcome via recordPublish() (juejin)
 *   MCP channel_plan_next → nextDue() → next slug to prepare
 * ============================================================================
 */
const fs = require('fs');
const t = require('../index');
const repo = require('../db/channel-plan');
const planRepo = require('../db/plan');
const { withConn } = require('../db/connection');

/** Default tenant: process-level APP_ID env var (default 1). */
const DEFAULT_APP_ID = () => Number(process.env.APP_ID || 1);

/** Overview status text → row status. */
const OVERVIEW_STATUS = { '✅': 'published', '📝': 'draft', '⬜': 'todo' };

/**
 * Parse the 《微信公众号发布计划.md》 text into calendar rows.
 * Extracts from each `### 第N期 <主题>` block:
 *   - the per-issue overview row (建议发布日 / 状态) and
 *   - the article slug table (slug, draft id, per-row status).
 * @param {string} text raw markdown of the plan document
 * @returns {Array<{period:string, topic:string, weekday:string|null, weekdayNote:string|null,
 *                  article_slugs:string[], status:string, draft_ids:string[], notes:string|null}>}
 */
function parseWechatPlanText(text) {
  const lines = text.split('\n');
  const issues = [];
  let current = null; // { period, topic, overview: {...}, articles: [...] }
  // The overview table ("二、排期总览") appears BEFORE the per-issue sections;
  // collect it globally and merge at flush time.
  const overviewByPeriod = new Map();

  const flush = () => {
    if (!current) return;
    const overview = current.overview || overviewByPeriod.get(current.period) || {};
    const slugs = current.articles.map((a) => a.slug).filter(Boolean);
    const status = OVERVIEW_STATUS[overview.statusMark] || (current.articles.some((a) => /已群发/.test(a.statusText)) ? 'published' : current.articles.some((a) => /草稿已建/.test(a.statusText)) ? 'draft' : 'todo');
    const draftIds = [...new Set(current.articles.map((a) => a.draftId).filter((d) => d && d !== '—' && d !== '-'))];
    issues.push({
      period: current.period,
      topic: current.topic || null,
      weekday: overview.weekday || null,
      weekdayNote: overview.weekdayNote || null,
      article_slugs: slugs,
      status,
      draft_ids: draftIds,
      notes: overview.weekdayNote ? `建议发布日：${overview.weekdayNote}` : null,
    });
    current = null;
  };

  const overviewRe = /^\|\s*(第\d+期)\s*\|\s*((?:第\d+周\s*)?[^|]*)\s*\|\s*([^|]*)\s*\|\s*\d+\s*\|\s*([✅📝⬜])/;
  const issueHeadRe = /^###\s*(第\d+期)\s+(.+)$/;
  const articleRowRe = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/;

  for (const line of lines) {
    const head = line.match(issueHeadRe);
    if (head) {
      flush();
      current = { period: head[1], topic: head[2].trim(), overview: null, articles: [] };
      continue;
    }
    if (!current) {
      // overview rows live before the per-issue sections
      const ov = line.match(overviewRe);
      if (ov && ov[1]) {
        overviewByPeriod.set(ov[1], {
          weekday: ov[2].replace(/^第\d+周[\s\u3000]*/, '').trim() || null,
          weekdayNote: ov[2].trim(),
          statusMark: ov[4],
        });
      }
      continue;
    }
    const row = line.match(articleRowRe);
    if (row && current) {
      current.articles.push({
        num: row[1],
        slug: row[2].trim(),
        title: row[3].trim(),
        category: row[4].trim(),
        tags: row[5].trim(),
        url: row[6].trim(),
        draftId: row[7].trim(),
        statusText: row[8].trim(),
      });
      continue;
    }
    // overview row inside the same section region (fallback capture)
    if (current && !current.overview) {
      const ov = line.match(overviewRe);
      if (ov && ov[1] === current.period) {
        current.overview = {
          weekday: ov[2].replace(/^第\d+周[\s\u3000]*/, '').trim() || null,
          weekdayNote: ov[2].trim(),
          statusMark: ov[4],
        };
      }
    }
  }
  flush();
  return issues;
}

/**
 * Import rows from the 《微信公众号发布计划.md》 file.
 * Upserts each issue keyed by (platform='wechat', period).
 * @param {string} mdPath absolute path of the plan markdown
 * @returns {Promise<{platform:string, imported:number, updated:number, rows:number}>}
 */
async function importWechatPlan(mdPath) {
  if (!fs.existsSync(mdPath)) throw new Error(`WeChat plan file not found: ${mdPath}`);
  const text = fs.readFileSync(mdPath, 'utf8');
  const issues = parseWechatPlanText(text);
  const appId = DEFAULT_APP_ID();
  let imported = 0;
  let updated = 0;
  await withConn(async (conn) => {
    for (const issue of issues) {
      const res = await repo.upsert(conn, appId, {
        platform: 'wechat',
        period: issue.period,
        topic: issue.topic,
        weekday: issue.weekday,
        article_slugs: issue.article_slugs,
        status: issue.status,
        draft_ids: issue.draft_ids,
        notes: issue.notes,
      });
      if (res.action === 'insert') imported += 1;
      else updated += 1;
    }
  });
  return { platform: 'wechat', imported, updated, rows: issues.length };
}

/** List calendar rows (optional platform / status filter). */
async function list({ platform, status } = {}) {
  const appId = DEFAULT_APP_ID();
  let result;
  await withConn(async (conn) => {
    result = await repo.list(conn, appId, { platform, status });
  });
  return result;
}

/** Get one row by id. */
async function get(id) {
  const appId = DEFAULT_APP_ID();
  let result;
  await withConn(async (conn) => {
    result = await repo.get(conn, appId, Number(id));
  });
  return result;
}

/** Transition a row's status (todo → draft → published / paused); optionally records draft ids. */
async function markStatus(id, status, draftIds) {
  const appId = DEFAULT_APP_ID();
  let result;
  await withConn(async (conn) => {
    result = await repo.markStatus(conn, appId, Number(id), status, draftIds);
  });
  return result;
}

/** The next due row for a platform (earliest row still in todo), or null. */
async function nextDue(platform) {
  const appId = DEFAULT_APP_ID();
  let result;
  await withConn(async (conn) => {
    result = await repo.nextDue(conn, appId, platform);
  });
  return result;
}

/**
 * Clear every row for a platform (drop a stale bulk-import before re-seeding with
 * only the actually-published articles).
 * @returns {Promise<{platform:string, deleted:number}>}
 */
async function clearPlatform(platform) {
  if (!platform) throw new Error('clearPlatform requires platform');
  const appId = DEFAULT_APP_ID();
  let deleted = 0;
  await withConn(async (conn) => {
    deleted = await repo.removeAll(conn, appId, platform);
  });
  return { platform, deleted };
}

/**
 * Set of slugs already marked `published` on a platform — drives nextDue skip.
 * @returns {Promise<Set<string>>}
 */
async function publishedSlugs(platform) {
  const appId = DEFAULT_APP_ID();
  const set = new Set();
  await withConn(async (conn) => {
    const rows = await repo.list(conn, appId, { platform, status: 'published' });
    for (const row of rows) for (const s of row.article_slugs) set.add(s);
  });
  return set;
}

/**
 * Record the OUTCOME of a publish attempt for one slug on a platform. Called by the
 * publish pipeline after each attempt (success OR failure). This is the ONLY writer
 * for non-wechat platforms: the channel_plan table is a publish LOG, NOT a mirror of
 * the blog plan. Idempotent — re-running on success updates the prior failed/duplicate
 * row instead of creating a new one.
 *
 * @param {{platform:string, slug:string, title?:string, blogOrder?:number,
 *          status:'published'|'failed', draftId?:string,
 *          notes?:string, error?:string}} rec
 * @returns {Promise<{ok:boolean, platform:string, slug:string, status:string}>}
 */
async function recordPublish(rec) {
  if (!rec || !rec.platform || !rec.slug) throw new Error('recordPublish requires platform + slug');
  const appId = DEFAULT_APP_ID();
  let order = rec.blogOrder;
  if (order == null) {
    await withConn(async (conn) => {
      const r = await planRepo.getBySlug(conn, appId, rec.slug);
      order = r ? r.publish_order : null;
    });
  }
  const period = `P${order != null ? order : 'x'}`;
  await withConn(async (conn) => {
    await repo.upsertBySlug(conn, appId, {
      platform: rec.platform,
      slug: rec.slug,
      title: rec.title || null,
      topic: rec.title || rec.slug,
      blogOrder: order,
      status: rec.status || 'failed',
      draftId: rec.draftId || null,
      notes: rec.error ? `error: ${String(rec.error).slice(0, 200)}` : rec.notes || null,
    });
  });
  return { ok: true, platform: rec.platform, slug: rec.slug, status: rec.status || 'failed' };
}

/**
 * Reconcile a platform's channel_plan with what is ACTUALLY on the platform.
 * For juejin this is the seeding step — we NEVER bulk-import the blog plan; the
 * table only logs real outcomes. Two modes:
 *   - map provided: insert the explicitly-known published articles (by slug).
 *   - no map: live-read the platform's published list and match back to blog slugs
 *     by title (useful later, once rate limits allow). Unmatched titles fall back to
 *     a synthetic slug so they are at least recorded.
 * @returns {Promise<{platform:string, source:string, inserted:number, matched:number, unmatched:number}>}
 */
async function reconcileFromJuejin({ map } = {}) {
  const appId = DEFAULT_APP_ID();
  if (Array.isArray(map) && map.length) {
    await withConn(async (conn) => {
      for (const m of map) {
        await repo.upsertBySlug(conn, appId, {
          platform: 'juejin',
          slug: m.slug,
          title: m.title || m.slug,
          topic: m.title || m.slug,
          blogOrder: m.blogOrder != null ? m.blogOrder : null,
          status: 'published',
          draftId: m.draftId || null,
          notes: m.notes || null,
        });
      }
    });
    return { platform: 'juejin', source: 'map', inserted: map.length, matched: map.length, unmatched: 0 };
  }
  // live mode: read the platform and match titles back to blog slugs
  const blog = (await t.plan.list({ limit: 5000 })).filter((r) => r.plan_status === 'published');
  const titleToSlug = new Map(blog.map((r) => [(r.title || '').trim().toLowerCase(), r.slug]));
  const jj = t.syndicate.juejin;
  const pub = await jj.listPublished(0, 50);
  const data = pub && pub.data;
  const items = Array.isArray(data) ? data : data && Array.isArray(data.data) ? data.data : [];
  let inserted = 0;
  let matched = 0;
  let unmatched = 0;
  await withConn(async (conn) => {
    for (const it of items) {
      const title = it.title || (it.article_info && it.article_info.title) || '';
      const articleId = it.article_id || it.id;
      const slug = titleToSlug.get(title.trim().toLowerCase());
      if (slug) {
        matched += 1;
        await repo.upsertBySlug(conn, appId, {
          platform: 'juejin',
          slug,
          title: title || slug,
          topic: title || slug,
          status: 'published',
          notes: null,
        });
      } else {
        unmatched += 1;
        await repo.upsertBySlug(conn, appId, {
          platform: 'juejin',
          slug: String(articleId),
          title: title || String(articleId),
          topic: title || String(articleId),
          status: 'published',
          notes: 'unmatched title — synthetic slug',
        });
      }
      inserted += 1;
    }
  });
  return { platform: 'juejin', source: 'api', inserted, matched, unmatched };
}

/**
 * The next article to publish on a platform.
 *   - wechat: the earliest calendar row still in todo (per-issue batch).
 *   - juejin / devto: DERIVED from the blog article plan — only blog-published rows,
 *     in publish_order, skipping slugs already recorded as published here. This keeps
 *     the juejin queue in the SAME order as the blog, resuming right after the last
 *     article published to that platform (a failed row is NOT skipped, so it retries).
 * @returns {Promise<object|null>}
 */
async function nextDue(platform) {
  const appId = DEFAULT_APP_ID();
  if (platform === 'wechat') {
    let result;
    await withConn(async (conn) => {
      result = await repo.nextDue(conn, appId, platform);
    });
    return result;
  }
  const published = await publishedSlugs(platform);
  const blog = (await t.plan.list({ limit: 5000 })).filter((r) => r.plan_status === 'published');
  const sorted = blog.slice().sort((a, b) => (a.publish_order || 1e9) - (b.publish_order || 1e9));
  for (const r of sorted) {
    if (published.has(r.slug)) continue;
    return {
      platform,
      status: 'todo',
      source: 'blog_plan',
      id: null,
      period: null,
      slug: r.slug,
      article_slugs: [r.slug],
      title: r.title,
      topic: r.title,
      blogOrder: r.publish_order,
    };
  }
  return null;
}

module.exports = {
  parseWechatPlanText,
  importWechatPlan,
  clearPlatform,
  publishedSlugs,
  recordPublish,
  reconcileFromJuejin,
  list,
  get,
  markStatus,
  nextDue,
};
