/**
 * Product-page URL normalization (tengence-geo-sdk/content/product-links)
 * ============================================================================
 * 2026-11-23 — the website moved its product pages under `/products/` and made
 * every static route language-prefixed and slash-less:
 *
 *   https://www.tengence.com/{lang}/products/{slug}     (zh-hans | en | zh-hant)
 *
 * Legacy bodies still ship three broken families:
 *   · `/tengence-search`            → 301 to /en/... (a Chinese article sends readers
 *                                     to the English page)
 *   · `/tengence-insight`           → 404 (the old insight page is gone)
 *   · `/products/tengence-rayview`  → 404 (Rayview is the retired English name)
 *   · `/products/tengence-search/`  → 403 (static product routes reject a trailing slash)
 *
 * This module rewrites the product-page URL only — it never re-renders the body,
 * never recomputes SEO/GEO and never touches title/cover/status/dates. It shares
 * the same write discipline as content/link-repair.js: DB columns first, then the
 * live WP post resolved by slug+language (the DB wp_post_id can be shared across
 * language rows and must not be trusted blindly).
 *
 *   auditProductLinks  — READ-ONLY inventory (dry-run)
 *   repairProductLinks — apply (default dryRun=true); re-reads and verifies 0 residue
 * ============================================================================
 */

const LANGS = ['zh-hans', 'zh-hant', 'en'];
const PRODUCT_SLUGS = ['tengence-search', 'tengence-insight', 'tengence-geo', 'tengence-rayview'];
const SLUG_GROUP = /(tengence-(?:search|insight|geo|rayview))/;

function normLang(lang) {
  const k = String(lang || '').trim().toLowerCase();
  return LANGS.includes(k) ? k : 'zh-hans';
}

/** Rayview (睿见's retired English name) maps to Insight by default. */
function targetSlug(slug, opts = {}) {
  if (slug === 'tengence-rayview' && opts.rayviewToInsight !== false) return 'tengence-insight';
  return slug;
}

function canonical(lang, slug, opts) {
  return `https://www.tengence.com/${normLang(lang)}/products/${targetSlug(slug, opts)}`;
}

function allowedProducts(opts = {}) {
  const want = Array.isArray(opts.products) && opts.products.length ? opts.products.map(String) : null;
  return want ? PRODUCT_SLUGS.filter((p) => want.includes(p)) : PRODUCT_SLUGS;
}

/** Build the regex pair for the requested product set (no state between calls). */
function buildRegexes(opts = {}) {
  const allowed = allowedProducts(opts);
  const group = allowed.length === PRODUCT_SLUGS.length
    ? SLUG_GROUP.source
    : `(tengence-(?:${allowed.map((p) => p.replace('tengence-', '')).join('|')}))`;
  const abs = new RegExp(
    `https?:\\/\\/(?:www\\.)?tengence\\.com\\/(?:(?:zh-hans|zh-hant|en)\\/)?(?:products\\/)?${group}\\/?(?![A-Za-z0-9\\-\\/_])`,
    'g'
  );
  const rel = new RegExp(
    `([\\s"'([|>])(\\/(?:(?:zh-hans|zh-hant|en)\\/)?(?:products\\/)?${group}\\/?)(?![A-Za-z0-9\\-\\/_])`,
    'g'
  );
  return { abs, rel };
}

/**
 * Read-only scan: every product-page URL that is not the canonical form.
 * @returns {{count:number, links:Array<{raw:string, expected:string}>}}
 */
function scanProductLinks(text, lang, opts = {}) {
  const out = { count: 0, links: [] };
  if (!text) return out;
  const s = String(text);
  const { abs, rel } = buildRegexes(opts);
  let m;
  while ((m = abs.exec(s))) {
    const slug = m[1];
    const want = canonical(lang, slug, opts);
    if (m[0] !== want) { out.count++; out.links.push({ raw: m[0], expected: want }); }
  }
  while ((m = rel.exec(s))) {
    const path = m[2];
    const slug = m[3];
    const want = canonical(lang, slug, opts).replace('https://www.tengence.com', '');
    if (path !== want) { out.count++; out.links.push({ raw: path, expected: want }); }
  }
  return out;
}

/** Rewrite the product-page URL only. Idempotent. */
function rewriteProductLinks(text, lang, opts = {}) {
  const empty = { text: text || '', before: [], after: [], changed: 0 };
  if (!text) return empty;
  const { abs, rel } = buildRegexes(opts);
  const before = [];
  let s = String(text);
  s = s.replace(abs, (m, slug) => {
    const want = canonical(lang, slug, opts);
    if (m === want) return m; // already canonical — no change, no record
    before.push(m);
    return want;
  });
  s = s.replace(rel, (m, pre, path, slug) => {
    const want = canonical(lang, slug, opts).replace('https://www.tengence.com', '');
    if (path === want) return m;
    before.push(path);
    return pre + want;
  });
  const after = scanProductLinks(s, lang, opts).links.map((x) => x.raw);
  return { text: s, before, after, changed: before.length };
}

