'use strict';
/**
 * Channel publishing-task service (plan domain) — t.plan.channel
 * ============================================================================
 * Orchestration over the workspace-local channel_plan table (repo: db/channel-plan):
 *   - v7 model: ONE ROW = ONE (platform, slug, lang) publish task. wechat keeps a
 *     calendar semantics by sharing one `period` ("第N期") across the rows of one
 *     issue; single-article channels record one row per article language.
 *   - REGISTRATION-BASED queue: the queue is NOT pre-generated. nextDue() looks up
 *     the plan first — already-dispatched → skip to the next; recorded-but-not-sent
 *     → reuse that row; not recorded → INSERT a todo row (register) and return it.
 *     The publish pipeline then updates the row's status on outcome
 *     (published / draft / failed / reviewing). A row is therefore never "published
 *     but missing from the plan".
 *   - every platform (wechat included) gets its queue DERIVED from the blog
 *     article_plan publish_order, filtered by the platform's language rule
 *     (PLATFORM_LANGS): which language of an article goes to which platform.
 *   - list / markStatus / nextDue expose the calendar to CLIs and MCP tools.
 * ============================================================================
 */
const t = require('../index');
const repo = require('../db/channel-plan');
const { withConn } = require('../db/connection');

/** Default tenant: process-level APP_ID env var (default 1). */
const DEFAULT_APP_ID = () => Number(process.env.APP_ID || 1);

/**
 * Language → platform routing: which language version of an article each platform
 * publishes. Single source for nextDue / filterUnpublished / recordPublish defaults.
 * Adjust to the real channel mix (e.g. devto → ['en'] for overseas platforms).
 */
const PLATFORM_LANGS = {
  wechat: ['zh-hans'],
  juejin: ['zh-hans'],
  csdn: ['zh-hans'],
  aliyun: ['zh-hans'],
  tencent: ['zh-hans'],
  devto: ['en'],
};
const defaultLangFor = (platform) => (PLATFORM_LANGS[platform] || ['zh-hans'])[0];

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
 * v7: one issue = N rows (one per slug) sharing the same `period`; in-issue order
 * = row id order (insertion order). `lang` defaults to zh-hans.
 *
 * @param {Array<{period:string, article_slugs:string[], lang?:string, topic?:string,
 *                weekday?:string, status?:string, draft_ids?:string[],
 *                notes?:string}>} issues
 * @returns {Promise<{platform:string, imported:number, updated:number, rows:number}>}
 */
