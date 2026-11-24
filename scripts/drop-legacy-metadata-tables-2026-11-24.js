#!/usr/bin/env node
/**
 * 一次性清理脚本：删除 8 张死表（2026-11-24）
 * ============================================================================
 * 背景：2026-09-20 起 SEO/GEO 元数据并入 `articles.seo` / `articles.geo` JSON 列，
 * 分类/标签的唯一真源是 `article_plan.category` / `article_plan.tags`（plan 是本地
 * 指定、发布时由工具读取的中间层）。下面 8 张表因此既不被主流程写入，也不再被任何
 * 读路径使用（实测全部 0 行）：
 *
 *   - 6 张 legacy 内容分表：seo / geo / qa_pairs / citations / social / vectors
 *   - 2 张分类标签关系表：article_categories / article_tags
 *
 * 代码侧同步动作：schema.js / sqlite-schema.js 里的 TABLES 常量、DDL、DROP 列表全部
 * 移除（SCHEMA_VERSION 11 → 12）；db/terms.js 只保留字典读；db/articles.js 改 join
 * article_plan；taxonomy 的 db-register 与 publish-draft 的注册调用删除。
 *
 * 性质：一次性任务，独立于 MCP / ensureSchema（ensureSchema 只做 IF NOT EXISTS + 版本号）。
 *
 * 用法：
 *   node scripts/drop-legacy-metadata-tables-2026-11-24.js            # dry-run，只出报告
 *   node scripts/drop-legacy-metadata-tables-2026-11-24.js --apply    # 备份后正式 DROP
 *
 * 环境变量：DB_PATH 覆盖数据库路径（默认 ~/.tengence/geo-mcp/geo.sqlite）
 * ============================================================================
 */
'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(process.env.HOME || '', '.tengence', 'geo-mcp', 'geo.sqlite');
const APPLY = process.argv.includes('--apply');

const DROP_TABLES = [
  'tengence_geo_seo',
  'tengence_geo_geo',
  'tengence_geo_qa_pairs',
  'tengence_geo_citations',
  'tengence_geo_social',
  'tengence_geo_vectors',
  'tengence_geo_article_categories',
  'tengence_geo_article_tags',
];

function tableExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function rowCount(db, name) {
  try {
    return db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get().c;
  } catch (_) {
    return null;
  }
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[drop-legacy] database not found: ${DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  console.log(`[drop-legacy] db: ${DB_PATH}`);
  console.log(`[drop-legacy] mode: ${APPLY ? 'APPLY' : 'dry-run'}`);
  console.log('');

  const present = [];
  for (const name of DROP_TABLES) {
    if (!tableExists(db, name)) {
      console.log(`  - ${name}: (absent, nothing to do)`);
      continue;
    }
    const rows = rowCount(db, name);
    present.push({ name, rows });
    console.log(`  - ${name}: ${rows} rows -> ${APPLY ? 'DROP' : 'would DROP'}`);
  }

  const nonEmpty = present.filter((t) => t.rows !== 0);
  if (nonEmpty.length) {
    console.error('');
    console.error('[drop-legacy] ABORT: these tables are not empty, refusing to drop:');
    for (const t of nonEmpty) console.error(`    ${t.name}: ${t.rows} rows`);
    db.close();
    process.exit(2);
  }

  if (!present.length) {
    console.log('\n[drop-legacy] nothing to drop.');
    db.close();
    return;
  }

  if (!APPLY) {
    console.log('\n[drop-legacy] dry-run complete. Re-run with --apply to execute.');
    db.close();
    return;
  }

  const backup = `/tmp/geo.sqlite.bak.${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  // consistent snapshot via the SQLite backup API (safe while WAL is live)
  return db.backup(backup).then(() => {
    console.log(`\n[drop-legacy] backup: ${backup}`);

    db.exec('BEGIN');
    try {
      for (const t of present) db.exec(`DROP TABLE IF EXISTS ${t.name}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      console.error(`[drop-legacy] failed, rolled back: ${e.message}`);
      db.close();
      process.exit(3);
    }

    console.log('\n[drop-legacy] dropped:');
    for (const t of present) console.log(`  - ${t.name}`);
    const remaining = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'tengence_geo_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    console.log('\n[drop-legacy] remaining tengence_geo_* tables:');
    for (const name of remaining) console.log(`  - ${name}`);
    db.close();
  });
}

main();
