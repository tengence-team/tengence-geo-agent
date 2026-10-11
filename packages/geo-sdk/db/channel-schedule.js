'use strict';
/**
 * Channel scheduling-rule repository (db domain) — table tengence_geo_channel_schedule
 * ============================================================================
 * Read/write entry for the auto-publish SCHEDULING-RULE table.
 *
 * One row = one (platform, publish_time) slot. This is a TEMPLATE, not a task
 * instance: it deliberately has NO slug (the unified executor picks nextDue's N
 * articles at fire time). The task instances live in tengence_geo_channel_plan
 * (one row = one (platform, slug, lang) publish task); the two tables stay apart
 * because channel_plan's unique key (app_id, platform, slug, lang) requires a
 * slug and cannot host schedule rules.
 *
 * Unique key = (app_id, platform, publish_time) — one slot per channel per time.
 * `enabled` pauses a slot without deleting the rule; `last_run_at` is the
 * day-level re-fire guard read by the executor (plan/channel-schedule.js).
 * ============================================================================
 */

const { CHANNEL_SCHEDULE } = require('./sqlite-schema');

/** Accepts "HH:MM" with zero-padded hours; returns the normalized string. */
const RE_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
function normalizeTime(t) {
  const v = String(t == null ? '' : t).trim();
  if (!RE_TIME.test(v)) {
    throw new Error(`channel_schedule publish_time must be "HH:MM" (zero-padded), got "${t}"`);
  }
  return v;
}

/** Normalize count: positive integer, default 1. */
function normalizeCount(c) {
  const n = Number(c);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`channel_schedule count must be a positive integer, got "${c}"`);
  }
  return n;
}

/** Normalize enabled: 0 | 1 (default 1). */
function normalizeEnabled(e) {
  if (e === undefined || e === null) return 1;
  const v = Number(e);
  return v === 0 ? 0 : 1;
}

/** List schedule rows (optional platform / enabled filter). */
async function list(conn, appId, filters = {}) {
  let sql = `SELECT * FROM ${CHANNEL_SCHEDULE} WHERE app_id = ?`;
  const params = [appId];
  if (filters.platform) {
    sql += ' AND platform = ?';
    params.push(filters.platform);
  }
  if (filters.enabled !== undefined && filters.enabled !== null) {
    sql += ' AND enabled = ?';
    params.push(Number(filters.enabled) === 0 ? 0 : 1);
  }
  sql += ' ORDER BY platform ASC, publish_time ASC';
  const [rows] = await conn.query(sql, params);
  return rows;
}

/** Get one schedule row by primary key. */
async function getById(conn, appId, id) {
  const [rows] = await conn.query(
    `SELECT * FROM ${CHANNEL_SCHEDULE} WHERE app_id = ? AND id = ?`,
    [appId, id]
  );
  return rows[0] || null;
}

/** Lookup by the unique key (platform, publish_time). */
async function getByKey(conn, appId, platform, publishTime) {
  const [rows] = await conn.query(
    `SELECT * FROM ${CHANNEL_SCHEDULE}
      WHERE app_id = ? AND platform = ? AND publish_time = ? LIMIT 1`,
    [appId, platform, normalizeTime(publishTime)]
  );
  return rows[0] || null;
}

/**
 * Upsert a schedule row keyed by (app_id, platform, publish_time): UPDATE the
 * existing slot, else INSERT. count/enabled are merged only when provided.
 * @param {object} row { platform, publish_time, count?, enabled? }
 * @returns {Promise<{id:number, action:'insert'|'update', row:object}>}
 */
async function set(conn, appId, row) {
  if (!row || !row.platform || row.publish_time == null) {
    throw new Error('channel_schedule set requires platform + publish_time');
  }
  const publishTime = normalizeTime(row.publish_time);
  const existing = await getByKey(conn, appId, row.platform, publishTime);
  if (existing) {
    const count = row.count !== undefined && row.count !== null ? normalizeCount(row.count) : existing.count;
    const enabled = normalizeEnabled(row.enabled !== undefined ? row.enabled : existing.enabled);
    await conn.query(
      `UPDATE ${CHANNEL_SCHEDULE} SET count = ?, enabled = ?, updated_at = NOW()
        WHERE app_id = ? AND id = ?`,
      [count, enabled, appId, existing.id]
    );
    const [rows] = await conn.query(
      `SELECT * FROM ${CHANNEL_SCHEDULE} WHERE app_id = ? AND id = ?`,
      [appId, existing.id]
    );
    return { id: existing.id, action: 'update', row: rows[0] };
  }
  const count = row.count !== undefined && row.count !== null ? normalizeCount(row.count) : 1;
  const enabled = normalizeEnabled(row.enabled);
  const [result] = await conn.query(
    `INSERT INTO ${CHANNEL_SCHEDULE} (app_id, platform, publish_time, count, enabled)
      VALUES (?, ?, ?, ?, ?)`,
    [appId, row.platform, publishTime, count, enabled]
  );
  const [rows] = await conn.query(
    `SELECT * FROM ${CHANNEL_SCHEDULE} WHERE app_id = ? AND id = ?`,
    [appId, Number(result.insertId)]
  );
  return { id: Number(result.insertId), action: 'insert', row: rows[0] };
}

/**
 * Delete a schedule row by primary key, or by the unique key (platform + publish_time).
 * @param {object} key { id } | { platform, publish_time }
 * @returns {Promise<{deleted:number}>}
 */
async function del(conn, appId, key) {
  if (!key) throw new Error('channel_schedule del requires { id } or { platform, publish_time }');
  if (key.id !== undefined && key.id !== null) {
    const [result] = await conn.query(
      `DELETE FROM ${CHANNEL_SCHEDULE} WHERE app_id = ? AND id = ?`,
      [appId, Number(key.id)]
    );
    return { deleted: result.affectedRows || 0 };
  }
  if (key.platform && key.publish_time != null) {
    const [result] = await conn.query(
      `DELETE FROM ${CHANNEL_SCHEDULE} WHERE app_id = ? AND platform = ? AND publish_time = ?`,
      [appId, key.platform, normalizeTime(key.publish_time)]
    );
    return { deleted: result.affectedRows || 0 };
  }
  throw new Error('channel_schedule del requires { id } or { platform, publish_time }');
}

/**
 * Record a successful fire for a slot (day-level re-fire guard for the executor).
 * @param {string} [ts] optional timestamp, default NOW()
 */
async function markLastRun(conn, appId, id, ts) {
  const [rows] = await conn.query(
    `SELECT * FROM ${CHANNEL_SCHEDULE} WHERE app_id = ? AND id = ?`,
    [appId, id]
  );
  if (!rows.length) throw new Error(`channel_schedule row not found: id=${id}`);
  if (ts !== undefined) {
    await conn.query(
      `UPDATE ${CHANNEL_SCHEDULE} SET last_run_at = ?, updated_at = NOW() WHERE app_id = ? AND id = ?`,
      [ts, appId, id]
    );
  } else {
    await conn.query(
      `UPDATE ${CHANNEL_SCHEDULE} SET last_run_at = NOW(), updated_at = NOW() WHERE app_id = ? AND id = ?`,
      [appId, id]
    );
  }
  return { id: Number(id) };
}

module.exports = {
  normalizeTime,
  normalizeCount,
  normalizeEnabled,
  list,
  getById,
  getByKey,
  set,
  del,
  markLastRun,
};
