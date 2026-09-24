/**
 * WeChat backend read-back & channel_plan reconciliation
 * ============================================================================
 * Locks in syncProgressFromWechat alignment rules (as confirmed by the user):
 *   - draft row, media_id present in the draft box            → keep draft
 *   - draft row, media_id gone but title in the publish list  → upgrade published
 *   - draft row, media_id gone and not in the publish list    → UNCERTAIN (no auto-write;
 *     WeChat has no API for mass-sent records, so the draft may have been consumed by a
 *     manual mass-send — never roll back to todo automatically)
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

/** Insert a channel_plan row; returns its id. */
async function insertPlanRow({ period, status, slugs, draftIds }) {
  sqlite.getDb();
  let id;
  await withConn(async (conn) => {
    const [r] = await conn.query(
      `INSERT INTO tengence_geo_channel_plan
         (app_id, platform, period, topic, weekday, status, article_slugs, draft_ids)
       VALUES (1, 'wechat', ?, ?, '周二', ?, ?, ?)`,
      [period, `主题 ${period}`, status, JSON.stringify(slugs), JSON.stringify(draftIds || [])]
    );
    id = r.insertId;
  });
  return id;
}

/** Insert an article row so getDetail can resolve a title for a slug. */
async function insertArticle(slug, title) {
  sqlite.getDb();
  await withConn(async (conn) => {
    await conn.query(
      `INSERT INTO tengence_geo_articles (app_id, slug, title, status)
       VALUES (1, ?, ?, 'published')`,
      [slug, title]
    );
  });
}

const fetchers = {
  listDrafts: async () => [{ media_id: 'DRAFT_EXISTS', update_time: 1, titles: ['草稿标题A'] }],
  listPublished: async () => [{ article_id: 'PUB_1', update_time: 1, titles: ['已群发标题B'] }],
};

test('wechat_sync_progress: auto-fix draft→published, keep draft, never downgrade published, uncertain on missing trace', async () => {
  // A: draft with a real draft-box media_id → kept
  const idA = await insertPlanRow({ period: '第1期', status: 'draft', slugs: ['slug-a'], draftIds: ['DRAFT_EXISTS'] });
  // B: draft whose media_id is gone but title was mass-sent → upgraded to published
  await insertArticle('slug-b', '已群发标题B');
  const idB = await insertPlanRow({ period: '第2期', status: 'draft', slugs: ['slug-b'], draftIds: ['DRAFT_GONE'] });
  // C: draft with neither draft nor publish record → UNCERTAIN, NOT auto-modified
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

  // changes: only B (draft→published)
  const byId = Object.fromEntries(result.report.changes.map((c) => [c.id, c]));
  assert.equal(result.report.changes.length, 1, `expected 1 change, got ${JSON.stringify(result.report.changes)}`);
  assert.equal(byId[idB].from, 'draft');
  assert.equal(byId[idB].to, 'published');

  // C reported as uncertain (no auto-write)
  const uncertain = result.report.uncertain.find((u) => u.id === idC);
  assert.ok(uncertain, 'missing-trace draft must be reported as uncertain');
  assert.match(uncertain.reason, /no API for mass-sent/, 'reason must explain the API limitation');

  // DB final state
  const rowA = await t.plan.channel.get(idA);
  assert.equal(rowA.status, 'draft', 'draft with real media_id must be kept');
  assert.deepEqual(rowA.draft_ids, ['DRAFT_EXISTS']);
  const rowB = await t.plan.channel.get(idB);
  assert.equal(rowB.status, 'published', 'draft whose title was mass-sent upgrades to published');
  assert.deepEqual(rowB.draft_ids, ['DRAFT_GONE'], 'published upgrade keeps the stored draft_ids');
  const rowC = await t.plan.channel.get(idC);
  assert.equal(rowC.status, 'draft', 'uncertain draft must NOT be rolled back to todo');
  assert.deepEqual(rowC.draft_ids, ['DRAFT_GONE_2'], 'uncertain draft keeps its draft_ids');
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
  const change = result.report.changes.find((c) => c.id === id);
  assert.ok(change, 'dryRun still reports the would-be change');
  assert.equal(change.to, 'published');
  const row = await t.plan.channel.get(id);
  assert.equal(row.status, 'draft', 'dryRun must not write');
  assert.deepEqual(row.draft_ids, ['DRAFT_GONE_3'], 'dryRun must not clear draft_ids');
});
