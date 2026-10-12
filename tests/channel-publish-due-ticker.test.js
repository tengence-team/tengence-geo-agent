'use strict';
// Unit test for the ticker's report rendering (pure, no SDK / no external calls).
// It proves the "display the published article links" requirement is met.
const test = require('node:test');
const assert = require('node:assert');
const { renderReport } = require('../scripts/channel-publish-due-ticker');

test('renders published external URLs for juejin / csdn / devto + wechat draft box', () => {
  const report = {
    ok: true,
    now: new Date().toISOString(),
    checked: 8,
    due: 3,
    audit: {
      juejin: { platform: 'juejin', liveCount: 14, total: 14 },
      csdn: { platform: 'csdn', liveCount: 10, total: 10 },
    },
    results: [
      {
        platform: 'juejin',
        publish_time: '10:00',
        status: 'published',
        asDraft: false,
        slugs: ['geo-ai-search'],
        urls: ['https://juejin.cn/post/7abc123'],
      },
      {
        platform: 'wechat',
        publish_time: '10:00',
        status: 'published',
        asDraft: true,
        slugs: ['geo-ai-search'],
      },
      {
        platform: 'csdn',
        publish_time: '10:00',
        status: 'no_due_articles',
      },
    ],
    skipped_today: [],
  };
  const text = renderReport(report, { site: 'www_tengence_com', dryRun: false }).join('\n');

  assert.ok(text.includes('https://juejin.cn/post/7abc123'), 'must show the juejin article URL');
  assert.ok(text.includes('PUBLISHED'), 'must mark real publishes as PUBLISHED');
  assert.ok(text.includes('DRAFT-BOX'), 'wechat must stay in the draft box');
  assert.ok(text.includes('slug: geo-ai-search'), 'must echo the slug next to the URL');
  assert.ok(text.includes('无待发布文章'), 'must show the no_due_articles note for csdn');
  assert.ok(text.includes('外链 1 条'), 'link count must equal 1 (wechat has no url)');
  assert.ok(text.includes('audit(审核同步): juejin:synced(14)  csdn:synced(10)'), 'audit sync line present');
});

test('renders an empty run when nothing is due', () => {
  const report = { ok: true, checked: 8, due: 0, results: [], skipped_today: [] };
  const text = renderReport(report, { site: 'www_tengence_com', dryRun: false }).join('\n');
  assert.ok(text.includes('当前无到期渠道，本次空跑'), 'empty-run message');
  assert.ok(text.includes('checked=8 · due=0'), 'shows checked/due counts');
});

test('dry-run does not claim a real publish', () => {
  const report = {
    ok: true,
    checked: 8,
    due: 1,
    results: [
      {
        platform: 'juejin',
        publish_time: '10:00',
        status: 'dry_run',
        asDraft: false,
        slugs: ['geo-ai-search'],
      },
    ],
    skipped_today: [],
  };
  const text = renderReport(report, { site: 'www_tengence_com', dryRun: true }).join('\n');
  assert.ok(text.includes('DRY-RUN'), 'mode banner shows DRY-RUN');
  assert.ok(text.includes('未执行真实发布'), 'no real publish claimed');
});
