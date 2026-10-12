#!/usr/bin/env node
/**
 * channel-publish-due-ticker — external auto-publish ticker for the GEO agent
 * ============================================================================
 * A PURE MCP CLIENT. It does NOT load the geo-sdk or run the engine directly.
 * It calls the already-running, persistent GEO MCP server (the encapsulation
 * layer) over HTTP and invokes the unified auto-publish tool `channel_publish_due`,
 * which scans channel_schedule slots and fires every platform whose slot is due
 * NOW (±30 min window, and not already run today), publishing through the same
 * pipeline as channel_publish (juejin / csdn / devto publish for real; wechat
 * stays in the draft box). The tool returns the full report (incl. published
 * article links) as JSON, which this ticker renders and logs.
 *
 * This is the "ONE external ticker" recommended by the tool docs — NOT one cron
 * job per channel. Intended to be driven by launchd (StartInterval 1800) or cron.
 *
 * Architecture (per project decision 2026-10-12):
 *   launchd (system node)  ──HTTP──▶  persistent GEO MCP server (launchd, system node)
 *                                       └─ runs channel_publish_due internally
 *
 * Config (env):
 *   MCP_BASE     base URL of the MCP server   (default http://127.0.0.1:8787)
 *   MCP_TOKEN    Bearer token                 (default sk-13e7ea6b5cb82ec6140180057284d86d)
 *   SITE         site key to publish for      (default www_tengence_com)
 *   DRY_RUN      1 -> dryRun (no external calls, no writes)
 *   GEO_TICKER_LOG  append log path           (default <repo>/logs/channel-publish-due.log)
 *
 * Exit: 0 = normal (incl. nothing due / dry-run / MCP unreachable handled as warn);
 *       1 = setup or fatal transport error.
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');

const MCP_BASE = (process.env.MCP_BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const MCP_TOKEN = process.env.MCP_TOKEN || 'sk-13e7ea6b5cb82ec6140180057284d86d';
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
      if (ageMin < 25) {
        return false;
      }
    }
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    return true;
  } catch (e) {
    return true;
  }
}

function cstStamp(d = new Date()) {
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
 * Minimal MCP Streamable-HTTP client (JSON-RPC 2.0 over POST /messages).
 * Mirrors the server's expected handshake: initialize -> notifications/initialized
 * -> tools/call. Returns the raw tool result object.
 */
async function callChannelPublishDue() {
  const headers = (sessionId) => {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${MCP_TOKEN}`,
    };
    if (sessionId) h['Mcp-Session-Id'] = sessionId;
    return h;
  };

  const post = async (body, sessionId) => {
    const res = await fetch(`${MCP_BASE}/messages`, {
      method: 'POST',
      headers: headers(sessionId),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const sid = res.headers.get('mcp-session-id') || sessionId;
    const text = await res.text();
    let data;
    if (/^\s*event:/.test(text) || text.includes('\ndata:')) {
      const lines = text.split('\n').filter((l) => l.startsWith('data:'));
      data = JSON.parse(lines[lines.length - 1].slice(5).trim());
    } else {
      data = text ? JSON.parse(text) : null;
    }
    return { data, sid };
  };

  // 1) initialize
  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'geo-channel-ticker', version: '1.0' },
    },
  });
  const sid = init.sid;
  if (!sid) {
    throw new Error('MCP initialize 未返回 session-id（服务不可用或鉴权失败）');
  }
  // 2) initialized notification
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
  // 3) tools/call channel_publish_due
  const call = await post(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'channel_publish_due',
        arguments: { site: SITE, dryRun: !!DRY_RUN },
      },
    },
    sid
  );

  const result = call.data && call.data.result;
  if (!result) {
    throw new Error('MCP 返回异常: ' + JSON.stringify(call.data));
  }
  if (result.isError) {
    throw new Error('MCP 工具执行失败: ' + (result.content || []).map((c) => c.text || '').join(''));
  }
  // ok() serializes the report as JSON.stringify(report, null, 2)
  const text = (result.content || []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  try {
    return JSON.parse(text);
  } catch {
    // Fallback: if the server ever returns a non-JSON payload, surface as-is.
    return { _raw: text, checked: 0, due: [], results: [] };
  }
}

/**
 * Render the publishDue report into human-readable lines (pure: no I/O, no SDK).
 * Exported so it can be unit-tested with a synthetic report (incl. the URL-display
 * branch) without triggering any real external publish.
 * @param {object} report  the publishDue report
 * @param {{site:string, dryRun:boolean, elapsed?:string}} opts
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

  // 1) call the persistent MCP server (the encapsulation layer)
  const report = await callChannelPublishDue();

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const rendered = renderReport(report, { site: SITE, dryRun: DRY_RUN, elapsed: secs });
  rendered.forEach((l) => push(l));

  const full = lines.join('\n');
  appendLog(full);
  return 0;
}

module.exports = { renderReport, main, callChannelPublishDue };

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
