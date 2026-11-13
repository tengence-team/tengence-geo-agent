/**
 * article-state — unit tests (node:test, no database)
 * ============================================================================
 * Pins the contract of the single status entry point:
 *   - derivation: article row wins, plan_status only speaks while no article exists
 *   - language guard: a status write without lang must throw, never hit 3 rows
 *   - illegal transitions: plan_status writes while an article exists, or
 *     post-writing states while none exists — both must throw
 *   - cover write: an unreachable URL writes nothing
 *
 *   npm test
 * ============================================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const as = require('../packages/geo-sdk/article-state');

const { STATE, derive, validateTransition } = as;

/** Stub connection: answers the merged SELECT with `oneRow`, records every query. */
function makeStub({ oneRow = null, articleRow = null } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/^\s*UPDATE/i.test(sql)) return [{ affectedRows: 1 }];
      if (/FROM\s+tengence_geo_article_plan/i.test(sql)) return [oneRow ? [oneRow] : []];
      if (/FROM\s+tengence_geo_articles/i.test(sql)) return [articleRow ? [articleRow] : []];
      return [[]];
    },
  };
}

const planRow = (over = {}) => ({
  plan_id: 1714,
  slug: 'ai-marketing-roi-measurement',
  lang: 'zh-hans',
  plan_status: 'published',
  publish_order: 88,
  publish_batch: 3,
  category: 'ai-marketing',
  tags: '["ai","roi"]',
  article_id: 1197,
  article_status: 'draft',
  article_wp_post_id: null,
  featured_image: null,
  ...over,
});

// ---------------------------------------------------------------- derivation

test('derive: no article row and plan_status=todo  -> todo', () => {
  assert.equal(derive({ planStatus: 'todo', article: null }), STATE.TODO);
});

test('derive: no article row and plan_status=paused -> paused', () => {
  assert.equal(derive({ planStatus: 'paused', article: null }), STATE.PAUSED);
});

test('derive: draft article without wp_post_id -> written', () => {
  assert.equal(derive({ planStatus: 'published', article: { id: 1, status: 'draft', wp_post_id: null } }), STATE.WRITTEN);
});

test('derive: draft article with wp_post_id -> queued', () => {
  assert.equal(derive({ article: { id: 1, status: 'draft', wp_post_id: 5044 } }), STATE.QUEUED);
});

test('derive: published article -> published, and plan_status lies are derived away', () => {
  assert.equal(derive({ planStatus: 'todo', article: { id: 1, status: 'publish', wp_post_id: 5044 } }), STATE.PUBLISHED);
});

// ---------------------------------------------------------------- read

test('read: merges plan + article into one state (draft article wins over plan=published)', async () => {
  const stub = makeStub({ oneRow: planRow() });
  const s = await as.read({ appId: 1, slug: 'ai-marketing-roi-measurement', lang: 'zh-hans', conn: stub });
  assert.equal(s.state, STATE.WRITTEN);
  assert.equal(s.articleStatus, 'draft');
  assert.equal(s.plan.publishOrder, 88);
  assert.deepEqual(s.plan.tags, ['ai', 'roi']);
});

test('read: a live article reports published + wpPostId', async () => {
  const stub = makeStub({ oneRow: planRow({ article_status: 'publish', article_wp_post_id: 5044 }) });
  const s = await as.read({ appId: 1, slug: 'x', lang: 'zh-hans', conn: stub });
  assert.equal(s.state, STATE.PUBLISHED);
  assert.equal(s.wpPostId, 5044);
});

// ---------------------------------------------------------------- language guard

test('setState: missing lang throws E_LANG_REQUIRED (never hits all three language rows)', async () => {
  const stub = makeStub({ oneRow: planRow() });
  await assert.rejects(
    () => as.setState({ appId: 1, slug: 'ai-marketing-roi-measurement', to: 'published', wpPostId: 5044, conn: stub }),
    (err) => err.code === 'E_LANG_REQUIRED'
  );
  assert.equal(stub.calls.filter((c) => /^\s*UPDATE/i.test(c.sql)).length, 0);
});

// ---------------------------------------------------------------- illegal transitions

test('setState: post-writing state while NO article row exists -> E_INVALID_TRANSITION', async () => {
  const stub = makeStub({ oneRow: planRow({ article_id: null, article_status: null, plan_status: 'todo' }) });
  await assert.rejects(
    () => as.setState({ appId: 1, slug: 'x', lang: 'zh-hans', to: 'published', wpPostId: 5044, conn: stub }),
    (err) => err.code === 'E_INVALID_TRANSITION'
  );
  assert.equal(stub.calls.filter((c) => /^\s*UPDATE/i.test(c.sql)).length, 0);
});

