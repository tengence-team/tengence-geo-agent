/**
 * Regression: wechat publishDue check callback must resolve `t` and `siteDir`
 * ============================================================================
 * 2026-11-18 incident: channel-schedule.js's wechat `check` callback referenced
 * `t.syndicate...` and a free `siteDir`, but the file never imported `t` and had
 * no `siteDir` in scope. Every candidate threw `ReferenceError: t is not defined`,
 * was swallowed by assembleIssue() into `needsRepair: ['check error: t is not
 * defined']`, and wechat produced NO draft for 5 days (2026-11-14..18).
 *
 * This test locks the fix: the check callback must call readRewrittenExport with
 * a real siteDir derived from siteKey, and call checkArticle — i.e. no ReferenceError.
 *
 * Isolation: temp SITES_ROOT + DB_PATH; no real workspace or platform API calls
 * (all external-facing helpers are stubbed, publishDue runs with dryRun=true).
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

let TMP;
let DB;
let WP_SEQ = 5000;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-wx-check-'));
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
    await conn.query('DELETE FROM tengence_geo_channel_schedule');
    await conn.query('DELETE FROM tengence_geo_channel_plan');
    await conn.query('DELETE FROM tengence_geo_articles');
  });
});

async function seedArticle(slug, order = 1) {
  const wpPostId = (WP_SEQ += 1);
  await withConn(async (conn) => {
    await conn.query(
      `INSERT INTO tengence_geo_articles (app_id, slug, title, lang, content_longtext, target_keywords, status, wp_post_id)
       VALUES (1, ?, ?, 'zh-hans', ?, 'geo,seo', 'publish', ?)`,
      [slug, slug, `# ${slug}\nbody`, wpPostId]
    );
  });
  await t.plan.upsert({ slug, plan_status: 'published', publish_order: order, title: slug }, { lang: 'zh-hans' });
}

/**
 * Stub every external-facing helper the wechat check callback touches, so the
 * ONLY thing under test is that `t` / `siteDir` resolve and no ReferenceError fires.
 */
function withCheckStubs(fn) {
  const checkObj = t.check;
  const wx = t.syndicate.wechat;
  const orig = {
    checkArticle: checkObj.checkArticle,
    readRewrittenExport: wx.readRewrittenExport,
    probeCoverUrl: wx.probeCoverUrl,
  };
  const calls = { readRewrittenExport: [], checkArticle: [], probeCoverUrl: [] };
  checkObj.checkArticle = async (args) => { calls.checkArticle.push(args); return { ok: true, rows: [] }; };
  wx.readRewrittenExport = (siteDir, slug) => { calls.readRewrittenExport.push({ siteDir, slug }); return null; };
  wx.probeCoverUrl = async (cover) => { calls.probeCoverUrl.push(cover); return { ok: true }; };
  return Promise.resolve()
    .then(fn.bind(null, calls))
    .finally(() => {
      checkObj.checkArticle = orig.checkArticle;
      wx.readRewrittenExport = orig.readRewrittenExport;
      wx.probeCoverUrl = orig.probeCoverUrl;
    });
}

test('wechat check callback resolves t + siteDir; never emits "t is not defined"', async () => {
  await seedArticle('wx-regression-a', 1);
  await seedArticle('wx-regression-b', 2);
  const cs = t.plan.channelSchedule;
  await cs.set({ platform: 'wechat', publish_time: '08:26', count: 2 });

  await withCheckStubs(async (calls) => {
    // 08:20 local is within ±45min of 08:26 → slot due. dryRun → no writes.
    const res = await cs.publishDue({
      now: new Date(2026, 9, 11, 8, 20, 0, 0),
      dryRun: true,
      siteKey: 'tengence_test',
    });

    assert.equal(res.due.length, 1, 'wechat slot must be due');
    const result = res.results[0];
    assert.equal(result.status, 'dry_run');
    assert.equal(result.asDraft, true, 'wechat must stay draft-box');

    // THE bug: needsRepair entries were "check error: t is not defined".
    const failures = (result.needsRepair || []).flatMap((x) => x.failures || []);
    assert.ok(
      !failures.some((f) => /t is not defined|siteDir is not defined/.test(f)),
      `check callback must not throw ReferenceError; got failures: ${JSON.stringify(failures)}`
    );

    // Direct proof the callback executed its body: readRewrittenExport received a
    // concrete siteDir derived from siteKey (not undefined), and checkArticle ran.
    assert.ok(calls.readRewrittenExport.length > 0, 'readRewrittenExport must be called by the check callback');
    for (const c of calls.readRewrittenExport) {
      assert.equal(typeof c.siteDir, 'string');
      assert.ok(c.siteDir.endsWith('tengence_test'), `siteDir must resolve from siteKey, got ${c.siteDir}`);
    }
    assert.ok(calls.checkArticle.length > 0, 'checkArticle must be reached (no early ReferenceError)');

    // With all gates stubbed ok, both candidates assemble into ready (count=2).
    assert.equal(result.actualCount, 2, 'both gated-ok candidates should be ready');
  });
});
