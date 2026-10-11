/**
 * channel_schedule: scheduling-rule table + unified auto-publish executor
 * ============================================================================
 * Locks in the v8 scheduling design:
 *   - repo (db/channel-schedule): set upsert by (platform, publish_time),
 *     list/get/del, markLastRun day-stamp, "HH:MM" validation
 *   - service (plan/channel-schedule): list/get/set/del passthrough +
 *     publishDue() — fires slots within ±FIRE_WINDOW_MIN of `now` that have not
 *     run today, publishes through the SAME pipeline as channel_publish
 *     (dryRun: no external calls, no writes), and only stamps last_run_at on a
 *     real (non-dryRun) outcome.
 *
 * Isolation: setSitesRoot + DB_PATH point at a temp dir; the real workspace and
 * the default ~/.tengence/geo-mcp/geo.sqlite are never touched.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const site = require('../packages/geo-sdk/site');
const sqlite = require('../packages/geo-sdk/db/sqlite');
const t = require('../packages/geo-sdk');
const { withConn } = require('../packages/geo-sdk/db/connection');
const scheduleRepo = require('../packages/geo-sdk/db/channel-schedule');
const { FIRE_WINDOW_MIN } = require('../packages/geo-sdk/plan/channel-schedule');

let TMP;
let DB;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-ch-sched-'));
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

/** Each test starts from an empty schedule table (tests share one temp DB). */
beforeEach(async () => {
  await withConn(async (conn) => {
    await conn.query('DELETE FROM tengence_geo_channel_schedule');
    await conn.query('DELETE FROM tengence_geo_channel_plan'); // publishDue registers todo rows
  });
});

const at = (h, m) => new Date(2026, 9, 11, h, m, 0, 0); // 2026-10-11 local

/** Seed one blog-published article (plan + articles rows) so nextDue has a candidate. */
async function seedArticle(slug, { title = slug, lang = 'zh-hans', order = 1 } = {}) {
  await withConn(async (conn) => {
    await conn.query(
      `INSERT INTO tengence_geo_articles (app_id, slug, title, lang, content_longtext, target_keywords, status)
       VALUES (1, ?, ?, ?, ?, ?, 'publish')`,
      [slug, title, lang, `# ${title}\nbody text`, 'geo,seo']
    );
  });
  await t.plan.upsert({ slug, plan_status: 'published', publish_order: order, title }, { lang });
}

// ==================== repo / CRUD ====================

test('schedule: set upserts by (platform, publish_time)', async () => {
  const cs = t.plan.channelSchedule;
  const a = await cs.set({ platform: 'csdn', publish_time: '10:35', count: 1 });
  assert.equal(a.action, 'insert');
  const b = await cs.set({ platform: 'csdn', publish_time: '10:35', count: 2, enabled: 0 });
  assert.equal(b.action, 'update');
  assert.equal(b.row.count, 2);
  assert.equal(b.row.enabled, 0);
  const all = await cs.list();
  assert.equal(all.length, 1, 'upsert must not duplicate the slot');
});

test('schedule: publish_time must be zero-padded HH:MM', async () => {
  await assert.rejects(t.plan.channelSchedule.set({ platform: 'csdn', publish_time: '10:5' }), /HH:MM/);
  await assert.rejects(t.plan.channelSchedule.set({ platform: 'csdn', publish_time: '25:00' }), /HH:MM/);
  await assert.rejects(t.plan.channelSchedule.set({ platform: 'csdn', publish_time: '10:65' }), /HH:MM/);
  await assert.rejects(scheduleRepo.set(null, 1, { platform: 'csdn', publish_time: '10:60' }), /HH:MM/);
});

test('schedule: count must be a positive integer (default 1)', async () => {
  await assert.rejects(t.plan.channelSchedule.set({ platform: 'juejin', publish_time: '15:20', count: 0 }), /positive integer/);
  await assert.rejects(t.plan.channelSchedule.set({ platform: 'juejin', publish_time: '15:20', count: 1.5 }), /positive integer/);
  const a = await t.plan.channelSchedule.set({ platform: 'juejin', publish_time: '15:20' });
  assert.equal(a.row.count, 1);
});

