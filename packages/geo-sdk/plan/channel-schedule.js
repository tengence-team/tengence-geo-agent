'use strict';
/**
 * Channel scheduling-rule service (plan domain) — t.plan.channelSchedule
 * ============================================================================
 * Orchestration over tengence_geo_channel_schedule (repo: db/channel-schedule):
 *   - list / get / set / del  — manage the (platform × publish_time) slots
 *   - publishDue()            — UNIFIED auto-publish executor. Reads every enabled
 *     slot, fires the ones whose time window matches NOW (±15 min — a 30-minute
 *     external tick always lands inside the window) and that have NOT run today,
 *     publishes through the SAME pipeline as channel_publish, writes the outcome
 *     back into channel_plan (per-platform calendar) and stamps last_run_at.
 *
 * Re-fire guards (three layers):
 *   1. last_run_at — a slot never fires twice on the same day (day-level).
 *   2. channel_plan unique key (app_id, platform, slug, lang) — article-level
 *      idempotency: nextDue skips already-dispatched slugs, so even a double fire
 *      cannot publish the same article twice.
 *   3. a single process lock lives at the CALLER (external ticker / CLI), not
 *      here — publishDue itself is safe to call from one process at a time.
 *
 * asDraft policy (2026-10-11): wechat keeps the DRAFT-BOX mode (recordWechatIssue
 * terminal state = draft) — the 原创声明/赞赏 flags cannot be set via any WeChat
 * API and must be toggled manually before sending, so the scheduler must never
 * auto-send wechat. juejin / csdn publish for real (asDraft=false). devto ALSO
 * publishes LIVE (2026-10-12: no draft-first — publishDevto sends published:true
 * with the article's cover image; dev.to has no review pipeline), so devto
 * outcomes are logged as "published".
 *
 * Audit (审核) integration (2026-10-11, plan A — merged into the unified executor):
 * publishDue runs the review-check loop FIRST (step ①) via channel.syncStatuses
 * for juejin + csdn — reviewing → published / review_failed (+ human-flag notes,
 * 24h stale-review watchdog), so every publish cycle also advances the audit state
 * before picking the next articles. A failed audit check never blocks publishing;
 * it surfaces in the report as audit.<platform>.error.
 * ============================================================================
 */

const repo = require('../db/channel-schedule');
const { withConn } = require('../db/connection');
const channel = require('./channel'); // nextDue / recordWechatIssue / recordPublish

/** Default tenant: process-level APP_ID env var (default 1). */
const DEFAULT_APP_ID = () => Number(process.env.APP_ID || 1);

/**
 * Fire-window in minutes: a slot whose publish_time is within ±FIRE_WINDOW_MIN of
 * `now` is due. The external ticker granularity drives this:
 *   - Doubao cron jobs have a hard MINIMUM interval of 1 hour (minExecInterval
 *     3600s), so the practical external tick is hourly ⇒ FIRE_WINDOW_MIN = 30
 *     covers every HH:MM exactly once per day (any time is ≤30 min from an
 *     hourly tick).
 *   - A local launchd/cron ticker could be finer (e.g. every 30 min ⇒ ±15),
 *     but the scheduler must stay correct for the hourly Doubao ticker.
 */
const FIRE_WINDOW_MIN = 30;

/**
 * Platforms whose outcomes are logged into channel_plan by publishDue.
 * NOTE: this includes devto — the MCP channel_publish tool's legacy
 * PUBLISH_LOG_PLATFORMS omits devto, but the scheduler MUST log it or nextDue
 * would keep re-offering the same already-published devto article.
 */
const PUBLISH_LOG_PLATFORMS = ['juejin', 'csdn', 'aliyun', 'tencent', 'devto'];

/** Which platform the scheduler keeps in draft mode (never auto-sends). */
const AS_DRAFT_BY_PLATFORM = { wechat: true };

