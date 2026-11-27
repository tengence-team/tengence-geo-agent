/**
 * channel-state — the single read/write entry for a platforom publishing task
 * ============================================================================
 * Before this module (2026-11-13) the same fact was written in eight places:
 *   db/channel-plan upsert (no validation at all) + markStatus (enum only, no rules)
 *   plan/channel markStatus + reconcile, syndicate/wechat mass + sync,
 *   MCP channel_plan_mark, CLI channel-plan
 * `published -> todo` was silently accepted; the upsert path accepted any string
 * (`blocked` entered the table that way).
 *
 * Rule now: every read goes through read()/list(); every write goes through
 * setState()/record(). Illegal moves throw a ChannelStateError — nothing is
 * "helpfully" fixed behind the caller's back.
 *
 * Usage:
 *   const channelState = require('tengence-geo-sdk/channel-state');
 *   await channelState.setState({ appId: 1, id: 253, to: 'published', draftIds: [mediaId] });
 * ============================================================================
 */

const conn = require('../db/connection');
const states = require('./states');
const errors = require('./errors');
const repo = require('./repo');

const DEFAULT_LIMIT = 1000;
const { STATES, ALL } = states;

function normalizeLang(lang) {
  return lang ? String(lang).trim().toLowerCase() : null;
}

function toRow(row, appId) {
  if (!row) return null;
  return {
    id: Number(row.id),
    appId: appId == null ? (row.app_id == null ? null : Number(row.app_id)) : appId,
    platform: row.platform,
    slug: row.slug,
    lang: normalizeLang(row.lang) || row.lang,
    status: row.status,
    period: row.period || null,
    topic: row.topic || null,
    weekday: row.weekday || null,
    draftIds: parseIds(row.draft_ids),
    articleId: row.article_id == null ? null : String(row.article_id),
    notes: row.notes || null,
    scheduleAt: row.schedule_at || null,
    error:
      row.error_code || row.error_message
        ? {
            code: row.error_code || null,
            message: row.error_message || null,
            stage: row.error_stage || null,
            detail: row.error_detail || null,
            failedAt: row.failed_at || null,
          }
        : null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function parseIds(v) {
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

function assertState(status) {
  const s = states.normalize(status);
  if (!states.isState(s)) throw errors.invalidState(status, ALL);
  return s;
}

/**
 * Read one row by id, or by (platform, slug, lang).
 * @param {{appId:number, id?:number, platform?:string, slug?:string, lang?:string, conn?:object}} args
 */
async function read({ appId, id = null, platform = null, slug = null, lang = null, conn: injected } = {}) {
  const run = async (c) => {
    const row = id != null
      ? await repo.selectOne(c, appId, id)
      : await repo.selectByKey(c, appId, platform, slug, normalizeLang(lang) || 'zh-hans');
    if (!row) return null;
    return toRow(row, appId);
  };
  return injected ? run(injected) : conn.withConn(run);
}

/**
 * List rows. `status` filter may be a string or an array.
 * @param {{appId:number, platform?:string, status?:string|string[], limit?:number, conn?:object}} args
 */
async function list({ appId, platform = null, status = null, limit = DEFAULT_LIMIT, conn: injected } = {}) {
  const wanted = status ? (Array.isArray(status) ? status : [status]).map((s) => assertState(s)) : null;
  const run = async (c) => {
    const rows = await repo.selectList(c, appId, { platform: platform || undefined, status: wanted && wanted.length === 1 ? wanted[0] : undefined });
    const mapped = rows.map((r) => toRow(r, appId));
    const filtered = wanted ? mapped.filter((r) => wanted.includes(states.normalize(r.status))) : mapped;
    return filtered.slice(0, Number(limit) || DEFAULT_LIMIT);
  };
  return injected ? run(injected) : conn.withConn(run);
}

/**
 * The single status write entry.
 *
 * @param {{appId:number, id:number, to:string, reason?:string, draftIds?:string[],
 *          articleId?:string|number, force?:boolean, conn?:object}} args
 */
async function setState({ appId, id, to, reason = null, draftIds, articleId, force = false, platform = null, conn: injected } = {}) {
  if (id == null) throw new Error('channelState.setState requires id');
  const target = assertState(to);
  const run = async (c) => {
    const row = await repo.selectOne(c, appId, id);
    if (!row) throw errors.notFound(id);
    const from = states.normalize(row.status) || null;
    // platform is only needed for the per-platform transition exceptions (a
    // live-publish platform may go todo -> published without a draft stage);
    // fall back to the row's own platform when the caller did not pass one.
    const platformKey = states.normalize(platform || row.platform);

    if (from === target) {
      // idempotent: still allow attaching metadata
      if (draftIds !== undefined) await repo.writeStatus(c, appId, id, target, draftIds);
      if (articleId != null && String(articleId)) await repo.writeArticleId(c, appId, id, String(articleId));
      return { ok: true, id: Number(id), from, to: target, changed: false };
    }

    if (force && !reason) throw errors.reasonRequired(from, target);
    if (!force && !states.canTransition(from, target, platformKey)) {
      throw errors.invalidTransition(from, target, states.TRANSITIONS[from]);
    }
    if (states.reasonRequired(from, target) && !reason) throw errors.reasonRequired(from, target);

    await repo.writeStatus(c, appId, id, target, draftIds);
    if (articleId != null && String(articleId)) await repo.writeArticleId(c, appId, id, String(articleId));
    if (reason) {
      await repo.writeNotes(c, appId, id, `[状态 ${new Date().toISOString()}] ${from}→${target}: ${String(reason).slice(0, 300)}`);
    }
    return { ok: true, id: Number(id), from, to: target, changed: true, forced: !!force };
  };
  return injected ? run(injected) : conn.withConn(run);
}

/**
 * Create-or-update a row in ONE call, keeping status legal.
 *
 * - row absent  -> created directly in `status` (creation is not a transition)
 * - row present -> non-status fields updated; a different `status` is applied
 *                  through setState, so the transition table still governs it.
 *
 * @param {{appId:number, platform:string, slug:string, lang?:string, status?:string,
 *          period?:string, topic?:string, weekday?:string, notes?:string,
 *          draftIds?:string[], appendDraftIds?:string[], articleId?:string|number,
 *          errorCode?:string, errorMessage?:string, errorStage?:string,
 *          errorDetail?:string, failedAt?:string, reason?:string, force?:boolean,
 *          conn?:object}} rec
 */
async function record(rec = {}) {
  const { appId, platform, slug, lang = 'zh-hans', status = null, conn: injected } = rec;
  if (!platform) throw new Error('channelState.record requires platform');
  if (!slug) throw new Error('channelState.record requires slug');
  const to = status == null ? null : assertState(status);
  const run = async (c) => {
    const existing = await repo.selectByKey(c, appId, platform, slug, normalizeLang(lang) || 'zh-hans');

    const fields = {
      platform,
      slug,
      lang: normalizeLang(lang) || 'zh-hans',
      period: rec.period,
      topic: rec.topic,
      weekday: rec.weekday,
      notes: rec.notes,
      schedule_at: rec.scheduleAt,
      error_code: rec.errorCode,
      error_message: rec.errorMessage,
      error_stage: rec.errorStage,
      error_detail: rec.errorDetail,
      failed_at: rec.failedAt,
    };
    if (rec.draftIds !== undefined) fields.draft_ids = rec.draftIds;
    if (rec.appendDraftIds !== undefined) fields.append_draft_ids = rec.appendDraftIds;

    if (!existing) {
      const res = await repo.writeRow(c, appId, { ...fields, status: to || STATES.TODO });
      if (rec.articleId != null && String(rec.articleId)) {
        await repo.writeArticleId(c, appId, res.id, String(rec.articleId));
      }
      return { id: res.id, action: 'insert', from: null, to: to || STATES.TODO };
    }

    const res = await repo.writeRow(c, appId, fields); // no status: never changes it
    let applied = states.normalize(existing.status);
    if (to && to !== applied) {
      const out = await setState({
        appId,
        id: existing.id,
        to,
        reason: rec.reason || null,
        force: rec.force === true,
        articleId: rec.articleId,
        platform,
        conn: c,
      });
      applied = out.to;
    } else if (rec.articleId != null && String(rec.articleId)) {
      await repo.writeArticleId(c, appId, existing.id, String(rec.articleId));
    }
    return { id: res.id, action: 'update', from: states.normalize(existing.status), to: applied };
  };
  return injected ? run(injected) : conn.withConn(run);
}

/**
 * Read-only consistency report (dryRun by default; pass fix:true to write the
 * safe subset — normalising an unknown status to `failed` with a note).
 * @param {{appId:number, platform?:string, fix?:boolean, dryRun?:boolean, conn?:object}} args
 */
async function audit({ appId, platform = null, fix = false, dryRun = true, conn: injected } = {}) {
  const run = async (c) => {
    const rows = await repo.selectList(c, appId, { platform: platform || undefined });
    const report = {
      invalidStatus: [],
      draftWithoutMedia: [],
      publishedWithoutMedia: [],
      queueWithMedia: [],
      draftWithoutPeriod: [],
      counts: {},
      fixed: null,
    };
    for (const r of rows) {
      const st = states.normalize(r.status);
      const ids = parseIds(r.draft_ids);
      const item = { id: Number(r.id), platform: r.platform, slug: r.slug, lang: r.lang, status: r.status, period: r.period || null };
      if (!states.isState(st)) report.invalidStatus.push(item);
      else if (st === STATES.DRAFT && !ids.length) report.draftWithoutMedia.push(item);
      // only wechat needs a stored media_id after publishing (that is the only way to
      // re-check / delete the draft later); juejin/csdn keep their id in article_id
      else if (st === STATES.PUBLISHED && !ids.length && /wechat/.test(String(r.platform))) {
        report.publishedWithoutMedia.push(item);
      }
      else if (st === STATES.DRAFT && !r.period && (r.platform === 'wechat' || /wechat/.test(String(r.platform)))) {
        report.draftWithoutPeriod.push(item);
      } else if (states.isQueueStatus(st) && ids.length) report.queueWithMedia.push(item);
    }
    report.counts = {
      rows: rows.length,
      invalidStatus: report.invalidStatus.length,
      draftWithoutMedia: report.draftWithoutMedia.length,
      publishedWithoutMedia: report.publishedWithoutMedia.length,
      queueWithMedia: report.queueWithMedia.length,
      draftWithoutPeriod: report.draftWithoutPeriod.length,
    };
    if (!fix || dryRun) return report;

    const fixed = { invalidStatus: 0 };
    for (const item of report.invalidStatus) {
      await repo.writeStatus(c, appId, item.id, STATES.FAILED);
      await repo.writeNotes(
        c,
        appId,
        item.id,
        `[状态对账 ${new Date().toISOString()}] 非法状态 ${item.status} → failed（原因未臆测，请人工确认后改回正确状态）`
      );
      fixed.invalidStatus += 1;
    }
    report.fixed = fixed;
    return report;
  };
  return injected ? run(injected) : conn.withConn(run);
}

module.exports = {
  STATES,
  ALL,
  TRANSITIONS: states.TRANSITIONS,
  DISPATCHED_BY_PLATFORM: states.DISPATCHED_BY_PLATFORM,
  DEFAULT_DISPATCHED: states.DEFAULT_DISPATCHED,
  NO_AUTO_RETRY: states.NO_AUTO_RETRY,
  QUEUE_STATUSES: states.QUEUE_STATUSES,
  isState: states.isState,
  canTransition: states.canTransition,
  dispatchedFor: states.dispatchedFor,
  isDispatched: states.isDispatched,
  isNoAutoRetry: states.isNoAutoRetry,
  read,
  list,
  setState,
  record,
  audit,
  errors,
  repo,
};
