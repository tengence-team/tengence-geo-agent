/**
 * plan / order — publish_order integrity: audit + repair + tail allocation
 * ============================================================================
 * `publish_order` is how "按历史发布顺序" is guaranteed: every WeChat/Juejin/CSDN
 * queue is derived by sorting on it ascending. So it must be
 *   1) an INTEGER (2026-11-13: 12 rows held the literal strings "written" / "queued"),
 *   2) ONE number per article (a slug's three language rows share it),
 *   3) UNIQUE across articles.
 *
 * (1) and (3) are now refused at the write layer (db/plan.upsert + the partial
 * unique index uq_sqlite_plan_order, schema v11); this module is the one-off
 * normaliser plus the report the MCP tools expose.
 *
 * Everything here is data maintenance: dryRun first, then an explicit apply.
 * ============================================================================
 */

const { TABLES } = require('../db/schema');

const NUMERIC = /^\d+$/;

function isOrderValue(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0;
  return NUMERIC.test(String(v).trim());
}

function toOrder(v) {
  return Number(String(v).trim());
}

/**
 * Read-only report of every publish_order problem in the plan table.
 * @param {{appId:number, conn:object}} args
 */
async function audit({ appId, conn }) {
  const [rows] = await conn.query(
    `SELECT id, slug, lang, publish_order FROM ${TABLES.articlePlan}
      WHERE app_id = ? ORDER BY id`,
    [appId]
  );

  const nonNumeric = [];
  const zeroOrder = [];
  const bySlug = new Map();

  for (const r of rows) {
    const raw = r.publish_order;
    const entry = { id: Number(r.id), slug: r.slug, lang: r.lang, value: raw };
    if (!isOrderValue(raw)) {
      nonNumeric.push(entry);
      continue;
    }
    const n = toOrder(raw);
    if (n === 0) {
      zeroOrder.push(entry);
      continue;
    }
    if (!bySlug.has(r.slug)) bySlug.set(r.slug, []);
    bySlug.get(r.slug).push({ ...entry, order: n });
  }

  // one article = one number
  const crossLangMismatch = [];
  for (const [slug, langs] of bySlug) {
    const distinct = Array.from(new Set(langs.map((l) => l.order)));
    if (distinct.length > 1) {
      crossLangMismatch.push({
        slug,
        values: langs.map((l) => ({ id: l.id, lang: l.lang, order: l.order })),
      });
    }
  }

  // one number = one article
  const owners = new Map();
  for (const [slug, langs] of bySlug) {
    const n = langs[0].order;
    if (!owners.has(n)) owners.set(n, []);
    owners.get(n).push(slug);
  }
  const crossSlugDuplicate = [];
  for (const [order, slugs] of owners) {
    if (slugs.length > 1) crossSlugDuplicate.push({ order, slugs });
  }

  const slugsWithoutValidOrder = Array.from(bySlug.keys()).length;
  const totalSlugs = new Set(rows.map((r) => r.slug)).size;

  return {
    counts: {
      rows: rows.length,
      slugs: totalSlugs,
      slugsWithOrder: slugsWithoutValidOrder,
      nonNumeric: nonNumeric.length,
      zeroOrder: zeroOrder.length,
      crossLangMismatch: crossLangMismatch.length,
      crossSlugDuplicate: crossSlugDuplicate.length,
    },
    nonNumeric,
    zeroOrder,
    crossLangMismatch,
    crossSlugDuplicate,
  };
}

/** Highest integer order currently in the table (0 when none). */
async function maxOrder({ appId, conn }) {
  const [rows] = await conn.query(
    // CAST: legacy rows hold the TEXT 'written'/'queued' in this integer column,
    // and MAX() over a mixed-type column returns that text (Number() -> NaN -> 0),
    // which would restart the tail at 1 and shove old articles to the front.
    `SELECT MAX(CAST(publish_order AS INTEGER)) AS m FROM ${TABLES.articlePlan} WHERE app_id = ?`,
    [appId]
  );
  const m = rows && rows.length ? Number(rows[0].m) : 0;
  return Number.isFinite(m) ? m : 0;
}

/**
 * Allocate the next tail number (max + 1). Callers that need several must call
 * this once per row, in the order they want the rows to sit.
 */
async function nextOrder({ appId, conn }) {
  return (await maxOrder({ appId, conn })) + 1;
}

