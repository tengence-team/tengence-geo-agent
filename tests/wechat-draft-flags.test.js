'use strict';
/**
 * WeChat draft flags: applyDraftFlags(article, fm)
 * ============================================================================
 * Per WeChat official docs (cgi-bin/draft/add), the ONLY article-level flags the
 * API can set are the comment controls:
 *   - need_open_comment:     0=off, 1=on
 *   - only_fans_can_comment: 0=everyone, 1=fans only
 * Comments are enabled BY DEFAULT (need_open_comment = 1) for the official
 * account. fm.fansOnlyComment can restrict to fans only.
 *
 * Flags that are NOT settable via API (silently dropped by WeChat — confirmed by
 * mp backend inspection on 2026-09-26) and must be toggled in the mp editor:
 *   - 原创 (original)  → no original_article_type field
 *   - 赞赏 (reward)    → no reward_wording field
 *   - 广告 (ads)       → auto-inserted for 流量主 accounts, no field
 *   - 推荐 (recommend) → algorithm-controlled, no field
 * This test HARDENS that contract: applyDraftFlags must never emit unsupported
 * fields, and must default comments ON. Pure unit test — no network, no DB.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyDraftFlags } = require('../packages/geo-sdk/syndicate/wechat');

const base = {
  title: 'T',
  content: '<p>x</p>',
  thumb_media_id: 'm',
};

test('default (empty fm) → comments ON, everyone can comment', () => {
  const out = applyDraftFlags(base, {});
  assert.equal(out.need_open_comment, 1, 'comments enabled by default');
  assert.equal(out.only_fans_can_comment, 0, 'everyone can comment by default');
});

test('fm null (no front matter) → comments ON, no crash (regression 2026-09-26)', () => {
  // parseFrontMatter returns data:null for articles without front matter; the
  // null-safe guard must not throw here.
  const out = applyDraftFlags(base, null);
  assert.equal(out.need_open_comment, 1);
  assert.equal(out.only_fans_can_comment, 0);
});

test('fm undefined → comments ON, no crash (default param)', () => {
  const out = applyDraftFlags(base);
  assert.equal(out.need_open_comment, 1);
  assert.equal(out.only_fans_can_comment, 0);
});

test('fansOnlyComment:true → only fans can comment, comments still ON', () => {
  const out = applyDraftFlags(base, { fansOnlyComment: true });
  assert.equal(out.need_open_comment, 1);
  assert.equal(out.only_fans_can_comment, 1);
});

test('fansOnlyComment:false → everyone can comment', () => {
  const out = applyDraftFlags(base, { fansOnlyComment: false });
  assert.equal(out.only_fans_can_comment, 0);
});

test('NO unsupported fields are emitted (原创/赞赏/广告/推荐 are API-unsupported)', () => {
  const out = applyDraftFlags(base, {});
  for (const key of ['original_article_type', 'reward_wording', 'ad_count', 'comment_enabled', 'article_type']) {
    assert.equal(out[key], undefined, `must NOT emit ${key} (silently dropped by WeChat)`);
  }
});

test('base article fields are preserved', () => {
  const out = applyDraftFlags(base, {});
  assert.equal(out.title, 'T');
  assert.equal(out.content, '<p>x</p>');
  assert.equal(out.thumb_media_id, 'm');
});
