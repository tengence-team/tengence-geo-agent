/**
 * Gate coverage on the write paths that bypassed check-article (2026-11-04)
 * ============================================================================
 * Locks in:
 *   - publish-update-article: any --status=publish write runs checkArticle first
 *     (gate fail → exit 1, "Gate failed, aborting the publish"); --skip-gate is
 *     refused for publish
 *   - publish_update_fields (MCP): status:'publish' runs checkArticle first
 *     (gate fail → isError "Gate failed — refusing to publish")
 *   - the positive control: an expanded article passes the same adjudication
 *
 * Run with SITES_ROOT set (the test sets it from the workspace default).
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const WORKSPACE = '/Users/tim/tengence/geo-workspace';
const SITE = 'www_tengence_com';
const REPO = path.resolve(__dirname, '..');

process.env.SITES_ROOT = process.env.SITES_ROOT || WORKSPACE;

// This is an integration test against the REAL local workspace: the
// www_tengence_com site plus the article DB (skeleton row id 640, the en
// gate-green article). Under the CI harness (SITES_ROOT=examples + an empty
// sqlite) that workspace is absent, so the suite is SKIPPED there instead of
// failing every `npm test` run (Site not found: sites/www_tengence_com).
const SITE_ROOT = process.env.SITES_ROOT;
const sitePresent = fs.existsSync(path.join(SITE_ROOT, SITE, 'config'));
const maybeTest = sitePresent ? test : test.skip;

const t = require('../packages/geo-sdk');
const { tools } = require('../packages/geo-mcp/tools/registry');

const updateFieldsTool = tools.find((x) => x.name === 'publish_update_fields');
assert.ok(updateFieldsTool, 'registry exposes publish_update_fields');

let skeletonRow = null; // { id, wp_post_id } of a 42-batch skeleton article
let expandedSlug = null; // a gate-green article (en) for the positive control

before(async () => {
  if (!sitePresent) return; // integration suite is skipped outside the real workspace
  await t.db.withConn(async (conn) => {
    const [rows] = await conn.query(
      "SELECT id, slug, lang, wp_post_id FROM tengence_geo_articles WHERE id = 640 LIMIT 1"
    );
    skeletonRow = rows[0] || null;
  });
  // gate-green positive control: geo-diagnostic-audit-checklist (en, expanded 10/10)
  const report = await t.check.checkArticle({ slug: 'geo-diagnostic-audit-checklist', lang: 'en', site: SITE });
  if (report.ok) expandedSlug = 'geo-diagnostic-audit-checklist';
});

maybeTest('publish-update-article: --status=publish on a skeleton article is blocked by the gate (exit 1)', async () => {
  assert.ok(skeletonRow && skeletonRow.wp_post_id, 'precondition: skeleton 640 has a wp_post_id');

  const md = path.join(os.tmpdir(), 'gate-test-skeleton.md');
  fs.writeFileSync(
    md,
    '# Gate Test Skeleton\n\n## 什么是门禁测试\n\n一句话。\n\n## 为什么重要\n\n一句话。\n\n## 怎么做\n\n一句话。\n\n## 数据来源\n\n- https://example.com\n',
    'utf8'
  );

  const r = spawnSync(
    process.execPath,
    [path.join(REPO, 'packages/geo-cli/bin/publish-update-article.js'), md,
      '--post-id', String(skeletonRow.wp_post_id),
      '--status', 'publish',
      '--site', SITE],
    { env: { ...process.env, SITES_ROOT: WORKSPACE }, encoding: 'utf8', timeout: 60000 }
  );

  assert.equal(r.status, 1, 'gate failure must abort with exit code 1');
  const out = (r.stdout || '') + (r.stderr || '');
  assert.match(out, /Gate failed, aborting the publish/, 'must report the gate abort');
  assert.match(out, /substantive content \(G17-5\)/, 'must surface the G17-5 failure row');
});

maybeTest('publish_update_fields: status="publish" on a skeleton article is refused by the gate', async () => {
  assert.ok(skeletonRow, 'precondition: skeleton row loaded');

  const res = await updateFieldsTool.run({
    article_id: skeletonRow.id,
    status: 'publish',
    site: SITE,
  });

  assert.equal(res.isError, true, 'gate refusal must surface as an error');
  const text = JSON.stringify(res.content);
  assert.match(text, /Gate failed — refusing to publish/, 'must name the gate refusal');
  assert.match(text, /G17-5/, 'must surface the G17-5 failure row');
  assert.match(text, /no manual override/, 'must state there is no manual override');
});

maybeTest('positive control: a gate-green expanded article passes the same adjudication', async () => {
  assert.ok(expandedSlug, 'precondition: geo-diagnostic-audit-checklist (en) is gate-green');
  const report = await t.check.checkArticle({ slug: expandedSlug, lang: 'en', site: SITE });
  assert.equal(report.ok, true, 'expanded article must pass the gate the write paths rely on');
});
