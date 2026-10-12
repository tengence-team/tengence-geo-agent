'use strict';
/**
 * geo-mcp long-running task repository (db domain) — table tengence_geo_mcp_tasks
 * ============================================================================
 * Workspace-local durable state for the MCP Tasks extension. One row = one task
 * handle for a long-running tool (publish_daily / monitor_run / diagnose_site /
 * channel_publish_due). The official MCP Task vocabulary maps 1:1 to columns:
 *
 *   task_id          durable handle (uuid) — survives client/server restarts
 *   status           working | input_required | completed | failed | cancelled
 *   ttl_ms           durable lifetime; poll_interval_ms suggested poll cadence
 *   progress         JSON snapshot (official statusMessage / progress)
 *   input_requests   JSON map of outstanding inputRequests (reserved, empty initially)
 *   result / error   JSON terminal output (completed) / error (failed)
 *   expires_at       TTL expiry, swept by the task manager
 *
 * Unique key = (app_id, task_id) — multi-tenant durable handle. All writes go
 * through conn.query under a withConn transaction (never direct sqlite access).
 * ============================================================================
 */

const { MCP_TASKS } = require('./sqlite-schema');

const TASK_TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const TASK_VALID = new Set(['working', 'input_required', 'completed', 'failed', 'cancelled']);

function assertStatus(s) {
  if (!TASK_VALID.has(s)) {
    throw new Error(`mcp_tasks status must be one of ${[...TASK_VALID].join('|')}, got "${s}"`);
  }
  return s;
}

/**
 * Insert a new working task and return its durable handle.
 * @param {object} row { task_id, name, status?, ttl_ms?, poll_interval_ms?, expires_at? }
 * @returns {Promise<object>} the stored row
 */
async function insert(conn, appId, row) {
  if (!row || !row.task_id || !row.name) {
    throw new Error('mcp_tasks insert requires task_id + name');
  }
  const status = row.status === undefined ? 'working' : assertStatus(row.status);
  const [result] = await conn.query(
    `INSERT INTO ${MCP_TASKS} (app_id, task_id, name, status, ttl_ms, poll_interval_ms, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [appId, row.task_id, row.name, status,
      row.ttl_ms === undefined ? null : Number(row.ttl_ms),
      row.poll_interval_ms === undefined ? null : Number(row.poll_interval_ms),
      row.expires_at === undefined ? null : row.expires_at]
  );
  const [rows] = await conn.query(
    `SELECT * FROM ${MCP_TASKS} WHERE app_id = ? AND id = ?`,
    [appId, Number(result.insertId)]
  );
  return rows[0];
}

/** Get one task by its durable handle. */
async function getByTaskId(conn, appId, taskId) {
  const [rows] = await conn.query(
    `SELECT * FROM ${MCP_TASKS} WHERE app_id = ? AND task_id = ? LIMIT 1`,
    [appId, String(taskId)]
  );
  return rows[0] || null;
}

/**
 * Update task fields (status / progress / input_requests / result / error / expires_at).
 * Terminal statuses are sticky: once completed/failed/cancelled, status cannot change.
 * @returns {Promise<object|null>} the updated row, or null if not found
 */
async function update(conn, appId, taskId, patch = {}) {
  const existing = await getByTaskId(conn, appId, taskId);
  if (!existing) return null;

  const sets = [];
  const params = [];
  if (patch.status !== undefined) {
    if (!TASK_TERMINAL.has(existing.status)) {
      sets.push('status = ?');
      params.push(assertStatus(patch.status));
    }
  }
  for (const col of ['progress', 'input_requests', 'result', 'error', 'expires_at', 'poll_interval_ms', 'ttl_ms']) {
    if (patch[col] !== undefined) {
      sets.push(`${col} = ?`);
      params.push(col.endsWith('_ms') && patch[col] !== null ? Number(patch[col]) : patch[col]);
    }
  }
  if (!sets.length) return existing;

  params.push(appId, String(taskId));
  await conn.query(
    `UPDATE ${MCP_TASKS} SET ${sets.join(', ')}, updated_at = NOW() WHERE app_id = ? AND task_id = ?`,
    params
  );
  return getByTaskId(conn, appId, taskId);
}

/**
 * Delete expired terminal tasks (TTL sweep). Applies only to terminal states.
 * @returns {Promise<{deleted:number}>}
 */
async function sweepExpired(conn, appId, now) {
  const cutoff = now || null;
  let sql = `DELETE FROM ${MCP_TASKS}
    WHERE status IN ('completed','failed','cancelled') AND expires_at IS NOT NULL AND expires_at < ?`;
  const params = [cutoff];
  if (appId !== undefined) {
    sql += ' AND app_id = ?';
    params.push(appId);
  }
  const [result] = await conn.query(sql, params);
  return { deleted: result.affectedRows || 0 };
}

/** Count active (non-terminal) tasks, optionally per app. */
async function countActive(conn, appId) {
  let sql = `SELECT COUNT(*) AS n FROM ${MCP_TASKS} WHERE status NOT IN ('completed','failed','cancelled')`;
  const params = [];
  if (appId !== undefined) {
    sql += ' AND app_id = ?';
    params.push(appId);
  }
  const [rows] = await conn.query(sql, params);
  return Number(rows[0] ? rows[0].n : 0);
}

module.exports = {
  MCP_TASKS,
  TASK_VALID,
  TASK_TERMINAL,
  insert,
  getByTaskId,
  update,
  sweepExpired,
  countActive,
};