/** Local "YYYY-MM-DD HH:MM:SS" for a Date (matches the DB's strftime localtime). */
function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/** Local "YYYY-MM-DD" for a Date. */
function localDay(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------------------------------------------------------------------------
// schedule CRUD (thin passthrough over the repo)
// ---------------------------------------------------------------------------

/** List schedule rows ({ platform?, enabled? }). */
async function list({ platform, enabled, appId = DEFAULT_APP_ID() } = {}) {
  return withConn((conn) => repo.list(conn, appId, { platform, enabled }));
}

/** Get one slot by id. */
async function get(id, { appId = DEFAULT_APP_ID() } = {}) {
  if (id == null) throw new Error('channelSchedule.get requires id');
  return withConn((conn) => repo.getById(conn, appId, Number(id)));
}

/** Upsert a slot ({ platform, publish_time, count?, enabled? }). */
async function set(record, { appId = DEFAULT_APP_ID() } = {}) {
  if (!record || !record.platform || record.publish_time == null) {
    throw new Error('channelSchedule.set requires platform + publish_time ("HH:MM")');
  }
  return withConn((conn) => repo.set(conn, appId, record));
}

/** Delete a slot ({ id } or { platform, publish_time }). */
async function del(key, { appId = DEFAULT_APP_ID() } = {}) {
  if (!key) throw new Error('channelSchedule.del requires { id } or { platform, publish_time }');
  return withConn((conn) => repo.del(conn, appId, key));
}

// ---------------------------------------------------------------------------
// unified auto-publish executor
// ---------------------------------------------------------------------------

/**
 * Fire every channel_schedule slot that is due at `now` and has not run today.
 *
 * @param {object} opts
 *   now      Date to evaluate against (default: new Date())
 *   dryRun   default false: publish for real; true prints the plan, no external
 *            calls, no channel_plan writes, no last_run_at stamp
 *   siteKey  site key passed to the publish pipeline (default: readSiteArg())
 *   appId    tenant id (default 1)
 * @returns {Promise<object>} report:
 *   { ok, now, checked, due, results: [{platform, publish_time, status, detail}], skipped_today }
 */
async function publishDue({ now = new Date(), dryRun = false, siteKey, appId = DEFAULT_APP_ID() } = {}) {
  const { publishToChannel } = require('../syndicate/channel');
  const schedule = await list({ appId });
  const day = localDay(now);
  const nowMs = now.getTime();

  const due = [];
  const skippedToday = [];
  for (const s of schedule) {
    if (!s.enabled) continue;
    const [h, m] = String(s.publish_time).split(':').map(Number);
    const t = new Date(now);
    t.setHours(h, m, 0, 0);
    if (Math.abs(nowMs - t.getTime()) / 60000 > FIRE_WINDOW_MIN) continue;
    if (s.last_run_at && String(s.last_run_at).slice(0, 10) === day) {
      skippedToday.push({ id: s.id, platform: s.platform, publish_time: s.publish_time, reason: 'already ran today' });
      continue;
    }
    due.push(s);
  }

  // step ① — audit (审核) check BEFORE any publishing (plan A: merged into the
  // unified executor). Real runs advance review states for juejin + csdn;
  // a platform failure is recorded and does NOT block the publish loop.
  const audit = dryRun ? { skipped: 'dry_run' } : {};
  if (!dryRun) {
    for (const p of ['juejin', 'csdn']) {
      try {
        audit[p] = await channel.syncStatuses(p);
      } catch (e) {
        audit[p] = { ok: false, error: e.message };
      }
    }
  }

  const results = [];
  for (const s of due) {
    const asDraft = AS_DRAFT_BY_PLATFORM[s.platform] === true;
    try {
      const next = await channel.nextDue(s.platform, { count: s.count || 1, register: !dryRun });
      if (!next) {
        results.push({
          platform: s.platform,
          publish_time: s.publish_time,
          status: 'no_due_articles',
          detail: 'no unpublished blog articles left for this platform today',
        });
        continue;
      }
      const slugs = next.tasks.map((x) => x.slug);
      const pub = await publishToChannel({
        platform: s.platform,
        slugs,
        articles: [],
        asDraft,
        dryRun,
        siteKey,
      });
      const fired = { platform: s.platform, publish_time: s.publish_time, count: s.count, asDraft, ok: !!pub.ok };
      if (!pub.ok) {
        fired.status = 'failed';
        fired.detail = pub.error || 'publishToChannel returned not-ok';
        results.push(fired);
        continue;
      }
      if (dryRun) {
        fired.status = 'dry_run';
        fired.detail = { slugs };
        results.push(fired);
        continue;
      }

      // ---- persist the outcome into channel_plan (mirror of channel_publish tool) ----
      if (s.platform === 'wechat') {
        const group = (pub.slugs && pub.slugs.length ? pub.slugs : slugs) || [];
        const mediaId = (pub.refs && pub.refs.mediaId) || null;
        if (group.length) {
          try {
            await channel.recordWechatIssue({
              slugs: group,
              mediaId,
              status: 'draft', // draft box is the terminal state — we never mass-send
              topic: group.length === 1 ? null : `${group.length} 篇合辑`,
              notes: `merged into one WeChat message (media_id: ${mediaId || 'n/a'})`,
            });
            fired.loggedIssue = { slugs: group, mediaId };
          } catch (logErr) {
            // logging failure must not mask the publish result
            console.error('[channel_publish_due] recordWechatIssue failed:', logErr.message);
          }
        }
      }
      if (PUBLISH_LOG_PLATFORMS.includes(s.platform)) {
        const wentLive = asDraft === false;
        for (const r of pub.results || []) {
          if (r.skipped || r.dryRun) continue;
          const tax = r.taxonomy;
          const taxNote = tax
            ? `tax: ${tax.category} [${tax.categoryOrigin}] / ${(tax.tags || []).join(', ')}`
            : Array.isArray(r.tags) && r.tags.length
              ? `tags: ${r.tags.join(', ')}`
              : null;
          // r.published is the platform's own answer (juejin/csdn = !asDraft,
          // devto true since 2026-10-12 = live publish) — it wins over wentLive.
          const status = !r.ok ? 'failed' : r.published === false ? 'draft' : wentLive && !r.publishGated ? 'published' : 'draft';
          try {
            await channel.recordPublish({
              platform: s.platform,
              slug: r.slug,
              title: r.title || (r.detail && r.detail.title),
              status,
              draftId: r.draftId || (r.detail && r.detail.draftId),
              notes: status === 'published' ? taxNote : null,
              error: r.ok ? null : r.error || (r.detail && (r.detail.err || r.detail.message)) || r.stage,
            });
          } catch (logErr) {
            console.error('[channel_publish_due] recordPublish failed:', logErr.message);
          }
        }
      }

      // only after the outcome is persisted: mark the slot as run today
      await withConn((conn) => repo.markLastRun(conn, appId, s.id, localStamp(now)));
      fired.status = 'published';
      fired.slugs = slugs;
      // Surface the external article URLs (juejin/csdn/devto publish for real and
      // return pub.results[].url; wechat stays in the draft box → no url) so the
      // external ticker can DISPLAY the links of what was just published.
      const publishedUrls = (pub.results || [])
        .map((r) => (r && typeof r === 'object' && r.url ? r.url : null))
        .filter(Boolean);
      if (publishedUrls.length) fired.urls = publishedUrls;
      results.push(fired);
    } catch (e) {
      results.push({
        platform: s.platform,
        publish_time: s.publish_time,
        status: 'failed',
        detail: e.message,
      });
    }
  }

  return {
    ok: true,
    now: now.toISOString(),
    checked: schedule.length,
    due,
    audit,
    results,
    skipped_today: skippedToday,
  };
}

module.exports = {
  FIRE_WINDOW_MIN,
  AS_DRAFT_BY_PLATFORM,
  PUBLISH_LOG_PLATFORMS,
  list,
  get,
  set,
  del,
  publishDue,
};
