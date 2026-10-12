#!/usr/bin/env node
/**
 * channel-publish-due-ticker — external auto-publish ticker for the GEO agent
 * ============================================================================
 * Calls the UNIFIED auto-publish executor (the engine behind the MCP tool
 * `channel_publish_due`: t.plan.channelSchedule.publishDue) on a fixed interval.
 * It scans the channel_schedule slots, fires every platform whose slot is due NOW
 * (±30 min window, and not already run today), publishes through the same pipeline
 * as channel_publish (juejin / csdn / devto publish for real; wechat stays in the
 * draft box), and prints the published article LINKS.
 *
 * This is the "ONE external ticker" recommended by the tool docs — NOT one cron
 * job per channel. Intended to be driven by launchd (StartInterval 1800) or cron.
 *
 * Config (env):
 *   SITES_ROOT   sites workspace root        (default /Users/tim/tengence/geo-workspace)
 *   DB_DRIVER    sqlite                       (default sqlite)
 *   DB_PATH      sqlite db file              (default ~/.tengence/geo-mcp/geo.sqlite)
 *   SITE         site key to publish for     (default www_tengence_com)
 *   DRY_RUN      1 -> dryRun (no external calls, no writes)
 *   GEO_TICKER_LOG  append log path          (default <repo>/logs/channel-publish-due.log)
 *
 * Exit: 0 = normal (incl. nothing due / dry-run); 1 = setup or transport error.
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');
const t = require('@tengence/geo-sdk');

const SITES_ROOT = process.env.SITES_ROOT || '/Users/tim/tengence/geo-workspace';
const SITE = process.env.SITE || 'www_tengence_com';
const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');
const LOG_FILE =
  process.env.GEO_TICKER_LOG || path.join(REPO_ROOT, 'logs', 'channel-publish-due.log');
const LOCK_FILE = path.join(os.tmpdir(), `geo-channel-publish-due.${SITE}.lock`);

// ---- guard: avoid two overlapping ticker runs ----
function acquireLock() {
  try {
    let prev = null;
    try {
      prev = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    } catch {
      /* no lock yet */
    }
    if (prev && prev.pid && prev.ts) {
      const ageMin = (Date.now() - prev.ts) / 60000;
      // still-running previous instance? (kill -0 style check via /proc not portable on mac,
      // so fall back to a time guard: a run should never take >25 min)
      if (ageMin < 25) {
        return false;
      }
    }
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    return true;
  } catch (e) {
    // If we cannot lock, still proceed (better to run than to silently skip).
    return true;
  }
}

