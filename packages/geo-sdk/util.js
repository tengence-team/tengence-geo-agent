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

module.exports = { retry };