test('schedule: list filters by platform / enabled', async () => {
  await t.plan.channelSchedule.set({ platform: 'csdn', publish_time: '10:35', count: 1 });
  await t.plan.channelSchedule.set({ platform: 'juejin', publish_time: '15:20' });
  await t.plan.channelSchedule.set({ platform: 'wechat', publish_time: '08:26', count: 2 });
  await t.plan.channelSchedule.set({ platform: 'devto', publish_time: '09:38', enabled: 0 });
  const all = await t.plan.channelSchedule.list();
  assert.equal(all.length, 4);
  const wechat = await t.plan.channelSchedule.list({ platform: 'wechat' });
  assert.equal(wechat.length, 1);
  assert.equal(wechat[0].count, 2);
  const active = await t.plan.channelSchedule.list({ enabled: 1 });
  assert.equal(active.length, 3);
});

test('schedule: getById / del by id / del by key / markLastRun', async () => {
  const cs = t.plan.channelSchedule;
  const a = await cs.set({ platform: 'tencent', publish_time: '14:45' });
  const got = await cs.get(a.id);
  assert.equal(got.platform, 'tencent');

  await withConn(async (conn) => {
    await scheduleRepo.markLastRun(conn, 1, a.id, '2026-10-11 14:45:00');
  });
  const stamped = await cs.get(a.id);
  assert.equal(stamped.last_run_at, '2026-10-11 14:45:00');

  const delKey = await cs.del({ platform: 'tencent', publish_time: '14:45' });
  assert.equal(delKey.deleted, 1);

  const b = await cs.set({ platform: 'tencent', publish_time: '16:58' });
  const delId = await cs.del({ id: b.id });
  assert.equal(delId.deleted, 1);
  assert.equal((await cs.list({ platform: 'tencent' })).length, 0);
});

// ==================== publishDue ====================

test('publishDue fires slots within ±FIRE_WINDOW_MIN of now', async () => {
  const cs = t.plan.channelSchedule;
  await cs.set({ platform: 'csdn', publish_time: '10:35' }); // 10:30 → 5 min → due
  await cs.set({ platform: 'juejin', publish_time: '10:35' }); // same window → due
  await cs.set({ platform: 'wechat', publish_time: '23:00' }); // far away → not due
  const res = await cs.publishDue({ now: at(10, 30), dryRun: true });
  assert.equal(res.checked, 3);
  assert.equal(res.due.length, 2);
  assert.deepEqual(res.due.map((d) => d.platform).sort(), ['csdn', 'juejin']);
  assert.equal(FIRE_WINDOW_MIN, 30, 'hourly Doubao ticker ⇒ ±30 min covers every HH:MM');
  // merged audit step ①: dryRun must NOT call the platforms and reports the skip
  assert.deepEqual(res.audit, { skipped: 'dry_run' });
});

test('publishDue audit step ①: real run reports per-platform audit sync (network-free path)', async () => {
  // With no site env injected, syncStatuses fails fast per platform and publishDue
  // must surface it as audit.<platform>.error instead of blocking the publish loop.
  const cs = t.plan.channelSchedule;
  await cs.set({ platform: 'csdn', publish_time: '10:35' });
  const res = await cs.publishDue({ now: at(10, 30), dryRun: false });
  assert.equal(typeof res.audit, 'object');
  assert.ok('juejin' in res.audit && 'csdn' in res.audit, 'audit report must include both platforms');
  for (const p of ['juejin', 'csdn']) {
    assert.equal(res.audit[p].ok, false, `${p} audit must fail fast without site env`);
    assert.ok(res.audit[p].error, `${p} audit error message present`);
  }
  assert.equal(res.results.length, 1, 'publish loop still runs after audit failure');
  assert.equal(res.results[0].status, 'no_due_articles', 'queue empty ⇒ publish loop completes normally');
});

test('publishDue boundary: exactly ±FIRE_WINDOW_MIN fires, 1 min past does not', async () => {
  const cs = t.plan.channelSchedule;
  await cs.set({ platform: 'csdn', publish_time: '10:35' });
  const edge = await cs.publishDue({ now: at(11, 5), dryRun: true }); // diff = 30 → due
  assert.equal(edge.due.length, 1);
  const over = await cs.publishDue({ now: at(11, 6), dryRun: true }); // diff = 31 → not due
  assert.equal(over.due.length, 0);
});

