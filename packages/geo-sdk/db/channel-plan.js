'use strict';
/**
 * Channel publishing-calendar repository (db domain) — table tengence_geo_channel_plan
 * ============================================================================
 * Read/write entry for the per-platform publishing calendar (which platform posts
 * which slugs in which period). The service layer (plan/channel.js) orchestrates
 * this table; raw SQL against it is forbidden.
 *
 * This table is WORKSPACE-LOCAL state only (never part of the MySQL production
 * schema); see db/sqlite-schema.js.
 *
 * Statuses: todo → draft → published (paused for manual holds).
 * nextDue() = the earliest todo row for a platform (period order), i.e. the next
 * issue to prepare.
 * ============================================================================
 */

const { CHANNEL_PLAN } = require('./sqlite-schema');

const STATUSES = ['todo', 'draft', 'published', 'paused'];

/** Normalize a row record (decode JSON columns). */
function normalizeRow(row) {
  if (!row) return null;
  let articleSlugs = row.article_slugs;
  if (typeof articleSlugs === 'string') {
    try {
      articleSlugs = JSON.parse(articleSlugs);
    } catch (e) {
      articleSlugs = [];
    }
  }
  if (!Array.isArray(articleSlugs)) articleSlugs = [];
  let draftIds = row.draft_ids;
  if (typeof draftIds === 'string') {
    try {
      draftIds = JSON.parse(draftIds);
    } catch (e) {
      draftIds = [];
    }
  }
  if (!Array.isArray(draftIds)) draftIds = [];
  return { ...row, article_slugs: articleSlugs, draft_ids: draftIds };
}

/**
 * List calendar rows (optional platform / status filter).
 * @param {object} filters { platform, status, limit }
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
  sql += ' ORDER BY id ASC';
  if (filters.limit) sql += ' LIMIT ?';
  if (filters.limit) params.push(filters.limit);
  const [rows] = await conn.query(sql, params);
  return rows.map(normalizeRow);
}

/**
 * Get one row by id.
 */
async function get(conn, appId, id) {
  const [rows] = await conn.query(`SELECT * FROM ${CHANNEL_PLAN} WHERE app_id = ? AND id = ?`, [appId, id]);
  return normalizeRow(rows[0] || null);
}

/**
 * Upsert a calendar row, keyed by (app_id, platform, period).
 * @param {object} row { platform, period, topic, weekday, article_slugs, status, draft_ids, notes, schedule_at }
 * @returns {Promise<{id:number, action:'insert'|'update'}>}
 */
async function upsert(conn, appId, row) {
  const existing = await getByPeriod(conn, appId, row.platform, row.period);
  const slugsJson = JSON.stringify(Array.isArray(row.article_slugs) ? row.article_slugs : []);
  const draftJson = JSON.stringify(Array.isArray(row.draft_ids) ? row.draft_ids : []);
  if (existing) {
    await conn.query(
      `UPDATE ${CHANNEL_PLAN}
         SET topic = ?, weekday = ?, article_slugs = ?, status = ?, draft_ids = ?,
             notes = ?, schedule_at = ?,
             updated_at = NOW()
       WHERE id = ?`,
      [
        row.topic || existing.topic || null,
        row.weekday || existing.weekday || null,
        row.article_slugs ? slugsJson : existing.article_slugs,
        row.status || existing.status || 'todo',
        row.draft_ids ? draftJson : existing.draft_ids,
        row.notes !== undefined ? row.notes : existing.notes,
        row.schedule_at !== undefined ? row.schedule_at : existing.schedule_at,
        existing.id,
      ]
    );
    return { id: existing.id, action: 'update' };
  }
  const [result] = await conn.query(
    `INSERT INTO ${CHANNEL_PLAN}
       (app_id, platform, period, topic, weekday, article_slugs, status, draft_ids, notes, schedule_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      appId,
      row.platform,
      row.period,
      row.topic || null,
      row.weekday || null,
      slugsJson,
      row.status || 'todo',
      draftJson,
      row.notes || null,
      row.schedule_at || null,
    ]
  );
  return { id: Number(result.insertId), action: 'insert' };
}

/** Lookup one row by (platform, period). */
async function getByPeriod(conn, appId, platform, period) {
  const [rows] = await conn.query(
    `SELECT * FROM ${CHANNEL_PLAN} WHERE app_id = ? AND platform = ? AND period = ?`,
    [appId, platform, period]
  );
  return normalizeRow(rows[0] || null);
}

/** Lookup one row by the single slug it carries in article_slugs (json array). */
async function findBySlug(conn, appId, platform, slug) {
  const [rows] = await conn.query(
    `SELECT * FROM ${CHANNEL_PLAN}
      WHERE app_id = ? AND platform = ?
        AND EXISTS (SELECT 1 FROM json_each(article_slugs) WHERE json_each.value = ?)
      LIMIT 1`,
    [appId, platform, slug]
  );
  return normalizeRow(rows[0] || null);
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
 * Upsert a row keyed by (app_id, platform, slug-in-article_slugs). Used by the
 * publish log: a re-run updates the prior row (failed → published) instead of
 * creating a duplicate. The slug is the unique key — no per-platform article id is
 * stored (consistent with the wechat rows, which rely on article_slugs only).
 */
async function upsertBySlug(conn, appId, row) {
  const existing = await findBySlug(conn, appId, row.platform, row.slug);
  const slugsJson = JSON.stringify([row.slug]);
  const draftJson = JSON.stringify(row.draftId ? [row.draftId] : []);
  if (existing) {
    await conn.query(
      `UPDATE ${CHANNEL_PLAN}
         SET topic = ?, status = ?, draft_ids = ?, notes = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        row.topic || existing.topic || null,
        row.status || existing.status || 'todo',
        draftJson,
        row.notes !== undefined ? row.notes : existing.notes,
        existing.id,
      ]
    );
    return { id: existing.id, action: 'update' };
  }
  const [result] = await conn.query(
    `INSERT INTO ${CHANNEL_PLAN}
       (app_id, platform, period, topic, article_slugs, status, draft_ids, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      appId,
      row.platform,
      row.period || `P${row.blogOrder != null ? row.blogOrder : 'x'}`,
      row.topic || null,
      slugsJson,
      row.status || 'todo',
      draftJson,
      row.notes || null,
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
  const existing = await get(conn, appId, id);
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
 * The next due row for a platform: the earliest row still in todo (nothing has
 * been prepared for it yet — draft/published rows are already handled). This is
 * what the scheduled publisher should prepare next. Returns null when all rows
 * are at least drafted.
 */
async function nextDue(conn, appId, platform) {
  const [rows] = await conn.query(
    `SELECT * FROM ${CHANNEL_PLAN}
      WHERE app_id = ? AND platform = ? AND status = 'todo'
      ORDER BY id ASC LIMIT 1`,
    [appId, platform]
  );
  return normalizeRow(rows[0] || null);
}

module.exports = {
  STATUSES,
  list,
  get,
  getByPeriod,
  findBySlug,
  removeAll,
  upsert,
  upsertBySlug,
  markStatus,
  nextDue,
};
