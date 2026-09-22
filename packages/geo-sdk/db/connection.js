/**
 * Database connection helper (dual driver: mysql | sqlite)
 * ============================================================================
 * Open-source refactor (2026-09-21):
 *   - Added the `DB_DRIVER` env var: 'sqlite' (default, works out of the box,
 *     single-file multi-tenant) | 'mysql' (production).
 *   - sqlite driver: a better-sqlite3 facade (db/sqlite.js) whose interface is
 *     compatible with mysql2/promise (query → [rows, fields], insertId/affectedRows,
 *     beginTransaction/commit/rollback/end).
 *   - Lazy require: mysql2 loads only when driver=mysql (zero MySQL dependency
 *     overhead in sqlite scenarios).
 *
 * Conventions:
 *   - In mysql mode, DB_* all come from <sites>/<site>/.env (injected into
 *     process.env by site/config.js's loadSite); this module does not load .env itself.
 *   - In sqlite mode: DB_PATH defaults to ~/.tengence/geo.sqlite; with
 *     DB_DRIVER=sqlite the schema is auto-initialized on first connect (idempotent,
 *     see db/sqlite.js ensureSchema).
 *
 * Usage:
 *   const { withConn } = require('../db/connection');
 *   const rows = await withConn(async (conn) => (await conn.query(sql, args))[0]);
 * ============================================================================
 */

/** Current driver (DB_DRIVER=sqlite default; explicit mysql goes to MySQL) */
function driver() {
  const v = (process.env.DB_DRIVER || 'sqlite').toLowerCase();
  return v === 'mysql' ? 'mysql' : 'sqlite';
}

/**
 * Assemble MySQL connection params from process.env
 * @param {Object} [overrides] override entries (e.g. database, multipleStatements)
 */
function configFromEnv(overrides = {}) {
  return {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    ...overrides,
  };
}

/** Open a new connection (caller is responsible for end()); driver decided by DB_DRIVER */
async function createConnection(overrides = {}) {
  if (driver() === 'sqlite') {
    // sqlite facade: lazy require, avoids loading mysql2 in sqlite scenarios
    const sqlite = require('./sqlite');
    return sqlite.createSqliteConnection(overrides);
  }
  const mysql = require('mysql2/promise');
  return mysql.createConnection(configFromEnv(overrides));
}

/**
 * Borrow a connection, run fn, auto-close afterwards (also closes on error)
 * @template T
 * @param {(conn: import('mysql2/promise').Connection | Object) => Promise<T>} fn
 * @param {Object} [overrides]
 * @returns {Promise<T>}
 */
async function withConn(fn, overrides = {}) {
  const conn = await createConnection(overrides);
  try {
    return await fn(conn);
  } finally {
    await conn.end();
  }
}

module.exports = { driver, configFromEnv, createConnection, withConn };
