#!/usr/bin/env node
/**
 * Daily promotion: turn queued WP drafts into published articles
 * ============================================================================
 * The queue IS the article plan table (tengence_geo_article_plan):
 *   plan_status: todo (to write) -> written (written, image pending) -> queued (draft in place) -> published
 *   Candidates: t.plan.nextDue() —— plan_status='queued' with non-empty wp_post_id, ascending publish_order
 * Schedule params: the publish node of config/wordpress.yaml (per_day / skip_dates; not stored in the DB)
 *
 * Usage:
 *   tengence-geo promote-daily.js [--count=N] [--dry-run]
 *
 * Design points (idempotent + zero 404):
 *   1. Always picks the front-most queued row by publish_order ⇒ a missed day is not
 *      back-filled; the next day still publishes the front row, so the rhythm shifts
 *      automatically; a failed publish does not change the plan status and is retried
 *      naturally the next day.
 *   2. Before publishing, verifies every internal-link target in the body is already
 *      published; if any target is unpublished, skip the article (defer), keeping the
 *      live site 404-free.
 *   3. After publishing, writes back the plan (published + published_url) and pushes
 *      IndexNow + Baidu inclusion; a single failure only logs, no rollback.
 *
 * Exit code: 0 = normal (including skipped / empty queue); 1 = abnormal (e.g. missing schedule config)
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const t = require('@tengence/geo-sdk');
const APP_ID = Number(process.env.APP_ID || 1);

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const { flags } = t.cli.args.parse(
    {
      count: { type: 'string' },
      'dry-run': { type: 'boolean' },
      date: { type: 'string' },
      site: { type: 'string' },
      slug: { type: 'string' },
    },
    argv
  );
  return {
    count: flags.count ? parseInt(flags.count, 10) || 1 : null,
    dryRun: flags['dry-run'],
    date: flags.date || null,
    site: flags.site || null,
    // --slug accepts a comma-separated list: every language of each slug is published
    slugs: flags.slug
      ? String(flags.slug)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  };
}

const ARGS = parseArgs(process.argv.slice(2));

/**
 * Site resolution: `--site` is parsed by site-config itself (from argv, both
 * `--site k` and `--site=k`), which is why every other geo CLI simply calls
 * loadSite(). Here we only add a workspace-aware hint when it cannot be resolved —
 * an unbound process used to fall back to the non-existent "tengence" site and crash.
 */
function loadSiteOrExplain(explicit) {
  try {
    return t.site.loadSite(explicit || undefined);
  } catch (e) {
    const sites = t.site.listSites();
    throw new Error(
      `${e.message}\n  → Pass --site=<key>. Sites in this workspace: ${sites.join(', ')}`
    );
  }
}

const SITE = loadSiteOrExplain(ARGS.site);
const SITE_KEY = SITE.siteKey; // needed by every SDK WP call (plugin endpoints resolve per site)

const SCHEDULE_PATH = path.join(SITE.configDir, 'wordpress.yaml'); // schedule params merged into wordpress.publish (per_day / skip_dates)

const INTERNAL_LINK_RE = new RegExp(
  'https?://(?:www\\.)?' +
    String(SITE.site.domain || 'tengence.com').replace(/\./g, '\\.') +
    '/blog/article/([a-z0-9-]+)/?',
  'g'
);

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Schedule params (publish.per_day / publish.skip_dates) come from config/wordpress.yaml (already parsed by loadSite) */
function loadSchedule() {
  if (!SITE.wordpress || !SITE.wordpress.publish) {
    console.error(`[promote-daily] Schedule config not found: ${SCHEDULE_PATH} (wordpress.publish node)`);
    process.exit(1);
  }
  return SITE.wordpress.publish;
}

/** Extract the list of internal-article link slugs from the DB body (from 2026-09-20: DB is the
 *  single source of truth; local md moved to data/) */
