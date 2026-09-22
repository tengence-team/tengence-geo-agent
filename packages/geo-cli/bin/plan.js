#!/usr/bin/env node
/**
 * Article plan table (Hub & Spoke) CLI
 * ============================================================================
 * Data source: tengence_geo_article_plan (single source of truth), all accessed via t.plan.
 *
 * Usage:
 *   tengence-geo plan.js import [--matrix=<path>] [--queue=<path>] [--site <key>]
 *        —— dual-source merged import (100-article matrix + publish-queue.json; the
 *           taxonomy.yaml source is retired), idempotent by slug; backfills article_id /
 *           title / published_url / featured_image.
 *   tengence-geo plan.js sync [--dry-run] [--site <key>]
 *        —— three-way reconciliation (WP article status + local md → plan table):
 *           WP publish → published; WP draft → queued; local md present → written; else todo.
 *   tengence-geo plan.js list [--status=] [--batch=] [--cluster=]
 *        [--category=] [--node=hub|spoke] [--limit=N] [--site <key>]
 *        —— list the plan table (replaces manually maintained doc status columns).
 *   tengence-geo plan.js status <slug> [--set=todo|written|queued|published|paused]
 *        [--site <key>]
 *        —— query a single row / manually adjust status (--set).
 *   tengence-geo plan.js set-featured <slug> <url> [--site <key>]
 *        —— backfill the featured-image path into articles.featured_image (called after
 *           the image pipeline produces one).
 * ============================================================================
 */

const t = require('@tengence/geo-sdk');
const fs = require('fs');
const path = require('path');

const SITE = t.site.loadSite();
const APP_ID = Number(process.env.APP_ID || 1);

function usage() {
  console.log(`
Usage:
  tengence-geo plan.js import [--matrix=<path>] [--queue=<path>] [--site <key>]
  tengence-geo plan.js sync [--dry-run] [--site <key>]
  tengence-geo plan.js list [--status=] [--batch=] [--cluster=] [--category=] [--node=hub|spoke] [--limit=N] [--site <key>]
  tengence-geo plan.js status <slug> [--set=todo|written|queued|published|paused] [--site <key>]
  tengence-geo plan.js set-featured <slug> <url> [--site <key>]
`);
  process.exit(1);
}

function parseArgs(argv) {
  const { positionals, flags } = t.cli.args.parse(
    {
      batch: { type: 'string' },
      category: { type: 'string' },
      cluster: { type: 'string' },
      'dry-run': { type: 'boolean' },
      limit: { type: 'string' },
      matrix: { type: 'string' },
      node: { type: 'string' },
      queue: { type: 'string' },
      set: { type: 'string' },
      status: { type: 'string' },
    },
    argv
  );
  return {
    positional: positionals,
    opts: {
      batch: flags.batch,
      category: flags.category,
      cluster: flags.cluster,
      'dry-run': flags['dry-run'],
      dryRun: flags['dry-run'],
      limit: flags.limit,
      matrix: flags.matrix,
      node: flags.node,
      queue: flags.queue,
      set: flags.set,
      status: flags.status,
    },
  };
}

function fmtRow(p) {
  const status = (p.plan_status || '').padEnd(9);
  const batch = p.publish_batch ? String(p.publish_batch) : '-';
  const cluster = (p.hub_cluster || '-').padEnd(2);
  const code = (p.matrix_code || '-').padEnd(4);
  const type = (p.node_type || '').padEnd(5);
  const cat = (p.category || '-').slice(0, 18).padEnd(18);
  const tagsRaw = Array.isArray(p.tag_names) ? p.tag_names.join(',') : (p.tag_names || (Array.isArray(p.tags) ? p.tags.join(',') : ''));
  const tags = tagsRaw.slice(0, 24).padEnd(24);
  const title = (p.title || '').slice(0, 34).padEnd(34);
  const url = (p.published_url || '') ? p.published_url : '';
  return `${status} ${batch} ${cluster} ${code} ${type} ${cat} ${tags} ${title} ${p.slug}${url ? ' → ' + url : ''}`;
}

