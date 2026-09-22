/**
 * SQLite driver facade (better-sqlite3)
 * ============================================================================
 * Lets the existing repository code (written against mysql2/promise conventions) run
 * on SQLite without modification:
 *
 *   query(sql, params) → Promise<[rows, fields]>      (SELECT → row array; writes → [{insertId, affectedRows, changedRows}])
 *   execute(sql, params) → same as query
 *   beginTransaction() / commit() / rollback() / end()
 *
 * Auto-init (no separate init step): on first connect, checks PRAGMA user_version;
 * if below SCHEMA_VERSION, executes the SQLite DDL (idempotent, IF NOT EXISTS) and
 * writes the version. Incremental migration: later schema changes only need to bump
 * SCHEMA_VERSION and append a migration branch.
 *
 * SQL dialect translation (only for legacy MySQL-specific constructs, kept minimal
 * and explicit):
 *   - NOW()                     → registers a same-named SQLite function (returns local
 *                                 time YYYY-MM-DD HH:MM:SS, same semantics as MySQL)
 *   - GROUP_CONCAT(DISTINCT … ORDER BY … SEPARATOR ', ') → GROUP_CONCAT(…, ', ')
 *   - SUBSTRING_INDEX(x, '?', 1) → CASE WHEN instr … END
 *   - JSON_CONTAINS(col, JSON_QUOTE(k)) → EXISTS (SELECT 1 FROM json_each(col) WHERE json_each.value = k)
 *   - IFNULL( → COALESCE(
 * The translation is a "bounded allow-list": if a new MySQL-specific function appears
 * later and cannot be translated, it throws a raw SQLite syntax error (fail fast)
 * instead of silently producing wrong results.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { createSqliteTablesSQL, SCHEMA_VERSION } = require('./sqlite-schema');

let _db = null;
let _dbPath = null;

const paths = require('../paths');

/**
 * Database file location: DB_PATH when set (also accepts `~`), otherwise the internal
 * default ~/.tengence/geo-mcp/geo.sqlite — one file, multi-tenant, shared by all
 * app_ids and independent of any user workspace (see geo-sdk/paths.js).
 */
function resolveDbPath() {
  return paths.dbPath();
}

/** MySQL NOW() semantics: local-time string */
function localNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Idempotent schema init + incremental migration (PRAGMA user_version)
 * @returns {{applied:boolean, version:number}}
 */
function ensureSchema(db) {
  const version = Number(db.pragma('user_version', { simple: true }));
  if (version >= SCHEMA_VERSION) return { applied: false, version };

  db.exec('BEGIN');
  try {
    db.exec(createSqliteTablesSQL);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { applied: true, version: SCHEMA_VERSION };
}

/** Open (or reuse) the database handle; auto-switches handles when DB_PATH changes (test-friendly) */
function getDb() {
  const dbPath = resolveDbPath();
  if (_db && _dbPath === dbPath) return _db;
  if (_db) {
    try { _db.close(); } catch (_) { /* ignore */ }
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.function('NOW', localNow);
  ensureSchema(db);
  _db = db;
  _dbPath = dbPath;
  return db;
}

/** Test/reset helper: close the handle and clear the cache */
function resetDb() {
  if (_db) {
    try { _db.close(); } catch (_) { /* ignore */ }
    _db = null;
    _dbPath = null;
  }
}

// ---------------------------------------------------------------------------
// SQL dialect translation
// ---------------------------------------------------------------------------

/** GROUP_CONCAT(DISTINCT x ORDER BY y SEPARATOR 's') → GROUP_CONCAT(x, 's') */
const RE_GC_DIST_SEP = /GROUP_CONCAT\(\s*DISTINCT\s+([A-Za-z0-9_.]+)\s+ORDER\s+BY\s+[^)]*?\s+SEPARATOR\s+'([^']*)'\s*\)/gi;
/** GROUP_CONCAT(DISTINCT x ORDER BY y) → GROUP_CONCAT(x) */
const RE_GC_DIST_ORDER = /GROUP_CONCAT\(\s*DISTINCT\s+([A-Za-z0-9_.]+)\s+ORDER\s+BY\s+[^)]*\)/gi;
/** GROUP_CONCAT(DISTINCT x SEPARATOR 's') → GROUP_CONCAT(x, 's') */
const RE_GC_DIST_SEP_ONLY = /GROUP_CONCAT\(\s*DISTINCT\s+([A-Za-z0-9_.]+)\s+SEPARATOR\s+'([^']*)'\s*\)/gi;
/** GROUP_CONCAT(DISTINCT x) → GROUP_CONCAT(x) */
const RE_GC_DIST = /GROUP_CONCAT\(\s*DISTINCT\s+([A-Za-z0-9_.]+)\s*\)/gi;
/** SUBSTRING_INDEX(x, 'd', 1) → CASE WHEN instr(x,'d')>0 THEN substr(x,1,instr(x,'d')-1) ELSE x END */
const RE_SUBSTR_IDX = /SUBSTRING_INDEX\(\s*([A-Za-z0-9_.]+)\s*,\s*'([^']{1,3})'\s*,\s*1\s*\)/gi;
/** JSON_CONTAINS(col, JSON_QUOTE(k)) → EXISTS (SELECT 1 FROM json_each(col) WHERE json_each.value = k) */
const RE_JSON_CONTAINS = /JSON_CONTAINS\(\s*([A-Za-z0-9_.]+)\s*,\s*JSON_QUOTE\(\s*([A-Za-z0-9_.]+)\s*\)\s*\)/gi;

