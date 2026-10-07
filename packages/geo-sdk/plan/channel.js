'use strict';
/**
 * Channel publishing-calendar service (plan domain) — t.plan.channel
 * ============================================================================
 * Orchestration over the workspace-local channel_plan table (repo: db/channel-plan):
 *   - importWechatIssues() writes wechat calendar rows from STRUCTURED input. The old
 *     importWechatPlan(mdPath), which parsed 《微信公众号发布计划.md》, was removed on
 *     2026-10-07: a prose document is not a data source.
 *   - every platform (wechat included) gets its queue DERIVED from the blog
 *     article_plan publish_order — see nextDue(). The table is a PUBLISH LOG:
 *     we NEVER bulk-import the blog plan. recordPublish() writes one row per slug
 *     on each attempt (success → published, failure → failed) keyed by slug;
 *     reconcileFromPlatform() seeds already-published articles (failed rows retry).
 *     Each platform therefore owns an INDEPENDENT publishing calendar inside the
 *     shared table: only what was actually published on that platform is recorded.
 *   - list / markStatus / nextDue expose the calendar to CLIs and MCP tools
 *
 * Data flow:
 *   channel-plan.js CLI   list / next / import-wechat / reconcile → this service
 *   channel-publish.js    records each outcome via recordPublish() (juejin)
 *   MCP channel_plan_next → nextDue() → next slug to prepare
 * ============================================================================
 */
const t = require('../index');
const repo = require('../db/channel-plan');
const planRepo = require('../db/plan');
const { withConn } = require('../db/connection');

/** Default tenant: process-level APP_ID env var (default 1). */
const DEFAULT_APP_ID = () => Number(process.env.APP_ID || 1);

/**
 * Import WeChat calendar rows from STRUCTURED input.
 *
 * Replaces the old importWechatPlan(mdPath), which parsed 《微信公众号发布计划.md》
 * (2026-10-07). A prose document is not a data source: that parser depended on
 * `### 第N期` headings, a hard-coded table column count and an emoji legend, so any
 * edit to the doc silently produced zero or wrong rows. Converting markdown into
 * rows is the caller's job (AI, or a one-off script under dev/) — this API only
 * accepts the result.
 *
 * @param {Array<{period:string, topic?:string, weekday?:string,
 *                article_slugs:string[], status?:string, draft_ids?:string[],
 *                notes?:string}>} issues
 * @returns {Promise<{platform:string, imported:number, updated:number, rows:number}>}
 */
