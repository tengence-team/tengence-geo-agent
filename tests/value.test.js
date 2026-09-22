/**
 * db/value.parseJsonValue — unit tests (node:test, zero dependencies)
 * ============================================================================
 * Batch 6 consolidated three parseJsonValue copies into the single source
 * tengence-geo-sdk/db/value. This test locks down its semantics — "JSON-column
 * values read back as objects return directly / string parsing / tolerant
 * fallback". This is exactly where db-query.js's old safeParse went wrong
 * ("JSON.parse on an object → throws → always N/A").
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonValue } = require('../packages/geo-sdk/db/value');

test('null / missing → returns the fallback', () => {
  assert.deepEqual(parseJsonValue(null, []), []);
  assert.deepEqual(parseJsonValue(undefined, {}), {});
  assert.deepEqual(parseJsonValue('', []), []);
});

test('JSON-column objects read back are returned directly (no re-parse)', () => {
  const obj = { a: 1, b: [2, 3] };
  assert.strictEqual(parseJsonValue(obj), obj);
  const arr = [1, 2];
  assert.strictEqual(parseJsonValue(arr), arr);
});

test('JSON strings parse correctly', () => {
  assert.deepEqual(parseJsonValue('["x","y"]', []), ['x', 'y']);
  assert.deepEqual(parseJsonValue('{"k":1}', {}), { k: 1 });
});

test('invalid JSON → returns the fallback', () => {
  assert.deepEqual(parseJsonValue('not json', []), []);
  assert.deepEqual(parseJsonValue('not json', {}), {});
});

test('the JSON string "null" → returns the fallback (not treated as a literal null)', () => {
  assert.deepEqual(parseJsonValue('null', []), []);
});
