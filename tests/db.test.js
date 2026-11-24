/**
 * db-domain queries — unit tests (node:test, zero dependencies)
 * ============================================================================
 * Uses a stub connection to capture (SQL, params), pinning the SQL shapes of
 * tengence-geo-sdk's articles.list / getDetail and terms.listCategories / listTags.
 * These SQLs came verbatim from commands/db-query.js's sink-down; changing a table
 * name or a JOIN requires changing this file first.
 *
 *   npm test
 * ============================================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const t = require('../packages/geo-sdk');
const { TABLES } = t.db;

/** Capturing stub connection */
function makeStub(firstRows = []) {
  const calls = [];
  let n = 0;
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      n += 1;
      if (n === 1 && firstRows.length) return [firstRows];
      return [[]];
    },
  };
}

/** Stub returning different results per call order (for config-hit scenarios) */
function makeSeq(returns) {
  const calls = [];
  let n = 0;
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      const r = returns[n] !== undefined ? returns[n] : [[]];
      n += 1;
      return [r]; // mysql2 wraps results as [rows, fields]; we only take the rows layer
    },
  };
}

test('articles.list: no filter → only the app_id param, with aggregation and ordering', async () => {
  const conn = makeStub();
  await t.db.articles.list(conn, 1, {});
  assert.equal(conn.calls.length, 1);
  const { sql, params } = conn.calls[0];
  assert.deepEqual(params, [1]);
  assert.match(sql, new RegExp(`FROM ${TABLES.articles} a`));
  // category/tags come from the article_plan join (2026-11-24); no GROUP_CONCAT/ GROUP BY
  assert.match(sql, new RegExp(`LEFT JOIN ${TABLES.articlePlan} p`));
  assert.match(sql, /p\.tags AS plan_tags/);
  assert.match(sql, new RegExp(`LEFT JOIN ${TABLES.categories} c`));
  assert.match(sql, /ORDER BY a\.lastmod DESC$/);
});

test('articles.list: status / lang / limit append params in order', async () => {
  const conn = makeStub();
  await t.db.articles.list(conn, 1, { status: 'publish', lang: 'zh-hans', limit: '6' });
  const { sql, params } = conn.calls[0];
  assert.deepEqual(params, [1, 'publish', 'zh-hans', 6]); // limit is parseInt'd
  assert.match(sql, /AND a\.status = \?/);
  assert.match(sql, /AND a\.lang = \?/);
  assert.match(sql, /LIMIT \?$/);
});

test('articles.list: category filters on the plan row (single param)', async () => {
  const conn = makeStub();
  await t.db.articles.list(conn, 1, { category: 'product-solutions' });
  const { sql, params } = conn.calls[0];
  assert.deepEqual(params, [1, 'product-solutions']);
  assert.match(sql, /AND p\.category = \?/);
});

test('articles.getDetail: single query, plan row supplies category/tags', async () => {
  const conn = makeStub([
    { id: 318, title: 'T', slug: 'what-is-geo', seo: null, geo: null, categories: 'GEO', plan_tags: '["geo","ai"]' },
  ]);
  const article = await t.db.articles.getDetail(conn, 1, 'what-is-geo');
  assert.equal(conn.calls.length, 1);
  assert.equal(article.id, 318);
  assert.deepEqual(conn.calls[0].params, [1, 'what-is-geo']);
  assert.match(conn.calls[0].sql, new RegExp(`LEFT JOIN ${TABLES.articlePlan} p`));
  // tags decoded from the plan row, plan_tags dropped
  assert.deepEqual(article.tags, ['geo', 'ai']);
  assert.equal(article.categories, 'GEO');
  assert.equal(article.plan_tags, undefined);
  // empty seo/geo normalized to null / []
  assert.equal(article.seo, null);
  assert.equal(article.geo, null);
  assert.deepEqual(article.qa_pairs, []);
  assert.deepEqual(article.citations, []);
});

test('articles.getDetail: seo/geo column reads drive qa/citations; single query', async () => {
  const seoCol = { title: 'T', meta_description: 'D', keywords: ['a', 'b'] };
  const geoCol = {
    ai_summary: 'S',
    key_takeaways: ['k1', 'k2'],
    qa_pairs: [{ question: 'Q', answer: 'A' }],
    citations: [{ url: 'https://x', text: 'Y' }],
  };
  const conn = makeSeq([
    [{ id: 9, title: 'T', slug: 's', seo: seoCol, geo: geoCol, plan_tags: '[]' }], // ① main (seo/geo columns + plan)
  ]);
  const article = await t.db.articles.getDetail(conn, 1, 's');
  assert.equal(conn.calls.length, 1); // no config / legacy seo/geo/qa/citations/social/vectors
  assert.deepEqual(conn.calls[0].params, [1, 's']);
  assert.deepEqual(article.tags, []);
  // the articles columns directly drive seo/geo/qa/citations
  assert.equal(article.seo.title, 'T');
  assert.deepEqual(article.geo.key_takeaways, ['k1', 'k2']);
  assert.deepEqual(article.qa_pairs, [{ question: 'Q', answer: 'A' }]);
  assert.deepEqual(article.citations, [{ url: 'https://x', text: 'Y' }]);
});

test('articles.getDetail: no hit → null and only 1 query', async () => {
  const conn = makeStub();
  const article = await t.db.articles.getDetail(conn, 1, 'no-such-slug');
  assert.equal(article, null);
  assert.equal(conn.calls.length, 1);
});

test('terms.listCategories / listTags: filter by app_id and sort by name', async () => {
  const c1 = makeStub();
  await t.db.terms.listCategories(c1, 1);
  assert.deepEqual(c1.calls[0].params, [1]);
  assert.match(c1.calls[0].sql, new RegExp(`SELECT \\* FROM ${TABLES.categories} WHERE app_id = \\? ORDER BY name$`));

  const c2 = makeStub();
  await t.db.terms.listTags(c2, 1);
  assert.deepEqual(c2.calls[0].params, [1]);
  assert.match(c2.calls[0].sql, new RegExp(`SELECT \\* FROM ${TABLES.tags} WHERE app_id = \\? ORDER BY name$`));
});

test('db domain doesn\'t open connections: functions only use the passed-in connection', async () => {
  // list / getDetail / listCategories / listTags all follow the "receive a conn,
  // never open one" convention. A stub with no methods besides query is enough to
  // prove the real connection is never touched.
  const conn = makeStub();
  await assert.doesNotReject(() => t.db.terms.listCategories(conn, 1));
  await assert.doesNotReject(() => t.db.articles.list(conn, 1, {}));
});
