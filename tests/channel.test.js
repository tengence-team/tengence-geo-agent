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
 *   - parseWechatPlanText: the 微信公众号发布计划.md → calendar rows
 *     (period/topic/weekday/status/slugs/draft ids)
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
const { parseWechatPlanText } = require('../packages/geo-sdk/plan/channel');
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

test('registry: 8 platforms with api/status declared', () => {
  const platforms = t.syndicate.registry.listPlatforms();
  assert.equal(platforms.length, 8);
  const byKey = Object.fromEntries(platforms.map((p) => [p.key, p]));
  assert.equal(byKey.wechat.api, 'official');
  assert.equal(byKey.wechat.status, 'ready');
  assert.equal(byKey.juejin.api, 'cookie');
  assert.equal(byKey.devto.api, 'official');
  assert.equal(byKey.baijiahao.api, 'official');
  assert.equal(byKey.baijiahao.status, 'pending', 'baijiahao is placeholder until enterprise credentials');
  for (const k of ['zhihu', 'csdn', 'toutiao', 'xiaohongshu']) {
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

// ==================== WeChat plan parsing ====================

const WECHAT_PLAN_SAMPLE = `# 微信公众号发布计划

## 二、排期总览

| 期次 | 建议发布日 | 主题 | 篇数 | 状态 |
|------|-----------|------|------|------|
| 第1期 | 第1周 周二 | GEO 入门 | 3 | ✅ 已群发 |
| 第2期 | 第1周 周四 | GEO 流量获取 | 3 | 📝 草稿已建 |

## 三、逐期详情

### 第1期 GEO 入门

| # | slug | 标题 | 类目 | 标签 | 官网地址 | 草稿ID | 状态 |
|---|------|------|------|------|----------|--------|------|
| 1 | what-is-geo | 什么是 GEO | geo-ai-search | GEO/SEO | https://www.tengence.com/blog/article/what-is-geo/ | STla8_i3I98 | ✅ 已群发 |
| 2 | geo-vs-seo-differences | GEO 与 SEO 区别 | geo-ai-search | GEO/SEO | https://www.tengence.com/blog/article/geo-vs-seo-differences/ | STla8_i3I98 | ✅ 已群发 |

### 第2期 GEO 流量获取

| # | slug | 标题 | 类目 | 标签 | 官网地址 | 草稿ID | 状态 |
|---|------|------|------|------|----------|--------|------|
| 1 | ai-search-traffic-acquisition | AI 搜索流量 | geo-ai-search | GEO/SEO | https://www.tengence.com/blog/article/ai-search-traffic-acquisition/ | — | ⬜ |
`;

test('parseWechatPlanText: period/topic/weekday/status/slugs/draft ids', () => {
  const issues = parseWechatPlanText(WECHAT_PLAN_SAMPLE);
  assert.equal(issues.length, 2);
  const first = issues[0];
  assert.equal(first.period, '第1期');
  assert.equal(first.topic, 'GEO 入门');
  assert.equal(first.weekday, '周二', 'weekday extracted from the overview row');
  assert.equal(first.weekdayNote, '第1周 周二');
  assert.equal(first.status, 'published');
  assert.deepEqual(first.article_slugs, ['what-is-geo', 'geo-vs-seo-differences']);
  assert.deepEqual(first.draft_ids, ['STla8_i3I98'], 'duplicate draft ids deduped');
  const second = issues[1];
  assert.equal(second.period, '第2期');
  assert.equal(second.weekday, '周四');
  assert.equal(second.status, 'todo', 'overview ⬜ → todo');
  assert.equal(second.draft_ids.length, 0);
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

test('nextDue: returns the earliest todo row, skips draft/published rows', async () => {
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
    const due = await t.plan.channel.nextDue('wechat');
    assert.ok(due, 'a todo row must be due');
    assert.equal(due.period, '待办期', 'draft rows are already handled and must be skipped');
    assert.deepEqual(due.article_slugs, ['y', 'z']);
    // mark it draft → next due becomes null
    await t.plan.channel.markStatus(todoId, 'draft', ['MEDIA_B']);
    const due2 = await t.plan.channel.nextDue('wechat');
    assert.equal(due2, null, 'no todo rows left → nothing due');
  } finally {
    await withConn(async (conn) => {
      await conn.query('DELETE FROM tengence_geo_channel_plan WHERE id IN (?, ?)', [draftId, todoId]);
    });
  }
});
