/**
 * Research-brief citation ledger backfill (tengence-geo-sdk/content/research-brief)
 * ================================================================================
 * 2026-11-15 — the B2 ledger row of check_article ("citation URLs present in research
 * brief") failed on 73 rows: the brief existed but did not carry the URLs the body
 * actually cites, so an already-published article could not be re-saved (and a
 * re-write would have been gated). The fix is not to loosen the gate: the brief is
 * the ledger, so the missing URLs are appended to it with the title the body already
 * carries.
 *
 *   auditBriefs — read-only: for every row, which body citation URLs are absent from
 *                 articles.research_md.
 *   backfillBriefCitations — append a dedicated section listing exactly those
 *                 missing citations (title + URL), then re-read the brief and confirm
 *                 the ledger is clean. Idempotent: URLs already present are skipped,
 *                 and the section is only written when something is genuinely missing.
 *
 * The judgement of "which URLs the body cites" is NOT re-implemented here: it uses the
 * same SSOT `content/md.js::parseGeoBlocks` the gate reads, so a backfilled brief can
 * never disagree with what check_article sees.
 * ================================================================================
 */

const md = require('./md');

const LANGS = ['zh-hans', 'zh-hant', 'en'];

function normLang(lang) {
  const k = String(lang || '').trim().toLowerCase();
  return LANGS.includes(k) ? k : 'zh-hans';
}

function bodyCitations(text) {
  try {
    return (md.parseGeoBlocks(String(text || '')).citations || [])
      .filter((c) => c && String(c.url || '').trim())
      .map((c) => ({ title: String(c.title || '').trim(), url: String(c.url).trim() }));
  } catch {
    return [];
  }
}

function missingInBrief(cites, brief) {
  const b = String(brief || '');
  return cites.filter((c) => !b.includes(c.url));
}

const fs = require('fs');
const path = require('path');

/**
 * The gate reads a FILE brief first and the DB column second. Patching only the DB row
 * therefore left the reader-facing verdict red (check_article kept reporting the same
 * missing URLs), so every writer must repair whichever copy the gate will actually read.
 */
function briefFileFor(siteDir, lang, slug) {
  if (!siteDir) return null;
  return path.join(String(siteDir), 'data', 'inbox', normLang(lang), String(slug) + '.research.md');
}

async function loadRows(appId, filter = {}) {
  const t = require('../index');
  return t.db.withConn(async (conn) => {
    const where = ['app_id = ?', 'content_longtext IS NOT NULL'];
    const params = [appId];
    if (filter.lang) { where.push('lang = ?'); params.push(normLang(filter.lang)); }
    if (filter.slug) { where.push('slug = ?'); params.push(String(filter.slug)); }
    if (filter.status) { where.push('status = ?'); params.push(String(filter.status)); }
    const [rows] = await conn.query(
      `SELECT id, slug, lang, status, wp_post_id, content_longtext, research_md
         FROM tengence_geo_articles WHERE ${where.join(' AND ')}`
,
      params
    );
    return rows;
  });
}

/**
 * @returns {Promise<{ok:boolean, total:number, affected:Array<object>, summary:object}>}
 */
async function auditBriefs(opts = {}) {
  const appId = parseInt(opts.appId || process.env.APP_ID || '1', 10);
  const rows = await loadRows(appId, { lang: opts.lang, slug: opts.slug, status: opts.status });
  const affected = [];
  let missingUrlCount = 0;
  for (const r of rows) {
    const cites = bodyCitations(r.content_longtext);
    const fp = briefFileFor(opts.siteDir, r.lang, r.slug);
    const fileBrief = fp && fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : null;
    const brief = fileBrief !== null ? String(fileBrief) : (r.research_md ? String(r.research_md) : '');
    const miss = brief ? missingInBrief(cites, brief) : [];
    if (!miss.length) continue;
    missingUrlCount += miss.length;
    affected.push({
      id: r.id, slug: r.slug, lang: r.lang, status: r.status, wpPostId: r.wp_post_id,
      cited: cites.length, missing: miss.length, urls: miss.map((m) => m.url),
    });
  }
  return {
    ok: true,
    total: rows.length,
    affected,
    summary: { rows: affected.length, missingUrls: missingUrlCount },
  };
}

