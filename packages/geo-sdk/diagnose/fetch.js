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
 * Request accounting for the whole diagnosis run. The diagnose domain wants to
 * be a *polite* guest on the target site: every outbound request is counted so
 * callers can enforce a total budget and report the load they caused.
 * `get`/`head` count every hop (redirects included).
 */
const requestStats = { get: 0, head: 0 };
function countRequest(method) {
  requestStats[(method || 'GET').toUpperCase() === 'HEAD' ? 'head' : 'get']++;
}
function getRequestStats() {
  return { ...requestStats };
}
function resetRequestStats() {
  requestStats.get = 0;
  requestStats.head = 0;
}

/**
 * @param {string} url
 * @param {{timeoutMs?:number, maxRedirects?:number, headers?:object, method?:'GET'|'HEAD'}} [opts]
 *        method: 'HEAD' skips the body download entirely (status/headers only) —
 *        used by every status-probe so large sitemaps don't drag megabytes down.
 * @returns {Promise<{ok:boolean, status:number, statusText:string, finalUrl:string,
 *          redirects:Array<{from:string,status:number,location:string}>,
 *          headers:object, ttfbMs:number, bodyLength:number, body:string, error?:string}>}
 */
async function fetchPage(url, { timeoutMs = 15000, maxRedirects = 6, headers = {}, method = 'GET' } = {}) {
  const wantHead = String(method || 'GET').toUpperCase() === 'HEAD';
  const t0 = Date.now();
  const redirects = [];
  let current = url;
  let res;

  const common = {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'zh-hans,zh;q=0.9,en;q=0.8',
    ...headers,
  };
  const fetchOpts = (u) => ({
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    headers: common,
    method: wantHead ? 'HEAD' : 'GET',
  });

  try {
    countRequest(wantHead ? 'HEAD' : 'GET');
    res = await fetch(current, fetchOpts(current));
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
      countRequest(wantHead ? 'HEAD' : 'GET');
      res = await fetch(current, fetchOpts(current));
    } catch (e) {
      return { error: e.message, finalUrl: current, redirects };
    }
    hops++;
  }

  const ttfbMs = Date.now() - t0;
  let body = '';
  if (wantHead) {
    // HEAD: no body is transferred — length comes from the content-length header
    const cl = res.headers.get('content-length');
    const bodyLength = cl ? parseInt(cl, 10) || 0 : 0;
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      finalUrl: current,
      redirects,
      headers: Object.fromEntries(res.headers.entries()),
      rawCookies: [],
      ttfbMs,
      bodyLength,
      body,
    };
  }
  try {
    body = await res.text();
  } catch {
    body = '';
  }

  // raw Set-Cookie values (undici merges them in entries(); getSetCookie keeps them)
  let rawCookies = [];
  try {
    rawCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  } catch {
    rawCookies = [];
  }

  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    finalUrl: current,
    redirects,
    headers: Object.fromEntries(res.headers.entries()),
    rawCookies,
    ttfbMs,
    bodyLength: Buffer.byteLength(body),
    body,
  };
}

/**
 * Parse raw Set-Cookie strings into {name, secure, httpOnly, sameSite}.
 * Flags are the parts of a cookie the diagnosis cares about: Secure / HttpOnly /
 * SameSite=Lax|Strict|None. Missing flag = a real exposure signal on B2B sites.
 *
 * @param {string[]} rawCookies
 * @returns {{cookies:Array<object>, flags:{secure:number,httpOnly:number,sameSite:number},
 *            worst:number, total:number}}
 */
function parseCookieFlags(rawCookies = []) {
  const cookies = [];
  let secure = 0;
  let httpOnly = 0;
  let sameSite = 0;
  for (const raw of rawCookies) {
    const parts = String(raw).split(';').map((p) => p.trim()).filter(Boolean);
    const first = parts.shift() || '';
    const name = first.split('=')[0].trim();
    const flags = parts.map((p) => p.toLowerCase());
    const hasSecure = flags.includes('secure');
    const hasHttpOnly = flags.includes('httponly');
    const hasSameSite = flags.some((f) => f.startsWith('samesite='));
    if (hasSecure) secure++;
    if (hasHttpOnly) httpOnly++;
    if (hasSameSite) sameSite++;
    cookies.push({
      name,
      secure: hasSecure,
      httpOnly: hasHttpOnly,
      sameSite: hasSameSite,
    });
  }
  return { cookies, flags: { secure, httpOnly, sameSite }, total: cookies.length };
}

module.exports = { fetchPage, parseCookieFlags, UA, countRequest, getRequestStats, resetRequestStats };
