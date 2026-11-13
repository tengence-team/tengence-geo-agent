/**
 * channel-state — unit tests (node:test, no real database)
 * ============================================================================
 * Pins the contract of the single channel status entry point:
 *   - the 8×8 transition matrix (legal moves pass, illegal ones throw)
 *   - `published` is terminal; `deleted -> todo` is the only exit and needs a reason
 *   - deleted / review_failed always need a reason (they hide or revive content)
 *   - record(): creating a row may stamp any legal status, updating an existing row
 *     routes a differing status through setState instead of writing it directly
 * ============================================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const cs = require('../packages/geo-sdk/channel-state');
const states = require('../packages/geo-sdk/channel-state/states');

/** Stub connection: one channel_plan row; records every SQL statement. */
function makeStub({ row = null } = {}) {
  const calls = [];
  const stub = {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/^\s*(UPDATE|INSERT)/i.test(sql)) return [{ affectedRows: 1, insertId: 1 }];
      if (/FROM\s+tengence_geo_channel_plan/i.test(sql)) return [row ? [{ ...row }] : []];
      return [[]];
    },
  };
  return stub;
}

const row = (over = {}) => ({
  id: 253,
  platform: 'wechat',
  slug: 'b2b-lead-gen-ai-search-funnel',
  lang: 'zh-hans',
  period: '第39期',
  status: 'draft',
  draft_ids: '["STla8_i3I98CjiyYKHqvT_H9ZTaXBC3saGzt0ysCVSn8ya_lLejJGgihuH"]',
  article_id: null,
  notes: null,
  created_at: '2026-11-13 16:53:30',
  updated_at: '2026-11-13 16:53:30',
  ...over,
});

// ------------------------------------------------------------------ matrix

test('matrix: all 8 states are known and self-transitions are allowed', () => {
  assert.equal(states.ALL.length, 8);
  for (const s of states.ALL) {
    assert.equal(states.isState(s), true, `${s} must be known`);
    assert.equal(states.canTransition(s, s), true, `${s} -> ${s} must be allowed (idempotent)`);
  }
});

test('matrix: unknown values are rejected (this is how "blocked" got in)', () => {
  assert.equal(states.isState('blocked'), false);
  assert.equal(states.canTransition('draft', 'blocked'), false);
  assert.equal(states.canTransition('blocked', 'draft'), false);
});

test('matrix: the happy path holds', () => {
  assert.equal(states.canTransition('todo', 'draft'), true);
  assert.equal(states.canTransition('draft', 'published'), true);
  assert.equal(states.canTransition('draft', 'reviewing'), true);
  assert.equal(states.canTransition('reviewing', 'published'), true);
  assert.equal(states.canTransition('reviewing', 'review_failed'), true);
  assert.equal(states.canTransition('failed', 'todo'), true);
  assert.equal(states.canTransition('review_failed', 'todo'), true);
  assert.equal(states.canTransition('paused', 'todo'), true);
});

test('matrix: published is terminal — nothing may leave it', () => {
  for (const to of states.ALL) {
    if (to === 'published') continue;
    assert.equal(states.canTransition('published', to), false, `published -> ${to} must be refused`);
  }
});

test('matrix: deleted has exactly one exit (todo)', () => {
  for (const to of states.ALL) {
    if (to === 'deleted' || to === 'todo') continue;
    assert.equal(states.canTransition('deleted', to), false, `deleted -> ${to} must be refused`);
  }
  assert.equal(states.canTransition('deleted', 'todo'), true);
});

test('matrix: draft may not skip straight back to the queue or to a retry', () => {
  assert.equal(states.canTransition('draft', 'todo'), false);
  assert.equal(states.canTransition('draft', 'review_failed'), false);
});

test('reason rule: hiding or reviving content requires an explanation', () => {
  assert.equal(states.reasonRequired('draft', 'deleted'), true);
  assert.equal(states.reasonRequired('reviewing', 'review_failed'), true);
  assert.equal(states.reasonRequired('deleted', 'todo'), true);
  assert.equal(states.reasonRequired('draft', 'published'), false);
  assert.equal(states.reasonRequired('todo', 'draft'), false);
});

test('dispatched semantics: wechat counts a draft as dispatched, juejin does not', () => {
  assert.equal(states.isDispatched('wechat', 'draft'), true);
  assert.equal(states.isDispatched('wechat', 'published'), true);
  assert.equal(states.isDispatched('juejin', 'draft'), false);
  assert.equal(states.isDispatched('juejin', 'reviewing'), true);
});

test('terminal semantics for the auto-picker', () => {
  for (const s of ['review_failed', 'deleted', 'paused', 'draft']) {
    assert.equal(states.isNoAutoRetry(s), true, `${s} must never be auto-re-picked`);
  }
  assert.equal(states.isNoAutoRetry('todo'), false);
  assert.equal(states.isNoAutoRetry('published'), false);
});

// ---------------------------------------------------------------- setState