/** Apply the rewrite to a parsed seo/geo object graph (strings only). */
function rewriteJsonValue(value, lang, opts, acc) {
  if (typeof value === 'string') {
    const r = rewriteProductLinks(value, lang, opts);
    if (r.changed) { acc.before.push(...r.before); acc.changed += r.changed; }
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => rewriteJsonValue(v, lang, opts, acc));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewriteJsonValue(v, lang, opts, acc);
    return out;
  }
  return value;
}

function parseJson(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (e) { return null; }
}

/** Resolve the real WP post id for slug+lang, falling back to the DB mirror. */
async function resolveWpId(t, slug, lang, wpPostId, siteKey) {
  try {
    const real = await t.wp.plugin.findPostByLanguage(slug, lang, { siteKey });
    if (real && real.id) return Number(real.id);
  } catch (e) { /* fall back */ }
  return wpPostId && Number(wpPostId) > 0 ? Number(wpPostId) : null;
}

async function fetchWp(t, postId, siteKey) {
  const post = await t.wp.api(`/posts/${postId}?_fields=id,status,content`, { siteKey });
  const html = (post.content && (post.content.raw || post.content.rendered)) || '';
  return { id: Number(postId), status: post.status, html };
}

/**
 * Audit or repair the product-page URLs of every article row (and optionally the
 * WP posts that have no DB row).
 *
 * @param {object} opts
 *   appId, site, dryRun (default true), langs, statuses, slugs,
 *   includeWp (default true), wpSlugs (array of {slug, lang}) for WP-only posts,
 *   products (default all three + rayview alias), rayviewToInsight (default true),
 *   maxResults (default 200)
 */
