'use strict';
/**
 * Channel publishing-task repository (db domain) — table tengence_geo_channel_plan
 * ============================================================================
 * Read/write entry for the per-platform publishing TASK table.
 *
 * v7 model (2026-10-11): ONE ROW = ONE (platform, slug, lang) publish task.
 *   - wechat: one issue (一期) = N rows sharing the same `period` ("第N期");
 *     in-issue headline order = row id order (insertion order of the slugs).
 *   - single-article channels (juejin / csdn / aliyun / tencent / devto …): one
 *     row per article language; `period` keeps only historical values (v5 legacy),
 *     new rows leave it NULL.
 * Unique key = (app_id, platform, slug, lang). Statuses: todo → draft → published
 * (paused for manual holds; reviewing / review_failed / deleted from live reconcile).
 *
 * This table is WORKSPACE-LOCAL state only (never part of the MySQL production
 * schema); see db/sqlite-schema.js. v5 → v7 data migration is a one-off script
 * (scripts/migrate-channel-plan-v7.js), NOT part of this repository.
 * ============================================================================
 */

const { CHANNEL_PLAN } = require('./sqlite-schema');

// Statuses: todo → draft → published (paused for manual holds).
// Reconciliation with the live platform can also surface:
//   reviewing     — published call succeeded but the platform still has it in review
//                   (e.g. Juejin audit_status=1: not yet publicly visible)
//   review_failed — platform rejected the article (e.g. Juejin audit_status=3)
//   deleted       — the article no longer exists on the platform at all
// `published` and `reviewing` are both treated as "already dispatched" by the dedup
// logic (nextDue / filterUnpublished); `review_failed` and `deleted` remain eligible
// for a (re)publish attempt.
const STATUSES = ['todo', 'failed', 'draft', 'published', 'paused', 'reviewing', 'review_failed', 'deleted'];

/** Normalize a language tag: 'zh-hans' | 'en' | 'zh-hant' (defensive trim/lowercase). */
function normalizeLang(l) {
  const v = String(l == null ? 'zh-hans' : l).trim().toLowerCase();
  return v || 'zh-hans';
}

/** Normalize a row record (decode JSON columns). */
function normalizeRow(row) {
  if (!row) return null;
  let draftIds = row.draft_ids;
  if (typeof draftIds === 'string') {
    try {
      draftIds = JSON.parse(draftIds);
    } catch (e) {
      draftIds = [];
    }
  }
  if (!Array.isArray(draftIds)) draftIds = [];
  const articleId = row.article_id != null ? String(row.article_id) : null;
  // Parse the JSON error_detail (written by recordPublish on failure) into convenient
  // sub-fields so consumers (channel_plan_status) get structured context + raw payload.
  let errorRaw = null;
  let errorContext = null;
  if (row.error_detail && typeof row.error_detail === 'string') {
    try {
      const o = JSON.parse(row.error_detail);
      errorRaw = o.raw || null;
      errorContext = o.context || null;
    } catch (_) {
      // not valid JSON — the raw string is still returned via error_detail
    }
  }
  return { ...row, draft_ids: draftIds, article_id: articleId, error_raw: errorRaw, error_context: errorContext };
}

/**
 * List task rows (optional platform / status / lang / slug filter).
 * NOTE: slug is filtered in SQL — a caller that combines slug with `limit` must
 * not let LIMIT truncate the result set before the slug match (the old
 * channel_plan_status path filtered slug in-memory after LIMIT and silently
 * returned nothing for rows past the limit).
 * @param {object} filters { platform, status, lang, slug, limit }
 */
async function list(conn, appId, filters = {}) {
  let sql = `SELECT * FROM ${CHANNEL_PLAN} WHERE app_id = ?`;
  const params = [appId];
  if (filters.platform) {
    sql += ' AND platform = ?';
    params.push(filters.platform);
  }
  if (filters.status) {
    sql += ' AND status = ?';
    params.push(filters.status);
  }
  if (filters.lang) {
    sql += ' AND lang = ?';
    params.push(normalizeLang(filters.lang));
  }
  if (filters.slug) {
    sql += ' AND slug = ?';
    params.push(filters.slug);
  }
  sql += ' ORDER BY id ASC';
  if (filters.limit) {
    sql += ' LIMIT ?';
    params.push(filters.limit);
  }
  const [rows] = await conn.query(sql, params);
  return rows.map(normalizeRow);
}

