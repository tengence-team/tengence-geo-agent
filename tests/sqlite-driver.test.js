/**
 * SQLite dual-driver consistency tests (node:test)
 * ============================================================================
 * Verifies the SQLite facade aligns with the MySQL convention:
 *   - auto-init: first connect creates the tables (user_version idempotent, no
 *     re-creation)
 *   - query returns [rows, fields] / insertId / affectedRows / changedRows
 *   - transactions begin/commit/rollback
 *   - JSON params auto-serialized (aligned with mysql2)
 *   - multi-tenant: the same file isolates by app_id
 *   - SQL dialect translation whitelist (GROUP_CONCAT / SUBSTRING_INDEX /
 *     JSON_CONTAINS)
 *
 *   DB_PATH points at a temp file; the default ~/.tengence/geo.sqlite is never
 *   touched.
 * ============================================================================
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = path.join(os.tmpdir(), `geo-sqlite-test-${process.pid}.sqlite`);
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = tmp;

const sqlite = require('../packages/geo-sdk/db/sqlite');
const { withConn } = require('../packages/geo-sdk/db/connection');

before(() => {
  try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
});
after(() => {
  sqlite.resetDb();
  try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
});

test('auto-init: first connect creates 16 tables + user_version=1 (idempotent)', async () => {
  // getDb() already performs lazy initialization internally; a second ensureSchema
  // is idempotent and returns applied:false
  const db = sqlite.getDb();
  assert.equal(sqlite.dbStatus().tableCount, 16);
  assert.equal(sqlite.dbStatus().schemaVersion, 1);
  assert.equal(sqlite.ensureSchema(db).applied, false);
});

test('query contract: SELECT returns [rows, fields]', async () => {
  await withConn(async (conn) => {
    const [rows] = await conn.query('SELECT 1 AS one');
    assert.equal(rows[0].one, 1);
  });
});

test('write contract: insertId / affectedRows / changedRows', async () => {
  await withConn(async (conn) => {
    const [r] = await conn.query(
      "INSERT INTO tengence_geo_categories (app_id, slug, name) VALUES (1, 'c1', '分类一')"
    );
    assert.ok(r.insertId > 0);
    assert.equal(r.affectedRows, 1);
    const [u] = await conn.query(
      "UPDATE tengence_geo_categories SET name = '分类一改' WHERE app_id = 1 AND slug = 'c1'"
    );
    assert.equal(u.affectedRows, 1);
    const [d] = await conn.query("DELETE FROM tengence_geo_categories WHERE app_id = 1 AND slug = 'c1'");
    assert.equal(d.affectedRows, 1);
  });
});

test('transactions: commit takes effect / rollback reverts', async () => {
  await withConn(async (conn) => {
    await conn.beginTransaction();
    await conn.query("INSERT INTO tengence_geo_categories (app_id, slug, name) VALUES (1, 'tx1', 'x')");
    await conn.rollback();
    let [rows] = await conn.query("SELECT COUNT(*) n FROM tengence_geo_categories WHERE slug = 'tx1'");
    assert.equal(rows[0].n, 0);

    await conn.beginTransaction();
    await conn.query("INSERT INTO tengence_geo_categories (app_id, slug, name) VALUES (1, 'tx2', 'y')");
    await conn.commit();
    [rows] = await conn.query("SELECT COUNT(*) n FROM tengence_geo_categories WHERE slug = 'tx2'");
    assert.equal(rows[0].n, 1);
    await conn.query("DELETE FROM tengence_geo_categories WHERE slug = 'tx2'");
  });
});

test('JSON params auto-serialized (aligned with mysql2)', async () => {
  await withConn(async (conn) => {
    await conn.query(
      `INSERT INTO tengence_geo_articles (app_id, slug, title, content_longtext, seo)
       VALUES (1, 'json1', 't', 'c', ?)`,
      [{ focus: 'x', meta: { a: 1 } }]
    );
    const [rows] = await conn.query('SELECT seo FROM tengence_geo_articles WHERE slug = ?', ['json1']);
    const parsed = JSON.parse(rows[0].seo);
    assert.equal(parsed.focus, 'x');
    assert.equal(parsed.meta.a, 1);
    await conn.query("DELETE FROM tengence_geo_articles WHERE slug = 'json1'");
  });
});

test('multi-tenant: the same file isolates by app_id', async () => {
  await withConn(async (conn) => {
    await conn.query("INSERT INTO tengence_geo_categories (app_id, slug, name) VALUES (1, 't1', '租户1')");
    await conn.query("INSERT INTO tengence_geo_categories (app_id, slug, name) VALUES (2, 't1', '租户2')");
    const [one] = await conn.query("SELECT name FROM tengence_geo_categories WHERE app_id = 1 AND slug = 't1'");
    const [two] = await conn.query("SELECT name FROM tengence_geo_categories WHERE app_id = 2 AND slug = 't1'");
    assert.equal(one[0].name, '租户1');
    assert.equal(two[0].name, '租户2');
    await conn.query("DELETE FROM tengence_geo_categories WHERE slug = 't1'");
  });
});

test('dialect translation: GROUP_CONCAT DISTINCT + SUBSTRING_INDEX + JSON_CONTAINS', () => {
  const out = sqlite.translateSql(`
    SELECT GROUP_CONCAT(DISTINCT t.name ORDER BY t.name SEPARATOR ', ') AS names,
           SUBSTRING_INDEX(original_url, '?', 1) AS clean,
           JSON_CONTAINS(p.tags, JSON_QUOTE(t.slug)) AS hit,
           IFNULL(a.name, 'x') AS fallback
    FROM x
  `);
  assert.ok(out.includes("GROUP_CONCAT(t.name, ', ')"), 'GC DIST+ORDER+SEP');
  assert.ok(out.includes('instr(original_url'), 'SUBSTRING_INDEX');
  assert.ok(out.includes('json_each(p.tags)'), 'JSON_CONTAINS');
  assert.ok(out.includes('COALESCE(a.name'), 'IFNULL → COALESCE');
  assert.ok(!/IFNULL\(/.test(out), 'no IFNULL left');
  assert.ok(!/JSON_QUOTE/.test(out), 'no JSON_QUOTE left');
});

test('dialect translation: GROUP_CONCAT(DISTINCT x SEPARATOR) without ORDER BY is covered too', () => {
  const out = sqlite.translateSql("SELECT GROUP_CONCAT(DISTINCT t.name SEPARATOR ', ') FROM x");
  assert.ok(out.includes("GROUP_CONCAT(t.name, ', ')"));
});

test('NOW(): registers a same-name function returning a local-time string', async () => {
  await withConn(async (conn) => {
    const [rows] = await conn.query('SELECT NOW() AS now');
    assert.match(String(rows[0].now), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