/**
 * Normalise every publish_order problem. DryRun by default.
 *
 * Order of operations:
 *   1. the zh-hans row owns an article's number; every other language follows it
 *   2. articles whose number is missing / text / 0 get a fresh tail number,
 *      taken in `id` order so the historical sequence is preserved
 *   3. any residual cross-article collision is broken by re-numbering the later
 *      slug to the tail (never by silently swapping existing numbers)
 *
 * @param {{appId:number, apply?:boolean, conn:object}} args
 */
async function repair({ appId, apply = false, conn }) {
  const before = await audit({ appId, conn });
  if (!apply) {
    const preview = await buildPlan({ appId, conn, before });
    return { applied: false, before: before.counts, plan: preview };
  }

  const { changes, assignments } = await buildPlan({ appId, conn, before, apply: true });
  const applied = [];
  for (const a of changes) {
    if (a.type === 'assign') {
      await conn.query(
        `UPDATE ${TABLES.articlePlan} SET publish_order = ? WHERE app_id = ? AND slug = ?`,
        [a.order, appId, a.slug]
      );
      applied.push(a);
    } else if (a.type === 'sync') {
      await conn.query(
        `UPDATE ${TABLES.articlePlan} SET publish_order = ?
          WHERE app_id = ? AND slug = ? AND lang <> 'zh-hans' AND publish_order <> ?`,
        [a.order, appId, a.slug, a.order]
      );
      applied.push(a);
    }
  }
  const after = await audit({ appId, conn });
  return { applied: true, before: before.counts, after: after.counts, assignments, changes: applied };
}

/** Compute what repair() would do (no writes). */
async function buildPlan({ appId, conn, before, apply = false }) {
  const [rows] = await conn.query(
    `SELECT id, slug, lang, publish_order FROM ${TABLES.articlePlan}
      WHERE app_id = ? ORDER BY id`,
    [appId]
  );

  const bySlug = new Map();
  for (const r of rows) {
    if (!bySlug.has(r.slug)) bySlug.set(r.slug, []);
    bySlug.get(r.slug).push(r);
  }

  let tail = (await maxOrder({ appId, conn })) + 1;
  const actions = [];
  const assignments = [];

  // canonical number per slug = zh-hans when usable, else any usable language row
  const canonical = new Map();
  for (const [slug, langs] of bySlug) {
    const hans = langs.find((l) => String(l.lang).toLowerCase() === 'zh-hans');
    const usable = (l) => isOrderValue(l.publish_order) && toOrder(l.publish_order) > 0;
    const pick = (hans && usable(hans) ? hans : langs.find(usable)) || null;
    canonical.set(slug, pick ? toOrder(pick.publish_order) : null);
  }

  // step 2: assign a tail number to articles with no usable number (id order)
  const orderedSlugs = Array.from(bySlug.keys()).sort(
    (a, b) => Number(bySlug.get(a)[0].id) - Number(bySlug.get(b)[0].id)
  );
  for (const slug of orderedSlugs) {
    if (canonical.get(slug) !== null) continue;
    const order = tail++;
    canonical.set(slug, order);
    actions.push({ type: 'assign', slug, order, reason: 'no usable integer order' });
    assignments.push({ slug, order });
  }

  // step 3: break residual cross-article collisions (later slug moves to the tail)
  const owners = new Map();
  for (const slug of orderedSlugs) {
    const n = canonical.get(slug);
    if (n === null) continue;
    if (!owners.has(n)) owners.set(n, []);
    owners.get(n).push(slug);
  }
  for (const [n, slugs] of owners) {
    if (slugs.length < 2) continue;
    for (const slug of slugs.slice(1)) {
      const order = tail++;
      canonical.set(slug, order);
      actions.push({ type: 'assign', slug, order, reason: `order ${n} was shared with ${slugs[0]}` });
      assignments.push({ slug, order });
    }
  }

  // step 1: every language row follows its article's number
  for (const slug of orderedSlugs) {
    const order = canonical.get(slug);
    const langs = bySlug.get(slug) || [];
    const drifting = langs.filter((l) => toOrder(l.publish_order) !== order);
    if (drifting.length) {
      const assign = actions.find((a) => a.type === 'assign' && a.slug === slug);
      if (!assign) actions.push({ type: 'sync', slug, order });
    }
  }

  return {
    dryRun: !apply,
    actions: actions.length,
    changes: actions,
    assignments,
    nonNumericFixed: before.nonNumeric.length,
    zeroFixed: before.zeroOrder.length,
    langRowsRealigned: before.crossLangMismatch.length,
    collisionsBroken: before.crossSlugDuplicate.length,
    nextTail: tail,
  };
}

module.exports = { audit, repair, nextOrder, maxOrder, isOrderValue };
