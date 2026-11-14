/**
 * Internal-link language audit & repair (tengence-geo-sdk/content/link-repair)
 * ============================================================================
 * 2026-11-14 — the article-body links of a zh-hans page were pointing at
 * `.../en/blog/article/...` (and legacy bodies carried bare `/blog/article/...`
 * links that resolve to another language). The rule is one:
 *
 *   every on-site link in a body must carry the BODY'S OWN language prefix —
 *   zh-hans → /zh-hans/, en → /en/, zh-hant → /zh-hant/.
 *
 * The judgement is NOT duplicated here: it calls the same SSOT
 * `content/md.js::internalLinkLanguageIssues` that check_article (writing +
 * publish gate) and the translation gate T10 use, so a body can never pass one
 * gate and fail another.
 *
 * This module is the maintenance side of the same rule:
 *   auditLinks  — read-only: list every row (draft + published) whose body has
 *                 a wrong/missing language prefix, with the offending links.
 *   repairLinks — rewrite `articles.content_longtext` and, for published rows,
 *                 the live WP post content, then re-verify. Idempotent.
 *
 * All writes stay inside the geo-mcp interface (the MCP tool wraps this module);
 * no caller pokes MySQL / WP directly.
 * ============================================================================
 */

const md = require('./md');

const LANGS = ['zh-hans', 'zh-hant', 'en'];

function normLang(lang) {
  const k = String(lang || '').trim().toLowerCase();
  return LANGS.includes(k) ? k : 'zh-hans';
}

/**
 * Audit every article body for internal links whose language prefix does not match
 * the body's language.
 * @param {{appId?:number, langs?:string[], slug?:string, statuses?:string[],
 *           includeWp?:boolean, site?:string}} [opts]
 *   includeWp: also read the LIVE WP content of published rows (the reader-facing
 *              surface can drift from the DB body — legacy posts were published
 *              before the write-exit normalization existed).
 * @returns {Promise<{ok:boolean, total:number, affected:Array<object>, summary:object}>}
 */
