#!/usr/bin/env node
/**
 * 一次性迁移脚本：publish_order 唯一化 + 删除死列（S9 / S10，2026-11-13）
 * ============================================================================
 * 背景：
 *   1) `publish_order` 是每个渠道队列"按历史发布顺序"排序的唯一依据，但它既没有
 *      唯一约束，还被写进了文本值 —— 生产库里有 12 行存的是 'written' / 'queued'
 *      而不是数字，另有 7 行是 0（从未分配）。三语行共用同一序号是设计，因此唯一
 *      索引只能约束主语言（zh-hans，453/453 篇都有）。
 *   2) `tengence_geo_article_images.status` 全代码库零读写，属于死列，直接删除。
 *
 * 步骤（全部幂等，可重复跑）：
 *   1. 用 plan/order.repair 归一：文本值/0 值 → 追加到队尾（按行 id 顺序，保留历史
 *      先后），三语对齐到 zh-hans，残余冲突把后一篇挪到队尾；
 *   2. 建部分唯一索引 uq_sqlite_plan_order (app_id, publish_order) WHERE lang='zh-hans'；
 *   3. DROP COLUMN tengence_geo_article_images.status（SQLite ≥ 3.35）。
 *
 * 性质：一次性任务，独立于 MCP / ensureSchema（ensureSchema 只做 IF NOT EXISTS + 版本号）。
 *
 * 用法：
 *   node scripts/migrate-plan-order-unique-2026-11-13.js            # dry-run，只出报告
 *   node scripts/migrate-plan-order-unique-2026-11-13.js --apply    # 正式执行
 *
 * 环境变量：DB_PATH 覆盖数据库路径（默认 ~/.tengence/geo-mcp/geo.sqlite）
 * ============================================================================
 */
'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const PLAN = 'tengence_geo_article_plan';
const ARTICLE_IMAGES = 'tengence_geo_article_images';
const DB_PATH = process.env.DB_PATH || path.join(process.env.HOME || '', '.tengence', 'geo-mcp', 'geo.sqlite');
const APPLY = process.argv.includes('--apply');
const APP_ID = Number(process.env.APP_ID || 1);

const order = require('../packages/geo-sdk/plan/order');

/** Adapt better-sqlite3 to the tiny `query()` surface plan/order expects. */
function makeConn(db) {
  return {
    async query(sql, params = []) {
      const stmt = db.prepare(sql);
      if (/^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)/i.test(sql)) {
        const info = stmt.run(...params);
        return [{ affectedRows: info.changes, insertId: info.lastInsertRowid }];
      }
      return [stmt.all(...params)];
    },
  };
}

function tableExists(db, name) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}

function columnExists(db, table, column) {
  if (!tableExists(db, table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function indexExists(db, name) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name = ?`).get(name);
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ DB not found: ${DB_PATH}`);
    process.exit(1);
  }
  console.log(`\n=== publish_order 唯一化迁移（${APPLY ? 'APPLY' : 'DRY-RUN'}）===`);
  console.log(`db: ${DB_PATH}`);

  const db = new Database(DB_PATH);
  const conn = makeConn(db);

  // haystack: the index cannot be built on dirty data, so repair must run before create
  const auditBefore = await order.audit({ appId: APP_ID, conn });
  console.log('before:', JSON.stringify(auditBefore.counts));

  const repair = await order.repair({ appId: APP_ID, apply: APPLY, conn });
  console.log('repair:', JSON.stringify(APPLY ? repair.after : repair.plan, null, 1).slice(0, 1200));
  if (!APPLY) {
    console.log('\n(dry-run) 未写库。确认无误后加 --apply。');
    db.close();
    return;
  }

  // 2) partial unique index
  const appIds = db.prepare(`SELECT DISTINCT app_id AS a FROM ${PLAN}`).all().map((r) => Number(r.a));
  const multiApp = appIds.length > 1;
  const idxName = multiApp ? null : 'uq_sqlite_plan_order';
  if (idxName && !indexExists(db, idxName)) {
    db.exec(
      `CREATE UNIQUE INDEX ${idxName} ON ${PLAN}                  (app_id, publish_order) WHERE lang = 'zh-hans' AND publish_order > 0`
    );
    console.log(`✅ index created: ${idxName}`);
  } else if (indexExists(db, 'uq_sqlite_plan_order')) {
    console.log('✅ index already present: uq_sqlite_plan_order');
  } else {
    console.log(`⚠️ multi-app DB (${appIds.join(',')}): index DDL is created by ensureSchema per app scope — skipped here`);
  }

  // 3) drop the dead column
  if (columnExists(db, ARTICLE_IMAGES, 'status')) {
    try {
      // an existing DB still carries the index on that column; SQLite refuses to
      // drop a column while an index references it
      if (indexExists(db, 'idx_sqlite_aimg_status')) db.exec('DROP INDEX idx_sqlite_aimg_status');
      db.exec(`ALTER TABLE ${ARTICLE_IMAGES} DROP COLUMN status`);
      console.log(`✅ dropped dead column: ${ARTICLE_IMAGES}.status`);
    } catch (e) {
      console.error(`❌ could not drop ${ARTICLE_IMAGES}.status: ${e.message}`);
      console.error('   (needs SQLite >= 3.35 — check better-sqlite3 version)');
      process.exitCode = 1;
    }
  } else {
    console.log(`✅ ${ARTICLE_IMAGES}.status already absent`);
  }

  const auditAfter = await order.audit({ appId: APP_ID, conn });
  console.log('after:', JSON.stringify(auditAfter.counts));
  if (auditAfter.counts.nonNumeric || auditAfter.counts.zeroOrder || auditAfter.counts.crossSlugDuplicate) {
    console.error('❌ still dirty after repair — investigate before relying on the index');
    process.exitCode = 1;
  }
  db.close();
  console.log('\n=== done ===');
}

main().catch((e) => {
  console.error('❌ migration failed:', e.message);
  console.error(e.stack);
  process.exit(1);
});
