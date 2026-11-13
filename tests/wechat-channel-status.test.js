/**
 * WeChat channel: status write-back, media_id preservation, reconciliation
 * ============================================================================
 * Locks in the 2026-11-13 contract:
 *   P1 — draft_ids are never silently cleared; a publish/mass-send writes
 *        `published` + article_id back to channel_plan;
 *   P2 — syncProgressFromWechat only touches `draft` rows and decides
 *        kept / backfilled / upgraded / deleted against the REAL backend values
 *        (media_id first, normalized unique title second), dryRun = zero writes;
 *   P3 — publishDraftByMediaId returns mediaId/articleId so the caller can write
 *        back, and issue numbering is idempotent for the same media_id.
 *
 * Isolation: temp sites root + temp sqlite DB; the real workspace and the
 * default ~/.tengence/geo-mcp/geo.sqlite are never touched.
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
const repo = require('../packages/geo-sdk/db/channel-plan');
const { normalizeTitle, buildTitleIndex, lookupTitle, partitionByDrafts } = require('../packages/geo-sdk/plan/wechat-match');

let TMP;
let DB;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-wechat-status-'));
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

beforeEach(async () => {
  await withConn(async (conn) => {
    await conn.query('DELETE FROM tengence_geo_channel_plan');
    await conn.query('DELETE FROM tengence_geo_articles');
  });
});

/** Seed one article row so title lookups resolve. */
async function seedArticle(slug, title, lang = 'zh-hans') {
  await withConn(async (conn) => {
    await conn.query(
      `INSERT INTO tengence_geo_articles (app_id, slug, title, lang, content_longtext, target_keywords, status)
       VALUES (1, ?, ?, ?, ?, ?, 'publish')`,
      [slug, title, lang, `# ${title}\nbody`, 'geo']
    );
  });
}

async function seedPlanRow(rec) {
  return withConn(async (conn) =>
    repo.upsert(conn, 1, { platform: 'wechat', lang: 'zh-hans', status: 'draft', ...rec })
  );
}

async function getRow(id) {
  return withConn(async (conn) => repo.getById(conn, 1, id));
}

// ============================ title matcher ============================

test('wechat-match: normalization hides spaces / full-width punctuation', () => {
  const a = normalizeTitle('GEO优化技术原理：AI搜索算法深度解析');
  const b = normalizeTitle('GEO 优化技术原理：AI 搜索算法深度解析。');
  assert.equal(a, b);
});

test('wechat-match: duplicate titles are NOT unique (never auto-written)', () => {
  const idx = buildTitleIndex([
    { titles: ['同名文章'], payload: 'm1' },
    { titles: ['同名 文章'], payload: 'm2' },
  ]);
  const r = lookupTitle(idx, '同名文章');
  assert.equal(r.hit, true);
  assert.equal(r.unique, false, 'two messages share the title → ambiguous');
});

test('wechat-match: unique exact hit and long-prefix fallback', () => {
  const long = 'AI 搜索时代的出海市场选择：哪个市场先做 GEO 以及为什么';
  const idx = buildTitleIndex([{ titles: [long], payload: 'm1' }]);
  assert.equal(lookupTitle(idx, long).unique, true);
  // WeChat truncates long titles in some listings → prefix match must still find it
  assert.equal(lookupTitle(idx, `${long.slice(0, 25)}…`).unique, true);
});

// ============================ P1: draft_ids ============================

test('P1: upsert without draft_ids keeps the existing media_id', async () => {
  const a = await seedPlanRow({ slug: 'a', draft_ids: ['media-1'], period: '第1期' });
  // a later, unrelated upsert (status/topic change) must NOT wipe the media_id
  await withConn(async (conn) =>
    repo.upsert(conn, 1, { platform: 'wechat', slug: 'a', lang: 'zh-hans', status: 'draft', topic: 'new topic' })
  );
  const row = await getRow(a.id);
  assert.deepEqual(row.draft_ids, ['media-1'], 'media_id must survive an unrelated upsert');
  assert.equal(row.topic, 'new topic');
});

test('P1: append_draft_ids merges and de-duplicates', async () => {
  const a = await seedPlanRow({ slug: 'b', draft_ids: ['media-1'] });
  await withConn(async (conn) =>
    repo.upsert(conn, 1, { platform: 'wechat', slug: 'b', lang: 'zh-hans', append_draft_ids: ['media-1', 'media-2'] })
  );
  const row = await getRow(a.id);
  assert.deepEqual(row.draft_ids, ['media-1', 'media-2']);
});