function cstStamp(d = new Date()) {
  // Beijing time (UTC+8) for human-friendly logs
  const beijing = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${beijing.getUTCFullYear()}-${p(beijing.getUTCMonth() + 1)}-${p(beijing.getUTCDate())} ` +
    `${p(beijing.getUTCHours())}:${p(beijing.getUTCMinutes())}:${p(beijing.getUTCSeconds())}`
  );
}

function appendLog(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    /* logging is best-effort */
  }
}

/**
 * Render the publishDue report into human-readable lines (pure: no I/O, no SDK).
 * Exported so it can be unit-tested with a synthetic report (incl. the URL-display
 * branch) without triggering any real external publish.
 * @param {object} report  the publishDue report
 * @param {{site:string, dryRun:boolean}} opts
 * @returns {string[]} lines
 */
function renderReport(report, opts) {
  const { site, dryRun, elapsed = '0.0' } = opts;
  const lines = [];
  const push = (s) => lines.push(s);

  push('================================================================');
  push(
    ` GEO channel_publish_due · ${cstStamp()} · site=${site} · mode=${dryRun ? 'DRY-RUN' : 'LIVE'}`
  );

  const checked = report.checked || 0;
  const due = (report.due || []).length;
  push(` checked=${checked} · due=${due}`);
  push('----------------------------------------------------------------');

  if (due === 0) {
    push(' 当前无到期渠道，本次空跑。');
  } else {
    for (const r of report.results || []) {
      const platform = (r.platform || '?').toUpperCase();
      const pt = r.publish_time || '';
      if (r.status === 'no_due_articles') {
        push(` [${platform}] ${pt} 无待发布文章（该渠道今日已无可分发草稿）`);
        continue;
      }
      if (r.status === 'failed') {
        push(` [${platform}] ${pt} ✗ 失败: ${r.detail || r.error || ''}`);
        continue;
      }
      const isDraft = r.asDraft === true;
      const tag = isDraft ? 'DRAFT-BOX ← 需人工在后台发送' : 'PUBLISHED';
      const urls = Array.isArray(r.urls) ? r.urls : [];
      const slugs = Array.isArray(r.slugs) ? r.slugs : [];
      if (urls.length) {
        push(` [${platform}] ${pt} ${tag} (${urls.length})`);
        urls.forEach((u, i) => push(`    • ${u}${slugs[i] ? `  slug: ${slugs[i]}` : ''}`));
      } else if (slugs.length) {
        push(` [${platform}] ${pt} ${tag} (${slugs.length})  slugs: ${slugs.join(', ')}`);
      } else {
        push(` [${platform}] ${pt} ${tag}`);
      }
    }
  }

  if (report.audit && !dryRun) {
    const parts = [];
    for (const p of ['juejin', 'csdn']) {
      const a = report.audit[p];
      if (!a) continue;
      if (a.error) parts.push(`${p}:ERR(${String(a.error).slice(0, 40)})`);
      else if (a.skipped === 'dry_run') parts.push(`${p}:skip`);
      else parts.push(`${p}:synced(${a.liveCount != null ? a.liveCount : a.total != null ? a.total : '?'})`);
    }
    if (parts.length) push(` audit(审核同步): ${parts.join('  ')}`);
  }

  const publishedCount = (report.results || []).filter((r) => r.status === 'published').length;
  const linkCount = (report.results || []).reduce(
    (n, r) => n + (Array.isArray(r.urls) ? r.urls.length : 0),
    0
  );
  push('----------------------------------------------------------------');
  if (dryRun) {
    push(` [dry-run] 未执行真实发布；预览见上。耗时 ${elapsed}s`);
  } else {
    push(` ✅ 本次发布 ${publishedCount} 个渠道任务，外链 ${linkCount} 条。耗时 ${elapsed}s`);
  }
  push('================================================================');
  return lines;
}

async function main() {
  const started = Date.now();
  const lines = [];
  const push = (s) => {
    lines.push(s);
    console.log(s);
  };

  // 1) bind workspace + site (mirrors the MCP tool's withSite())
  t.workspace.use(SITES_ROOT);
  const siteObj = t.site.loadSite(SITE, { domain: SITE });
  const siteKey = siteObj.siteKey;

  // 2) run the unified executor
  const report = await t.plan.channelSchedule.publishDue({
    dryRun: DRY_RUN,
    siteKey,
    appId: Number(process.env.APP_ID || 1),
  });

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const rendered = renderReport(report, { site: SITE, dryRun: DRY_RUN, elapsed: secs });
  rendered.forEach((l) => push(l));

  const full = lines.join('\n');
  appendLog(full);
  return 0;
}

module.exports = { renderReport, main };

// Auto-run only when executed directly (not when required by a test).
if (require.main === module) {
  if (!acquireLock()) {
    const msg = `[${cstStamp()}] SKIP: a previous ticker run is still in progress (lock < 25min).`;
    console.log(msg);
    appendLog(msg);
    process.exit(0);
  }

  main()
    .then((code) => process.exit(code || 0))
    .catch((e) => {
      const msg = `[${cstStamp()}] ERROR: ${e && e.stack ? e.stack : e}`;
      console.error(msg);
      appendLog(msg);
      process.exit(1);
    });
}
