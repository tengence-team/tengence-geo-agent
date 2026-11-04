/**
 * channel_plan reconcile → article_id backfill
 * ============================================================================
 * Locks in the 2026-10-19 change: reconcileFromPlatform (the MCP tool
 * channel_plan_reconcile) records the PLATFORM article id on the seeded row —
 * both in map mode (caller passes articleId, e.g. backfilling an article
 * published outside the scheduler) and in live mode (the id read from the
 * platform is no longer discarded). Juejin ids are 19-digit Snowflake values,
 * so they are stored as strings (Number would lose precision).
 *
 * Coverage:
 *   - map entry with articleId → row status=published + article_id recorded.
 *   - map entry without articleId → article_id stays null (backward compatible).
 *   - re-reconcile with a different articleId → the row is updated (upsert by
 *     platform+slug+lang, no duplicate row).
 *
 * Isolation: temp DB_PATH + temp sites root; the real workspace / default sqlite
 * are never touched. Map mode is pure DB (no platform API calls).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const site = require('../packages/geo-sdk/site');
const sqlite = require('../packages/geo-sdk/db/sqlite');
const t = require('../packages/geo-sdk');
const { reconcileFromPlatform } = require('../packages/geo-sdk/plan/channel');
const channelPlan = require('../packages/geo-sdk/db/channel-plan');

let TMP;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-reconcile-id-'));
  site.setSitesRoot(TMP);
  process.env.DB_DRIVER = 'sqlite';
  process.env.DB_PATH = path.join(TMP, 'geo.sqlite');
  site.initSite({ key: 'tengence_test', domain: 'www.tengence.com' });
});

after(() => {
  sqlite.resetDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function getRow(platform, slug) {
  return t.db.withConn((conn) => channelPlan.getByKey(conn, 1, platform, slug, 'zh-hans'));
}

test('map mode records the platform article id (Snowflake-safe string)', async () => {
  const snowflake = '7697664935023525938'; // 19 digits — would lose precision as a Number
  await reconcileFromPlatform('juejin', {
    map: [{ slug: 'ai-search-impact-on-seo', lang: 'zh-hans', title: 'AI 搜索对 SEO 的影响', articleId: snowflake }],
  });
  const r = await getRow('juejin', 'ai-search-impact-on-seo');
  assert.ok(r, 'row should exist');
  assert.equal(r.status, 'published');
  assert.equal(r.article_id, snowflake, 'article_id must round-trip as a string');
  assert.equal(typeof r.article_id, 'string');
});

test('map mode without articleId leaves article_id null (backward compatible)', async () => {
  await reconcileFromPlatform('juejin', {
    map: [{ slug: 'no-id-article', lang: 'zh-hans', title: '无 ID 文章' }],
  });
  const r = await getRow('juejin', 'no-id-article');
  assert.ok(r, 'row should exist');
  assert.equal(r.status, 'published');
  assert.equal(r.article_id, null);
});

test('re-reconcile updates the article id without duplicating the row', async () => {
  await reconcileFromPlatform('juejin', {
    map: [{ slug: 'rerun-article', lang: 'zh-hans', articleId: '1111111111111111111' }],
  });
  await reconcileFromPlatform('juejin', {
    map: [{ slug: 'rerun-article', lang: 'zh-hans', articleId: '2222222222222222222' }],
  });
  // list() has no slug filter (platform/status/lang only) — filter client-side.
  const rows = await t.db.withConn((conn) => channelPlan.list(conn, 1, { platform: 'juejin' }));
  const mine = rows.filter((r) => r.slug === 'rerun-article');
  assert.equal(mine.length, 1, 'upsert must not create a duplicate row');
  assert.equal(mine[0].article_id, '2222222222222222222', 'article id should be updated');
});

test('list() applies the slug filter in SQL — LIMIT cannot hide matching rows', async () => {
  // Regression: channel_plan_status used to filter slug in-memory AFTER the SQL
  // LIMIT, so any row past the limit (default 50) was invisible by slug.
  // Seed >50 other rows, then the target row last (highest id).
  for (let i = 0; i < 55; i++) {
    await t.db.withConn((conn) =>
      channelPlan.upsert(conn, 1, { platform: 'wechat', slug: `pad-${i}`, status: 'draft' })
    );
  }
  await t.db.withConn((conn) =>
    channelPlan.upsert(conn, 1, { platform: 'juejin', slug: 'deep-row', status: 'published' })
  );
  const rows = await t.db.withConn((conn) => channelPlan.list(conn, 1, { slug: 'deep-row', limit: 5 }));
  assert.equal(rows.length, 1, 'slug query must find the row regardless of LIMIT');
  assert.equal(rows[0].slug, 'deep-row');
});
