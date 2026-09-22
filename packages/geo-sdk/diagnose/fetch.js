/**
 * diagnose/fetch.js — deterministic page fetching (Node 22 native fetch only)
 * ============================================================================
 * - manual redirect following (records the chain, caps at maxRedirects)
 * - TTFB measurement, response headers, body + byte length
 * - browser-ish UA + accept-language, timeout via AbortSignal
 * Every network call in the diagnose domain goes through fetchPage.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * @param {string} url
 * @param {{timeoutMs?:number, maxRedirects?:number, headers?:object}} [opts]
 * @returns {Promise<{ok:boolean, status:number, statusText:string, finalUrl:string,
 *          redirects:Array<{from:string,status:number,location:string}>,
 *          headers:object, ttfbMs:number, bodyLength:number, body:string, error?:string}>}
 */
async function fetchPage(url, { timeoutMs = 15000, maxRedirects = 6, headers = {} } = {}) {
  const t0 = Date.now();
  const redirects = [];
  let current = url;
  let res;

  const common = {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...headers,
  };

  try {
    res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: common,
    });
  } catch (e) {
    return { error: e.message, finalUrl: current, redirects };
  }

  let hops = 0;
  while ([301, 302, 303, 307, 308].includes(res.status) && hops < maxRedirects) {
    const loc = res.headers.get('location');
    if (!loc) break;
    redirects.push({ from: current, status: res.status, location: loc });
    current = new URL(loc, current).href;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: common,
      });
    } catch (e) {
      return { error: e.message, finalUrl: current, redirects };
    }
    hops++;
  }

  const ttfbMs = Date.now() - t0;
  let body = '';
  try {
    body = await res.text();
  } catch {
    body = '';
  }

  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    finalUrl: current,
    redirects,
    headers: Object.fromEntries(res.headers.entries()),
    ttfbMs,
    bodyLength: Buffer.byteLength(body),
    body,
  };
}

module.exports = { fetchPage, UA };
