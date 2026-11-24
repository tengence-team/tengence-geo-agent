'use strict';
/**
 * G19 WP taxonomy gate (2026-11-24 rewrite) — packages/geo-sdk/check/index.js
 *
 * The rule changed from "plan taxonomy must exist in WP" to "WP is the judge":
 *   hard     — the live post carries at least one category and at least one tag;
 *   advisory — whether the locally staged plan taxonomy matches WP.
 *
 * These tests exercise wpTaxRows() directly, so the verdict is pinned without a
 * site/DB/WP harness. Row shape: [name, value, ok, advisory, alwaysHard].
 *
 * Run: node --test tests/g19-wp-taxonomy.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { wpTaxRows } = require('../packages/geo-sdk/check');

const HARD_CAT = 'WP taxonomy (G19): WP post carries a category (hard)';
const HARD_TAGS = 'WP taxonomy (G19): WP post carries tags (hard)';
const ADV_CAT = 'WP taxonomy (G19): plan category matched in WP (advisory)';
const ADV_TAGS = 'WP taxonomy (G19): plan tags matched in WP (advisory)';

const rowByName = (rows, name) => rows.find((r) => r[0] === name);

/** Same aggregation rule checkArticle uses. */
const gateFails = (rows) => rows.some(([, , ok, soft]) => !ok && !soft);

const checkedTax = (over) => ({
  checked: true,
  wpCats: [128],
  wpTags: [301, 302],
  wpCatCount: 1,
  wpTagCount: 2,
  planCat: 'geo-ai-search',
  planCatId: 128,
  missingCats: [],
  planTagCount: 3,
  missingPlanTags: [],
  missingTagCount: 0,
  advisoryError: '',
  extraCats: [],
  extraTags: [],
  ...over,
});

test('published post with categories and tags passes, even when the plan disagrees', () => {
  // Plan moved (2026-11-17 batch rewrite) and WP did not: this used to be a hard
  // failure on 96 live posts.
  const rows = wpTaxRows(
    checkedTax({ planCat: 'data-growth', planCatId: 999, missingCats: ['data-growth'], planTagCount: 2, missingPlanTags: ['ai-ask'], missingTagCount: 1 }),
    true
  );
  assert.equal(rows.length, 4);
  assert.equal(gateFails(rows), false, 'plan/WP drift must never block a publish');

  const adv = rowByName(rows, ADV_TAGS);
  assert.equal(adv[2], true);
  assert.equal(adv[3], true, 'plan tag row is advisory');
  assert.match(String(adv[1]), /1\/2 plan tags in WP/, 'advisory reports the overlap');
  assert.match(String(adv[1]), /missing: ai-ask/, 'advisory names the missing tag slug');

  const advCat = rowByName(rows, ADV_CAT);
  assert.match(String(advCat[1]), /not on this post/, 'plan category absent from the post is reported');
});

test('published post with an empty WP tag list is a hard failure', () => {
  const rows = wpTaxRows(checkedTax({ wpTags: [], wpTagCount: 0 }), true);
  const tags = rowByName(rows, HARD_TAGS);
  assert.equal(tags[2], false);
  assert.equal(tags[3], false, 'stays hard on an already-published article');
  assert.equal(tags[4], true, 'alwaysHard survives the isPublished demotion loop');
  assert.match(String(tags[1]), /EMPTY/);
  assert.equal(gateFails(rows), true);
});

test('published post with an empty WP category list is a hard failure', () => {
  const rows = wpTaxRows(checkedTax({ wpCats: [], wpCatCount: 0 }), true);
  const cat = rowByName(rows, HARD_CAT);
  assert.equal(cat[2], false);
  assert.match(String(cat[1]), /EMPTY/);
  assert.equal(gateFails(rows), true);
});

test('advisory lookup errors never turn the hard rows red', () => {
  // taxonomy endpoint hiccup: plan side unknown, WP side already read fine
  const rows = wpTaxRows(checkedTax({ advisoryError: 'ETIMEDOUT' }), true);
  assert.equal(gateFails(rows), false, 'a taxonomy-endpoint failure is not an editorial defect');
  assert.match(String(rowByName(rows, ADV_CAT)[1]), /advisory unavailable: ETIMEDOUT/);
  assert.match(String(rowByName(rows, ADV_TAGS)[1]), /advisory unavailable: ETIMEDOUT/);
  assert.equal(rowByName(rows, HARD_TAGS)[2], true, 'hard rows keep judging the WP post');
});

test('no plan category/tags: WP still judged, plan rows say n/a', () => {
  const rows = wpTaxRows(checkedTax({ planCat: '', planCatId: null, missingCats: [], planTagCount: 0, missingPlanTags: [], missingTagCount: 0 }), true);
  assert.equal(gateFails(rows), false);
  assert.equal(rowByName(rows, ADV_CAT)[1], 'no plan category (n/a)');
  assert.equal(rowByName(rows, ADV_TAGS)[1], 'no plan tags (n/a)');
});

test('post lookup failure blocks a published article, but drafts stay n/a', () => {
  const failed = wpTaxRows({ checked: false, error: 'WP 401' }, true);
  assert.equal(gateFails(failed), true, 'an unreadable live post cannot be verified');
  assert.match(String(rowByName(failed, HARD_TAGS)[1]), /lookup failed: WP 401/);

  const draft = wpTaxRows({ checked: false }, false);
  assert.equal(gateFails(draft), false, 'a draft has no WP post to judge yet');
  assert.match(String(rowByName(draft, HARD_TAGS)[1]), /n\/a \(draft/);
});