async function extractInternalLinks(item) {
  const md = await t.db.withConn(async (conn) => {
    const [rows] = await conn.query(
      'SELECT content_longtext FROM tengence_geo_articles WHERE app_id = ? AND slug = ? AND lang = ? LIMIT 1',
      [APP_ID, item.slug, 'zh-cn']
    );
    return (rows[0] && rows[0].content_longtext) || '';
  });
  if (!md.trim()) return { ok: false, slugs: [], reason: `articles.content_longtext is empty: ${item.slug}` };
  const slugs = new Set();
  let m;
  INTERNAL_LINK_RE.lastIndex = 0;
  while ((m = INTERNAL_LINK_RE.exec(md)) !== null) slugs.add(m[1]);
  return { ok: true, slugs: [...slugs] };
}

/** Gate: calls t.check.checkArticle directly (2026-09-20 de-subprocessed; rendering and exit
 *  semantics match the check-article CLI) */
async function runCheck(item) {
  try {
    const report = await t.check.checkArticle({ slug: item.slug, dir: item.category });
    if (report.ok) return { ok: true };
    const lines = [];
    for (const [label, value, ok, soft] of report.rows) {
      lines.push((ok ? '✅' : (soft ? '⚠️' : '❌')) + ' ' + label + ': ' + value);
    }
    return { ok: false, reason: lines.slice(-12).join('\n') };
  } catch (e) {
    return { ok: false, reason: `❌ check-article failed: ${e.message}` };
  }
}

/**
 * Inclusion push; a failure only logs (calls t.search.indexnow / t.search.baidu directly,
 * de-subprocessed 2026-09-20).
 *
 * Multi-language: IndexNow receives every language URL (it is per-URL and free);
 * Baidu 普通收录 is quota-bound and only indexes the zh-cn site, so translations are
 * pushed there only through the canonical-language URL.
 * @param {string[]} urls all language URLs (canonical, read back from WP)
 * @param {string} zhUrl the zh-cn canonical URL (the only one sent to Baidu)
 */
async function submitUrls(urls, zhUrl) {
  const list = [...new Set(urls.filter(Boolean))];
  // equivalent path to submit-indexnow.js
  try {
    const key = process.env.INDEXNOW_KEY;
    if (!key) throw new Error('INDEXNOW_KEY not configured');
    const host = process.env.INDEXNOW_HOST || `www.${SITE.site.domain || 'tengence.com'}`;
    const keyLocation = process.env.INDEXNOW_KEY_LOCATION || `https://${host}/${key}.txt`;
    await t.search.indexnow.submitUrls({ host, key, keyLocation, urlList: list });
    console.log(`    ↳ submit-indexnow.js pushed ${list.length} url(s)`);
  } catch (e) {
    console.log(`    ↳ submit-indexnow.js push failed (logged only, no rollback)`);
  }
  // equivalent path to submit-baidu.js
  try {
    const token = process.env.BAIDU_TOKEN;
    if (!token) throw new Error('BAIDU_TOKEN not configured');
    const site = process.env.BAIDU_SITE || `www.${SITE.site.domain || 'tengence.com'}`;
    await t.search.baidu.submitBatch([zhUrl], { token, site });
    console.log(`    ↳ submit-baidu.js pushed (zh-cn only)`);
  } catch (e) {
    console.log(`    ↳ submit-baidu.js push failed (logged only, no rollback)`);
  }
}

/**
 * Bring the translations of an article online together with their source.
 *
 * The plan table only tracks the zh-cn row, so without this step a scheduled promote
 * would publish the source and leave en-us / zh-hk sitting in the draft box forever.
 * Translations are found through the DB (same slug, wp_post_id > 0), promoted to
 * publish, and their post_date / post_modified are aligned to the source afterwards
 * (a status change refreshes modified, so the date sync must come last).
 *
 * Failures are logged and never abort the run: a missing translation must not block
 * the source article from going live.
 * @param {string} slug
 * @param {number} sourcePostId the zh-cn WP post id
 * @returns {Promise<Array<{lang:string, wp_post_id:number, link:string, status:string}>>}
 */
