#!/usr/bin/env node
// Three-way reconciliation (read-only): WP live (publish+draft) vs plan table vs the
// 《content-publishing-plan》 document.
// Contract: slug is authoritative from WP; the keyword matrix follows the document's
// "primary keyword" column.
// Output: count summary + difference detail (writes nothing to the databases).
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const t = require('../packages/geo-sdk');
t.site.loadSite();

const DOC = path.join(root, 'sites/tengence/plan/2026/内容发布计划.md');
const APP_ID = Number(process.env.APP_ID || 1);

// ---------- 1. document parsing: | A01 | slug | title | primary keyword | ... ----------
function parseDoc() {
  const lines = fs.readFileSync(DOC, 'utf8').split('\n');
  const map = {}; // slug -> { code, keyword }
  for (const line of lines) {
    // only matches A–G cluster table rows (first column A01..Gxx, second column slug)
    const m = line.match(/^\|\s*([A-G]\d+)\s*\|\s*([a-z0-9-]+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
    if (m) {
      const code = m[1], slug = m[2], title = m[3].trim(), keyword = m[4].trim();
      if (slug === 'slug') continue; // header row
      if (map[slug]) map[slug].codes.push(code);
      else map[slug] = { codes: [code], keyword, title };
    }
  }
  return map;
}

// ---------- 2. WP fetch (publish + draft) ----------
async function fetchWp() {
  const wpApi = process.env.WP_API_URL;
  const auth = 'Basic ' + Buffer.from(`${process.env.WP_USERNAME}:${process.env.WP_PASSWORD}`).toString('base64');
  const out = [];
  let page = 1;
  for (;;) {
    const url = `${wpApi}/wp/v2/posts?status=publish,draft&per_page=100&page=${page}&_fields=id,slug,status,title,link,categories,tags`;
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) throw new Error(`WP ${res.status}: ${url}`);
    const items = await res.json();
    if (!items.length) break;
    for (const p of items) out.push({ id: p.id, slug: p.slug, status: p.status, title: (p.title && p.title.rendered) || '', link: p.link, categories: p.categories, tags: p.tags });
    if (items.length < 100) break;
    page++;
  }
  // term mapping
  const terms = {};
  for (const [key, col] of [['categories', 'categories'], ['tags', 'tags']]) {
    let p2 = 1;
    for (;;) {
      const url = `${wpApi}/wp/v2/${col}?per_page=100&page=${p2}&_fields=id,slug`;
      const res = await fetch(url, { headers: { Authorization: auth } });
      if (!res.ok) break;
      const items = await res.json();
      if (!items.length) break;
      for (const x of items) terms[`${col}:${x.id}`] = x.slug;
      if (items.length < 100) break;
      p2++;
    }
  }
  for (const p of out) {
    p.categorySlugs = p.categories.map((id) => terms[`categories:${id}`]).filter(Boolean);
    p.tagSlugs = p.tags.map((id) => terms[`tags:${id}`]).filter(Boolean);
  }
  return out;
}

// ---------- 3. DB plan + articles ----------
async function fetchDb() {
  return t.db.withConn(async (conn) => {
    const [plans] = await conn.query(
      'SELECT slug, node_type, plan_status, category, tags, focus_keyword, matrix_code, wp_post_id, lang FROM tengence_geo_article_plan WHERE app_id = ?',
      [APP_ID]
    );
    const [arts] = await conn.query(
      'SELECT slug, wp_post_id, lang FROM tengence_geo_articles WHERE app_id = ?',
      [APP_ID]
    );
    return { plans, arts };
  });
}

// ---------- main ----------
async function main() {
  const doc = parseDoc();
  console.error(`document matrix rows: ${Object.keys(doc).length} slugs`);
  const wp = await fetchWp();
  console.error(`WP fetched: ${wp.length} (publish + draft)`);
  const { plans, arts } = await fetchDb();
  console.error(`plan rows: ${plans.length} | articles rows: ${arts.length}`);

  const wpPublish = wp.filter((p) => p.status === 'publish');
  const wpDraft = wp.filter((p) => p.status === 'draft');
  const planBySlug = new Map(plans.map((p) => [p.slug, p]));
  const artBySlug = new Map(arts.map((a) => [a.slug, a]));

  // ==== A. WP live vs plan table (slug authoritative from WP) ====
  const aNoPlan = [];        // in WP, missing in plan
  const aStatusMismatch = []; // WP publish but plan not published / WP draft but plan not queued/written
  for (const p of wp) {
    const pl = planBySlug.get(p.slug);
    if (!pl) { aNoPlan.push(`${p.slug} (WP ${p.status})`); continue; }
    if (p.status === 'publish' && pl.plan_status !== 'published') aStatusMismatch.push(`${p.slug}: WP=publish but plan=${pl.plan_status}`);
    if (p.status === 'draft' && !['queued', 'written', 'todo'].includes(pl.plan_status)) aStatusMismatch.push(`${p.slug}: WP=draft but plan=${pl.plan_status}`);
  }
  // in plan, missing in WP (beyond publish/draft: paused does not count as missing)
  const aNoWp = plans
    .filter((pl) => pl.plan_status === 'published' || pl.plan_status === 'queued' || pl.plan_status === 'written')
    .filter((pl) => !wp.some((p) => p.slug === pl.slug))
    .map((pl) => `${pl.slug} (plan=${pl.plan_status})`);

  // ==== B. keywords: plan.focus_keyword vs document primary keyword (document wins) ====
  const kwMismatch = []; // doc has a keyword, plan empty or different
  const kwNoDoc = [];    // plan has a keyword but the doc has no such slug
  for (const [slug, d] of Object.entries(doc)) {
    const pl = planBySlug.get(slug);
    if (!pl) { kwNoDoc.push(`${slug}: in doc, missing in plan`); continue; }
    if (!pl.focus_keyword) { kwMismatch.push(`${slug}: doc primary 「${d.keyword}」 but plan.focus_keyword empty`); continue; }
    if (pl.focus_keyword.trim() !== d.keyword) {
      kwMismatch.push(`${slug}: doc「${d.keyword}」vs plan「${pl.focus_keyword}」`);
    }
  }

  // ==== C. document slugs vs WP/plan existence ====
  const docNoWp = Object.keys(doc).filter((s) => !wp.some((p) => p.slug === s));
  const docNoPlan = Object.keys(doc).filter((s) => !planBySlug.has(s));

  // ==== D. category/tags: WP published articles vs plan (plan is the planning source of truth, differences only reported) ====
  const catTagMismatch = [];
  for (const p of wpPublish) {
    const pl = planBySlug.get(p.slug);
    if (!pl) continue;
    const planTags = Array.isArray(pl.tags) ? pl.tags : [];
    if (pl.category !== (p.categorySlugs[0] || null)) catTagMismatch.push(`${p.slug}: category plan=${pl.category} vs WP=${p.categorySlugs[0] || '(none)'}`);
    const diffTag = planTags.filter((x) => !p.tagSlugs.includes(x)).concat(p.tagSlugs.filter((x) => !planTags.includes(x)));
    if (diffTag.length) catTagMismatch.push(`${p.slug}: tags plan=[${planTags}] vs WP=[${p.tagSlugs}]`);
  }

  // ==== output ====
  const lines = [];
  lines.push('========== Reconciliation report (read-only, no data written) ==========');
  lines.push(`WP live: publish=${wpPublish.length} / draft=${wpDraft.length} | plan rows=${plans.length}（published=${plans.filter(p=>p.plan_status==='published').length}, queued=${plans.filter(p=>p.plan_status==='queued').length}, written=${plans.filter(p=>p.plan_status==='written').length}, todo=${plans.filter(p=>p.plan_status==='todo').length}, paused=${plans.filter(p=>p.plan_status==='paused').length}） | doc matrix slugs=${Object.keys(doc).length}`);
  lines.push('');
  lines.push(`【A1】in WP but missing in plan（${aNoPlan.length}）: ${aNoPlan.join('、') || 'none'}`);
  lines.push(`【A2】status mismatch（${aStatusMismatch.length}）: ${aStatusMismatch.join('；') || 'none'}`);
  lines.push(`【A3】plan published/queued/written but slug missing in WP（${aNoWp.length}）: ${aNoWp.join('、') || 'none'}`);
  lines.push('');
  lines.push(`【B1】plan.focus_keyword differs from doc primary keyword（doc wins，${kwMismatch.length}）:`);
  for (const x of kwMismatch) lines.push(`  - ${x}`);
  if (!kwMismatch.length) lines.push('  none');
  lines.push(`【B2】doc slug missing in plan（${kwNoDoc.length}）: ${kwNoDoc.join('、') || 'none'}`);
  lines.push('');
  lines.push(`【C1】doc slug missing in WP（neither publish nor draft，${docNoWp.length}）:`);
  for (const s of docNoWp) lines.push(`  - ${s}（plan_status=${(planBySlug.get(s) || {}).plan_status || 'no row'}）`);
  if (!docNoWp.length) lines.push('  none');
  lines.push(`【C2】doc slug missing in plan（${docNoPlan.length}）: ${docNoPlan.join('、') || 'none'}`);
  lines.push('');
  lines.push(`【D】published article category/tags plan vs WP differences（${catTagMismatch.length}）:`);
  for (const x of catTagMismatch) lines.push(`  - ${x}`);
  if (!catTagMismatch.length) lines.push('  none');

  const report = lines.join('\n');
  fs.writeFileSync(path.join(root, 'data/reconcile-report.txt'), report);
  console.log(report);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
