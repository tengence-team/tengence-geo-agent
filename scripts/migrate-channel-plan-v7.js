#!/usr/bin/env node
/**
 * 一次性迁移脚本：channel_plan v5 → v7（发布计划单篇化 + 语言维度）
 * ============================================================================
 * 背景：旧表以 `period` 为唯一键，且微信一行存一组（article_slugs 数组），
 *       单篇渠道的 period 由 publish_order 派生（P{order} 快照），重排后会撞唯一键。
 * 目标：新表一行 = 一个 (platform, slug, lang) 发布任务，唯一键 UNIQUE(app_id, platform, slug, lang)。
 *       - 微信组行 → 拆成 N 行（period=原期号，组内顺序=新行 id 顺序）
 *       - 单篇行 → slug = article_slugs[0]，period 保留原历史值（仅审计），lang 默认 'zh-hans'
 * 性质：一次性任务，独立于 MCP / ensureSchema（ensureSchema 只做 IF NOT EXISTS + 版本号）。
 *
 * 用法：
 *   node scripts/migrate-channel-plan-v7.js            # dry-run：预检 + 展示计划，不写库
 *   node scripts/migrate-channel-plan-v7.js --apply    # 正式执行（事务内，失败自动回滚）
 *
 * 环境变量：DB_PATH 覆盖数据库路径（默认 ~/.tengence/geo-mcp/geo.sqlite）
 * ============================================================================
 */
'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const TARGET_VERSION = 7;
const CHANNEL_PLAN = 'tengence_geo_channel_plan';
const DB_PATH = process.env.DB_PATH || path.join(process.env.HOME || '', '.tengence', 'geo-mcp', 'geo.sqlite');
const APPLY = process.argv.includes('--apply');

/** 新表 v7 DDL（与 packages/geo-sdk/db/sqlite-schema.js 的 channelPlanDDL 保持一致） */
function v7DDL(tableName) {
  return `
CREATE TABLE ${tableName} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL DEFAULT 1,
  platform TEXT NOT NULL,
  slug TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'zh-hans',
  period TEXT,
  topic TEXT,
  weekday TEXT,
  status TEXT DEFAULT 'todo',
  draft_ids TEXT,
  article_id TEXT,
  notes TEXT,
  schedule_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  UNIQUE (app_id, platform, slug, lang)
);`;
}