async function cmdImport(opts) {
  console.log(`[plan] Importing the three sources → article plan (app_id=${APP_ID})`);
  const report = await t.plan.importPlan(SITE, {
    matrixPath: opts.matrix || undefined,
    queuePath: opts.queue || undefined,
  });
  console.log('\n========== Import report ==========');
  console.log(`Matrix rows: ${report.matrix_rows} | Queue items: ${report.queue_items}`);
  console.log(`Total plan rows: ${report.total_plan_rows} (including ${report.hub_rows} hub rows)`);
  console.log(`Expected slug set: ${report.expected_slugs} | Not ingested: ${report.not_in_plan.length ? report.not_in_plan.join(', ') : 'none'}`);
  console.log(`Backfilled article_id: ${report.article_linked} | published_url: ${report.published_url_filled} | featured_image: ${report.featured_filled}`);
  if (report.matrix_warned.length) {
    console.log('\n⚠️ Matrix rows with empty slug (supplemented from queue/taxonomy):');
    report.matrix_warned.forEach((w) => console.log(`  - ${w}`));
  }
  if (report.missing_article.length) {
    console.log('\n⚠️ queued/published but no articles-table record:');
    report.missing_article.forEach((s) => console.log(`  - ${s}`));
  }
  if (report.not_in_plan.length) {
    console.log('\n⚠️ Expected but not ingested:');
    report.not_in_plan.forEach((s) => console.log(`  - ${s}`));
  }
  console.log('\nVerification:');
  const v = await t.plan.verify({ appId: APP_ID });
  console.log(`  ${v.ok ? '✅' : '❌'} allow-list / local md / wp_post_id verification (${v.errors.length} issue(s))`);
  if (!v.ok) v.errors.slice(0, 30).forEach((e) => console.log(`    - ${e}`));
  console.log(`  Status distribution: ${JSON.stringify(v.stats)}`);
}

async function cmdList(opts) {
  const rows = await t.plan.list({
    appId: APP_ID,
    status: opts.status || undefined,
    batch: opts.batch !== undefined ? opts.batch : undefined,
    cluster: opts.cluster || undefined,
    category: opts.category || undefined,
    nodeType: opts.node || undefined,
    limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
  });
  if (!rows.length) {
    console.log('(no matching rows)');
    return;
  }
  const isHubView = opts.node === 'hub';
  console.log(`\nArticle plan (${rows.length} rows)${isHubView ? ' · hub view' : ''}`);
  console.log('='.repeat(150));
  console.log('status    batch cluster code type  category             tags                     title                             slug');
  console.log('='.repeat(150));
  for (const r of rows) console.log(fmtRow(r));
  console.log('='.repeat(150));
}

async function cmdStatus(opts, slug) {
  if (!slug) usage();
  if (opts.set) {
    const allowed = ['todo', 'written', 'queued', 'published', 'paused'];
    if (!allowed.includes(opts.set)) {
      console.error(`✗ --set must be one of ${allowed.join('/')}`);
      process.exit(1);
    }
    const r = await t.plan.updateStatus(slug, { plan_status: opts.set }, { appId: APP_ID });
    console.log(r.updated ? `✅ ${slug} → ${opts.set}` : `⚠️ ${slug} not found, not updated`);
    return;
  }
  const row = await t.plan.get(slug, { appId: APP_ID });
  if (!row) {
    console.log(`Not found: ${slug}`);
    process.exit(1);
  }
  console.log(JSON.stringify({
    slug: row.slug, node_type: row.node_type, hub_cluster: row.hub_cluster,
    matrix_code: row.matrix_code, title: row.title, focus_keyword: row.focus_keyword,
    category: row.category, tags: row.tags, publish_batch: row.publish_batch,
    publish_order: row.publish_order, plan_status: row.plan_status,
    article_id: row.article_id, wp_post_id: row.wp_post_id,
    published_url: row.published_url,
    queued_at: row.queued_at, published_at: row.published_at, notes: row.notes,
  }, null, 2));
}