async function promoteTranslations(slug, sourcePostId) {
  const rows = await t.db.withConn(async (conn) => {
    const [r] = await conn.query(
      "SELECT lang, wp_post_id FROM tengence_geo_articles WHERE app_id = ? AND slug = ? AND lang <> 'zh-cn' AND wp_post_id > 0 ORDER BY lang",
      [APP_ID, slug]
    );
    return r || [];
  });
  if (!rows.length) return [];

  let srcDates = null;
  try {
    srcDates = await t.wp.posts.getPostDates(sourcePostId, { siteKey: SITE_KEY });
  } catch (e) {
    console.log(`    ⚠ 读取源文日期失败，译文不重设日期: ${e.message}`);
  }

  const done = [];
  for (const row of rows) {
    try {
      const before = await t.wp.posts.get(row.wp_post_id, '?_fields=id,slug,status,link', {
        siteKey: SITE_KEY,
      });
      if (!before) {
        console.log(`    ⚠ 译文 ${row.lang} (wp${row.wp_post_id}) 不存在，跳过`);
        continue;
      }
      if (before.status !== 'publish') {
        await t.wp.posts.update(row.wp_post_id, { status: 'publish' }, { siteKey: SITE_KEY });
      }
      // Dates last: any status/content write refreshes post_modified to now.
      if (srcDates) {
        await t.wp.posts.setPostDates(
          row.wp_post_id,
          {
            date: srcDates.date,
            date_gmt: srcDates.date_gmt,
            modified: srcDates.modified,
            modified_gmt: srcDates.modified_gmt,
          },
          { siteKey: SITE_KEY }
        );
      }
      const after = await t.wp.posts.get(row.wp_post_id, '?_fields=id,slug,status,link', {
        siteKey: SITE_KEY,
      });
      done.push({
        lang: row.lang,
        wp_post_id: row.wp_post_id,
        link: after && after.link,
        status: after && after.status,
      });
      console.log(`    ✓ 译文同步上线 ${row.lang} (wp${row.wp_post_id}) → ${after && after.link}`);
    } catch (e) {
      console.log(`    ⚠ 译文 ${row.lang} (wp${row.wp_post_id}) 上线失败（仅记录）: ${e.message}`);
    }
  }
  return done;
}

/**
 * Build the work items for `--slug` mode: one item per slug, carrying the source post
 * (zh-cn when present) and, implicitly, every other language row of that slug —
 * promoteTranslations() picks those up by slug, so whatever languages exist in the
 * draft box go live together.
 */
async function itemsFromSlugs(slugs) {
  const plans = await t.plan.list({ appId: APP_ID });
  const out = [];
  for (const slug of slugs) {
    const rows = await t.db.withConn(async (conn) => {
      const [r] = await conn.query(
        'SELECT id, lang, title, wp_post_id FROM tengence_geo_articles WHERE app_id = ? AND slug = ? AND wp_post_id > 0 ORDER BY lang',
        [APP_ID, slug]
      );
      return r || [];
    });
    if (!rows.length) {
      console.log(`    ✗ 该 slug 没有已入库（wp_post_id>0）的草稿: ${slug}`);
      continue;
    }
    const source = rows.find((r) => r.lang === 'zh-cn') || rows[0];
    const planRow = plans.find((p) => p.slug === slug);
    out.push({
      slug,
      wp_post_id: source.wp_post_id,
      title: (planRow && planRow.title) || source.title || slug,
      category: planRow && planRow.category,
      matrix_code: planRow && planRow.matrix_code,
      publish_order: planRow ? planRow.publish_order : 0,
      languages: rows.map((r) => r.lang),
    });
  }
  return out;
}

/**
 * Promote one article — and every language version of its slug — through the full gate:
 * draft check → internal links → gate re-check → promote → translations → plan → push.
 *
 * @param {object} item {slug, wp_post_id, title, category, matrix_code, publish_order}
 * @param {{dryRun?:boolean, publishDate?:string|null}} opts
 * @returns {Promise<{status:'published'|'skipped', item:object, url?:string, translations?:Array<object>, reason?:string}>}
 */
