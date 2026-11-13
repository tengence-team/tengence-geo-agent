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
 * Collect the REAL per-article failure reasons from a publishToChannel result so the
 * unified executor can echo them immediately (instead of a generic "not-ok"). Each
 * failed result carries `error` (object {code, message}) + `stage` from
 * syndicate/channel.failResult; fall back to the raw detail for older shapes.
 */
function collectPublishErrors(pub) {
  const all = (pub && pub.results) || [];
  const failed = all.filter((r) => !r.ok);
  if (!failed.length) return pub && pub.error ? pub.error : 'publishToChannel returned not-ok';
  return {
    summary: `${failed.length} of ${all.length} failed`,
    platform: pub && pub.platform,
    errors: failed.map((r) => ({
      slug: r.slug,
      stage: r.stage || (r.detail && r.detail.stage),
      error: r.error || (r.detail && (r.detail.err || r.detail.error || r.detail.message)) || r.stage,
      context: r.context || (r.detail && r.detail.context),
    })),
  };
}

/**
 * Fire-window in minutes: a slot whose publish_time is within ±FIRE_WINDOW_MIN of
 * `now` is due. The external ticker granularity drives this:
 *   - Doubao cron jobs have a hard MINIMUM interval of 1 hour (minExecInterval
 *     3600s), so the practical external tick is hourly ⇒ FIRE_WINDOW_MIN = 45
 *     covers every HH:MM exactly once per day with a 15-minute margin on each
 *     side. 30 was exactly zero-margin: the observed tick interval drifts to
 *     61–65 min (2026-11-11), so a slot could fall outside the window on the
 *     tick that "should" have hit it (11-11: wechat 08:26 and devto 09:38 both
 *     missed entirely). Double-firing the same slot is impossible — last_run_at
 *     dedups per slot per day — and re-publishing an article twice is impossible
 *     too (channel_plan unique key + nextDue skips dispatched rows). The cost of
 *     the wider window is that adjacent slots (e.g. juejin 21:08 / 21:41) may
 *     fire in the SAME tick, which is exactly what they are for: two slots = two
 *     articles.
 *   - A local launchd/cron ticker could be finer (e.g. every 30 min ⇒ ±15),
 *     but the scheduler must stay correct for the hourly Doubao ticker.
 */
const FIRE_WINDOW_MIN = 45;

/**
 * A slot whose window closed more than this many minutes ago without a
 * same-day last_run_at is reported as MISSED. The ticker never fires it again
 * that day, so without this flag a missed slot is invisible: the schedule
 * simply produces one less article, forever. Reported in publishDue's
 * `stale_slots` so the hourly automation can alert instead of staying silent.
 */
const MISSED_REPORT_DELAY_MIN = 120;

/**
 * 闸门隔离后的候选重试轮数上限（2026-11-11）。publishToChannel 命中 G17 实质内容
 * 闸会把不合格稿隔离成 review_failed 并返回 blocked:true；此时换下一批候选再试，
 * 最多这么多轮。作用是"队头压着一篇永久不合格的旧稿"不再让整个槽当天报废。
 */