async function cmdSetFeatured(slug, url) {
  if (!slug || !url) usage();
  const r = await t.plan.setFeaturedImage(slug, url, { appId: APP_ID });
  console.log(r.updated ? `✅ ${slug} featured image backfilled: ${url}` : `⚠️ ${slug} not found, not updated`);
}

/** Ingested article slug set (from 2026-09-20: DB is the single source of truth;
 *  local md moved to data/ and no longer takes part in reconciliation) */
async function scanLocalMds() {
  return t.db.withConn(async (conn) => {
    const [rows] = await conn.query('SELECT slug FROM tengence_geo_articles WHERE app_id = ?', [APP_ID]);
    return new Set(rows.map((r) => r.slug));
  });
}

function printReconcile(report) {
  console.log(`\n========== Reconciliation report ==========`);
  console.log(`Mode: ${report.dryRun ? 'DRY-RUN (nothing written)' : 'written'} | spoke rows: ${report.total_spoke} | unchanged: ${report.unchanged} | to update: ${report.updated.length}`);

  if (report.updated.length) {
    console.log(`\nStatus updates (${report.updated.length}):`);
    for (const u of report.updated) {
      const extra = u.published_url ? ` → ${u.published_url}` : '';
      console.log(`  ${u.slug}: ${u.from} → ${u.to} (wp_post_id=${u.wp_post_id || '-'})${extra}`);
    }
  }

  if (report.taxonomy_mismatch.length) {
    console.log(`\n⚠️ Category/tag mismatches (reported only, plan table not overwritten):`);
    for (const m of report.taxonomy_mismatch) {
      console.log(`  ${m.slug} [${m.field}] plan=${m.plan || '-'} | WP=${m.wp || '-'}${m.plan_missing_in_wp ? ` | in plan, missing in WP: ${m.plan_missing_in_wp}` : ''}${m.wp_extra ? ` | WP extra: ${m.wp_extra}` : ''}`);
    }
  }

  if (report.wp_not_in_plan.length) {
    console.log(`\n⚠️ In WP but missing from the plan (${report.wp_not_in_plan.length}, reported only):`);
    for (const w of report.wp_not_in_plan.slice(0, 30)) {
      console.log(`  ${w.slug} (WP ${w.wp_status}, id=${w.wp_post_id})`);
    }
    if (report.wp_not_in_plan.length > 30) console.log(`  … ${report.wp_not_in_plan.length - 30} more`);
  }
  console.log(`\nHint: full status distribution is in \`plan.js list\``);
}

/** sync: reconciles the plan-table status against WP article status + local md as authoritative */
async function cmdSync(opts) {
  const dryRun = !!(opts['dry-run'] || opts.dryRun);
  console.log(`[plan] sync three-way reconciliation (WP + local → plan table) ${dryRun ? '[DRY-RUN]' : ''}`);

  // ① all WP articles (status=any includes drafts)
  console.log('  ① Fetching WP articles…');
  const wpPosts = await t.wp.posts.list();
  console.log(`     ${wpPosts.length} WP articles`);
  const [wpCats, wpTags] = await Promise.all([
    t.wp.apiAll('categories', { _fields: 'id,slug' }),
    t.wp.apiAll('tags', { _fields: 'id,slug' }),
  ]);
  const categoryById = new Map(wpCats.map((c) => [c.id, c.slug]));
  const tagById = new Map(wpTags.map((x) => [x.id, x.slug]));

  // ② local md
  const localSlugs = await scanLocalMds();
  console.log(`  ② ${localSlugs.size} ingested articles (articles table)`);

  // ③ reconcile
  console.log('  ③ Reconciling…');
  const report = await t.plan.reconcile({ appId: APP_ID, wpPosts, categoryById, tagById, localSlugs, dryRun });
  printReconcile(report);
}

async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (cmd === 'import') return cmdImport(opts);
  if (cmd === 'sync') return cmdSync(opts);
  if (cmd === 'list') return cmdList(opts);
  if (cmd === 'status') return cmdStatus(opts, positional[1]);
  if (cmd === 'set-featured') return cmdSetFeatured(positional[1], positional[2]);
  usage();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[plan] failed: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  });
}

module.exports = { main };
