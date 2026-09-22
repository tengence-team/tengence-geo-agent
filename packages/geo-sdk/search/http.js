'use strict';
/**
 * GSC network layer: lightweight fetch wrapper (zero new dependencies)
 * ============================================================================
 * Background: Node 22's native fetch (undici) doesn't read the HTTPS_PROXY env var;
 * direct connections to Google from CN networks are often blocked and must go
 * through a user/system proxy (e.g. 127.0.0.1:7990) via a CONNECT tunnel.
 *
 * This module provides gFetch:
 *   - only when the target is a GSC (Google) domain (*.googleapis.com /
 *     *.google.com), AND HTTPS_PROXY / https_proxy is configured AND not excluded by
 *     NO_PROXY → go through the HTTP-proxy CONNECT tunnel + TLS (http/https proxies
 *     only; socks5 unsupported);
 *   - every other domain (Baidu data.zz.baidu.com, IndexNow api.indexnow.org, the
 *     site's own sitemap www.tengence.com, etc.) always uses native fetch directly,
 *     never through the proxy;
 *   - unified timeout (default 10s): fails fast when Google is unreachable without
 *     blocking the publish chain.
 *
 * ⚠️ Proxy allow-list rule (important): HTTPS_PROXY serves the GSC submission chain
 *    only. Non-Google requests like Baidu normal inclusion, IndexNow and sitemap
 *    fetching would report connect ECONNREFUSED if they accidentally routed through
 *    a local proxy (e.g. 127.0.0.1:7990 not running). The fix is in isGscHost.
 *
 * The returned object is compatible with existing caller usage (ok / status /
 * statusText / text() / json()).
 * ============================================================================
 */
const http = require('http');
const https = require('https');
const tls = require('tls');

const DEFAULT_TIMEOUT_MS = 10_000;

/** Read the proxy address (HTTPS targets use HTTPS_PROXY; both cases supported) */
function pickProxy() {
  return process.env.HTTPS_PROXY || process.env.https_proxy || null;
}

/** Only GSC (Google) domains may use the proxy: *.googleapis.com / *.google.com */
function isGscHost(host) {
  const h = (host || '').toLowerCase();
  return (
    h === 'googleapis.com' ||
    h.endsWith('.googleapis.com') ||
    h === 'google.com' ||
    h.endsWith('.google.com')
  );
}

/** NO_PROXY hit (exact host, subdomain wildcard or *) → direct, no proxy */
function inNoProxy(host) {
  const no = process.env.NO_PROXY || process.env.no_proxy;
  if (!no) return false;
  const h = host.toLowerCase();
  return no
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean)
    .some((p) => p === '*' || h === p || h.endsWith('.' + p));
}

/** Assemble a minimal response object compatible with the fetch Response */
function makeResponse(res, chunks) {
  const buf = Buffer.concat(chunks);
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    statusText: res.statusMessage || '',
    text: async () => buf.toString('utf8'),
    json: async () => JSON.parse(buf.toString('utf8')),
  };
}

/** Issue an HTTPS request through an HTTP-proxy CONNECT tunnel */
function tunnelFetch(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const pu = new URL(pickProxy());
    const isHttps = u.protocol === 'https:';
    if (!isHttps) {
      // non-HTTPS target (basically never in GSC scenarios): plain http request
      const req = http.request(
        u,
        { method: options.method || 'GET', headers: options.headers },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(makeResponse(res, chunks)));
        }
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timeout (${timeoutMs}ms)`)));
      req.once('error', reject);
      if (options.body) req.write(options.body);
      req.end();
      return;
    }

    const targetPort = u.port || 443;
    const proxyPort = pu.port || (pu.protocol === 'https:' ? 443 : 80);
    const connectReq = http.request({
      host: pu.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${u.hostname}:${targetPort}`,
      headers: { Host: `${u.hostname}:${targetPort}` },
    });
    connectReq.setTimeout(timeoutMs, () =>
      connectReq.destroy(new Error(`Proxy CONNECT timeout (${timeoutMs}ms)`))
    );
    connectReq.once('error', reject);

    connectReq.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed HTTP ${res.statusCode}`));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: u.hostname });
      const req = https.request(
        {
          createConnection: () => tlsSocket,
          host: u.hostname,
          path: u.pathname + u.search,
          method: options.method || 'GET',
          headers: options.headers,
        },
        (res2) => {
          const chunks = [];
          res2.on('data', (c) => chunks.push(c));
          res2.on('end', () => resolve(makeResponse(res2, chunks)));
        }
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timeout (${timeoutMs}ms)`)));
      req.once('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
    connectReq.end();
  });
}

/** Unified GSC request entry: only GSC domains with a proxy go through the tunnel;
 * everything else uses native fetch directly, all with a timeout */
async function gFetch(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const proxy = pickProxy();
  const host = new URL(url).hostname;
  if (proxy && isGscHost(host) && !inNoProxy(host)) {
    return tunnelFetch(url, options, timeoutMs);
  }
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

module.exports = { gFetch, pickProxy, isGscHost, inNoProxy, DEFAULT_TIMEOUT_MS };