async function importWechatIssues(issues) {
  if (!Array.isArray(issues)) throw new Error('importWechatIssues requires an issues array');
  const appId = DEFAULT_APP_ID();
  let imported = 0;
  let updated = 0;
  await withConn(async (conn) => {
    for (const issue of issues) {
      if (!issue || !issue.period) throw new Error('importWechatIssues: every issue requires a period');
      const res = await repo.upsert(conn, appId, {
        platform: 'wechat',
        period: issue.period,
        topic: issue.topic || null,
        weekday: issue.weekday || null,
        article_slugs: Array.isArray(issue.article_slugs) ? issue.article_slugs : [],
        status: issue.status || 'todo',
        draft_ids: Array.isArray(issue.draft_ids) ? issue.draft_ids : [],
        notes: issue.notes || null,
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
 * Set of slugs already DISPATCHED to a platform (published OR still under review) —
 * drives the nextDue / filterUnpublished skip. `reviewing` is included so a
 * just-published-but-not-yet-approved article is never re-sent; `review_failed` and
 * `deleted` are deliberately excluded so they get a fresh (re)publish attempt.
 * @returns {Promise<Set<string>>}
 */
const DISPATCHED_STATUSES = new Set(['published', 'reviewing']);
async function publishedSlugs(platform) {
  const appId = DEFAULT_APP_ID();
  const set = new Set();
  await withConn(async (conn) => {
    const rows = await repo.list(conn, appId, { platform });
    for (const row of rows) {
      if (DISPATCHED_STATUSES.has(row.status)) {
        for (const s of row.article_slugs) set.add(s);
      }
    }
  });
  return set;
}

/**
 * Channel-agnostic publish DEDUP — the SINGLE place every platform filters out
 * slugs already published on THAT platform, BEFORE anything is sent. Every publish
 * entry point (wechat / juejin / devto, Mode A and Mode B, MCP and CLI) must go
 * through this exactly once, so the logic is never re-implemented per platform.
 *
 * Keyed STRICTLY by slug against the local channel_plan publish log — no external
 * API calls, no title matching. Only `published` rows count; `draft` rows are NOT
 * skipped (a draft may not have been mass-sent yet, and skipping it would produce
 * an incomplete message on a re-run).
 *
 * @param {string} platform platform key
 * @param {string[]} slugs ordered input slugs
 * @returns {Promise<{toPublish:string[], skipped:string[]}>}
 */
async function filterUnpublished(platform, slugs) {
  const published = await publishedSlugs(platform); // Set<string>
  const toPublish = [];
  const skipped = [];
  for (const s of slugs || []) {
    if (published.has(s)) skipped.push(s);
    else toPublish.push(s);
  }
  return { toPublish, skipped };
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
 * Reconcile a platform's channel_plan with what is ACTUALLY on that platform.
 * This is the SEEDING step — we NEVER bulk-import the blog plan; the table only logs
 * real outcomes (every platform shares the same channel_plan table, each with its own
 * `platform` rows, so juejin and csdn keep independent publishing calendars).
 * Two modes:
 *   - map provided: insert the explicitly-known published articles (by slug).
 *   - no map: live-read the platform's published list and match back to blog slugs
 *     by title. Unmatched titles fall back to a synthetic slug so they are recorded.
 *
 * @param {string} platform platform key (juejin / csdn / …)
 * @param {{map?:Array<{slug:string,title?:string,blogOrder?:number,draftId?:string,notes?:string}>}} opts
 * @returns {Promise<{platform:string, source:string, inserted:number, matched:number, unmatched:number}>}
 */
async function reconcileFromPlatform(platform, { map } = {}) {
  if (!platform) throw new Error('reconcileFromPlatform requires a platform key');
  const appId = DEFAULT_APP_ID();
  if (Array.isArray(map) && map.length) {
    await withConn(async (conn) => {
      for (const m of map) {
        await repo.upsertBySlug(conn, appId, {
          platform,
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
    return { platform, source: 'map', inserted: map.length, matched: map.length, unmatched: 0 };
  }
  // live mode: read the platform and match titles back to blog slugs
  const blog = (await t.plan.list({ limit: 5000 })).filter((r) => r.plan_status === 'published');
  const titleToSlug = new Map(blog.map((r) => [(r.title || '').trim().toLowerCase(), r.slug]));

  let items = []; // [{title, id}]
  if (platform === 'juejin') {
    const pub = await t.syndicate.juejin.listPublished(0, 50);
    const data = pub && pub.data;
    const arr = Array.isArray(data) ? data : data && Array.isArray(data.data) ? data.data : [];
    items = arr.map((it) => ({
      title: it.title || (it.article_info && it.article_info.title) || '',
      id: it.article_id || it.id,
    }));
  } else if (platform === 'csdn') {
    const pub = await t.syndicate.csdn.listPublished(1, 50);
    if (pub && pub.cookieExpired) throw new Error('CSDN_COOKIE_EXPIRED');
    items = (pub.items || []).map((it) => ({ title: it.title || '', id: it.id }));
  } else {
    throw new Error(
      `reconcileFromPlatform: live mode not implemented for platform "${platform}" — pass an explicit map[] instead`
    );
  }

  let inserted = 0;
  let matched = 0;
  let unmatched = 0;
  await withConn(async (conn) => {
    for (const it of items) {
      const title = it.title || '';
      const articleId = it.id;
      const slug = titleToSlug.get(title.trim().toLowerCase());
      if (slug) {
        matched += 1;
        await repo.upsertBySlug(conn, appId, {
          platform,
          slug,
          title: title || slug,
          topic: title || slug,
          status: 'published',
          notes: null,
        });
      } else {
        unmatched += 1;
        await repo.upsertBySlug(conn, appId, {
          platform,
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
  return { platform, source: 'api', inserted, matched, unmatched };
}

/** Backwards-compatible juejin entry point (now a thin wrapper over the generic one). */
async function reconcileFromJuejin({ map } = {}) {
  return reconcileFromPlatform('juejin', { map });
}

/**
 * Reconcile a platform's channel_plan STATUSES with the platform's LIVE article list.
 * This is the "refresh my latest status from the source of truth" step the user asked
 * for: query the platform's article list (the most complete / authentic view — it
 * includes articles still under review, and drops deleted ones) and rewrite each
 * local row's status to match reality.
 *
 * Juejin semantics (verified empirically against public article pages):
 *   article_info.audit_status : 2 = 审核通过/已发布(publicly visible) · 1 = 审核中(under
 *                               review, public page 404s) · 0/3/… = treat as rejected
 *   article_info.status       : 1 = published · 0 = under review (consistent with audit)
 *   article_info.verify_status: editor-pick flag (0/1), NOT review-related
 * A row whose article is absent from the live list entirely is treated as `deleted`.
 *
 * Matching priority per row: juejin draft_id (stored in row.draft_ids) → normalized
 * title (row.topic OR the canonical blog title for the row's slug).
 *
 * Robustness: the platform's list API is occasionally flaky (a single call can drop an
 * item). To avoid a transient gap being mis-read as `deleted`, we fetch `retries` times,
 * keep the MOST COMPLETE response for status values, and build a UNION of draft_ids /
 * titles across ALL successful fetches for the existence check. An article is only
 * declared `deleted` when it is absent from every successful fetch AND the returned
 * list looks complete (did not unexpectedly shrink below the count of already-dispatched
 * rows). Otherwise a genuinely-present-but-unreadable-this-run article keeps its status.
 *
 * @param {string} platform platform key (currently 'juejin' only)
 * @param {{dryRun?:boolean, retries?:number}} [opts]
 * @returns {Promise<{platform:string, total:number, changed:number, recorded:number, liveCount:number,
 *           attempts:number, byStatus:object, changes:Array<object>, dryRun:boolean}>}
 */
async function syncStatuses(platform = 'juejin', { dryRun = false, retries = 3 } = {}) {
  if (!platform) throw new Error('syncStatuses requires a platform key');
  const appId = DEFAULT_APP_ID();
  const norm = (s) => (s || '').trim().toLowerCase();

  // 1) live fetch with retries → most-complete set (status) + union (existence)
  const fetchOnce = async () => {
    if (platform === 'juejin') return t.syndicate.juejin.listAllArticles();
    throw new Error(
      `syncStatuses: not implemented for platform "${platform}" — currently juejin only`
    );
  };
  let best = null; // { items } with the largest length
  const attempts = [];
  for (let i = 0; i < Math.max(1, retries); i += 1) {
    try {
      const items = await fetchOnce();
      if (Array.isArray(items)) {
        attempts.push(items);
        if (!best || items.length > best.items.length) best = { items };
      }
    } catch (e) {
      // transient — next attempt
    }
  }
  if (!best || !best.items.length) {
    throw new Error(
      `syncStatuses: live fetch for "${platform}" returned no data after ${retries} attempts — aborting to avoid false deletions`
    );
  }
  const liveItems = best.items;

  // 2) index: byDraft/byTitle from the most-complete fetch; presentSet (union) for existence
  const byDraft = new Map();
  const byTitle = new Map();
  const presentSet = new Set();
  const addPresent = (ai) => {
    if (ai.draft_id) presentSet.add(`d:${ai.draft_id}`);
    const ti = norm(ai.title);
    if (ti) presentSet.add(`t:${ti}`);
  };
  for (const it of liveItems) {
    const ai = it.article_info || it;
    if (ai.draft_id) byDraft.set(String(ai.draft_id), ai);
    const ti = norm(ai.title);
    if (ti) byTitle.set(ti, ai);
    addPresent(ai);
  }
  for (const items of attempts) {
    for (const it of items) addPresent(it.article_info || it);
  }

  // canonical blog title per slug — some channel_plan rows carry a truncated/older
  // topic, so fall back to the blog's current title when matching by title.
  const blog = (await t.plan.list({ limit: 5000 })).filter((r) => r.plan_status === 'published');
  const blogTitleBySlug = new Map(blog.map((r) => [r.slug, r.title]));

  const auditToStatus = (ai) => {
    const a = ai.audit_status;
    if (a === 2) return 'published'; // 审核通过
    if (a === 1) return 'reviewing'; // 审核中
    return 'review_failed'; // 0 / 3 / other → treat as rejected (retryable)
  };

  const changes = [];
  const byStatus = {};
  let total = 0;
  let changed = 0;
  let recorded = 0; // rows whose platform article_id was written this run

  await withConn(async (conn) => {
    const rows = await repo.list(conn, appId, { platform });
    total = rows.length;
    // guard: only declare deletions when the live list did not unexpectedly shrink
    const dispatchedBefore = rows.filter((r) => DISPATCHED_STATUSES.has(r.status)).length;
    const listLooksComplete = liveItems.length >= dispatchedBefore;

    for (const row of rows) {
      const draftId = row.draft_ids && row.draft_ids[0] ? String(row.draft_ids[0]) : null;
      const slug = (row.article_slugs || [])[0];
      const titleCandidates = [row.topic, slug && blogTitleBySlug.get(slug)]
        .filter(Boolean)
        .map(norm);
      const ai =
        (draftId && byDraft.get(draftId)) ||
        titleCandidates.map((tn) => byTitle.get(tn)).find(Boolean);

      let newStatus;
      if (ai) {
        newStatus = auditToStatus(ai);
      } else {
        const exists =
          (draftId && presentSet.has(`d:${draftId}`)) ||
          titleCandidates.some((tn) => presentSet.has(`t:${tn}`));
        // present in some fetch but status unreadable this run → keep current (don't flip)
        // absent from every fetch AND the list looks complete → genuinely deleted
        newStatus = exists ? row.status : listLooksComplete ? 'deleted' : row.status;
      }
      byStatus[newStatus] = (byStatus[newStatus] || 0) + 1;

      // the platform's authoritative article id (e.g. Juejin post id) to record locally.
      // Keep as string — these are 19-digit Snowflake ids that lose precision as a JS Number.
      const articleId = ai && ai.article_id != null ? String(ai.article_id) : null;
      const idChanged = newStatus !== row.status;
      const idRecorded =
        articleId != null && articleId !== (row.article_id != null ? String(row.article_id) : null);

      if (idChanged || idRecorded) {
        if (idChanged) changed += 1;
        if (idRecorded) recorded += 1;
        changes.push({
          id: row.id,
          slug,
          from: row.status,
          to: newStatus,
          draftId,
          articleId,
          articleIdRecorded: idRecorded,
          title: row.topic || '',
        });
        if (!dryRun) {
          if (idChanged) await repo.markStatus(conn, appId, row.id, newStatus);
          if (idRecorded) await repo.setArticleId(conn, appId, row.id, articleId);
        }
      }
    }
  });

  return {
    platform,
    total,
    changed,
    recorded,
    liveCount: liveItems.length,
    attempts: attempts.length,
    byStatus,
    changes,
    dryRun,
  };
}

/**
 * The next article(s) to publish on a platform.
 *
 * Every platform — wechat included — is DERIVED from the blog article_plan: only
 * blog-published rows, in publish_order, skipping slugs already dispatched to that
 * platform. This keeps each channel queue in the SAME order as the blog, resuming
 * right after the last article sent there (a failed row is NOT skipped, so it
 * retries). `count` lets wechat take a whole issue-sized batch in one go.
 *
 * wechat used to be driven by a per-issue calendar parsed out of
 * 《微信公众号发布计划.md》; the queue now comes from the DB publish_order like every
 * other platform, and the calendar rows are left as what they really are — a
 * dispatch log (importWechatIssues() can still seed issue metadata as structured
 * input, and dispatched rows keep driving the dedup in publishedSlugs()).
 *
 * @param {string} platform
 * @param {{count?:number}} [opts] how many slugs to return (default 1)
 * @returns {Promise<object|null>}
 */
async function nextDue(platform, { count = 1 } = {}) {
  const published = await publishedSlugs(platform);
  const blog = (await t.plan.list({ limit: 5000 })).filter((r) => r.plan_status === 'published');
  const sorted = blog.slice().sort((a, b) => (a.publish_order || 1e9) - (b.publish_order || 1e9));
  const picked = [];
  for (const r of sorted) {
    if (published.has(r.slug)) continue;
    picked.push(r);
    if (picked.length >= Math.max(1, count)) break;
  }
  if (!picked.length) return null;
  const head = picked[0];
  return {
    platform,
    status: 'todo',
    source: 'blog_plan',
    id: null,
    period: null,
    slug: head.slug,
    article_slugs: picked.map((r) => r.slug),
    title: head.title,
    topic: head.title,
    blogOrder: head.publish_order,
  };
}

module.exports = {
  // (parseWechatPlanText / importWechatPlan removed 2026-10-07 — no document parsing)
  importWechatIssues,
  clearPlatform,
  publishedSlugs,
  filterUnpublished,
  recordPublish,
  reconcileFromPlatform,
  reconcileFromJuejin,
  syncStatuses,
  list,
  get,
  markStatus,
  nextDue,
};
