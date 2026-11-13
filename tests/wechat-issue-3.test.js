/**
 * 微信「每期 3 篇 + 闸门预筛 + 改写稿优先」单测（2026-11-13）
 * ============================================================================
 * 覆盖三类行为：
 *   1. resolvePerIssue 的优先级（参数 > schedule.count > env > 3）；
 *   2. assembleIssue 的凑满语义（不合格不判死、不缩水、上限生效）；
 *   3. 渠道改写稿优先 / 草稿删除的确定性行为（文件 + 注入式 request）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const issue = require('../packages/geo-sdk/plan/wechat-issue');

test('resolvePerIssue: 参数 > schedule.count > env > 默认 3', () => {
  assert.equal(issue.resolvePerIssue({ perIssue: 5, scheduleCount: 4, env: { WECHAT_PER_ISSUE: '2' } }), 5);
  assert.equal(issue.resolvePerIssue({ scheduleCount: 4, env: { WECHAT_PER_ISSUE: '2' } }), 4);
  assert.equal(issue.resolvePerIssue({ env: { WECHAT_PER_ISSUE: '2' } }), 2);
  assert.equal(issue.resolvePerIssue({ env: {} }), 3);
  // 非法值一律回落到下一级，而不是变成 0/NaN
  assert.equal(issue.resolvePerIssue({ perIssue: 0, scheduleCount: -1, env: { WECHAT_PER_ISSUE: 'abc' } }), 3);
});

test('assembleIssue: 全部 PASS → 正好选满 3 篇，无待改写', async () => {
  const candidates = [1, 2, 3, 4, 5].map((i) => ({ slug: `s${i}`, title: `T${i}` }));
  const r = await issue.assembleIssue({ candidates, perIssue: 3, check: async () => ({ ok: true }) });
  assert.deepEqual(r.ready.map((x) => x.slug), ['s1', 's2', 's3']);
  assert.equal(r.needsRepair.length, 0);
  assert.equal(r.shortage, 0);
  assert.equal(r.tried, 3, '凑满即停，不再白跑闸门');
});

test('assembleIssue: 队头两篇 FAIL → 继续往下取，仍凑满 3 篇（不缩水）', async () => {
  const candidates = [1, 2, 3, 4, 5].map((i) => ({ slug: `s${i}`, title: `T${i}` }));
  const failing = new Set(['s1', 's2']);
  const r = await issue.assembleIssue({
    candidates,
    perIssue: 3,
    check: async (slug) => (failing.has(slug) ? { ok: false, failures: ['tag semantics'] } : { ok: true }),
  });
  assert.equal(r.ready.length, 3);
  assert.deepEqual(r.ready.map((x) => x.slug), ['s3', 's4', 's5']);
  // 不合格的两篇没有被判死，而是留在 needsRepair 里等改写
  assert.deepEqual(r.needsRepair.map((x) => x.slug), ['s1', 's2']);
  assert.deepEqual(r.needsRepair[0].failures, ['tag semantics']);
  assert.equal(r.shortage, 0);
});

test('assembleIssue: 候选耗尽且不足 → shortage 如实上报', async () => {
  const r = await issue.assembleIssue({
    candidates: [{ slug: 'a' }, { slug: 'b' }],
    perIssue: 3,
    check: async (slug) => ({ ok: slug === 'a' }),
  });
  assert.equal(r.ready.length, 1);
  assert.equal(r.shortage, 2);
});

test('assembleIssue: check 抛异常按"待改写"处理，绝不判死', async () => {
  const r = await issue.assembleIssue({
    candidates: [{ slug: 'boom' }, { slug: 'ok1' }, { slug: 'ok2' }],
    perIssue: 2,
    check: async (slug) => {
      if (slug === 'boom') throw new Error('db unavailable');
      return { ok: true };
    },
  });
  assert.deepEqual(r.ready.map((x) => x.slug), ['ok1', 'ok2']);
  assert.equal(r.needsRepair[0].slug, 'boom');
  assert.match(r.needsRepair[0].failures[0], /check error/);
});

test('assembleIssue: maxCandidates 上限生效（第 9 篇不再被考察）', async () => {
  const candidates = Array.from({ length: 12 }, (_, i) => ({ slug: `s${i}` }));
  let calls = 0;
  const r = await issue.assembleIssue({
    candidates,
    perIssue: 3,
    maxCandidates: 8,
    check: async () => {
      calls += 1;
      return { ok: false, failures: ['x'] };
    },
  });
  assert.equal(calls, 8, '只考察 8 篇就停');
  assert.equal(r.ready.length, 0);
  assert.equal(r.shortage, 3);
});

test('readRewrittenExport: 有改写稿则读回 title/正文，没有则返回 null', () => {
  const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxissue-'));
  const dir = path.join(siteDir, 'data', 'channel-export', 'wechat');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'has-rewrite.md'),
    '---\nplatform: wechat\nslug: has-rewrite\ntitle: 改写后的标题\ntags: [a]\nrewrite: harness\n---\n\n正文第一段\n',
    'utf8'
  );
  const wx = require('../packages/geo-sdk/syndicate/wechat');
  const got = wx.readRewrittenExport(siteDir, 'has-rewrite');
  assert.ok(got, '应读回改写稿');
  assert.equal(got.title, '改写后的标题');
  assert.match(got.contentMd, /正文第一段/);
  // 没有改写稿的文件 → null（回退原文）
  assert.equal(wx.readRewrittenExport(siteDir, 'no-such-slug'), null);
});

test('deleteDraft: dryRun 不调用接口；真删走 draft/delete 并透出微信错误', async () => {
  const wx = require('../packages/geo-sdk/syndicate/wechat');
  const dry = await wx.deleteDraft('MID_1', { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.match(dry.payload, /MID_1/);

  const calls = [];
  const reqOk = async (url, _opts, body) => {
    calls.push({ url, body });
    return { json: { errcode: 0, errmsg: 'ok' } };
  };
  const okRes = await wx.deleteDraft('MID_2', { request: reqOk, accessToken: 'TOKEN' });
  assert.equal(okRes.ok, true);
  assert.match(calls[0].url, /draft\/delete/);
  assert.match(calls[0].url, /access_token=TOKEN/);
  assert.match(calls[0].body, /MID_2/);

  const reqFail = async () => ({ json: { errcode: 40007, errmsg: 'invalid media_id' } });
  await assert.rejects(() => wx.deleteDraft('MID_3', { request: reqFail, accessToken: 'TOKEN' }), /40007/);
});

test('applyContentGate: 有改写稿时用改写稿校验，通过则不隔离', async () => {
  const channel = require('../packages/geo-sdk/syndicate/channel');
  const seen = [];
  const gate = await channel.applyContentGate({
    platform: 'wechat',
    slugs: ['fixed-by-rewrite', 'still-bad'],
    siteKey: 'tengence_test',
    defaultLang: 'zh-hans',
    siteDir: os.tmpdir(),
    rewritten: { 'fixed-by-rewrite': { title: '改写标题', contentMd: '改写后的正文' } },
    // 注入 checker：只有拿到改写稿的那篇才算合格
    check: async ({ slug, overrides }) => {
      seen.push({ slug, hasOverride: !!overrides });
      return { ok: !!(overrides && overrides.contentMd), rows: [] };
    },
  });
  assert.deepEqual(gate.survivors, ['fixed-by-rewrite']);
  assert.deepEqual(gate.blocked.map((x) => x.slug), ['still-bad']);
  const fixed = seen.find((x) => x.slug === 'fixed-by-rewrite');
  assert.equal(fixed.hasOverride, true, '闸门必须校验改写稿而不是 DB 原文');
});