test('publishDue skips disabled slots and slots that already ran today', async () => {
  const cs = t.plan.channelSchedule;
  await cs.set({ platform: 'devto', publish_time: '10:35', enabled: 0 });
  const paused = await cs.publishDue({ now: at(10, 30), dryRun: true });
  assert.equal(paused.due.length, 0);

  const c = await cs.set({ platform: 'aliyun', publish_time: '10:35' });
  await withConn(async (conn) => {
    await conn.query(
      `UPDATE tengence_geo_channel_schedule SET last_run_at = '2026-10-11 09:00:00' WHERE id = ?`,
      [c.id]
    );
  });
  const ran = await cs.publishDue({ now: at(10, 30), dryRun: true });
  assert.equal(ran.due.length, 0, 'already ran today ⇒ must not fire again');
  assert.equal(ran.skipped_today.length, 1);
});

test('publishDue: no_due_articles when the platform queue is empty', async () => {
  const cs = t.plan.channelSchedule;
  await cs.set({ platform: 'csdn', publish_time: '10:35' });
  const res = await cs.publishDue({ now: at(10, 30), dryRun: true });
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].status, 'no_due_articles');
});

test('publishDue dry-run full pipeline: fires a csdn slot with one article, no writes', async () => {
  await seedArticle('schedule-test-a', { title: 'Schedule Test A', order: 1 });
  const cs = t.plan.channelSchedule;
  await cs.set({ platform: 'csdn', publish_time: '10:35', count: 1 });
  const res = await cs.publishDue({ now: at(10, 30), dryRun: true, siteKey: 'tengence_test' });
  assert.equal(res.due.length, 1);
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].platform, 'csdn');
  assert.equal(res.results[0].status, 'dry_run');
  // dryRun must NOT stamp last_run_at and must NOT create a channel_plan row
  const rows = await t.plan.channel.list({ platform: 'csdn' });
  assert.equal(rows.length, 0, 'dryRun must not write channel_plan');
  const slot = await cs.list({ platform: 'csdn' });
  assert.equal(slot[0].last_run_at, null, 'dryRun must not stamp last_run_at');
});

test('publishDue dry-run full pipeline: wechat stays draft-box mode (asDraft)', async () => {
  await seedArticle('schedule-test-w', { title: 'Schedule Test W', order: 2 });
  const cs = t.plan.channelSchedule;
  await cs.set({ platform: 'wechat', publish_time: '08:26', count: 2 });
  const res = await cs.publishDue({ now: at(8, 20), dryRun: true, siteKey: 'tengence_test' });
  assert.equal(res.due.length, 1);
  assert.equal(res.results[0].asDraft, true, 'wechat must never auto-send');
  assert.equal(res.results[0].status, 'dry_run');
});

// ==================== audit 审核检查（plan A 合流） ====================

test('repo.appendNotes preserves existing notes (audit reason / stale flags)', async () => {
  const planRepo = require('../packages/geo-sdk/db/channel-plan');
  await t.plan.channel.recordPublish({
    platform: 'csdn', slug: 'append-notes-test', title: 'Append Notes Test', status: 'draft',
  });
  let row;
  await withConn(async (conn) => {
    const rows = await planRepo.list(conn, 1, { platform: 'csdn' });
    row = rows.find((r) => r.slug === 'append-notes-test');
    assert.ok(row, 'row exists');
    await planRepo.appendNotes(conn, 1, row.id, '审核未通过（CSDN），原因请查看后台');
    await planRepo.appendNotes(conn, 1, row.id, '审核超时 >24h 未定论');
  });
  await withConn(async (conn) => {
    const rows = await planRepo.list(conn, 1, { platform: 'csdn' });
    const final = rows.find((r) => r.slug === 'append-notes-test');
    assert.ok(final.notes.includes('审核未通过'), 'first note preserved');
    assert.ok(final.notes.includes('审核超时 >24h'), 'second note appended');
    assert.ok(final.notes.indexOf('审核未通过') < final.notes.indexOf('审核超时'), 'notes keep order');
  });
});