test('P1: explicit draft_ids array still overwrites (caller intent)', async () => {
  const a = await seedPlanRow({ slug: 'c', draft_ids: ['media-1'] });
  await withConn(async (conn) =>
    repo.upsert(conn, 1, { platform: 'wechat', slug: 'c', lang: 'zh-hans', draft_ids: [] })
  );
  assert.deepEqual((await getRow(a.id)).draft_ids, []);
});

test('P1: recordWechatIssueCreated is idempotent for the same media_id', async () => {
  const first = await t.plan.channel.recordWechatIssueCreated({ slugs: ['x1', 'x2'], mediaId: 'M1' });
  assert.equal(first.period, '第1期');
  assert.equal(first.reused, false);
  const second = await t.plan.channel.recordWechatIssueCreated({ slugs: ['x1', 'x2'], mediaId: 'M1' });
  assert.equal(second.reused, true, 'same message re-recorded → reuse the issue, no new 第N期');
  assert.equal(second.period, '第1期');
  // a genuinely new message gets the next issue
  const third = await t.plan.channel.recordWechatIssueCreated({ slugs: ['x3'], mediaId: 'M2' });
  assert.equal(third.period, '第2期');
});

test('P1: recordWechatIssueCreated appends media_id, never drops it', async () => {
  await seedArticle('s1', '第一篇文章');
  const a = await seedPlanRow({ slug: 's1', period: '第5期' });
  assert.deepEqual((await getRow(a.id)).draft_ids, []);
  await t.plan.channel.recordWechatIssueCreated({ slugs: ['s1'], mediaId: 'M9' });
  const row = await getRow(a.id);
  assert.deepEqual(row.draft_ids, ['M9']);
  assert.equal(row.status, 'draft');
  // a row that belonged to an older issue but has no media_id for THIS message gets
  // the next issue number — reuse only kicks in when the media_id already matches
  assert.equal(row.period, '第6期', 'new message → next issue number (reuse requires a matching media_id)');
});

test('P1: recordWechatPublished writes published + article_id + media_id', async () => {
  await seedArticle('p1', '已发布文章一');
  await seedArticle('p2', '已发布文章二');
  await seedPlanRow({ slug: 'p1', draft_ids: ['M1'] });
  await seedPlanRow({ slug: 'p2', draft_ids: ['M1'] });

  const out = await t.plan.channel.recordWechatPublished({ mediaId: 'M1', articleId: 'ART-1', slugs: ['p1', 'p2'] });
  assert.equal(out.rows.length, 2);
  for (const r of out.rows) {
    const row = await getRow(r.id);
    assert.equal(row.status, 'published');
    assert.equal(row.article_id, 'ART-1');
    assert.deepEqual(row.draft_ids, ['M1']);
  }
});

test('P1: recordWechatPublished resolves slugs from titles when not given', async () => {
  await seedArticle('t1', '标题唯一匹配的文章');
  await seedArticle('t2', '另一篇文章');
  await seedPlanRow({ slug: 't1' });
  await seedPlanRow({ slug: 't2' });

  const out = await t.plan.channel.recordWechatPublished({ mediaId: 'M2', titles: ['标题唯一匹配的文章'] });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].slug, 't1');
  assert.equal((await getRow(out.rows[0].id)).status, 'published');
  assert.equal((await getRow(out.rows[0].id)).article_id, null, 'no article_id given → left null');
});

test('P1: ambiguous title is reported, NOT written', async () => {
  await seedArticle('d1', '相同标题');
  await seedArticle('d2', '相同 标题');
  const d1 = await seedPlanRow({ slug: 'd1' });
  await seedPlanRow({ slug: 'd2' });

  const out = await t.plan.channel.recordWechatPublished({ mediaId: 'M3', titles: ['相同标题'] });
  assert.equal(out.rows.length, 0);
  assert.equal(out.unresolved.length, 1);
  assert.match(out.unresolved[0].reason, /ambiguous/);
  assert.equal((await getRow(d1.id)).status, 'draft');
});

// ======================== P2: reconciliation ========================

function fetchers({ drafts = [], published = [] }) {
  return {
    listDrafts: async () => drafts,
    listPublished: async () => published,
  };
}

