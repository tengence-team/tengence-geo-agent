/**
 * Cross-platform channel: registry, publish packages, calendar parsing
 * ============================================================================
 * Locks in the stage-1 channel design:
 *   - registry: 8 platforms, api type (official|cookie|none), status
 *     (ready|pending|manual), styles rewrite rules served to the harness
 *   - renderPublishPackage: full front matter (platform/slug/title/summary/
 *     tags/source_url/exported_at/rewrite/mode) + body
 *   - publishToChannel Mode B: exports publish packages under
 *     <site>/data/channel-export/<platform>/<slug>.md and logs to channel-log.jsonl
 *   - importWechatIssues: STRUCTURED calendar rows (period/topic/weekday/status/
 *     slugs/draft ids). The old parseWechatPlanText (markdown → rows) was removed
 *     on 2026-10-07: a prose document is not a data source, and parsing one inside
 *     the API silently produced zero or wrong rows whenever the doc was edited.
 *
 * Isolation: setSitesRoot + DB_PATH point at a temp dir; the real workspace and
 * the default ~/.tengence/geo-mcp/geo.sqlite are never touched.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const site = require('../packages/geo-sdk/site');
const sqlite = require('../packages/geo-sdk/db/sqlite');
const t = require('../packages/geo-sdk');
const { importWechatIssues } = require('../packages/geo-sdk/plan/channel');
const { renderPublishPackage } = require('../packages/geo-sdk/syndicate/channel');

let TMP;
let DB;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-channel-'));
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

// ==================== registry ====================

test('registry: 11 platforms with api/status declared', () => {
  const platforms = t.syndicate.registry.listPlatforms();
  assert.equal(platforms.length, 11);
  const byKey = Object.fromEntries(platforms.map((p) => [p.key, p]));
  assert.equal(byKey.wechat.api, 'official');
  assert.equal(byKey.wechat.status, 'ready');
  assert.equal(byKey.juejin.api, 'cookie');
  assert.equal(byKey.devto.api, 'official');
  assert.equal(byKey.baijiahao.api, 'official');
  assert.equal(byKey.baijiahao.status, 'pending', 'baijiahao is placeholder until enterprise credentials');
  // cookie-based channels added later (CSDN / Aliyun / Tencent developer community)
  assert.equal(byKey.csdn.api, 'cookie');
  assert.equal(byKey.aliyun.api, 'cookie');
  assert.equal(byKey.tencent.api, 'cookie');
  // every ready channel must actually have publish code behind it
  for (const k of ['wechat', 'juejin', 'devto', 'csdn', 'aliyun', 'tencent']) {
    assert.equal(t.syndicate.registry.hasPublish(k), true, `${k} is ready but has no publish code`);
  }
  for (const k of ['blog', 'zhihu', 'toutiao', 'xiaohongshu']) {
    assert.equal(byKey[k].api, 'none', `${k} must be api:none`);
    assert.equal(byKey[k].status, 'manual', `${k} publishes manually from the export`);
    assert.equal(t.syndicate.registry.hasPublish(k), false, `${k} has no publish code`);
  }
});

test('registry: every platform serves harness rewrite rules (styles)', () => {
  for (const p of t.syndicate.registry.listPlatforms()) {
    const rules = t.syndicate.registry.stylesFor(p.key);
    assert.ok(rules && rules.title, `${p.key} rewrite rules must declare title`);
    assert.ok(Array.isArray(rules.removeBlocks), `${p.key} removeBlocks must be an array`);
    assert.ok(rules.body && rules.body.maxChars, `${p.key} body limits required`);
  }
});

test('registry: unknown platform returns null', () => {
  assert.equal(t.syndicate.registry.getPlatform('nope'), null);
});

// ==================== publish package rendering ====================

test('renderPublishPackage: full front matter + body, rewrite marked as harness', () => {
  const md = renderPublishPackage('zhihu', {
    slug: 'what-is-geo',
    title: '改写标题',
    summary: '摘要文本',
    tags: ['GEO', 'SEO'],
    sourceUrl: 'https://www.tengence.com/blog/article/what-is-geo/',
    contentMd: '# 改写正文\n\n内容。',
  });
  assert.ok(md.startsWith('---\n'), 'must open with front matter');
  assert.match(md, /platform: zhihu/);
  assert.match(md, /slug: what-is-geo/);
  assert.match(md, /title: 改写标题/);
  assert.match(md, /summary: 摘要文本/);
  assert.match(md, /tags:/);
  assert.match(md, /source_url: https:\/\/www\.tengence\.com/);
  assert.match(md, /rewrite: harness/);
  assert.match(md, /exported_at:/);
  assert.ok(md.includes('# 改写正文'), 'body must be included after front matter');
});

// ==================== Mode B export ====================

test('publishToChannel Mode B: exports publish package + logs channel-log.jsonl', async () => {
  const res = await t.syndicate.channel.publishToChannel({
    platform: 'zhihu',
    articles: [
      {
        slug: 'what-is-geo',
        title: '知乎改写标题',
        contentMd: '# 正文\n\n结论前置。',
        summary: '平台摘要',
        tags: ['GEO'],
        sourceUrl: 'https://www.tengence.com/blog/article/what-is-geo/',
      },
    ],
    siteKey: 'tengence_test',
  });
  assert.equal(res.ok, true);
  assert.equal(res.action, 'manual');
  const mdPath = path.join(TMP, 'tengence_test', 'data', 'channel-export', 'zhihu', 'what-is-geo.md');
  assert.ok(fs.existsSync(mdPath), 'publish package must be written');
  const md = fs.readFileSync(mdPath, 'utf8');
  assert.match(md, /platform: zhihu/);
  assert.match(md, /title: 知乎改写标题/);
  const logPath = path.join(TMP, 'tengence_test', 'data', 'channel-log.jsonl');
  assert.ok(fs.existsSync(logPath), 'channel log must exist');
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.platform, 'zhihu');
  assert.equal(entry.action, 'export');
  assert.equal(entry.slug, 'what-is-geo');
  assert.equal(entry.ok, true);
});

test('publishToChannel Mode B: rejects article missing required fields', async () => {
  const res = await t.syndicate.channel.publishToChannel({
    platform: 'zhihu',
    articles: [{ slug: 'bad', title: '', contentMd: '' }],
    siteKey: 'tengence_test',
  });
  assert.equal(res.ok, false, 'malformed article must be reported, not fatal');
  assert.equal(res.exported[0].ok, false);
});

test('publishToChannel: unknown platform / empty inputs throw', async () => {
  await assert.rejects(
    () => t.syndicate.channel.publishToChannel({ platform: 'nope', slugs: ['a'], siteKey: 'tengence_test' }),
    /Unknown platform/
  );
  await assert.rejects(
    () => t.syndicate.channel.publishToChannel({ platform: 'zhihu', siteKey: 'tengence_test' }),
    /requires slugs|articles/
  );
});

// ==================== WeChat calendar (structured input) ====================

const WECHAT_ISSUES = [
  {
    period: '第1期',
    topic: 'GEO 入门',
    weekday: '周二',
    article_slugs: ['what-is-geo', 'geo-vs-seo-differences'],
    status: 'published',
    draft_ids: ['STla8_i3I98'],
    notes: '建议发布日：第1周 周二',
  },
  {
    period: '第2期',
    topic: 'GEO 流量获取',
    weekday: '周四',
    article_slugs: ['ai-search-traffic-acquisition'],
    status: 'todo',
    draft_ids: [],
  },
];

test('importWechatIssues: writes structured rows, idempotent on re-run', async () => {
  const dbSqlite = require('../packages/geo-sdk/db/sqlite');
  const { withConn } = require('../packages/geo-sdk/db/connection');
  dbSqlite.getDb();
  try {
    const res = await importWechatIssues(WECHAT_ISSUES);
    assert.equal(res.platform, 'wechat');
    assert.equal(res.rows, 2);
    assert.equal(res.imported, 2, 'first run inserts');
    const again = await importWechatIssues(WECHAT_ISSUES);
    assert.equal(again.imported, 0, 'second run is idempotent');
    assert.equal(again.updated, 2);

    const rows = await t.plan.channel.list({ platform: 'wechat' });
    const first = rows.find((r) => r.period === '第1期');
    const second = rows.find((r) => r.period === '第2期');
    assert.deepEqual(first.article_slugs, ['what-is-geo', 'geo-vs-seo-differences']);
    assert.deepEqual(first.draft_ids, ['STla8_i3I98']);
    assert.equal(first.status, 'published');
    assert.equal(second.status, 'todo');
  } finally {
    await withConn(async (conn) => {
      await conn.query("DELETE FROM tengence_geo_channel_plan WHERE app_id = 1 AND platform = 'wechat'");
    });
  }
});

test('importWechatIssues: rejects non-array / missing period', async () => {
  await assert.rejects(() => importWechatIssues('not-an-array'), /requires an issues array/);
  await assert.rejects(() => importWechatIssues([{ topic: 'no period' }]), /requires a period/);
});

test('nextDue: derived from blog publish_order, skipping slugs already sent', async () => {
  const dbSqlite = require('../packages/geo-sdk/db/sqlite');
  const { withConn } = require('../packages/geo-sdk/db/connection');
  dbSqlite.getDb();
  const ids = [];
  await withConn(async (conn) => {
    for (const [slug, order] of [['blog-a', 10], ['blog-b', 20], ['blog-c', 30]]) {
      const [r] = await conn.query(
        `INSERT INTO tengence_geo_article_plan
           (app_id, slug, lang, node_type, title, plan_status, publish_order)
         VALUES (1, ?, 'zh-hans', 'spoke', ?, 'published', ?)`,
        [slug, slug, order]
      );
      ids.push(r.insertId);
    }
    // blog-a already dispatched to wechat → must be skipped
    await conn.query(
      `INSERT INTO tengence_geo_channel_plan
         (app_id, platform, period, topic, weekday, status, article_slugs, draft_ids)
       VALUES (1, 'wechat', 'P10', 'blog-a', null, 'published', ?, ?)`,
      [JSON.stringify(['blog-a']), JSON.stringify([])]
    );
  });
  let logId;
  await withConn(async (conn) => {
    const [rows] = await conn.query(
      `SELECT id FROM tengence_geo_channel_plan WHERE app_id = 1 AND platform = 'wechat' AND period = 'P10'`
    );
    logId = rows[0].id;
  });
  try {
    const due = await t.plan.channel.nextDue('wechat');
    assert.ok(due, 'blog-published rows must be due');
    assert.equal(due.source, 'blog_plan');
    assert.equal(due.slug, 'blog-b', 'blog-a is already dispatched → resume at blog-b');
    assert.deepEqual(due.article_slugs, ['blog-b']);
    const batch = await t.plan.channel.nextDue('wechat', { count: 2 });
    assert.deepEqual(batch.article_slugs, ['blog-b', 'blog-c'], 'count takes an issue-sized batch');
  } finally {
    await withConn(async (conn) => {
      await conn.query('DELETE FROM tengence_geo_article_plan WHERE id IN (?, ?, ?)', ids);
      await conn.query('DELETE FROM tengence_geo_channel_plan WHERE id = ?', [logId]);
    });
  }
});

// ==================== channel_plan markStatus (draft ids) ====================

test('markStatus: records draft ids, preserves them when not passed', async () => {
  const dbSqlite = require('../packages/geo-sdk/db/sqlite');
  const { withConn } = require('../packages/geo-sdk/db/connection');
  dbSqlite.getDb();
  let id;
  await withConn(async (conn) => {
    const [r] = await conn.query(
      `INSERT INTO tengence_geo_channel_plan
         (app_id, platform, period, topic, weekday, status, article_slugs, draft_ids)
       VALUES (1, 'wechat', '测试期', '测试主题', '周二', 'todo', ?, ?)`,
      [JSON.stringify(['a', 'b']), JSON.stringify([])]
    );
    id = r.insertId;
  });
  try {
    const res = await t.plan.channel.markStatus(id, 'draft', ['MEDIA_1']);
    assert.equal(res.status, 'draft');
    assert.deepEqual(res.draftIds, ['MEDIA_1']);
    const row = await t.plan.channel.get(id);
    assert.deepEqual(row.draft_ids, ['MEDIA_1'], 'draft ids must persist');
    // not passing draftIds keeps the stored ones
    await t.plan.channel.markStatus(id, 'paused');
    const row2 = await t.plan.channel.get(id);
    assert.deepEqual(row2.draft_ids, ['MEDIA_1'], 'existing draft ids preserved');
    // invalid status rejected
    await assert.rejects(() => t.plan.channel.markStatus(id, 'nope'), /Invalid channel_plan status/);
  } finally {
    await withConn(async (conn) => {
      await conn.query('DELETE FROM tengence_geo_channel_plan WHERE id = ?', [id]);
    });
  }
});

test('nextDue: wechat no longer hijacked by calendar rows (derived like every platform)', async () => {
  const dbSqlite = require('../packages/geo-sdk/db/sqlite');
  const { withConn } = require('../packages/geo-sdk/db/connection');
  dbSqlite.getDb();
  let draftId;
  let todoId;
  await withConn(async (conn) => {
    const [d] = await conn.query(
      `INSERT INTO tengence_geo_channel_plan
         (app_id, platform, period, topic, weekday, status, article_slugs, draft_ids)
       VALUES (1, 'wechat', '已建草稿期', '主题A', '周二', 'draft', ?, ?)`,
      [JSON.stringify(['x']), JSON.stringify(['MEDIA_A'])]
    );
    draftId = d.insertId;
    const [t] = await conn.query(
      `INSERT INTO tengence_geo_channel_plan
         (app_id, platform, period, topic, weekday, status, article_slugs, draft_ids)
       VALUES (1, 'wechat', '待办期', '主题B', '周四', 'todo', ?, ?)`,
      [JSON.stringify(['y', 'z']), JSON.stringify([])]
    );
    todoId = t.insertId;
  });
  try {
    // Since 2026-10-07 the wechat queue is derived from the blog article_plan like
    // every other platform; a pending calendar row no longer hijacks the order.
    // The blog plan is empty in this test DB → nothing is due.
    const due = await t.plan.channel.nextDue('wechat');
    assert.equal(due, null, 'empty blog plan → nothing due (calendar rows do not drive the queue)');
    await t.plan.channel.markStatus(todoId, 'draft', ['MEDIA_B']);
    const due2 = await t.plan.channel.nextDue('wechat');
    assert.equal(due2, null);
  } finally {
    await withConn(async (conn) => {
      await conn.query('DELETE FROM tengence_geo_channel_plan WHERE id IN (?, ?)', [draftId, todoId]);
    });
  }
});
