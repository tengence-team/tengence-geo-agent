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
const STATUSES = ['todo', 'draft', 'published', 'paused', 'reviewing', 'review_failed', 'deleted'];

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
 * List task rows (optional platform / status / lang filter).
 * @param {object} filters { platform, status, lang, limit }
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
  const draftJson = JSON.stringify(Array.isArray(row.draft_ids) ? row.draft_ids : []);
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

module.exports = {
  STATUSES,
  normalizeLang,
  list,
  getById,
  getByKey,
  upsert,
  markStatus,
  setArticleId,
  removeAll,
  appendNotes,
};
