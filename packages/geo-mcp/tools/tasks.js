'use strict';
/**
 * geo-mcp MCP Tasks extension runtime (tools/tasks.js)
 * ============================================================================
 * Durable long-running task support for the MCP 2026-07-28 Tasks extension.
 * Built on the high-level McpServer (S6 keeps the whole existing server layer,
 * no service re-build): a long-running tool's executor returns
 *   { resultType: 'task', taskId, status, ttlMs, pollIntervalMs, createdAt, lastUpdatedAt }
 * and the SDK high-level tools/call emits it verbatim (tools/call is in the
 * EXTENDED_RESULT_TYPE_METHODS set). The task's durable state lives in
 * tengence_geo_mcp_tasks (app_id multi-tenant), managed via t.db.mcpTasks.
 *
 * The work (tool.run) is started in-process via setImmediate so tools/call never
 * blocks; terminal state is written back by the background runner. Cancellation
 * is cooperative (official): tasks/cancel marks cancelled, but a runner that
 * already wrote completed/failed wins (terminal states are sticky in the repo).
 * ============================================================================
 */

const crypto = require('crypto');
const t = require('@tengence/geo-sdk');
const taskNotify = require('./task-notify');

const DEFAULT_TTL_MS = 15 * 60 * 1000; // durable lifetime
const DEFAULT_POLL_MS = 2000; // suggested poll cadence

/** Resolve the current tenant app_id (current workspace's first site, else env, else 1). */
function resolveCurrentAppId() {
  try {
    const bound = t.workspace.current();
    if (bound) {
      const keys = t.site.listSites();
      if (keys.length) {
        const s = t.site.loadSite(keys[0]);
        return parseInt(process.env.APP_ID || (s && s.env && s.env.APP_ID) || '1', 10);
      }
    }
  } catch (_) { /* fall through to default */ }
  return parseInt(process.env.APP_ID || '1', 10);
}

/**
 * Did the client declare the Tasks extension in this request's capabilities?
 * @param {import('@modelcontextprotocol/server').McpRequestContext} ctx
 */
function clientDeclaresTasks(ctx) {
  try {
    const caps = ctx && ctx.mcpReq && ctx.mcpReq.envelope && ctx.mcpReq.envelope['io.modelcontextprotocol/clientCapabilities'];
    return !!(caps && caps.extensions && caps.extensions['io.modelcontextprotocol/tasks']);
  } catch (_) {
    return false;
  }
}

/** Map a DB row to the wire task object (official Task vocabulary). */
function taskFromRow(row) {
  if (!row) return null;
  const task = {
    taskId: row.task_id,
    status: row.status,
    ttlMs: row.ttl_ms == null ? null : Number(row.ttl_ms),
    pollIntervalMs: row.poll_interval_ms == null ? null : Number(row.poll_interval_ms),
    createdAt: row.created_at,
    lastUpdatedAt: row.updated_at,
  };
  if (row.progress) task.progress = safeJson(row.progress);
  if (row.result) task.result = safeJson(row.result);
  if (row.error) task.error = safeJson(row.error);
  return task;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch (_) { return s; }
}

/**
 * Create a durable task: persist `working` first (official "durably created before
 * the response is sent"), start the work in the background, and return the task
 * handle the executor should emit. Returns a Promise<task-handle-object>.
 * @param {number} appId tenant id
 * @param {object} meta { name, ttlMs?, pollIntervalMs? }
 * @param {() => Promise<any>} workFn background work; resolved value becomes `result`
 */
async function createTask(appId, meta, workFn) {
  const taskId = crypto.randomUUID();
  const ttlMs = meta.ttlMs === undefined ? DEFAULT_TTL_MS : Number(meta.ttlMs);
  const pollIntervalMs = meta.pollIntervalMs === undefined ? DEFAULT_POLL_MS : Number(meta.pollIntervalMs);
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  await t.db.withConn((conn) =>
    t.db.mcpTasks.insert(conn, appId, {
      task_id: taskId,
      name: meta.name,
      status: 'working',
      ttl_ms: ttlMs,
      poll_interval_ms: pollIntervalMs,
      expires_at: expiresAt,
    })
  );

  setImmediate(async () => {
    try {
      const result = await workFn();
      await t.db.withConn((conn) =>
        t.db.mcpTasks.update(conn, appId, taskId, { status: 'completed', result: JSON.stringify(result) })
      );
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      await t.db.withConn((conn) =>
        t.db.mcpTasks.update(conn, appId, taskId, { status: 'failed', error: JSON.stringify({ message }) })
      );
    } finally {
      // S7 (方案 A): publish the standard resources/updated change notification for
      // this task's resource URI. Subscribing clients then fetch the terminal state
      // via tasks/get instead of blind polling. No-op on the stdio transport (which
      // exposes no notifier) and when no subscription is open.
      taskNotify.publishTask(taskId);
    }
  });

  return {
    resultType: 'task',
    taskId,
    status: 'working',
    ttlMs,
    pollIntervalMs,
    createdAt: nowIso,
    lastUpdatedAt: nowIso,
  };
}

/** Read current task state (for tasks/get). */
async function getTask(appId, taskId) {
  return t.db.withConn((conn) => t.db.mcpTasks.getByTaskId(conn, appId, taskId));
}

/** Cooperative cancel (for tasks/cancel). */
async function cancelTask(appId, taskId) {
  const row = await t.db.withConn((conn) => t.db.mcpTasks.getByTaskId(conn, appId, taskId));
  if (!row) return null;
  await t.db.withConn((conn) => t.db.mcpTasks.update(conn, appId, taskId, { status: 'cancelled' }));
  return getTask(appId, taskId);
}

// ---- request handlers (registered on the McpServer low-level Server) ----
// NOTE: setRequestHandler(method, {params,result}, handler) invokes handler with the
// PARSED params directly (parsed.data), NOT a {params} envelope.

/** tasks/get: return current state; terminal states carry result / error. */
async function tasksGet(params, ctx) {
  const appId = resolveCurrentAppId();
  const row = await getTask(appId, params.taskId);
  if (!row) return { error: `task ${params.taskId} not found` };
  return taskFromRow(row);
}

/** tasks/update: no elicitation in the first batch — ack, ignore unknown keys. */
async function tasksUpdate(params, ctx) {
  return {};
}

/** tasks/cancel: cooperative — mark cancelled, ack. */
async function tasksCancel(params, ctx) {
  const appId = resolveCurrentAppId();
  await cancelTask(appId, params.taskId);
  return {};
}

module.exports = {
  DEFAULT_TTL_MS,
  DEFAULT_POLL_MS,
  resolveCurrentAppId,
  clientDeclaresTasks,
  taskFromRow,
  createTask,
  getTask,
  cancelTask,
  tasksGet,
  tasksUpdate,
  tasksCancel,
};