/** Get one row by primary key. */
async function getById(conn, appId, id) {
  const [rows] = await conn.query(`SELECT * FROM ${CHANNEL_PLAN} WHERE app_id = ? AND id = ?`, [appId, id]);
  return normalizeRow(rows[0] || null);
}

/** Lookup by the unique key (platform, slug, lang). */
async function getByKey(conn, appId, platform, slug, lang) {
  const [rows] = await conn.query(
    `SELECT * FROM ${CHANNEL_PLAN}
      WHERE app_id = ? AND platform = ? AND slug = ? AND lang = ? LIMIT 1`,
    [appId, platform, slug, normalizeLang(lang)]
  );
  return normalizeRow(rows[0] || null);
}

/**
 * Resolve the draft_ids value for an upsert (2026-11-13).
 * See the note inside upsert(): an omitted draft_ids must NEVER clear the stored
 * platform ids — that is how 75/75 wechat rows lost their media_id.
 * @param {object|null} existing current row (may be null)
 * @param {object} row incoming upsert payload
 * @returns {string[]} ids to persist
 */
function resolveDraftIds(existing, row) {
  const prev = existing && Array.isArray(existing.draft_ids) ? existing.draft_ids : [];
  const clean = (list) =>
    Array.from(new Set((list || []).map((x) => (x == null ? '' : String(x))).filter(Boolean)));
  if (Array.isArray(row && row.append_draft_ids)) {
    const merged = clean([...prev, ...row.append_draft_ids]);
    return merged;
  }
  if (Array.isArray(row && row.draft_ids)) return clean(row.draft_ids);
  return prev;
}

/**
 * Upsert a task row keyed by (app_id, platform, slug, lang): UPDATE the existing
 * row, else INSERT. Every write path (wechat issues, single-article recordPublish,
 * imports, reconciliation) goes through here so the unique key is the DB backstop
 * for "one (platform, slug, lang) task at most".
 * @param {object} row { platform, slug, lang?, period?, topic?, weekday?, status?, draft_ids?, notes?, schedule_at? }
 * @returns {Promise<{id:number, action:'insert'|'update'}>}
 */
