/**
 * Generic utilities (shared across modules)
 * ============================================================================
 * publish-from-db.js used to carry its own withRetry; this file lifts it into a
 * public SDK capability shared by the "publish chain" and the "image pipeline",
 * avoiding duplicate retry wrappers.
 * ============================================================================
 */

/**
 * Retry wrapper: auto-retries on transient network jitter so image processing etc.
 * is never silently downgraded.
 * @param {Function} fn          zero-arg function returning a Promise
 * @param {object}   [opts]
 * @param {number}   [opts.retries=3]  max attempts
 * @param {number}   [opts.delay=2000] retry interval (ms)
 * @param {Function} [opts.log=console.error] progress output
 * @returns {Promise<*>} fn's final return value
 */
async function retry(fn, { retries = 3, delay = 2000, log = console.error } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      log(`    ⚠️ retrying image operation ${i + 1}/${retries}: ${e.message}`);
      if (i < retries - 1) await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ===== cover probe (single implementation, 2026-11-13) =====
// The 公众号 G20 gate originally carried its own HEAD probe in syndicate/wechat.js,
// and article-state carried a third copy. Divergence here is exactly how "cover
// exists but 404" slipped through: every caller must judge one URL the same way.
// Rules: 2xx + image/* → usable; 4xx/5xx or non-image → unusable;
//        network error / timeout / disabled → ok with skipped:true (do not kill a good article).
const COVER_PROBE_TTL_MS = 10 * 60 * 1000;
const COVER_PROBE_MAX = 500;
const coverProbeCache = new Map(); // url -> { at, verdict }

function coverProbeEnabled() {
  const v = String(process.env.COVER_PROBE == null ? '1' : process.env.COVER_PROBE).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * HEAD-probe one cover URL.
 * @param {string} url
 * @param {{timeoutMs?:number, cache?:boolean, force?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, reason?:string, status?:number, type?:string, skipped?:boolean}>}
 */
async function probeCover(url, { timeoutMs = 2500, cache = true, force = false } = {}) {
  const target = String(url || '').trim();
  if (!target) return { ok: false, reason: 'no cover url' };
  if (!coverProbeEnabled()) return { ok: true, skipped: true, reason: 'probe disabled (COVER_PROBE=0)' };
  if (!/^https?:\/\//i.test(target)) return { ok: false, reason: `not an http(s) url (${target})` };

  if (cache && !force) {
    const hit = coverProbeCache.get(target);
    if (hit && Date.now() - hit.at < COVER_PROBE_TTL_MS) return hit.verdict;
  }
  const verdict = await headProbe(target, timeoutMs);
  if (cache) {
    if (coverProbeCache.size >= COVER_PROBE_MAX) {
      const oldest = coverProbeCache.keys().next().value;
      coverProbeCache.delete(oldest);
    }
    coverProbeCache.set(target, { at: Date.now(), verdict });
  }
  return verdict;
}

function headProbe(url, timeoutMs) {
  const http = require('http');
  const https = require('https');
  let mod;
  try {
    mod = new URL(url).protocol === 'https:' ? https : http;
  } catch (e) {
    return Promise.resolve({ ok: false, reason: `bad url (${e.message})` });
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = mod.request(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
      const type = String(res.headers['content-type'] || '');
      res.resume();
      if (res.statusCode >= 400) return done({ ok: false, reason: `http ${res.statusCode}`, status: res.statusCode, type });
      if (!/^image\//i.test(type)) return done({ ok: false, reason: `not an image (${type || 'unknown'})`, status: res.statusCode, type });
      return done({ ok: true, status: res.statusCode, type });
    });
    req.on('timeout', () => {
      req.destroy();
      done({ ok: true, skipped: true, reason: 'probe timeout — not treated as a hard failure' });
    });
    req.on('error', (e) => done({ ok: true, skipped: true, reason: `probe error: ${e.code || e.message}` }));
    req.end();
  });
}

/** Test hook: clear the in-process probe cache. */
function clearCoverProbeCache() {
  coverProbeCache.clear();
}

module.exports = { retry, probeCover, clearCoverProbeCache, coverProbeEnabled };
