#!/usr/bin/env node
/**
 * Plugin API (tengence/v1/posts) SDK integration smoke — E-batch migration verification
 * ============================================================================
 * Verifies wp.posts.getMeta / saveMeta / update(meta stripping) against a live site:
 *   1. Read-only: read meta of an already-published article (default 993), assert no
 *      prefixed keys and no _yoast.
 *   2. Full chain: create a test draft (WP API, no meta) → saveMeta writes 7 keys →
 *      getMeta read-back assertions → update the body (meta stripped without error)
 *      → delete the draft.
 * Requires TENGENCE_SITE_ID / TENGENCE_SECRET in sites/tengence/.env.
 *
 * Usage: node dev/sdk-plugin-meta-smoke.js [published-article-ID] [--keep]
 *   --keep keeps the test draft instead of deleting it (default cleans up)
 */

const t = require('../packages/geo-sdk');
const assert = require('node:assert/strict');

const EXISTING_ID = Number(process.argv[2] || 993);
const KEEP = process.argv.includes('--keep');

function line() { console.log('-'.repeat(70)); }

async function main() {
  console.log('='.repeat(70));
  console.log('Plugin API meta SDK integration smoke');
  console.log('='.repeat(70));

  // 1. read-only: existing article meta
  console.log(`\n[1] Read meta of published article ${EXISTING_ID} (plugin API)`);
  const existingMeta = await t.wp.posts.getMeta(EXISTING_ID);
  const keys = Object.keys(existingMeta).sort();
  console.log(`  ✓ read OK, ${keys.length} fields`);
  console.log(`  keys: ${keys.join(', ')}`);
  assertNoPrefixedOrYoast(keys, existingMeta);
  if (keys.length === 0) {
    console.log('  ⚠️ article meta is empty (no SEO/GEO data), continuing');
  }

  // 2. create a test draft (WP API, without meta)
  console.log('\n[2] Create test draft (WP API, no meta)');
  const draft = await t.wp.posts.create({
    title: '[E-smoke] Plugin API meta test draft',
    content: '<p>Temporary draft to verify the saveMeta / getMeta chain; deleted afterwards.</p>',
    status: 'draft',
    slug: 'e-batch-meta-smoke-' + Date.now(),
  });
  const draftId = draft.id;
  console.log(`  ✓ draft created ID=${draftId}`);

  try {
    // 3. saveMeta writes 7 keys
    console.log('\n[3] saveMeta writes 7 SEO/GEO fields (plugin API)');
    const payload = {
      seo_meta_title: '[E-smoke] Test title',
      seo_meta_description: 'Integration smoke test description.',
      seo_meta_keywords: ['smoke', 'plugin-api'],
      geo_ai_summary: 'Integration smoke summary.',
      geo_qa_pairs: [{ question: 'Smoke question?', answer: 'Smoke answer.' }],
      geo_citations: [{ url: 'https://example.com/smoke', title: 'Smoke source' }],
      geo_key_takeaways: ['Smoke takeaway one', 'Smoke takeaway two'],
    };
    const saved = await t.wp.posts.saveMeta(draftId, payload);
    console.log(`  ✓ written OK, read back ${Object.keys(saved).length} fields`);
    assertNoPrefixedOrYoast(Object.keys(saved), saved);

    // 4. getMeta read-back assertions
    console.log('\n[4] getMeta read-back assertions');
    const read = await t.wp.posts.getMeta(draftId);
    assert.equal(read.seo_meta_title, payload.seo_meta_title, 'seo_meta_title matches');
    assert.equal(read.seo_meta_description, payload.seo_meta_description, 'seo_meta_description matches');
    assert.deepEqual(read.seo_meta_keywords, payload.seo_meta_keywords, 'keywords array matches');
    assert.equal(read.geo_ai_summary, payload.geo_ai_summary, 'geo_ai_summary matches');
    assert.ok(Array.isArray(read.geo_qa_pairs) && read.geo_qa_pairs.length === 1, 'qa_pairs array');
    assert.equal(read.geo_qa_pairs[0].question, 'Smoke question?', 'qa question matches');
    assert.ok(Array.isArray(read.geo_citations) && read.geo_citations.length === 1, 'citations array');
    assert.ok(Array.isArray(read.geo_key_takeaways) && read.geo_key_takeaways.length === 2, 'takeaways array');
    console.log('  ✓ all assertions passed');

    // 5. update body (meta stripping must not error)
    console.log('\n[5] posts.update updates body (meta fields stripped)');
    const updated = await t.wp.posts.update(draftId, {
      title: '[E-smoke] Test title (updated)',
      status: 'draft',
      meta: { seo_meta_title: 'should-not-write' }, // should be stripped + warning
    });
    assert.equal(updated.title?.raw || updated.title, '[E-smoke] Test title (updated)');
    const read2 = await t.wp.posts.getMeta(draftId);
    assert.equal(read2.seo_meta_title, payload.seo_meta_title, 'meta untouched by update');
    console.log('  ✓ body updated OK, meta stays independent');
  } finally {
    // 6. cleanup
    if (KEEP) {
      console.log(`\n[6] --keep specified, keeping draft ${draftId}`);
    } else {
      console.log(`\n[6] Deleting test draft ${draftId}`);
      await t.wp.api(`/posts/${draftId}?force=true`, { method: 'DELETE' });
      console.log('  ✓ deleted');
    }
  }

  console.log('\n✓ Integration smoke all passed');
  line();
}

function assertNoPrefixedOrYoast(keys, meta) {
  const bad = keys.filter((k) => k.startsWith('tengence_') || k.includes('_yoast_'));
  if (bad.length) {
    throw new Error(`plugin API meta should not contain prefixed/dead keys: ${bad.join(', ')}`);
  }
  console.log('  ✓ key-name contract OK (no tengence_ prefix, no _yoast_*)');
}

main().catch((error) => {
  console.error('\n✗ Integration smoke failed:', error.message);
  if (process.env.DEBUG) console.error(error.stack);
  process.exit(1);
});
