/**
 * WeChat backend read-back & channel_plan reconciliation
 * ============================================================================
 * Locks in syncProgressFromWechat alignment rules (superceded 2026-11-13 — the
 * earlier "roll back to todo / uncertain" contract was replaced by the five-category
 * one the user approved):
 *   - draft row, media_id present in the draft box            → keep draft
 *   - draft row, media_id gone but title in the publish list  → upgrade published
 *   - draft row, media_id gone, title uniquely in a draft msg → backfill the media_id
 *   - draft row, no trace in either list                      → deleted (TERMINAL:
 *     never re-sent automatically; a human must reset it to todo)
 *   - published row                                           → never downgraded
 *
 * The WeChat API itself is mocked via the `fetchers` injection seam; the real DB
 * (temp sqlite) is read/written exactly like production.
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

let TMP;
let DB;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-wechat-sync-'));
  DB = path.join(TMP, 'geo.sqlite');
  site.setSitesRoot(TMP);
  process.env.DB_DRIVER = 'sqlite';
  process.env.DB_PATH = DB;
  process.env.APP_ID = '1';
  site.initSite({ key: 'tengence_test', domain: 'www.tengence.com' });
});

after(() => {
  sqlite.resetDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** Insert channel_plan rows (one per slug, sharing period + draftIds); returns the ids. */
async function insertPlanRow({ period, status, slugs, draftIds }) {
  sqlite.getDb();
  const ids = [];
  await withConn(async (conn) => {
    for (const slug of slugs) {
      const [r] = await conn.query(
        `INSERT INTO tengence_geo_channel_plan
           (app_id, platform, slug, lang, period, topic, weekday, status, draft_ids)
         VALUES (1, 'wechat', ?, 'zh-hans', ?, ?, '周二', ?, ?)`,
        [slug, period, `主题 ${period}`, status, JSON.stringify(draftIds || [])]
      );
      ids.push(r.insertId);
    }
  });
  return ids.length === 1 ? ids[0] : ids;
}

/** Insert an article row so getDetail can resolve a title for a slug. */
async function insertArticle(slug, title) {
  sqlite.getDb();
  await withConn(async (conn) => {
    await conn.query(
      `INSERT INTO tengence_geo_articles (app_id, slug, title, lang, status)
       VALUES (1, ?, ?, 'zh-hans', 'published')`,
      [slug, title]
    );
  });
}

const fetchers = {
  listDrafts: async () => [{ media_id: 'DRAFT_EXISTS', update_time: 1, titles: ['草稿标题A'] }],
  listPublished: async () => [{ article_id: 'PUB_1', update_time: 1, titles: ['已群发标题B'] }],
};

test('wechat_sync_progress: kept / upgraded / deleted / never downgraded', async () => {
  // A: draft with a real draft-box media_id → kept
  const idA = await insertPlanRow({ period: '第1期', status: 'draft', slugs: ['slug-a'], draftIds: ['DRAFT_EXISTS'] });
  // B: draft whose media_id is gone but title was published → upgraded to published
  await insertArticle('slug-b', '已群发标题B');
  const idB = await insertPlanRow({ period: '第2期', status: 'draft', slugs: ['slug-b'], draftIds: ['DRAFT_GONE'] });
  // C: draft with neither draft nor publish record → deleted (terminal, never re-sent)
  await insertArticle('slug-c', '从未发布标题C');
  const idC = await insertPlanRow({ period: '第3期', status: 'draft', slugs: ['slug-c'], draftIds: ['DRAFT_GONE_2'] });
  // D: published → unchanged even though the title is absent from the publish list
  await insertArticle('slug-d', '老群发标题D');
  const idD = await insertPlanRow({ period: '第0期', status: 'published', slugs: ['slug-d'], draftIds: ['OLD_MEDIA'] });

  const result = await t.syndicate.wechat.syncProgressFromWechat({ siteKey: 'tengence_test', fetchers });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.report.drafts, 1);
  assert.equal(result.report.published, 1);

  const ids = (list) => list.map((x) => x.id);
  assert.deepEqual(ids(result.report.kept), [idA]);
  assert.deepEqual(ids(result.report.upgraded), [idB]);
  assert.deepEqual(ids(result.report.deleted), [idC], 'no-trace draft is judged deleted, never retried');
  assert.equal(ids(result.report.unchanged).includes(idD), true, 'published rows are never downgraded');
  assert.equal(result.report.unchanged.some((u) => u.id === idC), false);

  // DB final state
  const rowA = await t.plan.channel.get(idA);
  assert.equal(rowA.status, 'draft', 'draft with real media_id must be kept');
  assert.deepEqual(rowA.draft_ids, ['DRAFT_EXISTS']);
  const rowB = await t.plan.channel.get(idB);
  assert.equal(rowB.status, 'published', 'draft whose title was published upgrades to published');
  assert.equal(rowB.article_id, 'PUB_1', 'article_id comes from the freepublish record');
  const rowC = await t.plan.channel.get(idC);
  assert.equal(rowC.status, 'deleted', 'no-trace draft is terminal');
  assert.match(rowC.notes || '', /人工改回 todo/, 'the human-reset hint is recorded');
  const rowD = await t.plan.channel.get(idD);
  assert.equal(rowD.status, 'published', 'published rows are never downgraded');
});

test('wechat_sync_progress: dryRun reports but does not write', async () => {
  const id = await insertPlanRow({ period: '第9期', status: 'draft', slugs: ['slug-b2'], draftIds: ['DRAFT_GONE_3'] });
  await insertArticle('slug-b2', '已群发标题B');
  const result = await t.syndicate.wechat.syncProgressFromWechat({
    siteKey: 'tengence_test',
    dryRun: true,
    fetchers,
  });
  const upgrade = result.report.upgraded.find((c) => c.id === id);
  assert.ok(upgrade, 'dryRun still reports the would-be upgrade');
  assert.equal(upgrade.to, 'published');
  const row = await t.plan.channel.get(id);
  assert.equal(row.status, 'draft', 'dryRun must not write');
  assert.deepEqual(row.draft_ids, ['DRAFT_GONE_3'], 'dryRun must not clear draft_ids');
});