async function importWechatIssues(issues) {
  if (!Array.isArray(issues)) throw new Error('importWechatIssues requires an issues array');
  const appId = DEFAULT_APP_ID();
  let imported = 0;
  let updated = 0;
  let rows = 0;
  await withConn(async (conn) => {
    for (const issue of issues) {
      if (!issue || !issue.period) throw new Error('importWechatIssues: every issue requires a period');
      const slugs = Array.isArray(issue.article_slugs) ? issue.article_slugs : [];
      if (!slugs.length) throw new Error(`importWechatIssues: issue ${issue.period} requires non-empty article_slugs`);
      const lang = issue.lang || 'zh-hans';
      for (const slug of slugs) {
        const res = await repo.upsert(conn, appId, {
          platform: 'wechat',
          slug,
          lang,
          period: issue.period,
          topic: issue.topic || null,
          weekday: issue.weekday || null,
          status: issue.status || 'todo',
          draft_ids: Array.isArray(issue.draft_ids) ? issue.draft_ids : [],
          notes: issue.notes || null,
        });
        rows += 1;
        if (res.action === 'insert') imported += 1;
        else updated += 1;
      }
    }
  });
  return { platform: 'wechat', imported, updated, rows };
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
    result = await repo.getById(conn, appId, Number(id));
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
 * Set of (slug, lang) pairs already DISPATCHED to a platform (published OR still
 * under review) — drives the nextDue / filterUnpublished skip. `reviewing` is
 * included so a just-published-but-not-yet-approved article is never re-sent;
 * `review_failed` and `deleted` are deliberately excluded so they get a fresh
 * (re)publish attempt. Keyed by `slug::lang` (v7: language participates in dedup —
 * the en version of a slug may still be due on an overseas platform even when the
 * zh-hans version is dispatched domestically).
 * @returns {Promise<Set<string>>}
 */
const DEFAULT_DISPATCHED = new Set(['published', 'reviewing']);
/**
 * Per-platform "already dispatched" statuses (2026-10-08).
 *
 * wechat is the exception: our operating rule is DRAFT-BOX ONLY — we never mass-send
 * (no `mass_send`, ever), so a wechat row never reaches `published`. Its terminal
 * state IS `draft`, and counting only `published` made every article already sitting
 * in the WeChat drafts box look "not yet sent" → nextDue kept re-offering them
 * (24 articles from 第2–9期 were queued for a second send).
 *
 * devto publishes LIVE since 2026-10-12 (`published:true` + cover image; dev.to
 * has NO review pipeline). Its rows reach `published`; keeping `draft` in the
 * dispatched set preserves idempotence for legacy draft rows from before the
 * switch (no duplicate re-send).
 *
 * juejin/csdn keep the default on purpose: there a `draft` is only an intermediate
 * step on the way to a live article, so it must stay eligible for a retry.
 */
const DISPATCHED_BY_PLATFORM = {
  wechat: new Set(['published', 'reviewing', 'draft']),
  devto: new Set(['published', 'reviewing', 'draft']),
};
const dispatchedStatuses = (platform) => DISPATCHED_BY_PLATFORM[platform] || DEFAULT_DISPATCHED;

async function publishedSlugs(platform) {
  const appId = DEFAULT_APP_ID();
  const dispatched = dispatchedStatuses(platform);
  const set = new Set();
  await withConn(async (conn) => {
    const rows = await repo.list(conn, appId, { platform });
    for (const row of rows) {
      if (dispatched.has(row.status)) set.add(`${row.slug}::${row.lang}`);
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
 * Keyed by (slug, lang) against the local channel_plan publish log — no external
 * API calls, no title matching. The language of the check is the platform's default
 * language (PLATFORM_LANGS), so callers keep passing plain slug strings.
 *
 * @param {string} platform platform key
 * @param {string[]} slugs ordered input slugs
 * @returns {Promise<{toPublish:string[], skipped:string[]}>}
 */
async function filterUnpublished(platform, slugs) {
  const lang = defaultLangFor(platform);
  const published = await publishedSlugs(platform); // Set<`slug::lang`>
  const toPublish = [];
  const skipped = [];
  for (const s of slugs || []) {
    if (published.has(`${s}::${lang}`)) skipped.push(s);
    else toPublish.push(s);
  }
  return { toPublish, skipped };
}

/**
 * Record the OUTCOME of a publish attempt for one (slug, lang) on a platform.
 * Called by the publish pipeline after each attempt (success OR failure). This is
 * the ONLY writer for non-wechat platforms. Idempotent — re-running on success
 * updates the prior failed/duplicate row instead of creating a new one (unique key
 * (platform, slug, lang) backstops it at the DB level).
 *
 * v7: `period` is never derived here — publish_order has nothing to do with the
 * plan's period semantics anymore (the v5 root cause).
 *
 * @param {{platform:string, slug:string, lang?:string, title?:string,
 *          status:'published'|'failed', draftId?:string,
 *          notes?:string, error?:string}} rec
 * @returns {Promise<{ok:boolean, platform:string, slug:string, lang:string, status:string}>}
 */
async function recordPublish(rec) {
  if (!rec || !rec.platform || !rec.slug) throw new Error('recordPublish requires platform + slug');
  const appId = DEFAULT_APP_ID();
  const lang = rec.lang || defaultLangFor(rec.platform);
  await withConn(async (conn) => {
    await repo.upsert(conn, appId, {
      platform: rec.platform,
      slug: rec.slug,
      lang,
      topic: rec.title || rec.slug,
      status: rec.status || 'failed',
      draft_ids: rec.draftId ? [rec.draftId] : [],
      notes: rec.error ? `error: ${String(rec.error).slice(0, 200)}` : rec.notes || null,
    });
  });
  return { ok: true, platform: rec.platform, slug: rec.slug, lang, status: rec.status || 'failed' };
}

/**
 * Record ONE WeChat issue (one 群发 message) as calendar rows.
 *
 * v7: ONE ROW = ONE slug. An issue (一期, one media_id message) becomes N rows
 * sharing the same `period` ("第N期") and the same draft_ids (media_id); in-issue
 * headline order = row id order (insertion order of the slugs). Never log wechat
 * per-slug through recordPublish — this function keeps the issue↔message mapping
 * via the shared period/media_id.
 *
 * Issue numbering continues from whatever is already on the platform (第1期…第N期),
 * so the calendar stays a single continuous history instead of restarting.
 *
 * @param {{slugs:string[], lang?:string, mediaId?:string, status?:string,
 *          topic?:string, notes?:string}} rec
 * @returns {Promise<{platform:string, period:string, rows:Array<{id:number, action:string, slug:string}>, article_slugs:string[]}>}
 */
async function recordWechatIssue(rec) {
  const slugs = Array.isArray(rec && rec.slugs) ? rec.slugs.filter(Boolean) : [];
  if (!slugs.length) throw new Error('recordWechatIssue requires a non-empty slugs array');
  const appId = DEFAULT_APP_ID();
  const lang = rec.lang || 'zh-hans';
  const out = { platform: 'wechat', rows: [], article_slugs: slugs };
  await withConn(async (conn) => {
    const rows = await repo.list(conn, appId, { platform: 'wechat' });
    let maxIssue = 0;
    for (const r of rows) {
      const m = /第\s*(\d+)\s*期/.exec(String(r.period || ''));
      if (m) maxIssue = Math.max(maxIssue, Number(m[1]));
    }
    const period = `第${maxIssue + 1}期`;
    for (const slug of slugs) {
      const res = await repo.upsert(conn, appId, {
        platform: 'wechat',
        slug,
        lang,
        period,
        topic: rec.topic || null,
        status: rec.status || 'draft',
        draft_ids: rec.mediaId ? [rec.mediaId] : [],
        notes: rec.notes || null,
      });
      out.rows.push({ id: res.id, action: res.action, slug });
    }
    out.period = period;
  });
  return out;
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
 * v7: rows are keyed by (platform, slug, lang); `lang` defaults to the platform's
 * default language (PLATFORM_LANGS).
 *
 * @param {string} platform platform key (juejin / csdn / …)
 * @param {{map?:Array<{slug:string, lang?:string, title?:string, draftId?:string, notes?:string}>}} opts
 * @returns {Promise<{platform:string, source:string, inserted:number, matched:number, unmatched:number}>}
 */
async function reconcileFromPlatform(platform, { map } = {}) {
  if (!platform) throw new Error('reconcileFromPlatform requires a platform key');
  const appId = DEFAULT_APP_ID();
  const lang = defaultLangFor(platform);
  if (Array.isArray(map) && map.length) {
    await withConn(async (conn) => {
      for (const m of map) {
        await repo.upsert(conn, appId, {
          platform,
          slug: m.slug,
          lang: m.lang || lang,
          topic: m.title || m.slug,
          status: 'published',
          draft_ids: m.draftId ? [m.draftId] : [],
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
        await repo.upsert(conn, appId, {
          platform,
          slug,
          lang,
          topic: title || slug,
          status: 'published',
          notes: null,
        });
      } else {
        unmatched += 1;
        await repo.upsert(conn, appId, {
          platform,
          slug: String(articleId),
          lang,
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
 * @param {string} platform platform key ('juejin' | 'csdn')
 * @param {{dryRun?:boolean, retries?:number}} [opts]
 * @returns {Promise<{platform:string, total:number, changed:number, recorded:number, liveCount:number,
 *           attempts:number, byStatus:object, changes:Array<object>, dryRun:boolean}>}
 */
const AUDIT_STALE_HOURS = 24;
async function syncStatuses(platform = 'juejin', { dryRun = false, retries = 3 } = {}) {
  if (!platform) throw new Error('syncStatuses requires a platform key');
  const appId = DEFAULT_APP_ID();
  const norm = (s) => (s || '').trim().toLowerCase();

  // 1) live fetch with retries → most-complete set (status) + union (existence)
  //    juejin: article/list_by_user → article_info.audit_status
  //    csdn: published ∪ audit lists (audit = 审核中/未通过 SHARE one list; the API
  //          does not tell them apart and exposes no reject reason)
  const listAllForCsdn = async () => {
    const [pub, audit] = await Promise.all([
      t.syndicate.csdn.listArticles(1, 100, 'published'),
      t.syndicate.csdn.listArticles(1, 100, 'audit'),
    ]);
    const items = [];
    for (const it of pub.items || []) items.push({ draft_id: String(it.id), article_id: String(it.id), title: it.title, _list: 'published' });
    for (const it of audit.items || []) items.push({ draft_id: String(it.id), article_id: String(it.id), title: it.title, _list: 'audit' });
    return items;
  };
  const fetchOnce = async () => {
    if (platform === 'juejin') return t.syndicate.juejin.listAllArticles();
    if (platform === 'csdn') return listAllForCsdn();
    throw new Error(
      `syncStatuses: not implemented for platform "${platform}" — supported: juejin, csdn (devto/wechat have no automated review)`
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
  // Skip empty titles and let zh-hans win (platform lists are Chinese): a slug has
  // en/zh-hant rows whose title is often empty, and a naive last-write Map would
  // overwrite the real zh-hans title with '' → title fallback silently dies.
  const blog = (await t.plan.list({ limit: 5000 })).filter((r) => r.plan_status === 'published');
  const blogTitleBySlug = new Map();
  for (const r of blog) {
    if (!r.title) continue;
    const prev = blogTitleBySlug.get(r.slug);
    if (!prev || r.lang === 'zh-hans') blogTitleBySlug.set(r.slug, r.title);
  }

  // Platform verdict: juejin audits via audit_status; csdn via which list the
  // article sits in (published = 通过 / audit = 审核中或未通过).
  const auditToStatus = (ai) => {
    if (platform === 'csdn') return ai._list === 'published' ? 'published' : 'review_failed';
    const a = ai.audit_status;
    if (a === 2) return 'published'; // 审核通过
    if (a === 1) return 'reviewing'; // 审核中
    return 'review_failed'; // 0 / 3 / other → treat as rejected (retryable)
  };
  // The platform APIs expose NO reject reason text — the human-flag tells the user
  // where to look (Juejin/CSDN backend) while keeping the machine state truthful.
  const reviewFailedReason = (ai) =>
    platform === 'juejin'
      ? `审核未通过（juejin audit_status=${ai && ai.audit_status}），原因请查看掘金后台`
      : 'CSDN 审核中/未通过列表，原因请查看 CSDN 后台';
  const AUDIT_STALE_MS = AUDIT_STALE_HOURS * 3600 * 1000;

  const changes = [];
  const byStatus = {};
  let total = 0;
  let changed = 0;
  let recorded = 0; // rows whose platform article_id was written this run

  await withConn(async (conn) => {
    const rows = await repo.list(conn, appId, { platform });
    total = rows.length;
    // guard: only declare deletions when the live list did not unexpectedly shrink
    const dispatchedBefore = rows.filter((r) => dispatchedStatuses(platform).has(r.status)).length;
    const listLooksComplete = liveItems.length >= dispatchedBefore;

    for (const row of rows) {
      const draftId = row.draft_ids && row.draft_ids[0] ? String(row.draft_ids[0]) : null;
      const slug = row.slug;
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
          reason: newStatus === 'review_failed' ? reviewFailedReason(ai) : null,
        });
        if (!dryRun) {
          if (idChanged) await repo.markStatus(conn, appId, row.id, newStatus);
          if (idRecorded) await repo.setArticleId(conn, appId, row.id, articleId);
          if (newStatus === 'review_failed' && row.status !== 'review_failed') {
            await repo.appendNotes(conn, appId, row.id, reviewFailedReason(ai));
          }
        }
      }

      // stale-review watchdog: still reviewing after AUDIT_STALE_HOURS → human check
      if (newStatus === 'reviewing' && row.status === 'reviewing' && row.updated_at) {
        const at = Date.parse(String(row.updated_at).replace(' ', 'T') + 'Z');
        if (!Number.isNaN(at) && Date.now() - at > AUDIT_STALE_MS && !/(审核超时|需人工查看平台后台)/.test(row.notes || '')) {
          changes.push({
            id: row.id,
            slug,
            from: 'reviewing',
            to: 'reviewing',
            stale: true,
            hours: AUDIT_STALE_HOURS,
            title: row.topic || '',
            reason: `审核超时 >${AUDIT_STALE_HOURS}h 未定论，需人工查看平台后台`,
          });
          if (!dryRun) await repo.appendNotes(conn, appId, row.id, `审核超时 >${AUDIT_STALE_HOURS}h 未定论，需人工查看平台后台`);
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
 * The next article(s) to publish on a platform — REGISTRATION-BASED queue.
 *
 * The queue is NOT pre-generated. nextDue() works through the blog article_plan in
 * publish_order (filtered to the platform's language rule, PLATFORM_LANGS) and, per
 * article, consults the channel_plan task table FIRST:
 *   - already dispatched (published / reviewing, plus wechat draft) → skip to next
 *   - recorded but not yet sent (todo / failed / review_failed / deleted / paused)
 *     → reuse that row (no duplicate INSERT; failed rows retry)
 *   - not recorded at all → INSERT a todo row (register) and return it
 * The publish pipeline then updates the row's status on outcome. A row therefore
 * never "published but missing from the plan".
 *
 * `count` lets wechat take a whole issue-sized batch in one go (N rows sharing one
 * period when recordWechatIssue is called afterwards).
 *
 * @param {string} platform
 * @param {{count?:number, register?:boolean}} [opts] how many articles to return
 *   (default 1). register=false (dry-run previews) looks up existing todo rows but
 *   does NOT insert — a pure read with zero side effects.
 * @returns {Promise<object|null>}
 */
async function nextDue(platform, { count = 1, register = true } = {}) {
  const appId = DEFAULT_APP_ID();
  const langs = PLATFORM_LANGS[platform] || ['zh-hans'];
  const published = await publishedSlugs(platform); // Set<`slug::lang`>
  const blog = (await t.plan.list({ limit: 5000 })).filter(
    (r) => r.plan_status === 'published' && langs.includes(r.lang)
  );
  const sorted = [...blog].sort((a, b) => (a.publish_order || 1e9) - (b.publish_order || 1e9));
  const picked = [];
  await withConn(async (conn) => {
    for (const r of sorted) {
      const key = `${r.slug}::${r.lang}`;
      if (published.has(key)) continue; // 已发送 → 下一篇
      let task = await repo.getByKey(conn, appId, platform, r.slug, r.lang);
      if (!task) {
        if (!register) {
          // dry-run preview: never write; the row will be registered at real fire time
          task = { id: null };
        } else {
          // 未记录 → 先登记 todo（这就是"发布计划"的登记动作）
          const res = await repo.upsert(conn, appId, {
            platform,
            slug: r.slug,
            lang: r.lang,
            status: 'todo',
          });
          task = { id: res.id };
        }
      }
      picked.push({
        id: task.id,
        platform,
        slug: r.slug,
        lang: r.lang,
        status: 'todo',
        period: null,
        title: r.title,
        topic: r.title,
        blogOrder: r.publish_order,
      });
      if (picked.length >= Math.max(1, count)) break;
    }
  });
  if (!picked.length) return null;
  return {
    platform,
    status: 'todo',
    source: 'blog_plan',
    tasks: picked,
    id: picked[0].id,
    period: null,
    slug: picked[0].slug,
    lang: picked[0].lang,
    article_slugs: picked.map((r) => r.slug),
    title: picked[0].title,
    topic: picked[0].title,
    blogOrder: picked[0].blogOrder,
  };
}

module.exports = {
  // (parseWechatPlanText / importWechatPlan removed 2026-10-07 — no document parsing)
  importWechatIssues,
  recordWechatIssue,
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
  PLATFORM_LANGS,
};
