'use strict';
/**
 * Channel publish SAFETY: never burn an article, never lose a failure, never
 * silently miss a slot
 * ============================================================================
 * Three defects behind the 2026-11-07..11-11 outage (juejin/csdn published
 * nothing for 5 days):
 *
 *   1. syncStatuses judged every local row absent from the platform list as
 *      `deleted`, including rows that never reached the platform at all
 *      (no draft_id, no article_id). `deleted` ∈ NO_AUTO_RETRY ⇒ burned forever;
 *      34 rows (juejin 19 + csdn 15) died this way, ~1-3 more every day.
 *      Fix: classifyMissingRow() only declares a deletion when the row demonstrably
 *      landed before; a never-dispatched queue row becomes `failed` (retryable).
 *
 *   2. publishDue's `!pub.ok` branch returned WITHOUT persisting anything, so
 *      channel_plan carried no error and the ticker printed "1 of 1 failed".
 *      Fix: every failed result is recorded (status=failed + error_message +
 *      failed_at), which is what makes "blocked" distinguishable from "not run".
 *
 *   3. A slot whose window closed without a run is never offered again that day
 *      and leaves no trace. Fix: publishDue returns stale_slots + alerts.
 *
 * Isolation: temp SITES_ROOT + DB_PATH; no external calls (publishToChannel and
 * nextDue are stubbed), the real workspace/DB are never touched.
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
const planChannel = require('../packages/geo-sdk/plan/channel');
const syndicateChannel = require('../packages/geo-sdk/syndicate/channel');
const { classifyMissingRow } = planChannel;

let TMP;
let DB;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-channel-safety-'));
  DB = path.join(TMP, 'geo.sqlite');
  site.setSitesRoot(TMP);
  process.env.DB_DRIVER = 'sqlite';
  process.env.DB_PATH = DB;
  site.initSite({ key: 'tengence_test', domain: 'www.tengence.com' });
});

after(() => {
  sqlite.resetDb();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

beforeEach(async () => {
  await withConn(async (conn) => {
    await conn.query('DELETE FROM tengence_geo_channel_schedule');
    await conn.query('DELETE FROM tengence_geo_channel_plan');
  });
});

const at = (h, m) => new Date(2026, 9, 11, h, m, 0, 0); // 2026-10-11 local

// ==================== 1. reconcile must not burn articles ====================

test('classifyMissingRow: a queue row that never landed is failed, never deleted', () => {
  // the exact shape of the 34 burned rows: todo + empty draft_ids + empty article_id
  for (const status of ['todo', 'failed']) {
    for (const articleId of [null, '', undefined]) {
      const v = classifyMissingRow({ status, draftId: null, articleId, listLooksComplete: true });
      assert.equal(v.status, 'failed', `${status}/${String(articleId)}: must stay retryable`);
      assert.equal(v.neverSent, true);
    }
  }
});

test('classifyMissingRow: a row that DID reach the platform can still be judged deleted', () => {
  // had a platform article id, now gone → genuinely deleted by the platform
  const withArticleId = classifyMissingRow({
    status: 'published',
    draftId: null,
    articleId: '7300000000000000001',
    listLooksComplete: true,
  });
  assert.equal(withArticleId.status, 'deleted');
  assert.equal(withArticleId.neverSent, false);

  // dispatched as a draft (draft id present), now gone → deleted
  const withDraftId = classifyMissingRow({
    status: 'reviewing',
    draftId: 'draft-123',
    articleId: null,
    listLooksComplete: true,
  });
  assert.equal(withDraftId.status, 'deleted');
});

test('classifyMissingRow: an incomplete live list never declares deletions', () => {
  const v = classifyMissingRow({
    status: 'published',
    draftId: 'draft-1',
    articleId: null,
    listLooksComplete: false,
  });
  assert.equal(v.status, 'published', 'keep current status when the platform list looks truncated');
});

test('NO_AUTO_RETRY coverage: `failed` is retryable, `deleted` is terminal', () => {
  // Guard against someone "fixing" this by adding 'failed' to the terminal set,
  // which would silently re-introduce the burn (just with a different label).
  // 2026-11-13: the vocabulary moved to the single channel-state source; plan/channel
  // now does `new Set(channelState.NO_AUTO_RETRY)`.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'packages/geo-sdk/channel-state/states.js'),
    'utf8'
  );
  const m = /const NO_AUTO_RETRY = \[([^\]]+)\]/.exec(src);
  assert.ok(m, 'NO_AUTO_RETRY declaration found');
  assert.ok(m[1].includes('deleted'), 'deleted stays terminal');
  assert.ok(m[1].includes('review_failed'));
  assert.ok(!m[1].includes("'failed'"), 'failed must NOT be terminal (it is the retryable queue state)');
});

// ==================== 2. failures must land in the DB ====================

test('publishDue persists a blocked failure into channel_plan (error_message + failed_at)', async () => {
  const origNextDue = planChannel.nextDue;
  const origPublish = syndicateChannel.publishToChannel;
  planChannel.nextDue = async () => ({ platform: 'csdn', tasks: [{ slug: 'blocked-slug' }] });
  syndicateChannel.publishToChannel = async () => ({
    ok: false,
    platform: 'csdn',
    results: [
      {
        slug: 'blocked-slug',
        ok: false,
        blocked: true,
        stage: 'style_check',
        reason: '硬拦截 styleCheck 未通过（2 项）：应删除块『关于通智云』',
        errors: ['应删除块『关于通智云』', '禁止的转化链接'],
        error: { code: 'STYLE_GATE', message: '硬拦截 styleCheck 未通过（2 项）：应删除块『关于通智云』' },
      },
    ],
  });
  try {
    await t.plan.channelSchedule.set({ platform: 'csdn', publish_time: '10:00' });
    const res = await t.plan.channelSchedule.publishDue({ now: at(10, 0), siteKey: 'tengence_test' });

    assert.equal(res.results[0].status, 'failed');
    assert.equal(res.results[0].failuresLogged, 1, 'the failed article must be counted as logged');
    assert.ok(res.results[0].detail.errors.length >= 1, 'report carries the real per-article reason');

    const rows = await planChannel.list({ platform: 'csdn' });
    const hit = rows.filter((r) => r.slug === 'blocked-slug');
    assert.equal(hit.length, 1, 'the failure must create a channel_plan row');
    const row = hit[0];
    assert.equal(row.status, 'failed', 'retryable state, not deleted/draft');
    assert.equal(row.error_code, 'STYLE_GATE');
    assert.ok(String(row.error_message).includes('关于通智云'), 'the real gate reason is stored');
    assert.ok(row.failed_at, 'failed_at stamped');
    assert.ok(String(row.notes).includes('[attempt'), 'attempt timestamp recorded');

    const slot = await t.plan.channelSchedule.get(1);
    assert.equal(slot.last_run_at, null, 'a failed run must NOT advance last_run_at');
  } finally {
    planChannel.nextDue = origNextDue;
    syndicateChannel.publishToChannel = origPublish;
  }
});

// ==================== 3. a missed slot must be reported ====================

test('publishDue reports stale_slots for a slot whose window closed without running today', async () => {
  await t.plan.channelSchedule.set({ platform: 'wechat', publish_time: '08:26' });
  const res = await t.plan.channelSchedule.publishDue({ now: at(14, 0), dryRun: true });

  assert.equal(res.stale_slots.length, 1, '08:26 slot is 5.5h past its window ⇒ missed');
  const missed = res.stale_slots[0];
  assert.equal(missed.platform, 'wechat');
  assert.equal(missed.publish_time, '08:26');
  assert.ok(missed.missed_by_min >= 300, 'minutes since the slot are reported');
  assert.equal(res.alerts.length, 1);
  assert.equal(res.alerts[0].type, 'slot_missed');
  assert.ok(res.alerts[0].message.includes('漏发'));
});

test('publishDue does NOT flag a slot that already ran today, nor one still in the future', async () => {
  const ran = await t.plan.channelSchedule.set({ platform: 'wechat', publish_time: '08:26' });
  await withConn((conn) =>
    conn.query(`UPDATE tengence_geo_channel_schedule SET last_run_at='2026-10-11 08:31:00' WHERE id=${ran.id}`)
  );
  await t.plan.channelSchedule.set({ platform: 'devto', publish_time: '23:53' }); // not reached yet
  const res = await t.plan.channelSchedule.publishDue({ now: at(14, 0), dryRun: true });
  assert.deepEqual(res.stale_slots, [], 'ran-today and future slots are not misses');
});

test('the ticker renders missed slots and real failure reasons instead of "1 of 1 failed"', () => {
  const { renderReport } = require('../scripts/channel-publish-due-ticker');
  const text = renderReport(
    {
      ok: true,
      checked: 3,
      due: [{ platform: 'csdn', publish_time: '21:41' }],
      results: [
        {
          platform: 'csdn',
          publish_time: '21:41',
          status: 'failed',
          detail: {
            summary: '1 of 1 failed',
            errors: [{ slug: 'algolia-alternatives', stage: 'style_check', error: { code: 'STYLE_GATE', message: '应删除块『关于通智云』' } }],
          },
          failuresLogged: 1,
        },
      ],
      skipped_today: [],
      stale_slots: [{ platform: 'wechat', publish_time: '08:26', missed_by_min: 334, last_run_at: null }],
      alerts: [{ type: 'slot_missed', platform: 'wechat', publish_time: '08:26', message: '漏发' }],
    },
    { site: 'www_tengence_com', dryRun: false }
  ).join('\n');

  assert.ok(text.includes('应删除块『关于通智云』'), 'the real reason must be printed');
  assert.ok(!text.includes('[object Object]'), 'no raw object dumping');
  assert.ok(text.includes('失败明细已落库 channel_plan'), 'shows the failure was persisted');
  assert.ok(text.includes('漏跑 1 个槽'), 'missed slot section rendered');
  assert.ok(text.includes('WECHAT 08:26'), 'identifies which slot was missed');
});

// ============ 4. G17 闸门：隔离不合格稿，不整批否决（2026-11-11 二次根因） ============
//
// 现场证据：调度真实跑一次 → "channel_publish gate: 1 article(s) failed the
// substantive-content gate ... bi-tools-comparison"。旧实现 throw，整批中止，
// 队头只要压着一篇永久不合格的旧稿，这个槽每小时都会以同一篇失败，last_run_at
// 永不推进。以下是这条行为的回归锁。

test('markStatus accepts the retryable `failed` state (audit sync used to throw)', async () => {
  await planChannel.recordPublish({
    platform: 'csdn',
    slug: 'status-failed-probe',
    status: 'failed',
    error: { code: 'STYLE_GATE', message: 'blocked' },
    stage: 'style_check',
  });
  const probe = (await planChannel.list({ platform: 'csdn' })).find((r) => r.slug === 'status-failed-probe');
  // the exact call that failed in production: audit → markStatus(status='failed')
  await planChannel.markStatus(probe.id, 'failed');
  const rows = await planChannel.list({ platform: 'csdn' });
  const hit = rows.find((r) => r.slug === 'status-failed-probe');
  assert.ok(hit, 'row exists');
  assert.equal(hit.status, 'failed', 'failed must be an allowed channel_plan status');
});

test('applyContentGate quarantines the failing slug and keeps the rest publishable', async () => {
  const origCheck = t.check.checkArticle;
  t.check.checkArticle = async ({ slug }) => {
    if (slug === 'bad-article') {
      return {
        ok: false,
        rows: [
          ['Chinese char count (T1/T5/T6 2200–3800)', 1800, false],
          ['WP taxonomy (G19): plan category present in WP', 'missing', false],
          ['Banned words hit', '0', true],
        ],
      };
    }
    return { ok: true, rows: [] };
  };
  try {
    const gate = await syndicateChannel.applyContentGate({
      platform: 'csdn',
      slugs: ['bad-article', 'good-article'],
      siteKey: 'tengence_test',
      defaultLang: 'zh-hans',
      siteDir: t.site.loadSite('tengence_test').siteDir,
    });

    assert.deepEqual(gate.survivors, ['good-article'], 'good article survives the gate');
    assert.equal(gate.blocked.length, 1);
    assert.ok(gate.blocked[0].reason.includes('Chinese char count'), 'reason names the failing checks');

    const rows = await planChannel.list({ platform: 'csdn' });
    const bad = rows.find((r) => r.slug === 'bad-article');
    assert.ok(bad, 'quarantine writes a channel_plan row');
    assert.equal(bad.status, 'review_failed', 'quarantined, so it stops re-blocking the slot');
    assert.equal(bad.error_code, 'G17_GATE');
    assert.ok(String(bad.error_message).includes('Chinese char count'));
    assert.ok(String(bad.notes).includes('[gate]'));
    // review_failed ∈ NO_AUTO_RETRY ⇒ it leaves the queue instead of retrying forever
    assert.equal(
      planChannel.classifyMissingRow({ status: bad.status, draftId: null, articleId: null, listLooksComplete: true }).status,
      'review_failed'
    );
  } finally {
    t.check.checkArticle = origCheck;
  }
});

test('publishDue retries the next candidate when the gate blocks the head article', async () => {
  const origNextDue = planChannel.nextDue;
  const origPublish = syndicateChannel.publishToChannel;
  let calls = 0;
  planChannel.nextDue = async () => {
    calls += 1;
    return { platform: 'csdn', tasks: [{ slug: calls === 1 ? 'head-blocked' : 'retry-winner' }] };
  };
  syndicateChannel.publishToChannel = async ({ slugs }) => {
    if (slugs[0] === 'head-blocked') {
      return {
        ok: false,
        blocked: true,
        action: 'gate_blocked',
        results: [
          {
            slug: 'head-blocked',
            ok: false,
            blocked: true,
            stage: 'content_gate',
            error: { code: 'G17_GATE', message: 'Banned words hit' },
          },
        ],
      };
    }
    return { ok: true, platform: 'csdn', results: [{ slug: 'retry-winner', ok: true, published: true, url: 'https://blog.csdn.net/x/1' }] };
  };
  try {
    const slotRow = await t.plan.channelSchedule.set({ platform: 'csdn', publish_time: '10:00' });
    const res = await t.plan.channelSchedule.publishDue({ now: at(10, 0), siteKey: 'tengence_test' });

    assert.equal(calls, 2, 'the blocked head article triggers one retry with the next candidate');
    assert.equal(res.results[0].status, 'published', 'the slot still publishes something');
    assert.deepEqual(res.results[0].slugs, ['retry-winner']);
    assert.deepEqual(res.results[0].urls, ['https://blog.csdn.net/x/1']);

    const slot = await t.plan.channelSchedule.get(slotRow.id);
    assert.ok(slot.last_run_at, 'a successful retry advances last_run_at');
    const rows = await planChannel.list({ platform: 'csdn' });
    const winner = rows.find((r) => r.slug === 'retry-winner');
    assert.equal(winner.status, 'published');
  } finally {
    planChannel.nextDue = origNextDue;
    syndicateChannel.publishToChannel = origPublish;
  }
});