function translateSql(sql) {
  let out = String(sql)
    .replace(RE_GC_DIST_SEP, (_, expr, sep) => `GROUP_CONCAT(${expr}, '${sep}')`)
    .replace(RE_GC_DIST_ORDER, (_, expr) => `GROUP_CONCAT(${expr})`)
    .replace(RE_GC_DIST_SEP_ONLY, (_, expr, sep) => `GROUP_CONCAT(${expr}, '${sep}')`)
    .replace(RE_GC_DIST, (_, expr) => `GROUP_CONCAT(${expr})`)
    .replace(RE_SUBSTR_IDX, (_, expr, delim) =>
      `CASE WHEN instr(${expr},'${delim}')>0 THEN substr(${expr},1,instr(${expr},'${delim}')-1) ELSE ${expr} END`)
    .replace(RE_JSON_CONTAINS, (_, col, key) =>
      `EXISTS (SELECT 1 FROM json_each(${col}) WHERE json_each.value = ${key})`)
    .replace(/IFNULL\(/g, 'COALESCE(');
  return out;
}

/** Param normalization: undefined → null; objects/arrays → JSON strings (matches mysql2's behavior for JSON columns) */
function normalizeParams(params) {
  return (params || []).map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'object' && !Buffer.isBuffer(p) && p !== null) return JSON.stringify(p);
    return p;
  });
}

/** Write-statement prefix detection (INSERT/UPDATE/DELETE/DDL etc. return impact info; the rest return rows) */
const RE_WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|BEGIN|COMMIT|ROLLBACK|VACUUM|ANALYZE|ATTACH|DETACH|REINDEX|TRUNCATE)/i;

/**
 * Create a mysql2/promise-compatible connection facade (shares the in-process single handle)
 */
async function createSqliteConnection() {
  const db = getDb();
  return {
    async query(sql, params = []) {
      const translated = translateSql(sql);
      const p = normalizeParams(params);
      if (RE_WRITE.test(translated)) {
        const info = db.prepare(translated).run(...p);
        return [{ insertId: Number(info.lastInsertRowid), affectedRows: info.changes, changedRows: info.changes }];
      }
      return [db.prepare(translated).all(...p)];
    },
    async execute(sql, params = []) {
      return this.query(sql, params);
    },
    async beginTransaction() {
      db.exec('BEGIN');
    },
    async commit() {
      db.exec('COMMIT');
    },
    async rollback() {
      db.exec('ROLLBACK');
    },
    async end() {
      // shared single handle: do not close (borrowed by callers); closing is managed
      // by resetDb / process exit
    },
  };
}

/**
 * Database status (for the db_status tool / CLI diagnostics)
 */
function dbStatus() {
  const db = getDb();
  const version = Number(db.pragma('user_version', { simple: true }));
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  return {
    driver: 'sqlite',
    dbPath: resolveDbPath(),
    schemaVersion: version,
    tableCount: tables.length,
    tables,
  };
}

module.exports = {
  SCHEMA_VERSION,
  resolveDbPath,
  ensureSchema,
  getDb,
  resetDb,
  createSqliteConnection,
  dbStatus,
  translateSql,
};