async function upsert(conn, appId, row) {
  const lang = normalizeLang(row.lang);
  const existing = await getByKey(conn, appId, row.platform, row.slug, lang);
  // 2026-11-13 — draft_ids 是"平台侧凭证"（微信 media_id / 掘金 draft_id），
  // 绝不能因为调用方没传就被写成 []。历史事故：一次无关的 upsert（改状态、
  // 重排期号）把 75/75 条 wechat draft 行的 media_id 抹空，导致"第N期"永远
  // 映射不回草稿消息，发布后也无从回写。现在：
  //   - draft_ids === undefined → 保留旧值
  //   - append_draft_ids       → 追加去重（发布后补 media_id / article_id）
  //   - draft_ids 显式数组      → 覆盖（调用方明确要求）
  const draftIds = resolveDraftIds(existing, row);
  const draftJson = JSON.stringify(draftIds);
  if (existing) {
    await conn.query(
      `UPDATE ${CHANNEL_PLAN}
         SET period = ?, topic = ?, weekday = ?, status = ?, draft_ids = ?,
             notes = ?, schedule_at = ?,
             error_code = ?, error_message = ?, error_stage = ?, error_detail = ?, failed_at = ?,
             updated_at = NOW()
       WHERE app_id = ? AND id = ?`,
      [
        row.period !== undefined ? row.period : existing.period,
        row.topic !== undefined ? row.topic : existing.topic,
        row.weekday !== undefined ? row.weekday : existing.weekday,
        row.status || existing.status || 'todo',
        draftJson,
        row.notes !== undefined ? row.notes : existing.notes,
        row.schedule_at !== undefined ? row.schedule_at : existing.schedule_at,
        row.error_code !== undefined ? row.error_code : existing.error_code,
        row.error_message !== undefined ? row.error_message : existing.error_message,
        row.error_stage !== undefined ? row.error_stage : existing.error_stage,
        row.error_detail !== undefined ? row.error_detail : existing.error_detail,
        row.failed_at !== undefined ? row.failed_at : existing.failed_at,
        appId,
        existing.id,
      ]
    );
    return { id: existing.id, action: 'update' };
  }
  const [result] = await conn.query(
    `INSERT INTO ${CHANNEL_PLAN}
       (app_id, platform, slug, lang, period, topic, weekday, status, draft_ids, notes, schedule_at,
        error_code, error_message, error_stage, error_detail, failed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      appId,
      row.platform,
      row.slug,
      lang,
      row.period || null,
      row.topic || null,
      row.weekday || null,
      row.status || 'todo',
      draftJson,
      row.notes || null,
      row.schedule_at || null,
      row.error_code || null,
      row.error_message || null,
      row.error_stage || null,
      row.error_detail || null,
      row.failed_at || null,
    ]
  );
  return { id: Number(result.insertId), action: 'insert' };
}

/**
 * Transition a row's status (todo → draft → published; paused for holds).
 * Optionally records draft ids (e.g. wechat media_id) in the same write —
 * used by the publish pipeline after a draft is actually created.
 */
async function markStatus(conn, appId, id, status, draftIds) {
  if (!STATUSES.includes(status)) {
    throw new Error(`Invalid channel_plan status "${status}" (allowed: ${STATUSES.join(', ')})`);
  }
  const existing = await getById(conn, appId, id);
  if (!existing) throw new Error(`channel_plan row not found: id=${id}`);
  if (draftIds !== undefined) {
    if (!Array.isArray(draftIds)) throw new Error('draftIds must be an array of media ids');
    await conn.query(
      `UPDATE ${CHANNEL_PLAN} SET status = ?, draft_ids = ?, updated_at = NOW() WHERE app_id = ? AND id = ?`,
      [status, JSON.stringify(draftIds), appId, id]
    );
  } else {
    await conn.query(
      `UPDATE ${CHANNEL_PLAN} SET status = ?, updated_at = NOW() WHERE app_id = ? AND id = ?`,
      [status, appId, id]
    );
  }
  return { id: Number(id), status, draftIds: draftIds === undefined ? existing.draft_ids : draftIds };
}

/**
 * Persist the external platform's article id (e.g. Juejin post id) onto a row.
 * Used by the juejin reconciliation so the live article id is recorded locally and
 * can be referenced later (deep-linking, re-checks) without re-querying the platform.
 */
async function setArticleId(conn, appId, id, articleId) {
  // Keep as string — Juejin article ids are 19-digit Snowflake ids that lose precision as a JS Number.
  await conn.query(
    `UPDATE ${CHANNEL_PLAN} SET article_id = ?, updated_at = NOW() WHERE app_id = ? AND id = ?`,
    [articleId != null ? String(articleId) : null, appId, id]
  );
  return { id: Number(id), articleId: articleId != null ? String(articleId) : null };
}

/** Delete every row for a platform (used to drop a stale bulk-import). */
async function removeAll(conn, appId, platform) {
  const [result] = await conn.query(
    `DELETE FROM ${CHANNEL_PLAN} WHERE app_id = ? AND platform = ?`,
    [appId, platform]
  );
  return result.affectedRows || 0;
}

/**
 * Append a timestamped note to a row's `notes` column (audit verdicts, human-action
 * flags, retry hints). Preserves existing notes; no-op on a missing row.
 */
async function appendNotes(conn, appId, id, note) {
  const existing = await getById(conn, appId, id);
  if (!existing) return { id: Number(id), appended: false };
  const prev = existing.notes || '';
  const merged = prev ? `${prev}\n${note}` : note;
  await conn.query(
    `UPDATE ${CHANNEL_PLAN} SET notes = ?, updated_at = NOW() WHERE app_id = ? AND id = ?`,
    [merged, appId, id]
  );
  return { id: Number(id), appended: true, note };
}

/**
 * Append platform draft ids to an existing row (dedup, keep prior ids).
 * Used after a draft/message is created so "which message is this issue" is
 * never lost even if a later upsert rewrites other columns.
 * @returns {Promise<{id:number, draftIds:string[]}>}
 */
async function appendDraftIds(conn, appId, id, ids) {
  const existing = await getById(conn, appId, id);
  if (!existing) return { id: Number(id), draftIds: [] };
  const merged = Array.from(
    new Set(
      [...(existing.draft_ids || []), ...(ids || [])]
        .map((x) => (x == null ? '' : String(x)))
        .filter(Boolean)
    )
  );
  await conn.query(
    `UPDATE ${CHANNEL_PLAN} SET draft_ids = ?, updated_at = NOW() WHERE app_id = ? AND id = ?`,
    [JSON.stringify(merged), appId, id]
  );
  return { id: Number(id), draftIds: merged };
}

module.exports = {
  STATUSES,
  normalizeLang,
  list,
  getById,
  getByKey,
  upsert,
  markStatus,
  setArticleId,
  appendDraftIds,
  removeAll,
  appendNotes,
  resolveDraftIds,
};
