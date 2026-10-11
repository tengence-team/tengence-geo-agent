/**
 * diagnose/probeRange.js — bounded batch status probing for site-scale inventory
 * ============================================================================
 * Lightweight HTTP status probes (HEAD, no body download) over a URL list, used
 * to answer the questions a single-page diagnosis cannot:
 *   - how many sitemap URLs actually resolve (200) vs fail (500 / 404 / other)
 *   - where the stable soft-500 / dead-page clusters are
 *   - what share of the *discoverable* site the sitemap really covers
 * Always bounded: concurrency + maxUrls caps keep this cheap even on huge
 * sitemaps (a site is sampled, never fully crawled).
 *
 * Politeness: HEAD only — a 200-URL sitemap probe must not drag tens of
 * megabytes of HTML across the network. Servers that answer HEAD with 405/501
 * fall back to GET (body still discarded) so the inventory stays accurate.
 */

const { UA, fetchPage } = require('./fetch');

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

  /** One status probe. HEAD first; if the server rejects HEAD (405/501) or the
   *  HEAD response has no useful status semantics, retry once with GET and
   *  discard the body. Redirects are followed by fetchPage internally.
   *  单次网络瞬时失败（error / status 0）重试一次（与 probeLlms 同模式），
   *  避免偶发超时把正常 URL 误报为 status 0。 */
  async function probeOne(url) {
    const attempt = async (method) => {
      const r = await fetchPage(url, { timeoutMs, method });
      return { status: r.status || 0, finalUrl: r.finalUrl || url, error: r.error };
    };

    let r = await attempt('HEAD');
    if (r.status === 405 || r.status === 501) {
      r = await attempt('GET');
    }

    if (r.error || r.status === 0) {
      const retry = await attempt('HEAD');
      if (retry.status === 405 || retry.status === 501) {
        r = await attempt('GET');
      } else {
        r = retry;
      }
    }

    return r;
  }

  let i = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, list.length) },
    async () => {
      while (i < list.length) {
        const url = list[i++];
        const r = await probeOne(url);
        out.statusDist[r.status] = (out.statusDist[r.status] || 0) + 1;
        if (r.status === 200) {
          out.ok200++;
          out.okUrls.push(r.finalUrl);
        } else {
          out.errorCount++;
          const rec = { url, status: r.status, finalUrl: r.finalUrl };
          out.failures.push(rec);
          if (ABNORMAL.has(r.status)) out.abnormal.push(rec);
        }
        if (r.error) out.failures[out.failures.length - 1].error = r.error;
      }
    },
  );
  await Promise.all(workers);
  return out;
}

module.exports = { probeRange, ABNORMAL };
