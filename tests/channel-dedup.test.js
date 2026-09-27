/**
 * Channel-agnostic publish dedup (filterUnpublished + publishFromSlugs/exportArticles)
 * ============================================================================
 * Locks in the SINGLE, per-platform slug dedup so a slug already marked
 * `published` on a platform is never re-sent — for WeChat, Juejin, Devto, Mode A
 * and Mode B alike. The logic lives in exactly one function (plan/channel.js →
 * filterUnpublished) and is invoked once at the top of every publish entry point.
 *
 * Keyed STRICTLY by slug against the local channel_plan publish log; no external
 * API calls, no title matching. `draft` rows are NOT skipped (a draft may not
 * have been mass-sent yet, and skipping it would drop an article on a re-run).
 *
 * Isolation: temp SITES_ROOT + DB_PATH; the real workspace is never touched.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const site = require('../packages/geo-sdk/site');
const sqlite = require('../packages/geo-sdk/db/sqlite');
const { withConn } = require('../packages/geo-sdk/db/connection');
const t = require('../packages/geo-sdk');
const { filterUnpublished } = require('../packages/geo-sdk/plan/channel');

let TMP;
let DB;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-dedup-'));
  DB = path.join(TMP, 'geo.sqlite');
  site.setSitesRoot(TMP);
  process.env.DB_DRIVER = 'sqlite';
  process.env.DB_PATH = DB;
  site.initSite({ key: 'tengence_test', domain: 'www.tengence.com' });
  sqlite.getDb();
});

after(() => {
  sqlite.resetDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function insertPlanRow({ platform, status, slugs }) {
  let id;
  await withConn(async (conn) => {
    const [r] = await conn.query(
      `INSERT INTO tengence_geo_channel_plan
         (app_id, platform, period, topic, weekday, status, article_slugs, draft_ids)
       VALUES (1, ?, '测试期', '测试主题', '周二', ?, ?, ?)`,
      [platform, status, JSON.stringify(slugs), JSON.stringify([])]
    );
    id = r.insertId;
  });
  return id;
}

async function deletePlanRow(id) {
  await withConn(async (conn) => {
    await conn.query('DELETE FROM tengence_geo_channel_plan WHERE id = ?', [id]);
  });
}

// ==================== filterUnpublished (pure unit) ====================

test('filterUnpublished: drops published slugs, keeps the rest', async () => {
  const id = await insertPlanRow({ platform: 'wechat', status: 'published', slugs: ['already-out', 'also-out'] });
  try {
    const { toPublish, skipped } = await filterUnpublished('wechat', [
      'already-out',
      'fresh',
      'also-out',
      'another-fresh',
    ]);
    assert.deepEqual(skipped.sort(), ['already-out', 'also-out']);
    assert.deepEqual(toPublish.sort(), ['another-fresh', 'fresh']);
  } finally {
    await deletePlanRow(id);
  }
});

test('filterUnpublished: draft rows are NOT skipped', async () => {
  const id = await insertPlanRow({ platform: 'juejin', status: 'draft', slugs: ['only-draft'] });
  try {
    const { toPublish, skipped } = await filterUnpublished('juejin', ['only-draft', 'fresh']);
    assert.deepEqual(skipped, [], 'draft-status slug must NOT be filtered');
    assert.deepEqual(toPublish.sort(), ['fresh', 'only-draft']);
  } finally {
    await deletePlanRow(id);
  }
});

test('filterUnpublished: cross-platform isolation', async () => {
  const w = await insertPlanRow({ platform: 'wechat', status: 'published', slugs: ['shared'] });
  const j = await insertPlanRow({ platform: 'juejin', status: 'published', slugs: ['shared'] });
  try {
    const wRes = await filterUnpublished('wechat', ['shared']);
    const jRes = await filterUnpublished('juejin', ['shared']);
    assert.deepEqual(wRes.skipped, ['shared']);
    assert.deepEqual(jRes.skipped, ['shared']);
    // a slug published on wechat only is kept when asking juejin
    const jOnly = await filterUnpublished('juejin', ['wechat-only']);
    assert.deepEqual(jOnly.toPublish, ['wechat-only']);
  } finally {
    await deletePlanRow(w);
    await deletePlanRow(j);
  }
});

// ==================== publishFromSlugs skip-empty (no platform API call) ====================

test('publishFromSlugs (WeChat): all published → skip-empty, no mediaId', async () => {
  const id = await insertPlanRow({ platform: 'wechat', status: 'published', slugs: ['a', 'b', 'c'] });
  try {
    const res = await t.syndicate.channel.publishToChannel({
      platform: 'wechat',
      slugs: ['a', 'b', 'c'],
      asDraft: true,
      siteKey: 'tengence_test',
    });
    assert.equal(res.ok, true, 'skip-empty is a successful no-op');
    assert.equal(res.action, 'skip-empty', 'must short-circuit before any platform call');
    assert.equal(res.refs.mediaId, undefined, 'no draft created');
    assert.deepEqual(res.skipped.sort(), ['a', 'b', 'c']);
  } finally {
    await deletePlanRow(id);
  }
});

test('publishFromSlugs (Juejin): all published → skip-empty (unified dedup covers juejin too)', async () => {
  const id = await insertPlanRow({ platform: 'juejin', status: 'published', slugs: ['j-done'] });
  try {
    const res = await t.syndicate.channel.publishToChannel({
      platform: 'juejin',
      slugs: ['j-done'],
      asDraft: true,
      siteKey: 'tengence_test',
    });
    assert.equal(res.action, 'skip-empty', 'juejin must use the same unified filterUnpublished');
    assert.deepEqual(res.skipped, ['j-done']);
  } finally {
    await deletePlanRow(id);
  }
});

// ==================== Mode B exportArticles dedup ====================

test('publishToChannel Mode B: skips already-published slug, exports the rest', async () => {
  const id = await insertPlanRow({ platform: 'zhihu', status: 'published', slugs: ['done-slug'] });
  try {
    const res = await t.syndicate.channel.publishToChannel({
      platform: 'zhihu',
      articles: [
        { slug: 'done-slug', title: '已发布', contentMd: 'x' },
        { slug: 'fresh-slug', title: '新的', contentMd: '# 新' },
      ],
      siteKey: 'tengence_test',
    });
    assert.equal(res.ok, true);
    const skippedEntry = res.exported.find((e) => e.slug === 'done-slug');
    assert.ok(skippedEntry && skippedEntry.skipped, 'published slug must be reported as skipped');
    const freshEntry = res.exported.find((e) => e.slug === 'fresh-slug');
    assert.ok(freshEntry && freshEntry.ok, 'fresh slug must be exported');
    const freshPath = path.join(TMP, 'tengence_test', 'data', 'channel-export', 'zhihu', 'fresh-slug.md');
    assert.ok(fs.existsSync(freshPath), 'fresh package written');
    const donePath = path.join(TMP, 'tengence_test', 'data', 'channel-export', 'zhihu', 'done-slug.md');
    assert.ok(!fs.existsSync(donePath), 'skipped slug must NOT be written');
  } finally {
    await deletePlanRow(id);
  }
});