const SECTION_HEADING = '## 正文引用来源（B2 ledger 补齐）';

function appendSection(brief, miss, today) {
  const lines = [];
  const base = String(brief || '');
  const hasHeading = base.includes(SECTION_HEADING);
  if (!hasHeading) {
    lines.push('');
    lines.push(SECTION_HEADING);
    lines.push('');
    lines.push(`> 由正文「数据来源」逐条回填，仅收录 brief 原本缺失的引用（${today}）。`);
  } else {
    lines.push('');
  }
  for (const c of miss) {
    const title = c.title || c.url;
    lines.push(`- ${title} — ${c.url}`);
  }
  return base + lines.join('\n') + '\n';
}

/**
 * @param {{appId?:number, slug?:string, lang?:string, status?:string, dryRun?:boolean, slugs?:Array<object>}} opts
 */
async function backfillBriefCitations(opts = {}) {
  const t = require('../index');
  const appId = parseInt(opts.appId || process.env.APP_ID || '1', 10);
  const dryRun = opts.dryRun !== false;
  const today = opts.today || new Date().toISOString().slice(0, 10);

  const rows = await loadRows(appId, { lang: opts.lang, slug: opts.slug, status: opts.status });
  const scoped = Array.isArray(opts.slugs) && opts.slugs.length
    ? rows.filter((r) => opts.slugs.some((s) => s.slug === r.slug && (!s.lang || normLang(s.lang) === r.lang)))
    : rows;

  const results = [];
  for (const r of scoped) {
    const cites = bodyCitations(r.content_longtext);
    const filePath = briefFileFor(opts.siteDir, r.lang, r.slug);
    const fileBrief = filePath && fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
    const brief = fileBrief !== null ? String(fileBrief) : (r.research_md ? String(r.research_md) : '');
    if (!brief) {
      // B2 is n/a without a brief (a brief has to be WRITTEN, not backfilled). Not a failure
      // of this operation, so it stays ok:true and is reported as skipped.
      results.push({ slug: r.slug, lang: r.lang, status: r.status, ok: true, skipped: 'no research brief (B2 n/a — needs a brief written, not a backfill)' });
      continue;
    }
    const miss = missingInBrief(cites, brief);
    if (!miss.length) {
      results.push({ slug: r.slug, lang: r.lang, status: r.status, ok: true, missing: 0 });
      continue;
    }
    const next = appendSection(brief, miss, today);
    // write-exit verification: the appended brief must now carry every cited URL
    const still = missingInBrief(cites, next);
    if (still.length) {
      results.push({ slug: r.slug, lang: r.lang, status: r.status, ok: false, error: 'append did not resolve ' + still.length + ' url(s)' });
      continue;
    }
    if (dryRun) {
      results.push({ slug: r.slug, lang: r.lang, status: r.status, ok: true, dryRun: true, missing: miss.length, preview: next.slice(-600) });
      continue;
    }
    let readback = '';
    if (fileBrief !== null) {
      fs.writeFileSync(filePath, next, 'utf8');
      readback = fs.readFileSync(filePath, 'utf8');
    } else {
      await t.db.withConn(async (conn) => {
        await conn.query('UPDATE tengence_geo_articles SET research_md = ? WHERE id = ?', [next, r.id]);
      });
      readback = await t.db.withConn(async (conn) => {
        const [x] = await conn.query('SELECT research_md FROM tengence_geo_articles WHERE id = ? LIMIT 1', [r.id]);
        return x && x[0] ? String(x[0].research_md) : '';
      });
    }
    const after = missingInBrief(cites, readback);
    results.push({
      slug: r.slug, lang: r.lang, status: r.status,
      ok: after.length === 0, added: miss.length, remaining: after.length,
      brief: fileBrief !== null ? 'file' : 'articles.research_md',
    });
  }

  return {
    ok: results.every((x) => x.ok),
    dryRun,
    summary: {
      checked: scoped.length,
      updated: results.filter((x) => !x.dryRun && x.ok && x.added).length,
      missingRows: results.filter((x) => x.added || x.missing).length,
      addedUrls: results.reduce((a, x) => a + (x.added || 0), 0),
      failed: results.filter((x) => !x.ok).length,
    },
    results,
  };
}

module.exports = { auditBriefs, backfillBriefCitations, bodyCitations, missingInBrief };
