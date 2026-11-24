/**
 * Dev.to tags must come from article_plan.tags (2026-11-24), the same single
 * source of truth the other channels use — not from the nearly-empty
 * articles.target_keywords column (which made every post ship with `seo, ai`).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { mapPlanTagsToDevto } = require('../packages/geo-sdk/syndicate/devto');

test('devto: plan tags map onto Dev.to tags', () => {
  assert.deepEqual(mapPlanTagsToDevto(['geo-seo', 'ai-search']), ['seo', 'ai']);
  assert.deepEqual(mapPlanTagsToDevto(['api-integration', 'tengence-search']), ['api', 'search']);
});

test('devto: synonyms collapse and the list is capped at 4', () => {
  const tags = mapPlanTagsToDevto(['geo-seo', 'technical-seo', 'schema-markup', 'ai-search', 'agentic-ai']);
  assert.deepEqual(tags, ['seo', 'ai']);
  const long = mapPlanTagsToDevto([
    'geo-seo',
    'ai-search',
    'data-analytics',
    'conversion-optimization',
    'ecommerce',
    'core-web-vitals',
  ]);
  assert.equal(long.length, 4);
});

test('devto: unknown slugs are dropped, empty input yields no tags', () => {
  assert.deepEqual(mapPlanTagsToDevto(['not-a-real-tag']), []);
  assert.deepEqual(mapPlanTagsToDevto([]), []);
  assert.deepEqual(mapPlanTagsToDevto(null), []);
});