async function repairProductLinks(opts = {}) {
  const t = require('../index');
  const appId = parseInt(opts.appId || process.env.APP_ID || '1', 10);
  const dryRun = opts.dryRun !== false; // default = READ-ONLY
  const siteKey = opts.site || null;
  const includeWp = opts.includeWp !== false;
  const langs = Array.isArray(opts.langs) && opts.langs.length ? opts.langs.map(normLang) : null;
  const statuses = Array.isArray(opts.statuses) && opts.statuses.length ? opts.statuses : null;
  const optsRule = { products: opts.products, rayviewToInsight: opts.rayviewToInsight !== false };

  let wanted = null;
  if (Array.isArray(opts.slugs) && opts.slugs.length) {
    wanted = opts.slugs.map((s) => (typeof s === 'string' ? { slug: s, lang: null } : { slug: String(s.slug), lang: s.lang ? normLang(s.lang) : null }));
  }

  const rows = await t.db.withConn(async (conn) => {
    const where = ['app_id = ?'];
    const params = [appId];
    if (langs) { where.push(`lang IN (${langs.map(() => '?').join(',')})`); params.push(...langs); }
    if (statuses) { where.push(`status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses); }
    const [list] = await conn.query(
      `SELECT id, slug, lang, status, wp_post_id, content_longtext, content_html, seo, geo
         FROM tengence_geo_articles WHERE ${where.join(' AND ')}`,
      params
    );
    return list || [];
  });

  const results = [];
  const errors = [];
  const totals = {
    rowsScanned: 0, rowsAffected: 0, wpChecked: 0,
    dbLinksBefore: 0, dbLinksAfter: 0, wpLinksBefore: 0, wpLinksAfter: 0,
    rowsWritten: 0, wpWritten: 0, remaining: 0,
  };

  for (const row of rows) {
    if (wanted && !wanted.some((w) => w.slug === row.slug && (!w.lang || w.lang === row.lang))) continue;
    totals.rowsScanned++;
    const lang = normLang(row.lang);
    const mdBefore = scanProductLinks(row.content_longtext, lang, optsRule);
    const htmlBefore = scanProductLinks(row.content_html, lang, optsRule);
    const seoObj = parseJson(row.seo);
    const geoObj = parseJson(row.geo);
    const seoAcc = { changed: 0, before: [] };
    const geoAcc = { changed: 0, before: [] };
    const seoAfterObj = seoObj ? rewriteJsonValue(seoObj, lang, optsRule, seoAcc) : null;
    const geoAfterObj = geoObj ? rewriteJsonValue(geoObj, lang, optsRule, geoAcc) : null;

    // Live WP surface (published or draft post). A post can drift from the DB body.
    let wp = null;
    if (includeWp && Number(row.wp_post_id) > 0) {
      try {
        const id = await resolveWpId(t, row.slug, lang, row.wp_post_id, siteKey);
        if (id) { wp = await fetchWp(t, id, siteKey); totals.wpChecked++; }
      } catch (e) { errors.push({ slug: row.slug, lang, stage: 'wp-read', error: e.message }); }
    }
    const wpBefore = wp ? scanProductLinks(wp.html, lang, optsRule) : { count: 0, links: [] };

    const dbChanged = mdBefore.count + htmlBefore.count + seoAcc.changed + geoAcc.changed;
    const wpChanged = wp ? wpBefore.count : 0;
    totals.dbLinksBefore += dbChanged;
    totals.wpLinksBefore += wpChanged;
    if (!dbChanged && !wpChanged) continue;
    totals.rowsAffected++;

    const mdRes = rewriteProductLinks(row.content_longtext, lang, optsRule);
    const htmlRes = rewriteProductLinks(row.content_html, lang, optsRule);
    const wpRes = wp ? rewriteProductLinks(wp.html, lang, optsRule) : null;

    // WP plugin meta (geo citations / canonical) — the reader-facing AI citation list
    let metaBefore = 0;
    let metaPatch = null;
    if (wp) {
      try {
        const meta = await t.wp.plugin.getPostMeta(wp.id, { siteKey });
        const acc = { changed: 0, before: [] };
        const next = {};
        for (const key of ['geo_citations', 'seo_canonical_url']) {
          if (meta[key] === undefined || meta[key] === null) continue;
          const rewritten = rewriteJsonValue(meta[key], lang, optsRule, acc);
          if (acc.changed) next[key] = rewritten;
        }
        if (acc.changed) { metaBefore = acc.changed; metaPatch = next; }
      } catch (e) { errors.push({ slug: row.slug, lang, stage: 'wp-meta-read', error: e.message }); }
    }
    totals.wpLinksBefore += metaBefore;

    const entry = {
      slug: row.slug, lang, status: row.status, wp_post_id: row.wp_post_id || null,
      wp_id: wp ? wp.id : null,
      db: { md: mdBefore.count, html: htmlBefore.count, seo: seoAcc.changed, geo: geoAcc.changed },
      wp: wp ? { content: wpBefore.count, meta: metaBefore, status: wp.status } : null,
      links: [...mdBefore.links, ...htmlBefore.links, ...wpBefore.links].slice(0, 6),
      dryRun,
    };

    if (dryRun) {
      entry.ok = true;
      entry.after = { md: mdRes.after.length, html: htmlRes.after.length, wp: wpRes ? wpRes.after.length : null };
      results.push(entry);
      continue;
    }

    try {
      // 1) DB columns — only the changed ones, no lastmod/updated_at writes
      const sets = [];
      const vals = [];
      if (mdRes.changed) { sets.push('content_longtext = ?'); vals.push(mdRes.text); }
      if (htmlRes.changed && row.content_html) { sets.push('content_html = ?'); vals.push(htmlRes.text); }
      if (seoAcc.changed && seoObj) { sets.push('seo = ?'); vals.push(JSON.stringify(seoAfterObj)); }
      if (geoAcc.changed && geoObj) { sets.push('geo = ?'); vals.push(JSON.stringify(geoAfterObj)); }
      if (sets.length) {
        await t.db.withConn(async (conn) => {
          await conn.query(`UPDATE tengence_geo_articles SET ${sets.join(', ')} WHERE id = ?`, [...vals, row.id]);
        });
        totals.rowsWritten++;
      }

      // 2) Live WP content
      if (wp && wpRes && wpRes.changed) {
        await t.wp.api(`/posts/${wp.id}`, { method: 'POST', siteKey, body: { content: wpRes.text } });
        totals.wpWritten++;
      }
      // 3) Live WP plugin meta (geo citations / canonical)
      if (wp && metaPatch) {
        await t.wp.plugin.updatePostMeta(wp.id, metaPatch, { siteKey });
        totals.wpWritten++;
      }

      // 4) Re-read and verify zero residue on both surfaces
      const check = await t.db.withConn(async (conn) => {
        const [r2] = await conn.query(
          'SELECT content_longtext, content_html, seo, geo FROM tengence_geo_articles WHERE id = ?',
          [row.id]
        );
        return r2 && r2[0] ? r2[0] : null;
      });
      let dbAfter = 0;
      if (check) {
        dbAfter += scanProductLinks(check.content_longtext, lang, optsRule).count;
        dbAfter += scanProductLinks(check.content_html, lang, optsRule).count;
        const s2 = parseJson(check.seo); const g2 = parseJson(check.geo);
        if (s2) dbAfter += scanProductLinks(JSON.stringify(s2), lang, optsRule).count;
        if (g2) dbAfter += scanProductLinks(JSON.stringify(g2), lang, optsRule).count;
      }
      let wpAfter = 0;
      if (wp) {
        try {
          const post2 = await fetchWp(t, wp.id, siteKey);
          wpAfter += scanProductLinks(post2.html, lang, optsRule).count;
          const meta2 = await t.wp.plugin.getPostMeta(wp.id, { siteKey });
          for (const key of ['geo_citations', 'seo_canonical_url']) {
            if (meta2[key] !== undefined && meta2[key] !== null) wpAfter += scanProductLinks(JSON.stringify(meta2[key]), lang, optsRule).count;
          }
        } catch (e) { errors.push({ slug: row.slug, lang, stage: 'wp-verify', error: e.message }); }
      }
      totals.dbLinksAfter += dbAfter;
      totals.wpLinksAfter += wpAfter;
      totals.remaining += dbAfter + wpAfter;
      entry.after = { db: dbAfter, wp: wpAfter };
      entry.ok = dbAfter + wpAfter === 0;
      if (!entry.ok) entry.remaining = (await t.db.withConn(async (conn) => {
        const [r3] = await conn.query('SELECT content_longtext, content_html FROM tengence_geo_articles WHERE id = ?', [row.id]);
        return r3 && r3[0] ? { md: scanProductLinks(r3[0].content_longtext, lang, optsRule).links.slice(0, 3), html: scanProductLinks(r3[0].content_html, lang, optsRule).links.slice(0, 3) } : null;
      }));
    } catch (e) {
      entry.ok = false;
      entry.error = e.message;
      errors.push({ slug: row.slug, lang, stage: 'write', error: e.message });
    }
    results.push(entry);
  }

  // 5) WP-only rows (live posts without an article row)
  if (Array.isArray(opts.wpSlugs) && opts.wpSlugs.length) {
    for (const w of opts.wpSlugs) {
      const lang = normLang(w.lang);
      try {
        const id = await resolveWpId(t, w.slug, lang, null, siteKey);
        if (!id) { errors.push({ slug: w.slug, lang, stage: 'wp-only-resolve', error: 'post not found' }); continue; }
        const post = await fetchWp(t, id, siteKey);
        totals.wpChecked++;
        const before = scanProductLinks(post.html, lang, optsRule);
        let metaBefore = 0; let metaPatch = null;
        const meta = await t.wp.plugin.getPostMeta(id, { siteKey });
        const acc = { changed: 0, before: [] };
        const next = {};
        for (const key of ['geo_citations', 'seo_canonical_url']) {
          if (meta[key] === undefined || meta[key] === null) continue;
          const rewritten = rewriteJsonValue(meta[key], lang, optsRule, acc);
          if (acc.changed) next[key] = rewritten;
        }
        if (acc.changed) { metaBefore = acc.changed; metaPatch = next; }
        totals.wpLinksBefore += before.count + metaBefore;
        if (!before.count && !metaBefore) continue;
        totals.rowsAffected++;
        const entry = { slug: w.slug, lang, status: post.status, wp_id: id, wpOnly: true, db: { md: 0, html: 0, seo: 0, geo: 0 }, wp: { content: before.count, meta: metaBefore, status: post.status }, links: before.links.slice(0, 6), dryRun };
        if (dryRun) { entry.ok = true; results.push(entry); continue; }
        const res = rewriteProductLinks(post.html, lang, optsRule);
        if (res.changed) { await t.wp.api(`/posts/${id}`, { method: 'POST', siteKey, body: { content: res.text } }); totals.wpWritten++; }
        if (metaPatch) { await t.wp.plugin.updatePostMeta(id, metaPatch, { siteKey }); totals.wpWritten++; }
        const post2 = await fetchWp(t, id, siteKey);
        const after = scanProductLinks(post2.html, lang, optsRule).count;
        totals.wpLinksAfter += after; totals.remaining += after;
        entry.after = { db: 0, wp: after }; entry.ok = after === 0;
        results.push(entry);
      } catch (e) {
        errors.push({ slug: w.slug, lang, stage: 'wp-only', error: e.message });
      }
    }
  }

  const maxResults = Number(opts.maxResults || 200);
  return {
    ok: errors.length === 0 && (dryRun || totals.remaining === 0),
    dryRun,
    scope: { langs, statuses, products: allowedProducts(optsRule), rayviewToInsight: optsRule.rayviewToInsight, includeWp },
    totals,
    results: results.slice(0, maxResults),
    truncated: results.length > maxResults,
    errors,
  };
}

async function auditProductLinks(opts = {}) {
  return repairProductLinks({ ...opts, dryRun: true });
}

module.exports = { auditProductLinks, repairProductLinks, scanProductLinks, rewriteProductLinks, PRODUCT_SLUGS, normLang };
