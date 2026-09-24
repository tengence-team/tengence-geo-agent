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
const SITE = t.site.loadSite();
const APP_ID = Number(process.env.APP_ID || 1);

const SCHEDULE_PATH = path.join(SITE.configDir, 'wordpress.yaml'); // schedule params merged into wordpress.publish (per_day / skip_dates)

const INTERNAL_LINK_RE = new RegExp(
  'https?://(?:www\\.)?' +
    String(SITE.site.domain || 'tengence.com').replace(/\./g, '\\.') +
    '/blog/article/([a-z0-9-]+)/?',
  'g'
);

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const { flags } = t.cli.args.parse(
    { count: { type: 'string' }, 'dry-run': { type: 'boolean' }, date: { type: 'string' } },
    argv
  );
  return {
    count: flags.count ? parseInt(flags.count, 10) || 1 : null,
    dryRun: flags['dry-run'],
    date: flags.date || null,
  };
}

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
      [APP_ID, item.slug, 'zh-CN']
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

/** Inclusion push; a failure only logs (calls t.search.indexnow / t.search.baidu directly,
 *  de-subprocessed 2026-09-20) */
async function submitUrl(url) {
  // equivalent path to submit-indexnow.js
  try {
    const key = process.env.INDEXNOW_KEY;
    if (!key) throw new Error('INDEXNOW_KEY not configured');
    const host = process.env.INDEXNOW_HOST || `www.${SITE.site.domain || 'tengence.com'}`;
    const keyLocation = process.env.INDEXNOW_KEY_LOCATION || `https://${host}/${key}.txt`;
    await t.search.indexnow.submitUrls({ host, key, keyLocation, urlList: [url] });
    console.log(`    ↳ submit-indexnow.js pushed`);
  } catch (e) {
    console.log(`    ↳ submit-indexnow.js push failed (logged only, no rollback)`);
  }
  // equivalent path to submit-baidu.js
  try {
    const token = process.env.BAIDU_TOKEN;
    if (!token) throw new Error('BAIDU_TOKEN not configured');
    const site = process.env.BAIDU_SITE || `www.${SITE.site.domain || 'tengence.com'}`;
    await t.search.baidu.submitBatch([url], { token, site });
    console.log(`    ↳ submit-baidu.js pushed`);
  } catch (e) {
    console.log(`    ↳ submit-baidu.js push failed (logged only, no rollback)`);
  }
}

// ---------------------------------------------------------------- main
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const schedule = loadSchedule();
  const count = args.count ?? (schedule.per_day || 1);
  const dryRun = args.dryRun;
  const publishDate = args.date || null;
  const today = todayStr();

  console.log(`[promote-daily] ${today} | count=${count}${dryRun ? ' | DRY-RUN' : ''}`);
  console.log(`[promote-daily] queue source: article plan table (t.plan.nextDue) | schedule: ${SCHEDULE_PATH}`);

  // step 0: skip_dates (config/publish.yaml)
  if ((schedule.skip_dates || []).includes(today)) {
    console.log('[promote-daily] Today is in skip_dates, skipping publishing.');
    return;
  }

  // Over-fetch candidates: prevents a deadlock when an article skipped due to an
  // unpublished internal link permanently occupies the queue front
  // (e.g. article 2 links article 3, and article 3 is ordered after article 2 —
  //  taking the front-most row would block forever)
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

  const published = [];
  const skipped = [];

  for (const item of candidates) {
    if (published.length >= count) break;
    console.log(`\n[${item.publish_order}] ${item.matrix_code || ''} ${item.title}`);
    console.log(`    slug=${item.slug} post_id=${item.wp_post_id}`);

    // step 2: confirm it is a draft
    let post;
    try {
      post = await t.wp.posts.get(item.wp_post_id, '?_fields=id,slug,status,link');
    } catch (e) {
      skipped.push({ item, reason: `Failed to read WP post: ${e.message}` });
      console.log(`    ✗ Read failed: ${e.message}`);
      continue;
    }
    if (!post || post.status === 'publish') {
      const reason = !post ? 'WP post does not exist' : 'already publish';
      skipped.push({ item, reason });
      console.log(`    ⚠ ${reason}; marking the plan as published and skipping.`);
      await t.plan.markPublished(item.slug, {
        wpPostId: item.wp_post_id,
        publishedUrl: `https://www.${SITE.site.domain || 'tengence.com'}/blog/article/${item.slug}/`,
      });
      continue;
    }
    if (post.status !== 'draft') {
      skipped.push({ item, reason: `abnormal status: ${post.status}` });
      console.log(`    ✗ Abnormal status (${post.status}), skipping.`);
      continue;
    }

    // step 3: internal-link check
    const links = await extractInternalLinks(item);
    if (!links.ok) {
      skipped.push({ item, reason: links.reason });
      console.log(`    ✗ ${links.reason}`);
      continue;
    }
    const broken = [];
    for (const slug of links.slugs) {
      try {
        const p = await t.wp.posts.findBySlug(slug);
        if (!p || p.status !== 'publish') broken.push(slug);
      } catch (e) {
        broken.push(`${slug}(query failed)`);
      }
    }
    if (broken.length > 0) {
      skipped.push({ item, reason: `internal-link targets unpublished: ${broken.join(', ')}` });
      console.log(`    ✗ Internal-link targets unpublished, deferring: ${broken.join(', ')}`);
      continue;
    }
    console.log(`    ✓ ${links.slugs.length} internal links, all targets published`);

    // step 4: gate re-check
    const chk = await runCheck(item);
    if (!chk.ok) {
      skipped.push({ item, reason: `gate failed:\n${chk.reason}` });
      console.log(`    ✗ Gate failed, skipping`);
      continue;
    }
    console.log(`    ✓ Gate passed`);

    if (dryRun) {
      console.log(`    [DRY-RUN] would promote to publish; skipping the actual write.`);
      continue;
    }

    // step 5: promote
    try {
      const promotePatch = { status: 'publish' };
      if (publishDate) { promotePatch.date = publishDate; promotePatch.modified = publishDate; }
      await t.wp.posts.update(item.wp_post_id, promotePatch);
    } catch (e) {
      skipped.push({ item, reason: `promote to publish failed: ${e.message}` });
      console.log(`    ✗ Promote to publish failed: ${e.message}`);
      continue;
    }
    console.log(`    ✓ Promoted to publish`);

    // step 6: write back the plan (queued → published)
    const url = `https://www.${SITE.site.domain || 'tengence.com'}/blog/article/${item.slug}/`;
    try {
      await t.plan.markPublished(item.slug, { wpPostId: item.wp_post_id, publishedUrl: url });
      console.log(`    ✓ Plan updated: ${item.slug} → published`);
    } catch (e) {
      console.warn(`    ⚠️ Plan write-back failed: ${e.message}`);
    }
    published.push({ item, url });

    // step 7: inclusion push
    await submitUrl(url);
  }

  // step 9: summary
  console.log(`\n========== Summary ==========`);
  console.log(`Published ${published.length} article(s), skipped ${skipped.length}`);
  for (const { item, url } of published) {
    console.log(`  ✅ [${item.publish_order}] ${item.matrix_code || ''} ${item.title}`);
    console.log(`     ${url}`);
  }
  for (const { item, reason } of skipped) {
    console.log(`  ⏭  [${item.publish_order}] ${item.matrix_code || ''} ${item.title} — ${reason.split('\n')[0]}`);
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
