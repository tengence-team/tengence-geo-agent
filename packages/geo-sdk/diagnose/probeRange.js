/**
 * diagnose/probeRange.js — bounded batch status probing for site-scale inventory
 * ============================================================================
 * Lightweight HTTP status probes (GET, body discarded) over a URL list, used to
 * answer the questions a single-page diagnosis cannot:
 *   - how many sitemap URLs actually resolve (200) vs fail (500 / 404 / other)
 *   - where the stable soft-500 / dead-page clusters are
 *   - what share of the *discoverable* site the sitemap really covers
 * Always bounded: concurrency + maxUrls caps keep this cheap even on huge
 * sitemaps (a site is sampled, never fully crawled).
 */

const { UA } = require('./fetch');

const ABNORMAL = new Set([500, 502, 503, 504, 429, 403, 410]);

/**
 * @param {string[]} urls
 * @param {{concurrency?:number, timeoutMs?:number, maxUrls?:number}} [opts]
 * @returns {Promise<{
 *   total:number, ok200:number, errorCount:number,
 *   statusDist:Record<string,number>,
 *   failures:Array<{url:string,status:number,finalUrl:string}>,
 *   abnormal:Array<{url:string,status:number,finalUrl:string}>,
 *   okUrls:string[]
 * }>}
 */
async function probeRange(urls, { concurrency = 8, timeoutMs = 8000, maxUrls = 500 } = {}) {
  const list = (urls || []).slice(0, Math.max(1, maxUrls));
  const out = {
    total: list.length,
    ok200: 0,
    errorCount: 0,
    statusDist: {},
    failures: [],
    abnormal: [],
    okUrls: [],
  };
  if (!list.length) return out;

  let i = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, list.length) },
    async () => {
      while (i < list.length) {
        const url = list[i++];
        let status = 0;
        let finalUrl = url;
        let error = null;
        try {
          const res = await fetch(url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
              'user-agent': UA,
              accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
          });
          status = res.status;
          finalUrl = res.url || url;
          // body intentionally discarded — status-only inventory probe
          await res.arrayBuffer().catch(() => {});
        } catch (e) {
          error = e.message;
        }
        out.statusDist[status] = (out.statusDist[status] || 0) + 1;
        if (status === 200) {
          out.ok200++;
          out.okUrls.push(finalUrl);
        } else {
          out.errorCount++;
          const rec = { url, status, finalUrl };
          out.failures.push(rec);
          if (ABNORMAL.has(status)) out.abnormal.push(rec);
        }
        if (error) out.failures[out.failures.length - 1].error = error;
      }
    },
  );
  await Promise.all(workers);
  return out;
}

module.exports = { probeRange, ABNORMAL };
