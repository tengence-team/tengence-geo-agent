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

/** UTC ISO time → Beijing (UTC+8) date YYYY-MM-DD (pure offset math, no ICU) */
function beijingDay(iso) {
  const d = new Date(iso);
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Today's remaining quota: scan the log tail-to-head for the latest "same-day
 * (Beijing time) successful submission" record and return its detail.remain.
 * Returns null when there is no record / the log is unreadable (unknown).
 * Baidu's over-quota response carries no remain, so this is the only way to
 * infer the remaining daily quota.
 */
function lastRemainToday(logPath = defaultLogPath()) {
  let q = null;
  try {
    if (!fs.existsSync(logPath)) return null;
    const today = beijingDay(new Date().toISOString());
    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const d = JSON.parse(line);
        if (d.ok && d.detail && Number.isFinite(d.detail.remain) && beijingDay(d.ts) === today) {
          q = d.detail.remain;
          break;
        }
      } catch {
        /* skip a bad single line */
      }
    }
  } catch {
    /* unreadable log treated as unknown */
  }
  return q;
}

/** Record a failed batch: update stats.fail + batches and write the log (kept in sync) */
function failBatch(stats, logPath, batchNo, urls, error) {
  stats.fail += urls.length;
  stats.batches.push({ no: batchNo, ok: false, error });
  logLine({ action: 'submit', batch: batchNo, ok: false, error, urls: urls.slice(0, 20) }, logPath);
}

/**
 * Adaptive batched submission: when a whole batch hits "over quota", split and
 * retry by today's remaining quota instead of wasting the whole batch:
 *   1. If the log has a same-day success remain, split by that quota up front
 *      (the publish pipeline typically consumes quota first via single pushes);
 *   2. With unknown quota, try the full batch first, then halve on over-quota
 *      (failed requests do not consume quota, so halving is cheap);
 *   3. After a success, keep pushing with the response remain; stop at remain=0.
 *      The leftover count is recorded as failed.
 * Non over-quota errors (bad token / network, etc.) fail the whole batch without
 * splitting, matching the previous behavior.
 * @returns {Promise<void>} Results are merged into stats (ok / fail / batches)
 */
async function submitBatchAdaptive(batch, { token, site, logPath = defaultLogPath(), batchNo = 1, stats, submit = submitBatch }) {
  let remaining = batch.slice();
  let quota = null; // known today's remaining quota (0 = exhausted); null = unknown
  let size = null;  // size of the next attempt; null = decide automatically

  while (remaining.length > 0) {
    // 1) decide the size of this attempt
    if (quota === 0) break; // quota exhausted, give up on the rest
    if (size == null) {
      if (quota == null) {
        const q = lastRemainToday(logPath);
        if (q === 0) break; // the log says today's quota is exhausted
        if (q > 0) {
          quota = q;
          size = Math.min(q, remaining.length);
        } else {
          size = remaining.length; // no log info: try the full batch
        }
      } else {
        size = Math.min(quota, remaining.length);
      }
    }

    const sub = remaining.slice(0, size);
    try {
      const r = await submit(sub, { token, site });
      const pushed = r.success || 0;
      stats.ok += pushed;
      stats.batches.push({ no: batchNo, ok: true, detail: r });
      logLine({ action: 'submit', batch: batchNo, ok: true, detail: r, urls: sub.slice(0, 20) }, logPath);
      remaining = remaining.slice(pushed);
      quota = r.remain;
      size = null; // decide again next round
    } catch (e) {
      if (!/over\s*quota/i.test(e.message)) {
        // non-quota problem: fail the whole batch, do not split
        failBatch(stats, logPath, batchNo, remaining, e.message);
        return;
      }
      // over quota: shrink the batch (failed requests don't consume quota, halving is cheap)
      const next = Math.max(1, Math.floor(size / 2));
      if (next >= size) {
        failBatch(stats, logPath, batchNo, remaining, 'Baidu quota insufficient (over quota)');
        return;
      }
      quota = null; // ignore a possibly stale log remain, switch to halving mode
      size = next;
    }
  }

  if (remaining.length > 0) {
    failBatch(stats, logPath, batchNo, remaining, 'Baidu daily quota exhausted, leftover not submitted');
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

  // batched submission (Baidu max 2000 per request; each batch adaptively splits
  // by the remaining daily quota, see submitBatchAdaptive)
  const BATCH = 2000;
  const stats = { total: all.length, doneCount, pendingCount: pending.length, submitted: list.length, ok: 0, fail: 0, batches: [], noPending };
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const batchNo = i / BATCH + 1;
    await submitBatchAdaptive(batch, { token, site, logPath, batchNo, stats });
  }
  return stats;
}

module.exports = { API, submitBatch, loadDoneUrls, logLine, submitUrlsFromSitemap, submitBatchAdaptive, lastRemainToday, defaultLogPath };