test('setState: legal move writes the status and keeps the media ids', async () => {
  const conn = makeStub({ row: row({ status: 'reviewing', draft_ids: '[]' }) });
  const out = await cs.setState({ appId: 1, id: 253, to: 'published', draftIds: ['m1'], conn });
  assert.equal(out.from, 'reviewing');
  assert.equal(out.to, 'published');
  assert.equal(out.changed, true);
  const update = conn.calls.find((c) => /UPDATE/i.test(c.sql));
  assert.ok(update, 'an UPDATE must be issued');
  assert.equal(update.params[0], 'published');
  assert.deepEqual(update.params[1], JSON.stringify(['m1']));
});

test('setState: illegal move throws E_INVALID_TRANSITION and writes nothing', async () => {
  const conn = makeStub({ row: row({ status: 'published' }) });
  await assert.rejects(
    () => cs.setState({ appId: 1, id: 253, to: 'todo', conn }),
    (e) => e.code === 'E_INVALID_TRANSITION'
  );
  assert.equal(conn.calls.filter((c) => /UPDATE/i.test(c.sql)).length, 0);
});

test('setState: unknown target throws E_INVALID_STATE', async () => {
  const conn = makeStub({ row: row() });
  await assert.rejects(() => cs.setState({ appId: 1, id: 253, to: 'blocked', conn }), (e) => e.code === 'E_INVALID_STATE');
});

test('setState: deleted -> todo without a reason is refused', async () => {
  const conn = makeStub({ row: row({ status: 'deleted' }) });
  await assert.rejects(() => cs.setState({ appId: 1, id: 253, to: 'todo', conn }), (e) => e.code === 'E_REASON_REQUIRED');
});

test('setState: deleted -> todo WITH a reason succeeds and leaves a note trail', async () => {
  const conn = makeStub({ row: row({ status: 'deleted' }) });
  const out = await cs.setState({ appId: 1, id: 253, to: 'todo', reason: '确认从未发出，退回队列', conn });
  assert.equal(out.to, 'todo');
  const note = conn.calls.find((c) => /notes/i.test(c.sql) || /appendNotes|notes =/i.test(c.sql));
  assert.ok(conn.calls.some((c) => String(c.params && c.params.join(' ')).includes('确认从未发出')));
});

test('setState: missing row throws E_NOT_FOUND', async () => {
  const conn = makeStub({ row: null });
  await assert.rejects(() => cs.setState({ appId: 1, id: 999, to: 'todo', conn }), (e) => e.code === 'E_NOT_FOUND');
});

test('setState: idempotent re-apply reports changed=false', async () => {
  const conn = makeStub({ row: row({ status: 'published' }) });
  const out = await cs.setState({ appId: 1, id: 253, to: 'published', conn });
  assert.equal(out.changed, false);
});

// ------------------------------------------------------------------ record

test('record: a brand-new row may be created directly in its status (creation is not a transition)', async () => {
  const conn = makeStub({ row: null });
  const out = await cs.record({ appId: 1, platform: 'wechat', slug: 'new-slug', status: 'draft', conn });
  assert.equal(out.action, 'insert');
  assert.equal(out.to, 'draft');
  const insert = conn.calls.find((c) => /INSERT/i.test(c.sql));
  assert.ok(insert);
});

test('record: updating an existing row routes a differing status through setState', async () => {
  const conn = makeStub({ row: row({ status: 'draft' }) });
  const out = await cs.record({ appId: 1, platform: 'wechat', slug: row().slug, status: 'published', conn });
  assert.equal(out.action, 'update');
  assert.equal(out.to, 'published');
});

test('record: an illegal transition on update still throws (no silent bypass)', async () => {
  const conn = makeStub({ row: row({ status: 'published' }) });
  await assert.rejects(
    () => cs.record({ appId: 1, platform: 'wechat', slug: row().slug, status: 'todo', conn }),
    (e) => e.code === 'E_INVALID_TRANSITION'
  );
});

// ------------------------------------------------------------------- audit

test('audit: reports draft rows with no media id and queue rows still holding one', async () => {
  const rows = [
    { id: 1, platform: 'wechat', slug: 'a', lang: 'zh-hans', status: 'draft', draft_ids: '[]', period: '第40期' },
    { id: 2, platform: 'wechat', slug: 'b', lang: 'zh-hans', status: 'published', draft_ids: '[]', period: '第4期' },
    { id: 3, platform: 'wechat', slug: 'c', lang: 'zh-hans', status: 'todo', draft_ids: '["m"]', period: null },
    { id: 4, platform: 'wechat', slug: 'd', lang: 'zh-hans', status: 'blocked', draft_ids: '[]', period: null },
    { id: 5, platform: 'wechat', slug: 'e', lang: 'zh-hans', status: 'draft', draft_ids: '["m2"]', period: null },
  ];
  const conn = { query: async () => [rows] };
  const report = await cs.audit({ appId: 1, conn });
  assert.equal(report.counts.invalidStatus, 1);
  assert.equal(report.counts.draftWithoutMedia, 1);
  assert.equal(report.counts.publishedWithoutMedia, 1);
  assert.equal(report.counts.queueWithMedia, 1);
  assert.equal(report.counts.draftWithoutPeriod, 1);
});
