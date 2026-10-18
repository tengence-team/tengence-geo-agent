/**
 * Channel publish-failure transparency
 * ============================================================================
 * Locks in the v10 change (2026-10-18): a failed multi-platform dispatch must
 * record the REAL platform rejection (e.g. Juejin err_no/err_msg, stage, cover/tags
 * context) into channel_plan error columns — instead of the generic
 * "publishToChannel returned not-ok" that used to swallow it.
 *
 * Coverage:
 *   - recordPublish persists error_code / error_message / error_stage /
 *     error_detail(+context) / failed_at and never stuffs it into notes.
 *   - normalizeRow exposes error_context (parsed) + error_raw (parsed) so
 *     channel_plan_status (and any list caller) can surface structured reasons.
 *   - string errors (legacy catch path) fall back to error_message, code null.
 *   - a successful outcome writes no error and stamps no failed_at.
 *
 * Isolation: temp DB_PATH + temp sites root; the real workspace / default sqlite
 * are never touched.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const site = require('../packages/geo-sdk/site');
const sqlite = require('../packages/geo-sdk/db/sqlite');
const t = require('../packages/geo-sdk');
const { recordPublish } = require('../packages/geo-sdk/plan/channel');
const channelPlan = require('../packages/geo-sdk/db/channel-plan');

let TMP;
let DB;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-err-env-'));
  DB = path.join(TMP, 'geo.sqlite');
  site.setSitesRoot(TMP);
  process.env.DB_DRIVER = 'sqlite';
  process.env.DB_PATH = DB;
  site.initSite({ key: 'tengence_test', domain: 'www.tengence.com' });
});

after(() => {
  sqlite.resetDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function listFailed(platform) {
  return t.db.withConn((conn) => channelPlan.list(conn, 1, { platform, status: 'failed' }));
}

test('recordPublish persists a structured platform error (object) + context', async () => {
  await t.db.withConn(async (conn) => {
    await recordPublish({
      platform: 'juejin',
      slug: 'err-obj',
      status: 'failed',
      error: { code: 2, message: '参数错误', raw: '{"err_no":2,"err_msg":"参数错误","data":null}', stage: 'publish' },
      stage: 'publish',
      context: { coverImage: 'https://cdn.example.com/c.jpg', tagIds: [123, 456] },
    });
  });
  const rows = await listFailed('juejin');
  const r = rows.find((x) => x.slug === 'err-obj');
  assert.ok(r, 'row should exist');
  assert.equal(r.status, 'failed');
  assert.equal(String(r.error_code), '2');
  assert.equal(r.error_message, '参数错误');
  assert.equal(r.error_stage, 'publish');
  // context is parsed back out of error_detail
  assert.deepEqual(r.error_context, { coverImage: 'https://cdn.example.com/c.jpg', tagIds: [123, 456] });
  // raw platform payload is preserved (string, caller can JSON.parse)
  assert.equal(JSON.parse(r.error_raw).err_no, 2);
  // failed_at is stamped on a real failure
  assert.ok(r.failed_at, 'failed_at should be stamped');
  // The original raw JSON blob must live in the structured columns (error_raw), never
  // dumped verbatim into notes (the old swallow was `error: ${String(rec.error)...}`).
  assert.ok(!(r.notes && r.notes.includes('err_no')), 'raw JSON must not be stuffed into notes');
  assert.ok(r.error_detail && r.error_detail.length > 0, 'error_detail should be non-empty');
  assert.ok(r.error_raw && r.error_raw.includes('err_no'), 'raw platform payload must be in error_raw');
});

test('recordPublish handles a legacy string error (fallback to message)', async () => {
  await t.db.withConn(async (conn) => {
    await recordPublish({ platform: 'csdn', slug: 'err-str', status: 'failed', error: 'cookie expired' });
  });
  const rows = await listFailed('csdn');
  const r = rows.find((x) => x.slug === 'err-str');
  assert.ok(r, 'row should exist');
  assert.equal(r.error_message, 'cookie expired');
  assert.equal(r.error_code, null, 'string error has no code');
  assert.ok(r.failed_at, 'failed_at should still be stamped');
});

test('a successful outcome writes no error and no failed_at', async () => {
  await t.db.withConn(async (conn) => {
    await recordPublish({ platform: 'juejin', slug: 'ok-1', status: 'published', draftId: '999' });
  });
  const rows = await t.db.withConn((conn) => channelPlan.list(conn, 1, { platform: 'juejin', slug: 'ok-1' }));
  const r = rows.find((x) => x.slug === 'ok-1');
  assert.ok(r, 'row should exist');
  assert.equal(r.error_code, null);
  assert.equal(r.error_message, null);
  assert.equal(r.failed_at, null);
  assert.equal(r.status, 'published');
});