const GATE_RETRY_MAX = 4;

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
async function publishDue({ now = new Date(), dryRun = false, siteKey, appId = DEFAULT_APP_ID(), onProgress } = {}) {
  const { publishToChannel } = require('../syndicate/channel');
  const schedule = await list({ appId });
  const day = localDay(now);
  const nowMs = now.getTime();

  const due = [];
  const skippedToday = [];
  const staleSlots = [];
  for (const s of schedule) {
    if (!s.enabled) continue;
    const [h, m] = String(s.publish_time).split(':').map(Number);
    const t = new Date(now);
    t.setHours(h, m, 0, 0);
    const ranToday = !!(s.last_run_at && String(s.last_run_at).slice(0, 10) === day);
    // P2 漏跑自检：窗口右端已过 MISSED_REPORT_DELAY_MIN 分钟、今天仍没跑过 ⇒ 今日必漏。
    // 只看"今天已过点的槽"，避免把当天还没到的槽误报成漏跑。
    const rightEdgeMs = t.getTime() + FIRE_WINDOW_MIN * 60000;
    if (!ranToday && nowMs > rightEdgeMs + MISSED_REPORT_DELAY_MIN * 60000) {
      staleSlots.push({
        id: s.id,
        platform: s.platform,
        publish_time: s.publish_time,
        last_run_at: s.last_run_at || null,
        missed_by_min: Math.round((nowMs - t.getTime()) / 60000),
        action: '人工补跑或等明日窗口；连续多日出现说明外部 tick 与窗口不匹配',
      });
    }
    if (Math.abs(nowMs - t.getTime()) / 60000 > FIRE_WINDOW_MIN) continue;
    if (ranToday) {
      skippedToday.push({ id: s.id, platform: s.platform, publish_time: s.publish_time, reason: 'already ran today' });
      continue;
    }
    due.push(s);
  }

  // step ① — audit (审核) check BEFORE any publishing (plan A: merged into the
  // unified executor). Real runs advance review states for juejin + csdn;
  // wechat has no review pipeline, but it needs a read-only TRUTH pass against the
  // draft box + freepublish list so "已发布/已删草稿" never stays mislabeled as
  // `draft` (2026-11-13). It only runs when a wechat slot is due this tick, so we
  // never burn API quota on idle platforms. A platform failure is recorded and
  // does NOT block the publish loop.
  const audit = dryRun ? { skipped: 'dry_run' } : {};
  if (!dryRun) {
    const auditPlatforms = ['juejin', 'csdn'];
    if (due.some((s) => s.platform === 'wechat')) auditPlatforms.push('wechat');
    for (const p of auditPlatforms) {
      try {
        audit[p] = await channel.syncStatuses(p, { siteKey });
      } catch (e) {
        audit[p] = { ok: false, error: e.message };
      }
    }
  }

  const results = [];
  // Optional progress reporting (MCP long-task progress), reported once per due
  // platform as processing starts (safe to omit; continue branches can't skip it).
  const totalPlatforms = Math.max(1, due.length);
  let pStep = 0;
  for (const s of due) {
    pStep += 1;
    if (typeof onProgress === 'function') {
      onProgress({
        step: pStep,
        total: totalPlatforms,
        stage: '平台',
        detail: `${s.platform} 发布处理中`,
        percent: Math.round((pStep / totalPlatforms) * 100),
      });
    }
    const asDraft = AS_DRAFT_BY_PLATFORM[s.platform] === true;
    // Declared OUTSIDE the try so the catch branch can still record WHICH articles
    // the failed attempt was carrying (2026-11-13: a thrown access_token/cover
    // error used to leave channel_plan completely untouched).
    let next = null;
    let slugs = [];
    let pub = null;
    try {
      // 2026-11-11 — 闸门隔离后的候选重试：publishToChannel 命中 G17 会把不合格稿
      // 隔离成 review_failed（从队列移出）并返回 blocked:true。旧行为是直接失败，
      // 这个槽当天就此报废；现在换下一批候选再试，最多 GATE_RETRY_MAX 轮，
      // 这样队头压着坏稿也不会让整个槽连续多日空转。
      for (let attempt = 1; attempt <= GATE_RETRY_MAX; attempt += 1) {
        next = await channel.nextDue(s.platform, { count: s.count || 1, register: !dryRun });
        if (!next) break;
        slugs = next.tasks.map((x) => x.slug);
        pub = await publishToChannel({
          platform: s.platform,
          slugs,
          articles: [],
          asDraft,
          dryRun,
          siteKey,
        });
        if (!pub || pub.ok || !pub.blocked) break;
        if (attempt === GATE_RETRY_MAX) {
          // 用尽重试：把最后一轮的 blocked 结果原样返回，交给下面的失败留痕分支
          break;
        }
      }
      if (!next) {
        results.push({
          platform: s.platform,
          publish_time: s.publish_time,
          status: 'no_due_articles',
          detail: 'no unpublished blog articles left for this platform today',
        });
        continue;
      }
      const fired = { platform: s.platform, publish_time: s.publish_time, count: s.count, asDraft, ok: !!pub.ok };
      if (!pub.ok) {
        fired.status = 'failed';
        // Surface the REAL per-article failure reasons (platform err_no/err_msg, stage,
        // cover/tags context) instead of a generic "not-ok".
        fired.detail = collectPublishErrors(pub);
        // 失败也要留痕（2026-11-11）。此前这里直接 continue：channel_plan 一行都不写，
        // error_code/error_message/failed_at 永远为空，ticker 日志只剩 "1 of 1 failed"，
        // 结果"发了但被前置闸门拦下"与"根本没被调度到"在数据上完全无法区分——这正是
        // 掘金/CSDN 停发 5 天却查不出原因的直接原因。现在把每个失败项按行落库。
        if (!dryRun && PUBLISH_LOG_PLATFORMS.includes(s.platform)) {
          const attemptAt = localStamp(new Date());
          for (const r of pub.results || []) {
            if (!r || r.ok) continue;
            try {
              await channel.recordPublish({
                platform: s.platform,
                slug: r.slug,
                title: r.title || (r.detail && r.detail.title),
                status: 'failed',
                draftId: r.draftId || (r.detail && r.detail.draftId),
                notes: `[attempt ${attemptAt}] 发布失败：${r.stage || 'unknown'}${r.blocked ? '（前置闸门拦截，未调平台接口）' : ''}`,
                error: r.error || (r.reason ? { code: 'STYLE_GATE', message: r.reason } : null),
                stage: r.stage || (r.blocked ? 'style_check' : null),
                context: r.context || (r.errors ? { gateErrors: r.errors.slice(0, 10) } : null),
              });
            } catch (logErr) {
              console.error('[channel_publish_due] recordPublish(failed) failed:', logErr.message);
            }
          }
          fired.failuresLogged = (pub.results || []).filter((r) => r && !r.ok).length;
        }
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
            // 2026-11-13: recordWechatIssueCreated appends the media_id (never
            // overwrites it) and reuses the existing 第N期 when the same message
            // is re-recorded — so "which message is this issue" survives re-runs
            // and a retry can never mint a second phantom 期.
            await channel.recordWechatIssueCreated({
              slugs: group,
              mediaId,
              topic: group.length === 1 ? null : `${group.length} 篇合辑`,
              notes: `merged into one WeChat message (media_id: ${mediaId || 'n/a'})${pub.action === 'draft-exists' ? ' [reused existing draft]' : ''}`,
            });
            fired.loggedIssue = { slugs: group, mediaId, reused: pub.action === 'draft-exists' };
          } catch (logErr) {
            // logging failure must not mask the publish result
            console.error('[channel_publish_due] recordWechatIssueCreated failed:', logErr.message);
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
              error: r.ok ? null : r.error || (r.detail && (r.detail.err || r.detail.error || r.detail.message)) || r.stage,
              stage: r.ok ? null : r.stage || (r.detail && r.detail.stage),
              context: r.ok ? null : r.context || (r.detail && r.detail.context),
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
      // 2026-11-13 — exceptions (access_token 40164 IP whitelist, missing featured
      // image, draft/add failure) used to leave channel_plan COMPLETELY untouched
      // and the slot un-stamped, so the ticker retried the same batch for the whole
      // 45-minute window with no evidence in the DB. Now: record one `failed` row
      // per candidate with the real error, then stamp the slot so the day's window
      // is closed (a retry needs an explicit reset, same rule as juejin/csdn).
      if (!dryRun && Array.isArray(slugs) && slugs.length) {
        const attemptAt = localStamp(new Date());
        for (const slug of slugs) {
          try {
            await channel.recordPublish({
              platform: s.platform,
              slug,
              status: 'failed',
              notes: `[attempt ${attemptAt}] 调度执行异常：${e.message.slice(0, 300)}`,
              error: { code: 'DISPATCH_ERROR', message: e.message.slice(0, 1000) },
              stage: 'dispatch',
            });
          } catch (logErr) {
            console.error('[channel_publish_due] recordPublish(exception) failed:', logErr.message);
          }
        }
        try {
          await withConn((conn) => repo.markLastRun(conn, appId, s.id, localStamp(now)));
        } catch (markErr) {
          console.error('[channel_publish_due] markLastRun after exception failed:', markErr.message);
        }
      }
      results.push({
        platform: s.platform,
        publish_time: s.publish_time,
        status: 'failed',
        detail: e.message,
        slugs,
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
    // P2: 今日必漏的槽（窗口右端已过 2 小时且未跑）。非空即需告警——外部 ticker
    // 不会补跑，漏掉的槽当天就是少一篇文章，且不会自己出现在任何日志里。
    stale_slots: staleSlots,
    alerts: staleSlots.map((x) => ({
      type: 'slot_missed',
      platform: x.platform,
      publish_time: x.publish_time,
      message: `${x.platform} ${x.publish_time} 今日窗口已关闭（已过 ${x.missed_by_min} 分钟）且未执行，本日该槽漏发`,
    })),
  };
}

module.exports = {
  FIRE_WINDOW_MIN,
  GATE_RETRY_MAX,
  MISSED_REPORT_DELAY_MIN,
  AS_DRAFT_BY_PLATFORM,
  PUBLISH_LOG_PLATFORMS,
  list,
  get,
  set,
  del,
  publishDue,
};
