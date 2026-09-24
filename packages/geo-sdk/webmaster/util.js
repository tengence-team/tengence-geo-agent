'use strict';
/**
 * Search-engine webmaster console shared utilities (tengence-geo-sdk/webmaster/util)
 * ============================================================================
 * Shared helpers for the webmaster domain (Bing Webmaster Tools today; GSC / Baidu
 * / IndexNow are planned to move here from search/ later):
 *   - basicAuthHeader   build the HTTP Basic auth header for a console API key
 *     (Bing's convention: username = API key, password empty)
 *   - maskKey           mask a secret in logs / echoed config
 *   - encodeParam       URL-encode a path/query param per Bing API conventions
 *   - jsonl log (defaultLogPath / loadDoneUrls / logLine) — same incremental
 *     dedupe pattern as search/baidu, so sitemap-driven batch submission never
 *     re-pushes an already-submitted URL
 *
 * Conventions (inherited from the baidu domain):
 *   - the dedupe log lives in <SITES_ROOT>/../data/<name>-log.jsonl, shared across
 *     sites, overridable via logPath
 *   - log writes are best-effort: a write failure warns only and never affects
 *     the main flow
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const siteConfig = require('../site/config');

/** Mask a key: first 4 chars + "…" + total length (never the full secret). */
function maskKey(key) {
  if (!key) return '(not configured)';
  const s = String(key);
  return `${s.slice(0, 4)}… (${s.length} chars)`;
}

/** URL-encode a query parameter (siteUrl / url / sitemapUrl) per Bing API. */
function encodeParam(value) {
  return encodeURIComponent(String(value));
}

/** Default log location: <SITES_ROOT>/../data/<name>-log.jsonl (resolved per call). */
function defaultLogPath(name) {
  return path.join(siteConfig.requireSitesRoot(), '..', 'data', `${name}-log.jsonl`);
}

/** Read previously-ok entries from a jsonl log into a Set (for incremental dedupe). */
function loadDoneUrls(logPath) {
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

/** Append a log line (write failure warns only, never affects the main flow). */
function logLine(entry, logPath) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.warn(`  ⚠️ Log write failed (does not affect the main flow): ${e.message}`);
  }
}

module.exports = { maskKey, encodeParam, defaultLogPath, loadDoneUrls, logLine };
