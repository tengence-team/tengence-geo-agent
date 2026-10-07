/**
 * The plan API must not consume documents
 * ============================================================================
 * Regression guard for 2026-10-07. plan.importPlan used to parse two
 * CONTROL-PLANE documents — 《内容发布计划.md》(a 13-column matrix whose status
 * column was an emoji legend) and publish-queue.json — and replay them over the
 * plan table on every import. Replaying a prose document rewound live rows (35
 * genuinely published rows were flipped back to queued) and clobbered DB-edited
 * topic fields.
 *
 * The rule now: the plan table is the source of truth; the API accepts STRUCTURED
 * input only (plan.upsert / plan_import{ rows[] }); markdown → structured
 * conversion happens OUTSIDE the API.
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
const plan = require('../packages/geo-sdk/plan');
const channel = require('../packages/geo-sdk/plan/channel');

let TMP;
let DB;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-plan-nodoc-'));
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

test('plan / channel no longer expose document parsers', () => {
  for (const name of ['parseMatrix', 'parseQueue', 'mdExists']) {
    assert.equal(plan[name], undefined, `plan.${name} must be gone`);
  }
  for (const name of ['parseWechatPlanText', 'importWechatPlan']) {
    assert.equal(channel[name], undefined, `channel.${name} must be gone`);
  }
  assert.equal(typeof channel.importWechatIssues, 'function', 'structured import replaces the md one');
});

/** Comments legitimately explain WHY the parsers were removed (and therefore name
 * the documents); only executable code is subject to the ban. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

test('plan / channel sources read no files at all', () => {
  const files = [
    path.resolve(__dirname, '../packages/geo-sdk/plan/index.js'),
    path.resolve(__dirname, '../packages/geo-sdk/plan/channel.js'),
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/\breadFileSync\b/.test(src), `${path.basename(f)} must not read files`);
    assert.ok(!/\bexistsSync\b/.test(src), `${path.basename(f)} must not stat files`);
    const code = stripComments(src);
    assert.ok(!/内容发布计划|publish-queue|微信公众号发布计划/.test(code), `${path.basename(f)} must not reference a plan document in code`);
    assert.ok(!/require\(['"]fs['"]\)/.test(code), `${path.basename(f)} must not even require fs`);
  }
});

test('a planted 内容发布计划.md in the site dir cannot leak into the plan table', async () => {
  const siteDir = path.join(TMP, 'tengence_test');
  const planDir = path.join(siteDir, 'plan', '2026');
  fs.mkdirSync(planDir, { recursive: true });
  const doc = path.join(planDir, '内容发布计划.md');
  fs.writeFileSync(
    doc,
    [
      '| 编号 | slug | 标题 | 关键词 | 量 | 竞争 | 意图 | 类型 | 字数 | 批次 | 类目 | 标签 | 状态 |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
      '| A1 | planted-by-doc | 文档注入的选题 | planted | 100 | 低 | 信息 | 指南 | 2000 | 1 | geo-ai-search | GEO | ✅ |',
    ].join('\n'),
    'utf8'
  );

  const loaded = require('../packages/geo-sdk/site/config').loadSite('tengence_test');
  const before = await plan.list({ limit: 5000 });
  const report = await plan.importPlan(loaded, {});
  const after = await plan.list({ limit: 5000 });

  assert.equal(
    after.length,
    before.length,
    'importPlan must not create rows from a document'
  );
  assert.ok(
    !after.some((r) => r.slug === 'planted-by-doc'),
    'the planted slug must never reach the plan table'
  );
  assert.equal(report.matrix_rows, undefined, 'the report no longer has a matrix count');
});
