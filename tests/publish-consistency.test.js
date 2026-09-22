/**
 * Publish-chain consistency — the WP body must go through GEO materialization
 * (node:test, zero dependencies)
 * ============================================================================
 * Background (2026-09-16 incident): the `关键要点 / 常见问题` blocks only existed in
 * GEO meta (`geo.key_takeaways` / `geo.qa_pairs`) and were written into
 * `post_content` by **materialization at publish time**. So "materialize" is a step
 * every body-writing path must take. At the time of the incident,
 * `publish-from-db.js` already used `composeBody`, while
 * `publish-update-article.js` still wrote `markdownToHtml` output straight to the
 * DB ⇒ updating the body wiped both blocks wholesale, and the page still returned
 * 200 — a silent failure.
 *
 * This test pins that invariant: **every script under commands/ that assigns HTML
 * to the WP body must use the unified exit `buildPostHtml` (or the lower-level
 * `composeBody`)**. A new publish entry that forgets materialization turns
 * `npm test` red.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const COMMANDS_DIR = path.resolve(__dirname, '../packages/geo-cli/bin');

/** The assignment shapes that write HTML into the WP body (add new forms here) */
const CONTENT_ASSIGN_RE = /content:\s*(htmlContent|newHtml)\b/;
/** The compliant materialization exits */
const COMPOSE_RE = /buildPostHtml\s*\(|composeBody\s*\(/;

test('every script under commands/ that writes the WP body must pass through GEO materialization', () => {
  const offenders = [];
  // skip before geo-cli exists (the invariant takes effect once Phase 3 lands)
  if (!fs.existsSync(COMMANDS_DIR)) return;

  for (const file of fs.readdirSync(COMMANDS_DIR).sort()) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf8');
    if (CONTENT_ASSIGN_RE.test(src) && !COMPOSE_RE.test(src)) {
      offenders.push(file);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `The following scripts write the body into WP without GEO materialization, silently dropping 「关键要点 / 常见问题」: ${offenders.join(', ')}.\n` +
      'Fix: switch to t.content.md.buildPostHtml(markdown, geo).'
  );
});

test('buildPostHtml = markdownToHtml + composeBody (the materialized body contains both blocks)', () => {
  const { buildPostHtml } = require('../packages/geo-sdk/content/md');
  const md = '# 标题\n\n结论前置段。\n\n## 一、正文章节\n\n正文内容。';
  const geo = {
    key_takeaways: ['要点一'],
    qa_pairs: [{ question: '问题一？', answer: '答案一。' }],
  };

  const out = buildPostHtml(md, geo);
  assert.ok(out.includes('<h2>关键要点</h2>'), 'should contain the key-takeaways section');
  assert.ok(out.includes('<h2>常见问题</h2>'), 'should contain the FAQ section');
  assert.ok(out.indexOf('<h2>关键要点</h2>') < out.indexOf('<h2>一、正文章节</h2>'), 'key takeaways should precede the first body H2');
  assert.ok(out.includes('<blockquote>'), 'each FAQ Q&A should be a blockquote');

  // without geo, degrades to plain markdownToHtml without error
  const bare = buildPostHtml(md);
  assert.ok(!bare.includes('关键要点'));
  assert.ok(bare.includes('<h2>一、正文章节</h2>'));
});