async function auditLinks(opts = {}) {
  const t = require('../index');
  const appId = parseInt(opts.appId || process.env.APP_ID || '1', 10);
  const langs = Array.isArray(opts.langs) && opts.langs.length ? opts.langs.map(normLang) : null;
  const statuses = Array.isArray(opts.statuses) && opts.statuses.length ? opts.statuses : null;
  const siteKey = opts.site || null;

  const rows = await t.db.withConn(async (conn) => {
    const where = ['app_id = ?'];
    const params = [appId];
    if (langs) { where.push(`lang IN (${langs.map(() => '?').join(',')})`); params.push(...langs); }
    if (statuses) { where.push(`status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses); }
    if (opts.slug) { where.push('slug = ?'); params.push(String(opts.slug)); }
    const [list] = await conn.query(
      `SELECT id, slug, lang, status, wp_post_id, content_longtext
         FROM tengence_geo_articles
        WHERE ${where.join(' AND ')}`,
      params
    );
    return list || [];
  });

  const affected = [];
  const summary = { rows: 0, rowsWithHard: 0, hardLinks: 0, missing: 0, wrong: 0, publishedRows: 0, draftRows: 0, mdHardRows: 0, wpHardRows: 0, wpChecked: 0 };
  for (const r of rows) {
    summary.rows++;
    const body = String(r.content_longtext || '');
    if (!body.trim()) continue;
    const lang = normLang(r.lang);
    const { hard, soft } = md.internalLinkLanguageIssues(body, lang);
    let wpHard = [];
    let wpPostIdReal = null;
    if (opts.includeWp && Number(r.wp_post_id) > 0) {
      try {
        const fetchWp = async (id) => {
          const post = await t.wp.api(`/posts/${id}?_fields=id,content`, { siteKey });
          return (post.content && (post.content.raw || post.content.rendered)) || '';
        };
        const rawHtml = await fetchWp(r.wp_post_id);
        wpHard = md.internalLinkLanguageIssues(rawHtml, lang).hard;
        summary.wpChecked++;
        // wp_post_id pollution (a known pitfall): several language rows of one slug
        // can share ONE wp id, so auditing "the DB's id" may grade another language's
        // post. Resolve the real post by slug+language before trusting the verdict.
        if (wpHard.length) {
          try {
            const real = await t.wp.plugin.findPostByLanguage(r.slug, lang, { siteKey });
            if (real && Number(real.id) !== Number(r.wp_post_id)) {
              wpPostIdReal = Number(real.id);
              const realHtml = await fetchWp(wpPostIdReal);
              wpHard = md.internalLinkLanguageIssues(realHtml, lang).hard;
            }
          } catch { /* keep the DB-id verdict */ }
        }
      } catch (e) {
        wpHard = [];
      }
    }
    if (!hard.length && !wpHard.length) continue;
    summary.rowsWithHard++;
    if (hard.length) summary.mdHardRows++;
    if (wpHard.length) summary.wpHardRows++;
    summary.hardLinks += hard.length + wpHard.length;
    for (const x of [...hard, ...wpHard]) {
      if (x.kind === 'article-missing-lang') summary.missing++;
      else summary.wrong++;
    }
    summary[Number(r.wp_post_id) > 0 ? 'publishedRows' : 'draftRows']++;
    affected.push({
      slug: r.slug,
      lang,
      status: Number(r.wp_post_id) > 0 ? 'publish' : r.status,
      wp_post_id: Number(r.wp_post_id) > 0 ? Number(r.wp_post_id) : null,
      wp_post_id_real: wpPostIdReal,
      expected: md.langToPrefix(lang),
      sources: [hard.length ? 'md' : null, wpHard.length ? 'wp' : null].filter(Boolean),
      hard: hard.map((x) => ({ kind: x.kind, slug: x.slug || null, path: x.path || null, href: x.href, found: x.found })),
      wpHard: wpHard.map((x) => ({ kind: x.kind, slug: x.slug || null, path: x.path || null, href: x.href, found: x.found })),
      softCount: soft.length,
    });
  }
  return { ok: true, total: summary.rows, affected, summary };
}

/**
 * Rewrite wrong/missing internal-link language prefixes in the DB body and in the
 * live WP post content. Idempotent; re-verifies every body after the rewrite.
 * @param {{appId?:number, site?:string, slugs?:Array<{slug:string,lang?:string}>|string[],
 *           langs?:string[], dryRun?:boolean}} [opts]
 */
async function repairLinks(opts = {}) {
  const t = require('../index');
  const appId = parseInt(opts.appId || process.env.APP_ID || '1', 10);
  const dryRun = opts.dryRun !== false; // default is READ-ONLY: a caller must ask to write
  const siteKey = opts.site || null;

  // Resolve target rows: explicit slug list wins, else audit all.
  let wanted = null;
  if (Array.isArray(opts.slugs) && opts.slugs.length) {
    wanted = opts.slugs.map((s) => (typeof s === 'string' ? { slug: s, lang: null } : { slug: String(s.slug), lang: s.lang ? normLang(s.lang) : null }));
  }
  const audit = await auditLinks({ appId, langs: opts.langs, slug: null, includeWp: true, site: siteKey });
  const targets = audit.affected.filter((a) => !wanted || wanted.some((w) => w.slug === a.slug && (!w.lang || w.lang === a.lang)));

  const results = [];
  for (const a of targets) {
    const row = await t.db.withConn(async (conn) => {
      const [rows] = await conn.query(
        'SELECT id, slug, lang, wp_post_id, content_longtext FROM tengence_geo_articles WHERE app_id = ? AND slug = ? AND lang = ? LIMIT 1',
        [appId, a.slug, a.lang]
      );
      return rows[0] || null;
    });
    if (!row) { results.push({ slug: a.slug, lang: a.lang, skipped: 'row not found' }); continue; }

    const before = a.hard.length + (a.wpHard ? a.wpHard.length : 0);
    // Target existence (per-language): rewriting a link to the article's own prefix
    // must never turn a working link into a 404. Every target slug is resolved in the
    // article's language; missing ones are reported separately (pre-existing dead links
    // need a content decision — replace or drop — not a prefix rewrite).
    const targetSlugs = [...new Set([...a.hard, ...(a.wpHard || [])]
      .filter((x) => x.kind.startsWith('article') && x.slug).map((x) => x.slug))];
    let deadTargets = [];
    if (targetSlugs.length) {
      try {
        deadTargets = await t.db.withConn(async (conn) => {
          const [rows] = await conn.query(
            `SELECT slug FROM tengence_geo_articles
              WHERE app_id = ? AND lang = ? AND wp_post_id > 0
                AND slug IN (${targetSlugs.map(() => '?').join(',')})`,
            [appId, a.lang, ...targetSlugs]
          );
          const have = new Set((rows || []).map((r) => r.slug));
          return targetSlugs.filter((s) => !have.has(s));
        });
      } catch { deadTargets = []; }
    }
    const newBody = md.rewriteInternalArticleLinks(row.content_longtext, a.lang);
    const verify = md.internalLinkLanguageIssues(newBody, a.lang);
    const entry = {
      slug: a.slug, lang: a.lang, wp_post_id: row.wp_post_id || null,
      before, after: verify.hard.length, changed: newBody !== row.content_longtext,
      deadTargets, // target slugs not published in this language (pre-existing 404s)
    };

    if (verify.hard.length) {
      // Never write a half-fixed body: a rule that cannot be satisfied means the
      // link shape is unexpected (e.g. a relative or redirect URL) — surface it.
      entry.ok = false;
      entry.remaining = verify.hard.slice(0, 5);
      results.push(entry);
      continue;
    }
    if (dryRun) {
      entry.ok = true;
      entry.dryRun = true;
      results.push(entry);
      continue;
    }

    // 1) DB body (the authoring SSOT the gate reads)
    if (newBody !== row.content_longtext) {
      await t.db.withConn(async (conn) => {
        await conn.query('UPDATE tengence_geo_articles SET content_longtext = ? WHERE id = ?', [newBody, row.id]);
      });
    }

    // 2) Live WP body — resolve the REAL post by slug+language first. The DB's
    // wp_post_id can be shared across the language rows of one slug (known pollution),
    // and writing "the DB id" would stamp the wrong language's links onto a live page.
    let wpPostId = null;
    try {
      const real = await t.wp.plugin.findPostByLanguage(a.slug, a.lang, { siteKey });
      if (real && real.id) wpPostId = Number(real.id);
    } catch { wpPostId = null; }
    if (!wpPostId && Number(row.wp_post_id) > 0) wpPostId = Number(row.wp_post_id);
    if (wpPostId) {
      try {
        const post = await t.wp.api(`/posts/${wpPostId}?_fields=id,status,content`, { siteKey });
        const rawHtml = (post.content && (post.content.raw || post.content.rendered)) || '';
        const newHtml = md.rewriteInternalArticleLinks(rawHtml, a.lang);
        const htmlVerify = md.internalLinkLanguageIssues(newHtml, a.lang);
        entry.wpPostId = wpPostId;
        entry.wpStatus = post.status;
        if (Number(row.wp_post_id) !== wpPostId) entry.wpMappingDrift = `db=${row.wp_post_id} real=${wpPostId}`;
        if (htmlVerify.hard.length) {
          entry.ok = false;
          entry.wpAfter = htmlVerify.hard.length;
          entry.wp = 'not updated: rewritten HTML still has ' + htmlVerify.hard.length + ' violation(s)';
        } else if (newHtml !== rawHtml) {
          await t.wp.api(`/posts/${wpPostId}`, { method: 'POST', siteKey, body: { content: newHtml } });
          entry.wpAfter = 0;
          entry.wp = 'content updated';
        } else {
          entry.wpAfter = 0;
          entry.wp = 'already correct';
        }
      } catch (e) {
        entry.ok = false;
        entry.wp = 'error: ' + e.message;
      }
    }
    if (entry.ok === undefined) entry.ok = true;
    entry.after = verify.hard.length + (typeof entry.wpAfter === 'number' ? entry.wpAfter : 0);
    results.push(entry);
  }

  return {
    ok: results.every((r) => r.ok !== false),
    dryRun,
    targetCount: targets.length,
    results,
  };
}

/**
 * Repair the `articles.wp_post_id` mapping itself.
 *
 * Known pitfall: one slug's three language rows can carry the SAME wp_post_id (or the
 * id of another language's post), because the translation flow once copied the value.
 * Every write path resolves the real post by slug+language, but the column stays dirty
 * and misleads everything that trusts it (state audits, re-publishes, dashboards).
 * This resolves each row through the plugin multilingual endpoint and rewrites only the
 * rows whose value genuinely differs.
 *
 * @param {{appId?:number, site?:string, slug?:string, dryRun?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, dryRun:boolean, checked:number, changed:Array<object>,
 *   unresolved:Array<object>, mismatchedDuplicates:number}>}
 */
async function repairMapping(opts = {}) {
  const t = require('../index');
  const appId = parseInt(opts.appId || process.env.APP_ID || '1', 10);
  const dryRun = opts.dryRun !== false;
  const siteKey = opts.site || null;

  const rows = await t.db.withConn(async (conn) => {
    const where = ['app_id = ?', 'wp_post_id > 0'];
    const params = [appId];
    if (opts.slug) { where.push('slug = ?'); params.push(String(opts.slug)); }
    const [list] = await conn.query(
      `SELECT id, slug, lang, wp_post_id FROM tengence_geo_articles WHERE ${where.join(' AND ')}`,
      params
    );
    return list || [];
  });

  const changed = [];
  const cleared = [];
  const unresolved = [];
  for (const r of rows) {
    let real = null;
    let lookupError = null;
    // The plugin endpoint occasionally times out; a timeout is NOT "no post exists".
    // Only a definitive `null` answer may clear a mapping, so retry the failures.
    for (let attempt = 0; attempt < 3 && !real; attempt++) {
      try {
        real = await t.wp.plugin.findPostByLanguage(r.slug, normLang(r.lang), { siteKey });
        lookupError = null;
        break;
      } catch (e) {
        lookupError = e;
        await new Promise((res) => setTimeout(res, 300 * (attempt + 1)));
      }
    }
    if (!real && lookupError) {
      unresolved.push({ slug: r.slug, lang: r.lang, dbWpPostId: Number(r.wp_post_id), error: lookupError.message });
      continue;
    }
    if (!real || !real.id) {
      // Definitive: this language has no WordPress post at all, so the id on this row
      // belongs to another language's post (the pollution case). Clearing it stops the
      // row from borrowing somebody else's body/status; it does not change the row status.
      cleared.push({ slug: r.slug, lang: r.lang, from: Number(r.wp_post_id), reason: 'no WP post for this language' });
      if (!dryRun) {
        await t.db.withConn(async (conn) => {
          await conn.query('UPDATE tengence_geo_articles SET wp_post_id = 0 WHERE id = ?', [r.id]);
        });
      }
      continue;
    }
    const realId = Number(real.id);
    if (realId === Number(r.wp_post_id)) continue;
    changed.push({
      slug: r.slug, lang: r.lang, from: Number(r.wp_post_id), to: realId,
      fromStatus: real.status || null,
    });
    if (!dryRun) {
      await t.db.withConn(async (conn) => {
        await conn.query('UPDATE tengence_geo_articles SET wp_post_id = ? WHERE id = ?', [realId, r.id]);
      });
    }
  }

  // Re-read the mapping to report residual duplicate ids (should be zero after the fix).
  let mismatchedDuplicates = 0;
  if (!dryRun) {
    mismatchedDuplicates = await t.db.withConn(async (conn) => {
      const [dups] = await conn.query(
        `SELECT wp_post_id, COUNT(*) c FROM tengence_geo_articles
          WHERE app_id = ? AND wp_post_id > 0 GROUP BY wp_post_id HAVING c > 1`,
        [appId]
      );
      return (dups || []).length;
    });
  }

  return { ok: true, dryRun, checked: rows.length, changed, cleared, unresolved, mismatchedDuplicates };
}

/**
 * Replace dead internal article targets (pre-existing 404s) with live same-language
 * articles, both in the DB body and in the live WP content.
 *
 * The prefix rule is applied afterwards (rewriteInternalArticleLinks), so the replacement
 * always lands as the body's own language. Each replacement target is resolved by
 * slug+language before anything is written: a replacement that is not live in that
 * language is refused, never silently written as a new 404.
 *
 * @param {{appId?:number, site?:string, replace:Record<string,string>,
 *           slugs?:Array<{slug:string,lang?:string}>|string[], dryRun?:boolean}} opts
 *   replace: { '<dead-slug>': '<live-slug>' }
 */
async function repairDeadTargets(opts = {}) {
  const t = require('../index');
  const appId = parseInt(opts.appId || process.env.APP_ID || '1', 10);
  const dryRun = opts.dryRun !== false;
  const siteKey = opts.site || null;
  const replace = opts.replace && typeof opts.replace === 'object' ? opts.replace : {};
  if (!Object.keys(replace).length) throw new Error('repairDeadTargets requires opts.replace');

  let wanted = null;
  if (Array.isArray(opts.slugs) && opts.slugs.length) {
    wanted = opts.slugs.map((s) => (typeof s === 'string' ? { slug: s, lang: null } : { slug: String(s.slug), lang: s.lang ? normLang(s.lang) : null }));
  }

  const rows = await t.db.withConn(async (conn) => {
    const [list] = await conn.query(
      `SELECT id, slug, lang, wp_post_id, content_longtext FROM tengence_geo_articles WHERE app_id = ?`,
      [appId]
    );
    return list || [];
  });

  const results = [];
  for (const r of rows) {
    const lang = normLang(r.lang);
    if (wanted && !wanted.some((w) => w.slug === r.slug && (!w.lang || w.lang === lang))) continue;
    const body = String(r.content_longtext || '');
    const hits = Object.keys(replace).filter((dead) =>
      new RegExp(`blog/article/${dead}(/|[?#"'\\)]|$)`, 'i').test(body)
    );
    if (!hits.length) continue;

    // Verify every replacement is live in THIS language before touching the body.
    const plan = [];
    const refused = [];
    for (const dead of hits) {
      const live = replace[dead];
      let post = null;
      try {
        post = await t.wp.plugin.findPostByLanguage(live, lang, { siteKey });
      } catch { post = null; }
      if (post && post.id) plan.push({ dead, live, wpPostId: Number(post.id) });
      else refused.push({ dead, live, reason: `not live in ${lang}` });
    }
    if (!plan.length) { results.push({ slug: r.slug, lang, refused, changed: false }); continue; }

    let newBody = body;
    for (const p of plan) {
      newBody = newBody.replace(new RegExp(`blog/article/${p.dead}(?=/|[?#"'\\)]|$)`, 'gi'), `blog/article/${p.live}`);
    }
    newBody = md.rewriteInternalArticleLinks(newBody, lang);
    const verify = md.internalLinkLanguageIssues(newBody, lang);
    const entry = { slug: r.slug, lang, plan, refused, changed: newBody !== body, after: verify.hard.length };
    if (verify.hard.length) {
      entry.ok = false;
      results.push(entry);
      continue;
    }
    if (!dryRun && newBody !== body) {
      await t.db.withConn(async (conn) => {
        await conn.query('UPDATE tengence_geo_articles SET content_longtext = ? WHERE id = ?', [newBody, r.id]);
      });
      // live WP body: resolve the real post, then rewrite the same dead targets there
      let wpPostId = null;
      try {
        const real = await t.wp.plugin.findPostByLanguage(r.slug, lang, { siteKey });
        if (real && real.id) wpPostId = Number(real.id);
      } catch { wpPostId = null; }
      if (!wpPostId && Number(r.wp_post_id) > 0) wpPostId = Number(r.wp_post_id);
      if (wpPostId) {
        try {
          const post = await t.wp.api(`/posts/${wpPostId}?_fields=id,status,content`, { siteKey });
          const rawHtml = (post.content && (post.content.raw || post.content.rendered)) || '';
          let newHtml = rawHtml;
          for (const p of plan) {
            newHtml = newHtml.replace(new RegExp(`blog/article/${p.dead}(?=/|[?#"'\\)]|$)`, 'gi'), `blog/article/${p.live}`);
          }
          newHtml = md.rewriteInternalArticleLinks(newHtml, lang);
          if (newHtml !== rawHtml) {
            await t.wp.api(`/posts/${wpPostId}`, { method: 'POST', siteKey, body: { content: newHtml } });
            entry.wp = 'content updated';
          } else {
            entry.wp = 'already correct';
          }
          entry.wpPostId = wpPostId;
          entry.wpStatus = post.status;
        } catch (e) {
          entry.wp = 'error: ' + e.message;
        }
      }
    }
    if (dryRun) entry.dryRun = true;
    results.push(entry);
  }

  return { ok: results.every((r) => r.ok !== false), dryRun, affected: results.length, results };
}

module.exports = { auditLinks, repairLinks, repairMapping, repairDeadTargets, normLang };
