#!/usr/bin/env node
// Back-scan (2026-11-04): run the hardened gate over every published zh-hans article
// and list the rows that remain hard failures post-isPublished-demotion (G17 / B3 /
// ledger / featured-image etc.). Read-only; no writes.
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const t = require('@tengence/geo-sdk');
const DB = process.env.DB_PATH || path.join(process.env.HOME, '.tengence/geo-mcp/geo.sqlite');

async function main() {
  const db = await t.db.createConnection({ database: DB });
  const [rows] = await db.query(
    `SELECT id, slug FROM tengence_geo_articles WHERE lang = 'zh-hans' AND wp_post_id > 0 ORDER BY id`
  );
  console.log(`Scanning ${rows.length} published zh-hans articles`);
  const hardFails = [];
  for (const { id, slug } of rows) {
    let report;
    try {
      report = await t.check.checkArticle({ slug, dir: 'industry-insights', lang: 'zh-hans', site: 'www_tengence_com' });
    } catch (e) {
      hardFails.push({ id, slug, error: e.message });
      continue;
    }
    // post-demotion hard failures: rows that are still !ok and not soft
    const fails = report.rows.filter((r) => !r[2] && !r[3]).map((r) => r[0] + ': ' + r[1]);
    if (fails.length) hardFails.push({ id, slug, fails });
  }
  await db.end();
  console.log(`\n===== ${hardFails.length} articles with hard failures =====`);
  for (const h of hardFails) {
    console.log(`\n[${h.id}] ${h.slug}`);
    if (h.error) { console.log('  ERROR: ' + h.error); continue; }
    for (const f of h.fails) console.log('  ❌ ' + f);
  }
}

main().catch((e) => { console.error('scan failed:', e); process.exit(1); });