test('setState: writing plan_status while an article row exists -> E_INVALID_TRANSITION', async () => {
  const stub = makeStub({ oneRow: planRow() });
  await assert.rejects(
    () => as.setState({ appId: 1, slug: 'x', lang: 'zh-hans', to: 'paused', conn: stub }),
    (err) => err.code === 'E_INVALID_TRANSITION'
  );
});

test('validateTransition: published -> queued refused without allowDowngrade', () => {
  assert.throws(
    () => validateTransition({ to: 'queued', planStatus: 'published', article: { id: 1, status: 'publish', wp_post_id: 5044 } }),
    (err) => err.code === 'E_INVALID_TRANSITION'
  );
});

test('validateTransition: unknown state is refused by name', () => {
  assert.throws(
    () => validateTransition({ to: 'blocked', planStatus: 'todo', article: null }),
    (err) => err.code === 'E_INVALID_TRANSITION' && /unknown state/.test(err.message)
  );
});

// ---------------------------------------------------------------- writes

test('setState queued: writes articles.status=draft + wp_post_id, never plan_status', async () => {
  const stub = makeStub({ oneRow: planRow({ article_wp_post_id: 5044 }) });
  const r = await as.setState({ appId: 1, slug: 'x', lang: 'zh-hans', to: 'queued', wpPostId: 5044, conn: stub });
  const upd = stub.calls.filter((c) => /^\s*UPDATE/i.test(c.sql));
  assert.equal(upd.length, 1);
  assert.ok(/UPDATE\s+tengence_geo_articles/i.test(upd[0].sql));
  assert.ok(!/plan_status/i.test(upd[0].sql));
  assert.equal(r.target, 'articles.status');
  assert.equal(r.from, STATE.QUEUED);
});

test('setState published: writes status=publish + published_at', async () => {
  const stub = makeStub({ oneRow: planRow({ article_wp_post_id: 5044 }) });
  await as.setState({ appId: 1, slug: 'x', lang: 'zh-hans', to: 'published', wpPostId: 5044, at: '2026-11-13 09:05:07', conn: stub });
  const upd = stub.calls.filter((c) => /^\s*UPDATE/i.test(c.sql));
  assert.equal(upd.length, 1);
  assert.ok(/status = \?/.test(upd[0].sql));
  assert.deepEqual(upd[0].params[0], 'publish');
  assert.ok(upd[0].params.includes('2026-11-13 09:05:07'));
});

// ---------------------------------------------------------------- cover write

test('setFeaturedImage: unreachable URL writes nothing', async () => {
  const stub = makeStub({ oneRow: planRow() });
  await assert.rejects(
    () => as.setFeaturedImage({
      appId: 1, slug: 'x', url: 'https://example.com/404.jpg', conn: stub,
      probe: async () => ({ ok: false, reason: 'http 404' }),
    }),
    (err) => err.code === 'E_COVER_UNREACHABLE' && /http 404/.test(err.message)
  );
  assert.equal(stub.calls.filter((c) => /^\s*UPDATE/i.test(c.sql)).length, 0);
});

test('setFeaturedImage: reachable URL mirrors into all language rows', async () => {
  const stub = makeStub({ oneRow: planRow() });
  const r = await as.setFeaturedImage({
    appId: 1, slug: 'x', url: 'https://example.com/cover.jpg', conn: stub,
    probe: async () => ({ ok: true, status: 200, type: 'image/jpeg' }),
  });
  const upd = stub.calls.filter((c) => /^\s*UPDATE/i.test(c.sql));
  assert.equal(upd.length, 1);
  assert.ok(/UPDATE\s+tengence_geo_articles/i.test(upd[0].sql));
  assert.ok(!/AND lang = \?/.test(upd[0].sql), 'no lang clause means all language rows');
  assert.equal(r.lang, 'all');
});

test('setFeaturedImage: explicit lang narrows the update to one row', async () => {
  const stub = makeStub({ oneRow: planRow() });
  await as.setFeaturedImage({
    appId: 1, slug: 'x', url: 'https://example.com/cover.jpg', lang: 'zh-hans', conn: stub,
    probe: async () => ({ ok: true, status: 200, type: 'image/png' }),
  });
  const upd = stub.calls.filter((c) => /^\s*UPDATE/i.test(c.sql));
  assert.ok(/AND lang = \?/.test(upd[0].sql));
});