async function promoteOne(item, { dryRun = false, publishDate = null } = {}) {
  console.log(`    slug=${item.slug} post_id=${item.wp_post_id}`);

  // step 2: confirm it is a draft
  let post;
  try {
    post = await t.wp.posts.get(item.wp_post_id, '?_fields=id,slug,status,link', {
      siteKey: SITE_KEY,
    });
  } catch (e) {
    console.log(`    ✗ Read failed: ${e.message}`);
    return { status: 'skipped', item, reason: `Failed to read WP post: ${e.message}` };
  }
  if (!post || post.status === 'publish') {
    const reason = !post ? 'WP post does not exist' : 'already publish';
    console.log(`    ⚠ ${reason}; marking the plan as published and skipping.`);
    await t.plan.markPublished(item.slug, {
      wpPostId: item.wp_post_id,
      publishedUrl:
        (post && post.link) ||
        `https://www.${SITE.site.domain || 'tengence.com'}/blog/article/${item.slug}/`,
    });
    return { status: 'skipped', item, reason };
  }
  if (post.status !== 'draft') {
    console.log(`    ✗ Abnormal status (${post.status}), skipping.`);
    return { status: 'skipped', item, reason: `abnormal status: ${post.status}` };
  }

  // step 3: internal-link check
  const links = await extractInternalLinks(item);
  if (!links.ok) {
    console.log(`    ✗ ${links.reason}`);
    return { status: 'skipped', item, reason: links.reason };
  }
  const broken = [];
  for (const slug of links.slugs) {
    try {
      const p = await t.wp.posts.findBySlug(slug, { siteKey: SITE_KEY });
      if (!p || p.status !== 'publish') broken.push(slug);
    } catch (e) {
      broken.push(`${slug}(query failed)`);
    }
  }
  if (broken.length > 0) {
    console.log(`    ✗ Internal-link targets unpublished, deferring: ${broken.join(', ')}`);
    return { status: 'skipped', item, reason: `internal-link targets unpublished: ${broken.join(', ')}` };
  }
  console.log(`    ✓ ${links.slugs.length} internal links, all targets published`);

  // step 4: gate re-check
  const chk = await runCheck(item);
  if (!chk.ok) {
    console.log(`    ✗ Gate failed, skipping`);
    return { status: 'skipped', item, reason: `gate failed:\n${chk.reason}` };
  }
  console.log(`    ✓ Gate passed`);

  if (dryRun) {
    console.log(`    [DRY-RUN] would promote to publish; skipping the actual write.`);
    return { status: 'skipped', item, reason: 'dry-run' };
  }

    // step 5: promote (source first, then its translations — same run, same article)
    try {
      const promotePatch = { status: 'publish' };
      if (publishDate) { promotePatch.date = publishDate; promotePatch.modified = publishDate; }
      await t.wp.posts.update(item.wp_post_id, promotePatch, { siteKey: SITE_KEY });
    } catch (e) {
      console.log(`    ✗ Promote to publish failed: ${e.message}`);
      return { status: 'skipped', item, reason: `promote to publish failed: ${e.message}` };
    }
    console.log(`    ✓ Promoted to publish`);

    // Re-read: a draft's link is the ?p=ID form, only a published post exposes the
    // canonical permalink (which now carries the language prefix, e.g. /zh-hans/...).
    let liveLink = `https://www.${SITE.site.domain || 'tengence.com'}/blog/article/${item.slug}/`;
    try {
      const live = await t.wp.posts.get(item.wp_post_id, '?_fields=id,slug,status,link', {
        siteKey: SITE_KEY,
      });
      if (live && live.link) liveLink = live.link;
    } catch (e) {
      console.warn(`    ⚠️ 读取 canonical link 失败，回退拼接 URL: ${e.message}`);
    }

    // step 5.1: translations go live together with the source
    const translations = await promoteTranslations(item.slug, item.wp_post_id);
    if (!translations.length) console.log(`    - 无译文行（或译文未入库），仅上线源文`);

    // step 6: write back the plan (queued → published)
    const url = liveLink;
    try {
      await t.plan.markPublished(item.slug, { wpPostId: item.wp_post_id, publishedUrl: url });
      console.log(`    ✓ Plan updated: ${item.slug} → published`);
    } catch (e) {
      console.warn(`    ⚠️ Plan write-back failed: ${e.message}`);
    }

    // step 7: inclusion push (IndexNow: every language; Baidu: zh-cn only)
    await submitUrls([url, ...translations.map((x) => x.link)], url);

  return { status: 'published', item, url, translations };
}

