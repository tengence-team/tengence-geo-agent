'use strict';
/**
 * Baidu Search Resource Platform "normal inclusion - API push" wrapper
 * (tengence-geo-sdk/search/baidu)
 * ============================================================================
 * Docs: https://ziyuan.baidu.com/linksubmit/index
 *   POST http://data.zz.baidu.com/urls?site=<site>&token=<token>
 *   body: plain text, one URL per line (≤ 2000 per request)
 *   response: {"remain": remaining quota, "success": success count}; errors
 *             {"error":400,"message":"..."}
 * Note: data.zz.baidu.com is directly reachable from CN networks, no proxy needed
 * (does not go through gFetch / HTTPS_PROXY).
 *
 * Sunk down from commands/submit-baidu.js on 2026-09-20: protocol, log dedupe and
 * incremental orchestration moved into this file; the CLI
 * (packages/geo-cli/bin/submit-baidu.js) keeps only argument parsing and result
 * rendering.
 *
 * Conventions:
 *   - The site parameter must NOT be URL-encoded: Baidu's endpoint doesn't decode
 *     per the standard (encodeURIComponent'd https%3A%2F%2F returns "site init
 *     fail"); the site and token must be concatenated verbatim.
 *   - A single failed batch only logs (data/baidu-log.jsonl); Baidu's quota is
 *     decided by the site's weight (remain = today's remaining count),
 *     success = success count.
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');

// The log lives in data/ alongside SITES_ROOT (multi-site shared inclusion-dedupe
// log; overridable via logPath)
const siteConfig = require('../site/config');
const API = 'http://data.zz.baidu.com/urls';

/**
 * Default log location: data/ next to the workspace.
 * Resolved per call (never at load time) because the workspace is bound later —
 * and because a captured constant would go stale if the binding changes.
 */
function defaultLogPath() {
  return path.join(siteConfig.requireSitesRoot(), '..', 'data', 'baidu-log.jsonl');
}

/** Submit a batch of URLs to Baidu (max 2000 per request) */
async function submitBatch(urlList, { token, site }) {
  if (!token || !site) {
    throw new Error('Incomplete Baidu submission params: need token (BAIDU_TOKEN) + site (BAIDU_SITE)');
  }
  const url = `${API}?site=${site}&token=${token}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'User-Agent': 'curl/7.12.1 tengence-baidu-submitter/1.0',
    },
    body: urlList.join('\n'),
  });
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`Baidu returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (j.error) {
    throw new Error(`Baidu API error ${j.error}: ${j.message}`);
  }
  return { httpStatus: res.status, success: j.success, remain: j.remain };
}

/** Read the successfully submitted URLs from the log (for incremental dedupe) */
function loadDoneUrls(logPath = defaultLogPath()) {
  const done = new Set();
  try {
    if (!fs.existsSync(logPath)) return done;
    for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.ok && Array.isArray(d.urls)) d.urls.forEach((u) => done.add(u));
      } catch {
        /* skip a bad single line */
      }
    }
  } catch {
    /* unreadable log treated as no dedupe */
  }
  return done;
}

/** Append a submission log line (write failure warns only, never affects the main flow) */
function logLine(entry, logPath = defaultLogPath()) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.warn(`  ⚠️ Log write failed (does not affect the main flow): ${e.message}`);
  }
}

/**
 * Full incremental submission from a sitemap (--all orchestration: fetch → log
 * dedupe → batched submit → write log)
 * @returns {Promise<{
 *   total:number, doneCount:number, pendingCount:number, submitted:number,
 *   ok:number, fail:number, batches:Array<{no:number, ok:boolean, detail?:object, error?:string}>,
 *   noPending:boolean
 * }>}
 */
async function submitUrlsFromSitemap({ token, site, sitemapUrl, resubmit = false, limit = 2000, logPath = defaultLogPath() }) {
  const { fetchAllSitemapUrls } = require('./sitemap');
  const all = await fetchAllSitemapUrls(sitemapUrl);

  // incremental push: default excludes URLs already successfully submitted in the
  // log (--resubmit disables dedupe)
  let pending = all;
  let doneCount = 0;
  if (!resubmit) {
    const done = loadDoneUrls(logPath);
    doneCount = done.size;
    pending = all.filter((u) => !done.has(u));
  }
  const list = pending.slice(0, limit);
  const noPending = list.length === 0;

  // batched submission (Baidu max 2000 per request)
  const BATCH = 2000;
  const stats = { total: all.length, doneCount, pendingCount: pending.length, submitted: list.length, ok: 0, fail: 0, batches: [], noPending };
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const batchNo = i / BATCH + 1;
    try {
      const r = await submitBatch(batch, { token, site });
      stats.ok += r.success || 0;
      stats.batches.push({ no: batchNo, ok: true, detail: r });
      logLine({ action: 'submit', batch: batchNo, ok: true, detail: r, urls: batch.slice(0, 20) }, logPath);
    } catch (e) {
      stats.fail += batch.length;
      stats.batches.push({ no: batchNo, ok: false, error: e.message });
      logLine({ action: 'submit', batch: batchNo, ok: false, error: e.message, urls: batch.slice(0, 20) }, logPath);
    }
  }
  return stats;
}

module.exports = { API, submitBatch, loadDoneUrls, logLine, submitUrlsFromSitemap, defaultLogPath };
