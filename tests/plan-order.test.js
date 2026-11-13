/**
 * plan / order — publish_order integrity tests (node:test, no real database)
 * ============================================================================
 * publish_order is the only thing "按历史发布顺序" is built on, so it must be
 * an integer, one number per article (three language rows share it), and unique
 * across articles. These tests pin the audit + repair behaviour.
 * ============================================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const order = require('../packages/geo-sdk/plan/order');

/** Stub connection over an in-memory row set; supports SELECT / MAX / UPDATE. */
function makeStub(rows) {
  const data = rows.map((r) => ({ ...r }));
  const calls = [];
  const conn = {
    data,
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/MAX\(CAST\(publish_order AS INTEGER\)\)/i.test(sql)) {
        const nums = data
          .map((r) => Number(r.publish_order))
          .filter((n) => Number.isInteger(n) && n > 0);
        return [[{ m: nums.length ? Math.max(...nums) : 0 }]];
      }
      if (/^\s*UPDATE/i.test(sql)) {
        const [value, appId, slug, lang] = params;
        for (const r of data) {
          if (r.slug !== slug) continue;
          if (params.length === 3) r.publish_order = value; // UPDATE ... WHERE app_id AND slug
          else if (String(r.lang) !== 'zh-hans') r.publish_order = value;
        }
        return [{ affectedRows: 1 }];
      }
      return [data];
    },
  };
  return conn;
}

const r = (id, slug, lang, publish_order) => ({ id, slug, lang, publish_order });

test('audit: flags text values, zero values, cross-language drift and shared numbers', async () => {
  const conn = makeStub([
    r(1, 'alpha', 'zh-hans', 5),
    r(2, 'alpha', 'en', 5),
    r(3, 'beta', 'zh-hans', 'written'), // text in an integer column
    r(4, 'beta', 'en', 'written'),
    r(5, 'gamma', 'zh-hans', 0), // never assigned
    r(6, 'delta', 'zh-hans', 9),
    r(7, 'delta', 'en', 12), // drift inside one article
    r(8, 'epsilon', 'zh-hans', 9), // two articles at the same position
  ]);
  const report = await order.audit({ appId: 1, conn });
  assert.equal(report.counts.nonNumeric, 2);
  assert.equal(report.counts.zeroOrder, 1);
  assert.equal(report.counts.crossLangMismatch, 1);
  assert.equal(report.counts.crossSlugDuplicate, 1);
  assert.equal(report.crossSlugDuplicate[0].order, 9);
});

test('audit: a clean table reports zero everywhere', async () => {
  const conn = makeStub([r(1, 'alpha', 'zh-hans', 1), r(2, 'alpha', 'en', 1), r(3, 'beta', 'zh-hans', 2)]);
  const report = await order.audit({ appId: 1, conn });
  assert.deepEqual(report.counts, {
    rows: 3,
    slugs: 2,
    slugsWithOrder: 2,
    nonNumeric: 0,
    zeroOrder: 0,
    crossLangMismatch: 0,
    crossSlugDuplicate: 0,
  });
});

test('repair dry-run: reports the plan and writes nothing', async () => {
  const conn = makeStub([r(1, 'alpha', 'zh-hans', 'written'), r(2, 'beta', 'zh-hans', 0)]);
  const out = await order.repair({ appId: 1, apply: false, conn });
  assert.equal(out.applied, false);
  assert.equal(out.plan.assignments.length, 2);
  assert.equal(conn.calls.filter((c) => /UPDATE/i.test(c.sql)).length, 0);
});

test('repair apply: assigns tail numbers in row-id order, so history is preserved', async () => {
  const conn = makeStub([
    r(1, 'alpha', 'zh-hans', 'written'),
    r(2, 'alpha', 'en', 'written'),
    r(3, 'beta', 'zh-hans', 0),
  ]);
  const out = await order.repair({ appId: 1, apply: true, conn });
  assert.equal(out.applied, true);
  // no usable number existed -> tail starts at 1
  const alpha = conn.data.filter((x) => x.slug === 'alpha').map((x) => x.publish_order);
  const beta = conn.data.filter((x) => x.slug === 'beta').map((x) => x.publish_order);
  assert.deepEqual(alpha, [1, 1], 'both language rows share the article number');
  assert.deepEqual(beta, [2], 'the later article gets the next tail number');
  const after = await order.audit({ appId: 1, conn });
  assert.equal(after.counts.nonNumeric, 0);
  assert.equal(after.counts.zeroOrder, 0);
  assert.equal(after.counts.crossSlugDuplicate, 0);
});

test('repair apply: realigns language rows to the zh-hans number instead of re-numbering the article', async () => {
  const conn = makeStub([
    r(1, 'alpha', 'zh-hans', 5),
    r(2, 'alpha', 'en', 12),
    r(3, 'beta', 'zh-hans', 6),
  ]);
  await order.repair({ appId: 1, apply: true, conn });
  const alpha = conn.data.filter((x) => x.slug === 'alpha');
  const hans = alpha.find((x) => x.lang === 'zh-hans');
  const en = alpha.find((x) => x.lang === 'en');
  assert.equal(hans.publish_order, 5, 'the primary language keeps its number');
  assert.equal(Number(en.publish_order), 5, 'the other language follows it');
});

test('repair apply: never moves an existing article just to break a collision twice', async () => {
  const conn = makeStub([
    r(1, 'alpha', 'zh-hans', 3),
    r(2, 'beta', 'zh-hans', 3),
    r(3, 'gamma', 'zh-hans', 4),
  ]);
  const out = await order.repair({ appId: 1, apply: true, conn });
  assert.equal(out.after.crossSlugDuplicate, 0);
  const alpha = conn.data.find((x) => x.slug === 'alpha');
  assert.equal(alpha.publish_order, 3, 'the earlier article keeps its position');
  const beta = conn.data.find((x) => x.slug === 'beta');
  assert.notEqual(beta.publish_order, 4, 'the later article is not swapped into someone else’s slot');
  assert.ok(Number(beta.publish_order) > 4, 'it goes to the tail instead');
});

test('nextOrder: tail allocation is max+1', async () => {
  const conn = makeStub([r(1, 'alpha', 'zh-hans', 88), r(2, 'beta', 'zh-hans', 30203)]);
  assert.equal(await order.nextOrder({ appId: 1, conn }), 30204);
});