/** 从旧行拆出 v7 行；返回 null 表示该行无有效 slug（应中止） */
function expandOldRow(r) {
  let slugs = [];
  try { slugs = JSON.parse(r.article_slugs || '[]'); } catch (_) { slugs = []; }
  if (!Array.isArray(slugs) || !slugs.length) return null;
  const lang = 'zh-hans'; // 历史行均为国内平台中文发布
  return slugs.map((s) => {
    const slug = String(s).trim().toLowerCase();
    return {
      oldId: r.id,
      platform: r.platform,
      slug,
      lang,
      period: r.period,
      topic: r.topic,
      weekday: r.weekday,
      status: r.status,
      draft_ids: r.draft_ids,
      article_id: r.article_id,
      notes: r.notes,
      schedule_at: r.schedule_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  });
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`数据库不存在: ${DB_PATH}`);
    process.exit(1);
  }
  const db = new Database(DB_PATH);
  db.pragma('busy_timeout = 5000');
  try {
    const version = Number(db.pragma('user_version', { simple: true }));
    console.log(`DB   : ${DB_PATH}`);
    console.log(`mode : ${APPLY ? 'APPLY（正式执行）' : 'DRY-RUN（只预检，不写库）'}`);
    console.log(`user_version: ${version}`);

    if (version >= TARGET_VERSION) {
      console.log('已是 v7 或更高，无需迁移。');
      return;
    }
    const tbl = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(CHANNEL_PLAN);
    if (!tbl) {
      console.log(`表 ${CHANNEL_PLAN} 不存在，无需迁移（全新库走新 DDL）。`);
      return;
    }
    const oldSql = tbl.sql;
    const isOld = oldSql.includes('article_slugs') || oldSql.includes('UNIQUE (app_id, platform, period)');
    if (!isOld) {
      console.log('表结构不是 v5 旧版（无 article_slugs / period 唯一键），跳过。');
      return;
    }

    // ---- 预检：拆组 + 冲突检测 ----
    const rows = db.prepare(`SELECT * FROM ${CHANNEL_PLAN} ORDER BY id`).all();
    const newRows = [];
    const seen = new Map();
    for (const r of rows) {
      const expanded = expandOldRow(r);
      if (!expanded) {
        console.error(`行 ${r.id}（platform=${r.platform}, period=${r.period}）的 article_slugs 无有效 slug，请先人工处理。`);
        process.exit(1);
      }
      for (const nr of expanded) {
        const key = `${nr.platform}::${nr.slug}::${nr.lang}`;
        if (seen.has(key)) {
          console.error(`预检失败：迁移后唯一键冲突 "${key}"（旧行 ${seen.get(key)} 与 ${nr.oldId}）。`);
          console.error('说明：同一平台同一 slug 已有多行，需要先人工合并再去重。');
          process.exit(1);
        }
        seen.set(key, nr.oldId);
        newRows.push(nr);
      }
    }
    const wechatGroups = new Map();
    for (const nr of newRows) {
      if (nr.platform === 'wechat' && nr.period) {
        wechatGroups.set(nr.period, (wechatGroups.get(nr.period) || 0) + 1);
      }
    }
    console.log(`旧行数: ${rows.length} → 新行数: ${newRows.length}`);
    console.log(`平台分布: ${JSON.stringify([...new Set(newRows.map(r=>r.platform))].map(p => `${p}=${newRows.filter(r=>r.platform===p).length}`))}`);
    console.log(`微信期组: ${JSON.stringify([...wechatGroups.entries()].sort((a,b)=>a[0].localeCompare(b[0],'zh')))}`);
    console.log(`唯一键冲突: 0（预检通过）`);

    if (!APPLY) {
      console.log('\n预检通过。执行 `node scripts/migrate-channel-plan-v7.js --apply` 正式迁移。');
      return;
    }

    // ---- 正式迁移（事务） ----
    const tmp = `${CHANNEL_PLAN}_mig_v7`;
    db.exec('BEGIN');
    try {
      db.exec(`DROP TABLE IF EXISTS ${tmp}`);
      db.exec(v7DDL(tmp));
      const ins = db.prepare(
        `INSERT INTO ${tmp}
           (platform, slug, lang, period, topic, weekday, status, draft_ids, article_id, notes, schedule_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const nr of newRows) {
        ins.run(nr.platform, nr.slug, nr.lang, nr.period, nr.topic, nr.weekday, nr.status,
          nr.draft_ids, nr.article_id, nr.notes, nr.schedule_at, nr.created_at, nr.updated_at);
      }
      db.exec(`DROP TABLE ${CHANNEL_PLAN}`);
      db.exec(`ALTER TABLE ${tmp} RENAME TO ${CHANNEL_PLAN}`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sqlite_channel_plan_app ON ${CHANNEL_PLAN} (app_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sqlite_channel_plan_status ON ${CHANNEL_PLAN} (app_id, platform, status)`);
      db.pragma(`user_version = ${TARGET_VERSION}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    // ---- 校验 ----
    const count = db.prepare(`SELECT COUNT(*) c FROM ${CHANNEL_PLAN}`).get().c;
    const maxId = db.prepare(`SELECT MAX(id) m FROM ${CHANNEL_PLAN}`).get().m;
    const dup = db.prepare(
      `SELECT platform, slug, lang, COUNT(*) c FROM ${CHANNEL_PLAN} GROUP BY app_id, platform, slug, lang HAVING c > 1`
    ).all();
    const nullLang = db.prepare(`SELECT COUNT(*) c FROM ${CHANNEL_PLAN} WHERE lang IS NULL OR lang = ''`).get().c;
    const vNow = Number(db.pragma('user_version', { simple: true }));
    const issues = [];
    if (count !== newRows.length) issues.push(`行数不符: 期望 ${newRows.length}，实际 ${count}`);
    if (dup.length) issues.push(`唯一键冲突: ${JSON.stringify(dup)}`);
    if (nullLang) issues.push(`lang 空值: ${nullLang} 行`);
    if (vNow !== TARGET_VERSION) issues.push(`user_version 不符: ${vNow}`);

    console.log(`\n迁移完成。校验：行数=${count}，MAX(id)=${maxId}，user_version=${vNow}`);
    if (issues.length) {
      console.error('校验失败：');
      for (const i of issues) console.error('  - ' + i);
      process.exit(1);
    }
    console.log('校验全部通过。');

    // ---- 输出 旧id→新id 映射（审计） ----
    const mapFile = path.join(path.dirname(DB_PATH), 'channel-plan-v7-id-map.csv');
    const mapRows = db.prepare(
      `SELECT id, platform, slug, lang, period, status FROM ${CHANNEL_PLAN} ORDER BY id`
    ).all();
    const csv = ['new_id,platform,slug,lang,period,status'].concat(
      mapRows.map((r) => [r.id, r.platform, r.slug, r.lang, r.period, r.status].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    ).join('\n');
    fs.writeFileSync(mapFile, csv);
    console.log(`旧行→新行映射已写入: ${mapFile}`);
  } finally {
    db.close();
  }
}

main();
