/**
 * WordPress HTTP client (the only exit of the wp domain)
 * ============================================================================
 * Consolidation note (batch B): pre-refactor there were 4 separate WP request
 * implementations:
 *   - publish-from-db.js   httpRequest() + wpAPI()        (native http/https)
 *   - taxonomy.js          wpRequest() + wpFetchAll()     (node-fetch)
 *   - wp/media.js          uploadMedia()                  (raw https + form-data)
 *   - wordpress-update.py  requests.*
 * All now go through this module: one timeout, one error-body parser, one Basic
 * Auth, one pagination.
 *
 * Three layers:
 *   request(url, opts)                  low level: any absolute URL → {status, ok, headers, text, data}
 *   api(endpoint, opts)                 mid level: WP /wp/v2 relative paths → parsed data (throws on non-2xx)
 *   apiAll(resource, params, opts)      high level: auto-paginates by x-wp-totalpages for full records
 *
 * Usage:
 *   const wp = require('../wp');
 *   const post = await wp.posts.findBySlug('my-slug');
 *   const { data, headers } = await wp.request(url, { method: 'GET' });
 * ============================================================================
 */

const http = require('http');
const https = require('https');
const dns = require('dns');
const { wpTarget } = require('./target');

/**
 * Origin-direct connection (bypass the CDN layer): when WP_ORIGIN_HOST is set
 * (e.g. host.tengence.com, the origin server), resolve it once and force that IP
 * for the TCP connection while keeping the public hostname (WP_URL) for SNI and
 * certificate validation. Fixes "Client network socket disconnected before secure
 * TLS connection was established" — the CDN (cdngslb / 163.181.66.x) blocks node's
 * TLS ClientHello while the origin answers normally.
 * Returns a promise of the origin IP (null when not configured or resolution fails).
 */
let originIpPromise = null;
function resolveOriginIp() {
  if (!process.env.WP_ORIGIN_HOST) return Promise.resolve(null);
  if (!originIpPromise) {
    originIpPromise = dns.promises
      .lookup(process.env.WP_ORIGIN_HOST, { family: 4 })
      .then((r) => r.address)
      .catch(() => {
        originIpPromise = null; // allow a retry on the next request
        return null;
      });
  }
  return originIpPromise;
}

/**
 * Low-level request: any absolute URL
 * @param {string} url
 * @param {{method?:string, headers?:object, body?:any, auth?:boolean,
 *          timeout?:number}} [options]
 *   - auth: true attaches the Basic Auth header automatically
 *   - body: an object is JSON-serialized automatically with Content-Type added
 * @returns {Promise<{status:number, ok:boolean, headers:object, text:string, data:any}>}
 */
function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    auth = false,
    timeout = 60000,
  } = options;

  return resolveOriginIp().then((originIp) => new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${url}`));
    }

    const useHttps = target.protocol === 'https:';
    const mod = useHttps ? https : http;

    const finalHeaders = { ...headers };
    if (auth) finalHeaders.Authorization = wpTarget().authHeader;

    let payload = null;
    if (body !== null && body !== undefined) {
      if (typeof body === 'string' || Buffer.isBuffer(body)) {
        payload = body;
      } else {
        payload = JSON.stringify(body);
        if (!finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json';
      }
    }

    const reqOptions = {
      hostname: target.hostname,
      port: target.port || (useHttps ? 443 : 80),
      path: target.pathname + target.search,
      method,
      headers: finalHeaders,
    };
    // force the origin IP when configured (SNI / cert validation still use hostname)
    if (originIp) {
      reqOptions.lookup = (host, opts, cb) => {
        if (opts && opts.all) return cb(null, [{ address: originIp, family: 4 }]);
        cb(null, originIp, 4);
      };
    }

    const req = mod.request(reqOptions, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          let data = null;
          if (text) {
            try {
              data = JSON.parse(text);
            } catch (e) {
              data = text;
            }
          }
          const status = res.statusCode || 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            headers: res.headers,
            text,
            data,
          });
        });
        res.on('error', reject);
      }
    );

    req.setTimeout(timeout, () => {
      req.destroy(new Error(`Request timeout: ${url}`));
    });
    req.on('error', reject);

    if (payload !== null) req.write(payload);
    req.end();
  }));
}

/**
 * WP JSON API request (endpoints relative to /wp/v2)
 * @param {string} endpoint e.g. '/posts?slug=xxx'
 * @param {{method?:string, body?:any, auth?:boolean, timeout?:number, headers?:object}} [options]
 * @returns {Promise<any>} the parsed response body; throws on non-2xx
 */
async function api(endpoint, options = {}) {
  const { method = 'GET', body = null, auth = true, timeout = 60000, headers = {} } = options;
  const { apiUrl } = wpTarget();
  const res = await request(`${apiUrl}${endpoint}`, {
    method,
    body,
    auth,
    timeout,
    headers: { Accept: 'application/json', ...headers },
  });
  if (!res.ok) {
    const detail = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    throw new Error(`${method} ${endpoint} failed: ${res.status} ${detail}`);
  }
  return res.data;
}

/**
 * Auto-paginate by x-wp-totalpages, fetching a resource's full record set
 * @param {string} resource e.g. 'categories'
 * @param {object} [params] extra query params
 * @param {{auth?:boolean, timeout?:number}} [options]
 * @returns {Promise<Array>}
 */
async function apiAll(resource, params = {}, options = {}) {
  const { auth = true, timeout = 60000 } = options;
  const rows = [];
  let page = 1;
  while (true) {
    const query = new URLSearchParams({ ...params, per_page: '100', page: String(page) });
    const { apiUrl } = wpTarget();
    const res = await request(`${apiUrl}/${resource}?${query}`, {
      auth,
      timeout,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      const detail = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      throw new Error(`GET /${resource} failed: ${res.status} ${detail}`);
    }
    if (Array.isArray(res.data)) rows.push(...res.data);
    const totalPages = Number(res.headers['x-wp-totalpages'] || 1);
    if (page >= totalPages) break;
    page += 1;
  }
  return rows;
}

module.exports = { request, api, apiAll };