test('P2: draft row whose media_id is in the draft box stays draft', async () => {
  await seedArticle('k1', '仍在草稿箱的文章');
  const a = await seedPlanRow({ slug: 'k1', draft_ids: ['M-KEEP'] });
  const r = await t.syndicate.wechat.syncProgressFromWechat({
    siteKey: 'tengence_test',
    fetchers: fetchers({ drafts: [{ media_id: 'M-KEEP', titles: ['仍在草稿箱的文章'] }] }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.report.kept.length, 1);
  assert.equal((await getRow(a.id)).status, 'draft');
});

test('P2: missing media_id is backfilled when the title uniquely matches a draft', async () => {
  await seedArticle('k2', 'GEO 工具盘点 2026：AI 搜索优化工具怎么选');
  const a = await seedPlanRow({ slug: 'k2' });
  const r = await t.syndicate.wechat.syncProgressFromWechat({
    siteKey: 'tengence_test',
    fetchers: fetchers({ drafts: [{ media_id: 'M-BACKFILL', titles: ['GEO工具盘点 2026：AI搜索优化工具怎么选'] }] }),
  });
  assert.equal(r.report.backfilled.length, 1, 'normalized title match must backfill the media_id');
  const row = await getRow(a.id);
  assert.deepEqual(row.draft_ids, ['M-BACKFILL']);
  assert.equal(row.status, 'draft');
});

test('P2: title found in freepublish upgrades the row to published (+article_id)', async () => {
  await seedArticle('k3', '数据可视化工具对比：BI 工具怎么选？');
  const a = await seedPlanRow({ slug: 'k3' });
  const r = await t.syndicate.wechat.syncProgressFromWechat({
    siteKey: 'tengence_test',
    fetchers: fetchers({ published: [{ article_id: 'ART-9', titles: ['数据可视化工具对比：BI 工具怎么选'] }] }),
  });
  assert.equal(r.report.upgraded.length, 1);
  const row = await getRow(a.id);
  assert.equal(row.status, 'published');
  assert.equal(row.article_id, 'ART-9');
});

test('P2: no evidence in either list → deleted (terminal, never re-sent)', async () => {
  await seedArticle('k4', '一篇平台侧已经不存在的文章');
  const a = await seedPlanRow({ slug: 'k4' });
  const r = await t.syndicate.wechat.syncProgressFromWechat({ siteKey: 'tengence_test', fetchers: fetchers({}) });
  assert.equal(r.report.deleted.length, 1);
  const row = await getRow(a.id);
  assert.equal(row.status, 'deleted');
  assert.match(row.notes || '', /判 deleted 终态/, 'the human-reset hint must be recorded');
  // `deleted` is terminal: nextDue must never re-offer it
  const idx = await t.plan.channel.publishedSlugs('wechat');
  assert.equal(idx.size, 0, 'deleted is NOT dispatched…');
  await t.plan.upsert({ slug: 'k4', plan_status: 'published', publish_order: 2, title: '一篇平台侧已经不存在的文章' }, { lang: 'zh-hans' });
  const next = await t.plan.channel.nextDue('wechat', { count: 1, register: false });
  assert.equal(next, null, '…and it is excluded from the retry queue (no duplicate re-send)');
});

test('P2: dryRun reports the same picture with ZERO writes', async () => {
  await seedArticle('k5', '待判定的文章');
  const a = await seedPlanRow({ slug: 'k5' });
  const r = await t.syndicate.wechat.syncProgressFromWechat({ siteKey: 'tengence_test', dryRun: true, fetchers: fetchers({}) });
  assert.equal(r.dryRun, true);
  assert.equal(r.report.deleted.length, 1);
  assert.equal((await getRow(a.id)).status, 'draft', 'dryRun must not write');
});

test('P2: queue states (todo / review_failed) are never touched', async () => {
  await seedArticle('q1', '排队中的文章');
  await seedArticle('q2', '被隔离的文章');
  const todo = await seedPlanRow({ slug: 'q1', status: 'todo' });
  const rf = await seedPlanRow({ slug: 'q2', status: 'review_failed' });
  const r = await t.syndicate.wechat.syncProgressFromWechat({ siteKey: 'tengence_test', fetchers: fetchers({}) });
  assert.equal(r.report.deleted.length, 0);
  assert.equal(r.report.unchanged.length >= 1, true);
  assert.equal((await getRow(todo.id)).status, 'todo');
  assert.equal((await getRow(rf.id)).status, 'review_failed');
});

test('P2: published rows are never downgraded', async () => {
  await seedArticle('k6', '已发布的文章');
  const a = await seedPlanRow({ slug: 'k6', status: 'published' });
  await t.syndicate.wechat.syncProgressFromWechat({ siteKey: 'tengence_test', fetchers: fetchers({}) });
  assert.equal((await getRow(a.id)).status, 'published');
});

test('P2: a failing fetch aborts the run with zero writes (no false deletions)', async () => {
  await seedArticle('k7', '抓取失败的文章');
  const a = await seedPlanRow({ slug: 'k7' });
  await assert.rejects(
    t.syndicate.wechat.syncProgressFromWechat({
      siteKey: 'tengence_test',
      fetchers: {
        listDrafts: async () => {
          throw new Error('access_token fetch failed: 40164 invalid ip');
        },
        listPublished: async () => [],
      },
    })
  );
  assert.equal((await getRow(a.id)).status, 'draft', 'fetch failure must not delete anything');
});

test('P2: syncStatuses("wechat") returns the reconciliation summary', async () => {
  await seedArticle('k8', '对账摘要测试文章');
  await seedPlanRow({ slug: 'k8' });
  const st = await t.plan.channel.syncStatuses('wechat', {
    dryRun: true,
    siteKey: 'tengence_test',
    fetchers: fetchers({ drafts: [{ media_id: 'M-ANY', titles: ['对账摘要测试文章'] }] }),
  });
  assert.equal(st.platform, 'wechat');
  assert.equal(typeof st.counts.deleted, 'number');
  assert.match(st.source, /draft\/batchget/);
});

// ======================== P3: publish write-back =====================

test('P3: publishDraftByMediaId returns mediaId + articleId (status read is best-effort)', async () => {
  const calls = [];
  const fakeRequest = async (url, opts, body) => {
    calls.push({ url, body });
    return { json: { errcode: 0, errmsg: 'ok', publish_id: 'PUB-1' } };
  };
  const fakeStatus = async () => ({ article_id: 'ART-1' });
  const res = await t.syndicate.wechat.publishDraftByMediaId('M-PUB', {
    request: fakeRequest,
    accessToken: 'TOKEN',
    getStatus: fakeStatus,
  });
  assert.equal(res.mediaId, 'M-PUB');
  assert.equal(res.publishId, 'PUB-1');
  assert.equal(res.articleId, 'ART-1');
  assert.match(calls[0].url, /freepublish\/submit/);
});

test('P3: publishDraftByMediaId still succeeds when the status read fails', async () => {
  const fakeRequest = async () => ({ json: { errcode: 0, publish_id: 'PUB-2' } });
  const res = await t.syndicate.wechat.publishDraftByMediaId('M-PUB2', {
    request: fakeRequest,
    accessToken: 'TOKEN',
    getStatus: async () => {
      throw new Error('freepublish/get failed: 48001 api unauthorized');
    },
  });
  assert.equal(res.articleId, null);
  assert.equal(res.publishId, 'PUB-2');
});

test('P3: publishDraftByMediaId surfaces the real API error', async () => {
  const fakeRequest = async () => ({ json: { errcode: 40007, errmsg: 'invalid media_id' } });
  await assert.rejects(
    t.syndicate.wechat.publishDraftByMediaId('M-BAD', { request: fakeRequest, accessToken: 'TOKEN' }),
    /freepublish\/submit failed: 40007/
  );
});

// ================= P2: send-time dedupe (no second message) =================

test('P2 dedupe: every article already in the draft box → reuse, create nothing', () => {
  const { dup, kept } = partitionByDrafts(
    [{ slug: 'a1', title: '文章一' }, { slug: 'a2', title: '文章二' }],
    [{ media_id: 'M-OLD', titles: ['文章一'] }, { media_id: 'M-OLD', titles: ['文章二'] }]
  );
  assert.equal(kept.length, 0, 'no new message may be created');
  assert.equal(dup.length, 2);
  assert.deepEqual([...new Set(dup.map((d) => d.mediaId))], ['M-OLD'], 'the existing media_id is reused');
});

test('P2 dedupe: partial overlap → only the unseen article is sent', () => {
  const { dup, kept } = partitionByDrafts(
    [{ slug: 'a1', title: '文章一' }, { slug: 'a2', title: '文章二' }],
    [{ media_id: 'M-OLD', titles: ['文章一'] }]
  );
  assert.deepEqual(dup.map((d) => d.slug), ['a1']);
  assert.deepEqual(kept.map((d) => d.slug), ['a2'], 'the already-sent article must be removed from the payload');
});

test('P2 dedupe: an ambiguous title is NOT treated as duplicate (no false skip)', () => {
  const { dup, kept } = partitionByDrafts(
    [{ slug: 'a1', title: '同名标题' }],
    [{ media_id: 'M1', titles: ['同名标题'] }, { media_id: 'M2', titles: ['同名 标题'] }]
  );
  assert.equal(dup.length, 0);
  assert.equal(kept.length, 1, 'when in doubt the article is sent rather than silently dropped');
});
