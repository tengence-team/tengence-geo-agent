'use strict';
/**
 * Channel publishing-calendar service (plan domain) — t.plan.channel
 * ============================================================================
 * Orchestration over the workspace-local channel_plan table (repo: db/channel-plan):
 *   - importWechatPlan() parses the site's 《微信公众号发布计划.md》 into calendar rows
 *   - list / markStatus / nextDue expose the calendar to CLIs and MCP tools
 *
 * Data flow:
 *   channel-plan.js CLI   list / next / import-wechat → this service
 *   channel-publish.js    marks a row draft/published after syncing
 *   MCP channel_plan_next → nextDue() → slugs to prepare
 * ============================================================================
 */
const fs = require('fs');
const repo = require('../db/channel-plan');
const { withConn } = require('../db/connection');

/** Default tenant: process-level APP_ID env var (default 1). */
const DEFAULT_APP_ID = () => Number(process.env.APP_ID || 1);

/** Overview status text → row status. */
const OVERVIEW_STATUS = { '✅': 'published', '📝': 'draft', '⬜': 'todo' };

/**
 * Parse the 《微信公众号发布计划.md》 text into calendar rows.
 * Extracts from each `### 第N期 <主题>` block:
 *   - the per-issue overview row (建议发布日 / 状态) and
 *   - the article slug table (slug, draft id, per-row status).
 * @param {string} text raw markdown of the plan document
 * @returns {Array<{period:string, topic:string, weekday:string|null, weekdayNote:string|null,
 *                  article_slugs:string[], status:string, draft_ids:string[], notes:string|null}>}
 */
function parseWechatPlanText(text) {
  const lines = text.split('\n');
  const issues = [];
  let current = null; // { period, topic, overview: {...}, articles: [...] }
  // The overview table ("二、排期总览") appears BEFORE the per-issue sections;
  // collect it globally and merge at flush time.
  const overviewByPeriod = new Map();

  const flush = () => {
    if (!current) return;
    const overview = current.overview || overviewByPeriod.get(current.period) || {};
    const slugs = current.articles.map((a) => a.slug).filter(Boolean);
    const status = OVERVIEW_STATUS[overview.statusMark] || (current.articles.some((a) => /已群发/.test(a.statusText)) ? 'published' : current.articles.some((a) => /草稿已建/.test(a.statusText)) ? 'draft' : 'todo');
    const draftIds = [...new Set(current.articles.map((a) => a.draftId).filter((d) => d && d !== '—' && d !== '-'))];
    issues.push({
      period: current.period,
      topic: current.topic || null,
      weekday: overview.weekday || null,
      weekdayNote: overview.weekdayNote || null,
      article_slugs: slugs,
      status,
      draft_ids: draftIds,
      notes: overview.weekdayNote ? `建议发布日：${overview.weekdayNote}` : null,
    });
    current = null;
  };

  const overviewRe = /^\|\s*(第\d+期)\s*\|\s*((?:第\d+周\s*)?[^|]*)\s*\|\s*([^|]*)\s*\|\s*\d+\s*\|\s*([✅📝⬜])/;
  const issueHeadRe = /^###\s*(第\d+期)\s+(.+)$/;
  const articleRowRe = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/;

  for (const line of lines) {
    const head = line.match(issueHeadRe);
    if (head) {
      flush();
      current = { period: head[1], topic: head[2].trim(), overview: null, articles: [] };
      continue;
    }
    if (!current) {
      // overview rows live before the per-issue sections
      const ov = line.match(overviewRe);
      if (ov && ov[1]) {
        overviewByPeriod.set(ov[1], {
          weekday: ov[2].replace(/^第\d+周[\s\u3000]*/, '').trim() || null,
          weekdayNote: ov[2].trim(),
          statusMark: ov[4],
        });
      }
      continue;
    }
    const row = line.match(articleRowRe);
    if (row && current) {
      current.articles.push({
        num: row[1],
        slug: row[2].trim(),
        title: row[3].trim(),
        category: row[4].trim(),
        tags: row[5].trim(),
        url: row[6].trim(),
        draftId: row[7].trim(),
        statusText: row[8].trim(),
      });
      continue;
    }
    // overview row inside the same section region (fallback capture)
    if (current && !current.overview) {
      const ov = line.match(overviewRe);
      if (ov && ov[1] === current.period) {
        current.overview = {
          weekday: ov[2].replace(/^第\d+周[\s\u3000]*/, '').trim() || null,
          weekdayNote: ov[2].trim(),
          statusMark: ov[4],
        };
      }
    }
  }
  flush();
  return issues;
}

/**
 * Import rows from the 《微信公众号发布计划.md》 file.
 * Upserts each issue keyed by (platform='wechat', period).
 * @param {string} mdPath absolute path of the plan markdown
 * @returns {Promise<{platform:string, imported:number, updated:number, rows:number}>}
 */
async function importWechatPlan(mdPath) {
  if (!fs.existsSync(mdPath)) throw new Error(`WeChat plan file not found: ${mdPath}`);
  const text = fs.readFileSync(mdPath, 'utf8');
  const issues = parseWechatPlanText(text);
  const appId = DEFAULT_APP_ID();
  let imported = 0;
  let updated = 0;
  await withConn(async (conn) => {
    for (const issue of issues) {
      const res = await repo.upsert(conn, appId, {
        platform: 'wechat',
        period: issue.period,
        topic: issue.topic,
        weekday: issue.weekday,
        article_slugs: issue.article_slugs,
        status: issue.status,
        draft_ids: issue.draft_ids,
        notes: issue.notes,
      });
      if (res.action === 'insert') imported += 1;
      else updated += 1;
    }
  });
  return { platform: 'wechat', imported, updated, rows: issues.length };
}

/** List calendar rows (optional platform / status filter). */
async function list({ platform, status } = {}) {
  const appId = DEFAULT_APP_ID();
  let result;
  await withConn(async (conn) => {
    result = await repo.list(conn, appId, { platform, status });
  });
  return result;
}

/** Get one row by id. */
async function get(id) {
  const appId = DEFAULT_APP_ID();
  let result;
  await withConn(async (conn) => {
    result = await repo.get(conn, appId, Number(id));
  });
  return result;
}

/** Transition a row's status (todo → draft → published / paused); optionally records draft ids. */
async function markStatus(id, status, draftIds) {
  const appId = DEFAULT_APP_ID();
  let result;
  await withConn(async (conn) => {
    result = await repo.markStatus(conn, appId, Number(id), status, draftIds);
  });
  return result;
}

/** The next due row for a platform (earliest row still in todo), or null. */
async function nextDue(platform) {
  const appId = DEFAULT_APP_ID();
  let result;
  await withConn(async (conn) => {
    result = await repo.nextDue(conn, appId, platform);
  });
  return result;
}

module.exports = {
  parseWechatPlanText,
  importWechatPlan,
  list,
  get,
  markStatus,
  nextDue,
};
