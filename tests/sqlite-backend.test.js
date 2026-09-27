/**
 * SQLite backend parity tests (node:test)
 * ============================================================================
 * `better-sqlite3` was moved to optionalDependencies so a plain
 * `npx -y @tengence/geo-mcp` install stays pure JS (Node's built-in node:sqlite is the
 * default). These tests guard that the two backends behave identically:
 *   - both create the same schema (18 tables, user_version=4)
 *   - both support the registered NOW() function
 *   - GEO_SQLITE_DRIVER=builtin|native is honoured
 * Each backend runs in its own child process because the driver is chosen (and the
 * handle cached) per process, and env must be set before the module is required.
 * ============================================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const driver = require('../packages/geo-sdk/db/sqlite-driver');

const SDK = path.join(__dirname, '..', 'packages/geo-sdk/db/sqlite.js');

/**
 * Open a throwaway DB in a child process and report what the backend produced.
 * @param {Record<string,string>} env extra env for the child
 */
function runChild(env) {
  const file = path.join(os.tmpdir(), `geo-backend-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
  const script = `
    process.env.DB_DRIVER = 'sqlite';
    process.env.DB_PATH = process.argv[1];
    const sqlite = require(${JSON.stringify(SDK)});
    const db = sqlite.getDb();
    const status = sqlite.dbStatus();
    db.prepare('INSERT INTO tengence_geo_categories (app_id, slug, name) VALUES (1, ?, ?)')
      .run('drv', process.env.GEO_SQLITE_DRIVER || 'auto');
    const now = db.prepare('SELECT NOW() AS n').get().n;
    console.log(JSON.stringify({
      kind: db.kind,
      tables: status.tableCount,
      schema: status.schemaVersion,
      now: String(now),
      detect: sqlite.driverInfo().kind,
    }));
  `;
  try {
    const out = execFileSync(process.execPath, ['-e', script, file], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out.trim().split('\n').pop());
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(file + suffix); } catch (_) { /* ignore */ }
    }
  }
}

test('detect(): reports a usable backend on this runtime', () => {
  const info = driver.detect();
  assert.equal(info.available, true, 'at least one SQLite backend must be available');
  assert.ok(['builtin', 'better-sqlite3'].includes(info.kind), `unexpected kind ${info.kind}`);
});

test('builtin backend (node:sqlite): schema + NOW() behave like the native one', () => {
  if (!driver.builtinAvailable()) return; // Node < 22.5: nothing to compare
  const r = runChild({ GEO_SQLITE_DRIVER: 'builtin' });
  assert.equal(r.kind, 'builtin');
  assert.equal(r.detect, 'builtin');
  assert.equal(r.tables, 18);
  assert.equal(r.schema, 4);
  assert.match(r.now, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('native backend (better-sqlite3): same schema + NOW() when installed', () => {
  if (!driver.nativeAvailable()) return; // optional dependency not installed: skip
  const r = runChild({ GEO_SQLITE_DRIVER: 'native' });
  assert.equal(r.kind, 'better-sqlite3');
  assert.equal(r.tables, 18);
  assert.equal(r.schema, 4);
  assert.match(r.now, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('default selection prefers the built-in backend when it is available', () => {
  const r = runChild({});
  assert.equal(r.kind, driver.builtinAvailable() ? 'builtin' : 'better-sqlite3');
  assert.equal(r.tables, 18);
});