// ---------------------------------------------------------------- main
async function main() {
  const args = ARGS;
  const dryRun = args.dryRun;
  const publishDate = args.date || null;
  const today = todayStr();

  const published = [];
  const skipped = [];

  // ---- mode A: explicit --slug (publish every language of those slugs) ----
  // The queue schedule (skip_dates / per_day) is intentionally bypassed here: an
  // explicit slug is a deliberate, operator-driven publish.
  if (args.slugs.length) {
    console.log(
      `[promote-daily] ${today} | SLUG MODE: ${args.slugs.join(', ')}${dryRun ? ' | DRY-RUN' : ''}`
    );
    console.log(
      `[promote-daily] 每个 slug 的全部语言版本一并发布（仍执行内链校验 + 门禁复检）`
    );
    const items = await itemsFromSlugs(args.slugs);
    for (const item of items) {
      console.log(`\n[slug] ${item.slug} | languages: ${(item.languages || []).join(', ')}`);
      const r = await promoteOne(item, { dryRun, publishDate });
      if (r.status === 'published') published.push(r);
      else skipped.push({ item, reason: r.reason });
    }
  } else {
    // ---- mode B: the daily queue (plan table, publish_order ascending) ----
    const schedule = loadSchedule();
    const count = args.count ?? (schedule.per_day || 1);

    console.log(`[promote-daily] ${today} | count=${count}${dryRun ? ' | DRY-RUN' : ''}`);
    console.log(
      `[promote-daily] queue source: article plan table (t.plan.nextDue) | schedule: ${SCHEDULE_PATH}`
    );

    if ((schedule.skip_dates || []).includes(today)) {
      console.log('[promote-daily] Today is in skip_dates, skipping publishing.');
      return;
    }

    // Over-fetch candidates: prevents a deadlock when an article skipped due to an
    // unpublished internal link permanently occupies the queue front.
    const OVERFETCH = 5;
    const candidates = await t.plan.nextDue({ count: count + OVERFETCH, appId: APP_ID });

    const pending = (await t.plan.list({ status: ['todo', 'written'], appId: APP_ID })).length;
    const queued = (await t.plan.list({ status: 'queued', appId: APP_ID })).length;

    if (candidates.length === 0) {
      console.log(
        `[promote-daily] No queued drafts (queued=${queued}, unwritten todo+written=${pending}). Nothing to do.`
      );
      return;
    }

    for (const item of candidates) {
      if (published.length >= count) break;
      console.log(`\n[${item.publish_order}] ${item.matrix_code || ''} ${item.title}`);
      const r = await promoteOne(item, { dryRun, publishDate });
      if (r.status === 'published') published.push(r);
      else skipped.push({ item, reason: r.reason });
    }
  }

  // ---- summary ----
  console.log(`\n========== Summary ==========`);
  console.log(`Published ${published.length} article(s), skipped ${skipped.length}`);
  for (const { item, url, translations } of published) {
    console.log(`  ✅ [${item.publish_order ?? '-'}] ${item.matrix_code || ''} ${item.title}`);
    console.log(`     ${url}`);
    for (const tr of translations || []) console.log(`     ↳ ${tr.lang} ${tr.link}`);
  }
  for (const { item, reason } of skipped) {
    console.log(
      `  ⏭  [${item.publish_order ?? '-'}] ${item.matrix_code || ''} ${item.title} — ${String(reason || '').split('\n')[0]}`
    );
  }
  const remainQueued = (await t.plan.list({ status: 'queued', appId: APP_ID })).length;
  const remainPending = (await t.plan.list({ status: ['todo', 'written'], appId: APP_ID })).length;
  console.log(`Remaining: ${remainQueued} queued drafts, ${remainPending} unwritten todo+written`);

  if (published.length > 0) {
    console.log(`\n>> Published article status is in the article plan table (see plan list)`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[promote-daily] error:', e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

module.exports = { main };
