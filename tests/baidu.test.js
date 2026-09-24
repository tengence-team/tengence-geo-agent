/**
 * search/baidu — adaptive batch-splitting submission tests (node:test, zero
 * deps, no network)
 * ============================================================================
 * Added 2026-09-22: --all no longer fails a whole batch on "over quota"; it
 * splits and retries by today's remaining quota. Background: the publish
 * pipeline (publish-from-db) consumes the daily quota with single pushes first,
 * so a fixed-limit scheduled batch is guaranteed to exceed it and waste the
 * batch. These tests inject a fake submit to lock the split semantics; no real
 * requests are made.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const baidu = require('../packages/geo-sdk/search/baidu');

/** Build a temp log file (cleaned up by the test run) */
function mkLog(entries) {
  const p = path.join(os.tmpdir(), `baidu-test-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
}

function makeStats() {
  return { ok: 0, fail: 0, batches: [] };
}

const urls10 = Array.from({ length: 10 }, (_, i) => `https://www.tengence.com/blog/article/slug-${i}/`);

test('quota full → one whole batch succeeds, exactly 1 request', async () => {
  const log = mkLog([]);
  const stats = makeStats();
  let calls = 0;
  await baidu.submitBatchAdaptive(urls10, {
    token: 't', site: 'www.tengence.com', logPath: log, batchNo: 1, stats,
    submit: async (list) => { calls++; return { httpStatus: 200, success: list.length, remain: 0 }; },
  });
  assert.equal(stats.ok, 10);
  assert.equal(stats.fail, 0);
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'log has exactly 1 success line');
});

test('log says same-day remain=9 (publish pipeline used 1) → 9 succeed on the 1st try, 1 leftover fails', async () => {
  const log = mkLog([
    { ts: new Date().toISOString(), action: 'submit', batch: 1, ok: true, detail: { httpStatus: 200, success: 1, remain: 9 }, urls: [urls10[0]] },
  ]);
  const stats = makeStats();
  let calls = 0;
  await baidu.submitBatchAdaptive(urls10, {
    token: 't', site: 'www.tengence.com', logPath: log, batchNo: 1, stats,
    submit: async (list) => {
      calls++;
      if (list.length > 9) throw new Error('Baidu API error 400: over quota');
      return { httpStatus: 200, success: list.length, remain: 9 - list.length };
    },
  });
  assert.equal(stats.ok, 9);
  assert.equal(stats.fail, 1);
  assert.equal(calls, 1, 'split by quota up front, no whole-batch collision');
});

test('no log, actual quota 5 → full batch fails, halve to 5 which succeed, 5 leftover fail', async () => {
  const log = mkLog([]);
  const stats = makeStats();
  const calls = [];
  await baidu.submitBatchAdaptive(urls10, {
    token: 't', site: 'www.tengence.com', logPath: log, batchNo: 1, stats,
    submit: async (list) => {
      calls.push(list.length);
      if (list.length > 5) throw new Error('Baidu API error 400: over quota');
      return { httpStatus: 200, success: list.length, remain: 5 - list.length };
    },
  });
  assert.equal(stats.ok, 5);
  assert.equal(stats.fail, 5);
  assert.deepEqual(calls, [10, 5]);
});

test('no log, actual quota 9 → halve to 5 succeed, continue with remain=4, 1 leftover fails', async () => {
  const log = mkLog([]);
  const stats = makeStats();
  const calls = [];
  let used = 0;
  await baidu.submitBatchAdaptive(urls10, {
    token: 't', site: 'www.tengence.com', logPath: log, batchNo: 1, stats,
    submit: async (list) => {
      calls.push(list.length);
      if (list.length > 9 - used) throw new Error('Baidu API error 400: over quota');
      used += list.length;
      return { httpStatus: 200, success: list.length, remain: 9 - used };
    },
  });
  assert.equal(stats.ok, 9);
  assert.equal(stats.fail, 1);
  assert.deepEqual(calls, [10, 5, 4]);
});

test('non over-quota error (bad token) → whole batch fails, no split', async () => {
  const log = mkLog([]);
  const stats = makeStats();
  let calls = 0;
  await baidu.submitBatchAdaptive(urls10, {
    token: 't', site: 'www.tengence.com', logPath: log, batchNo: 1, stats,
    submit: async () => { calls++; throw new Error('Baidu API error 401: token is not valid'); },
  });
  assert.equal(stats.ok, 0);
  assert.equal(stats.fail, 10);
  assert.equal(calls, 1);
});

test('lastRemainToday: latest same-day success remain; non-same-day / no record → null', () => {
  const now = new Date();
  const todayIso = now.toISOString();
  // yesterday (Beijing): current UTC minus 24h is guaranteed to land on yesterday Beijing time
  const yesterdayIso = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const log = mkLog([
    { ts: yesterdayIso, action: 'submit', batch: 1, ok: true, detail: { httpStatus: 200, success: 1, remain: 5 }, urls: [] },
    { ts: todayIso, action: 'submit', batch: 1, ok: true, detail: { httpStatus: 200, success: 1, remain: 9 }, urls: [] },
    { ts: todayIso, action: 'submit', batch: 1, ok: false, error: 'Baidu API error 400: over quota', urls: [] },
  ]);
  assert.equal(baidu.lastRemainToday(log), 9, 'take the latest same-day success remain, ignore failures');
  assert.equal(baidu.lastRemainToday(mkLog([{ ts: yesterdayIso, action: 'submit', batch: 1, ok: true, detail: { httpStatus: 200, success: 1, remain: 5 }, urls: [] }])), null, 'only-yesterday record → null (today quota unknown)');
  assert.equal(baidu.lastRemainToday(mkLog([])), null, 'empty log → null');
});
