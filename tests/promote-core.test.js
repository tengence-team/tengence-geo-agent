/**
 * Unified promote-to-publish core (node:test)
 * ============================================================================
 * Regression guard for the 2026-11-05 "plan says published / WP says future"
 * drift. WordPress core (wp_insert_post "Scheduled posts") silently coerces
 * status=publish with a future post_date into `future` (scheduled, hidden),
 * while the old per-entry publish code marked the plan table published without
 * ever re-reading the real status. The core (packages/geo-sdk/publish/promote)
 * is now the single draft→publish action:
 *   1. clamp    — future publish slots are pulled back to now (past-or-now only)
 *   2. verify   — the REAL status is re-read after the write; only `publish`
 *                 counts as success
 *   3. plan     — the plan write-back is per-language and happens ONLY after
 *                 verification
 * ============================================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  clampToPastOrNow,
  isFutureDate,
  verifyPublished,
  confirmPlanPublished,
  promoteToPublish,
} = require('../packages/geo-sdk/publish/promote');

// ---------------------------------------------------------------- helpers

/** A "YYYY-MM-DDTHH:MM:SS" slot ~1h in the future (site-local naive string). */
function futureSlot() {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

/** A "YYYY-MM-DDTHH:MM:SS" slot ~1h in the past. */
function pastSlot() {
  const d = new Date(Date.now() - 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

/** Fake wp facade; `statusAfterUpdate` simulates what WP really stored. */
function fakeWp({ currentDate = null, statusAfterUpdate = 'publish' } = {}) {
  const calls = { updates: [], gets: 0 };
  return {
    calls,
    posts: {
      async get(id, fields) {
        calls.gets += 1;
        if (calls.updates.length === 0) {
          return { id, status: 'draft', link: null, date: currentDate, date_gmt: currentDate };
        }
        return {
          id,
          status: statusAfterUpdate,
          link: `https://www.tengence.com/blog/article/x/`,
          date: currentDate,
          date_gmt: currentDate,
        };
      },
      async update(id, patch) {
        calls.updates.push(patch);
        return { id, ...patch };
      },
    },
  };
}

function fakePlan() {
  const calls = [];
  return {
    calls,
    async markPublished(slug, fields, opts) {
      calls.push({ slug, fields, opts });
      return { updated: 1 };
    },
    async markQueued() {
      return { updated: 1 };
    },
  };
}

// ---------------------------------------------------------------- clamp

test('clampToPastOrNow: a future slot is clamped to ~now', () => {
  const logs = [];
  const out = clampToPastOrNow(futureSlot(), (m) => logs.push(m));
  const ts = Date.parse(`${out}+08:00`);
  assert.ok(!Number.isNaN(ts), `clamped output must parse, got ${out}`);
  assert.ok(Math.abs(Date.now() - ts) < 5 * 60 * 1000, 'clamped slot must be ~now');
  assert.ok(logs.length === 1, 'clamping must log a warning');
});

test('clampToPastOrNow: past and present slots pass through untouched', () => {
  const past = pastSlot();
  assert.equal(clampToPastOrNow(past), past);
  assert.equal(clampToPastOrNow(null), null);
  assert.equal(clampToPastOrNow(''), null);
});

test('isFutureDate: detects future, rejects past', () => {
  assert.equal(isFutureDate(futureSlot()), true);
  assert.equal(isFutureDate(pastSlot()), false);
  assert.equal(isFutureDate(null), false);
});

// ---------------------------------------------------------------- verify + plan

test('verifyPublished: re-reads the real status from the wp facade', async () => {
  const wp = fakeWp();
  const live = await verifyPublished(wp, 42);
  assert.equal(live.status, 'draft'); // no update yet → facade reports draft
  assert.equal(wp.calls.gets, 1);
});

test('confirmPlanPublished: writes the plan row for THIS language only', async () => {
  const plan = fakePlan();
  const ok = await confirmPlanPublished(plan, {
    slug: 'some-slug',
    lang: 'en',
    wpPostId: 3069,
    link: 'https://www.tengence.com/blog/article/some-slug/',
  });
  assert.equal(ok, true);
  assert.equal(plan.calls.length, 1);
  assert.equal(plan.calls[0].opts.lang, 'en');
});

// ---------------------------------------------------------------- promoteToPublish

test('promoteToPublish: future-dated draft → clamped update, verified, per-lang plan write', async () => {
  const wp = fakeWp({ currentDate: futureSlot(), statusAfterUpdate: 'publish' });
  const plan = fakePlan();
  const logs = [];
  const r = await promoteToPublish(
    { wp, plan },
    { postId: 3068, slug: 'some-slug', lang: 'zh-hans', log: (m) => logs.push(m) },
  );
  assert.equal(r.ok, true, `expected ok, got: ${JSON.stringify(r)}`);
  assert.equal(wp.calls.updates.length, 1);
  // the update must carry a clamped (≈now) date even though none was passed
  const patch = wp.calls.updates[0];
  assert.equal(patch.status, 'publish');
  assert.ok(patch.date, 'future-dated post must get an explicit clamped date');
  const ts = Date.parse(`${patch.date}+08:00`);
  assert.ok(Math.abs(Date.now() - ts) < 5 * 60 * 1000, 'patch date must be ~now');
  // plan written exactly once, for the given language
  assert.equal(plan.calls.length, 1);
  assert.equal(plan.calls[0].opts.lang, 'zh-hans');
});

test('promoteToPublish: explicit future slot is clamped before the update', async () => {
  const wp = fakeWp({ statusAfterUpdate: 'publish' });
  const plan = fakePlan();
  const future = futureSlot();
  const r = await promoteToPublish(
    { wp, plan },
    { postId: 1, slug: 's', lang: 'en', publishDate: future, log: () => {} },
  );
  assert.equal(r.ok, true);
  const patch = wp.calls.updates[0];
  assert.notEqual(patch.date, future, 'future slot must not reach WP unclamped');
});

test('promoteToPublish: WP parked the post as future → NOT ok, plan untouched', async () => {
  const wp = fakeWp({ statusAfterUpdate: 'future' });
  const plan = fakePlan();
  const r = await promoteToPublish(
    { wp, plan },
    { postId: 1, slug: 's', lang: 'zh-hans', log: () => {} },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /future/);
  assert.equal(plan.calls.length, 0, 'plan must NOT be marked published without verification');
});

test('promoteToPublish: update throws → NOT ok, plan untouched', async () => {
  const wp = {
    posts: {
      async get() { return { id: 1, status: 'draft', link: null }; },
      async update() { throw new Error('REST 500'); },
    },
  };
  const plan = fakePlan();
  const r = await promoteToPublish(
    { wp, plan },
    { postId: 1, slug: 's', lang: 'zh-hans', log: () => {} },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /promote to publish failed/);
  assert.equal(plan.calls.length, 0);
});
