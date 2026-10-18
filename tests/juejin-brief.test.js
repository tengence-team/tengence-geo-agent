/**
 * Juejin brief_content clamp (node:test)
 * ============================================================================
 * Regression guard for the 2026-10-18 orphan-draft incident: every scheduled
 * juejin publish of `ai-search-impact-on-seo` failed with `err_no:2 参数错误`
 * at the publish stage (drafts piled up unpublished). Bisection proved the
 * trigger is `brief_content` (简介) length — juejin's publish endpoint accepts
 * ONLY [30, 150] characters (create/update do not validate; publish does):
 *   29 → reject, 30 → ok, 150 → ok, 151 → reject
 * `extractBrief` used to return the whole `> **摘要**：...` line verbatim (the
 * real article's line is 155 chars → rejected), so it now clamps into range.
 * ============================================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractBrief } = require('../packages/geo-sdk/syndicate/juejin');

const MIN = 30;
const MAX = 150;

test('extractBrief: a long 摘要 line is clamped to <=150 (the real incident)', () => {
  const brief = extractBrief(`> **摘要**：${'摘'.repeat(155)}\n\n正文第二段。`);
  assert.ok(brief.length <= MAX, `brief must be <= ${MAX}, got ${brief.length}`);
  assert.ok(brief.length > 0, 'brief must not be empty');
  // the clamped brief is a prefix of the original 摘要 text
  assert.ok('摘'.repeat(155).startsWith(brief), 'clamp must be a prefix, not a rewrite');
});

test('extractBrief: a stub 摘要 line is padded to >=30 from the body', () => {
  const brief = extractBrief(`> **摘要**：短。\n\n${'正'.repeat(80)}`);
  assert.ok(brief.length >= MIN, `brief must be >= ${MIN}, got ${brief.length}`);
  assert.ok(brief.length <= MAX, `brief must be <= ${MAX}, got ${brief.length}`);
  assert.ok(brief.startsWith('短。'), 'the stub 摘要 must lead the padded brief');
  // the 摘要 line itself must not be duplicated into the padding
  assert.ok(!brief.includes('> **摘要**'), 'padding must not repeat the 摘要 line');
});

test('extractBrief: an in-range 摘要 line passes through unchanged', () => {
  const summary = '摘'.repeat(40);
  const brief = extractBrief(`> **摘要**：${summary}\n\n正文第二段。`);
  assert.equal(brief, summary);
});

test('extractBrief: no 摘要 line falls back to the body prefix, still clamped', () => {
  const brief = extractBrief('正文开头内容'.repeat(50));
  assert.ok(brief.length >= MIN, `fallback brief must be >= ${MIN}, got ${brief.length}`);
  assert.ok(brief.length <= MAX, `fallback brief must be <= ${MAX}, got ${brief.length}`);
});

test('extractBrief: a leading H1 is dropped before the fallback', () => {
  const brief = extractBrief(`# 标题行\n\n${'正'.repeat(60)}`);
  assert.ok(!brief.startsWith('#'), 'the H1 must not leak into the brief');
  assert.ok(brief.length >= MIN && brief.length <= MAX);
});
