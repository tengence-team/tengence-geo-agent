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
    'accept-language': 'zh-hans,zh;q=0.9,en;q=0.8',
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

module.exports = { fetchPage, parseCookieFlags, UA };
