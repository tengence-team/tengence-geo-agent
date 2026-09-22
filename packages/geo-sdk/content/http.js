/**
 * Generic HTTP fetching (content domain)
 * ============================================================================
 * Convergence note (batch B): before the refactor, "fetch JSON" and "download a file"
 * each had 3 implementations:
 *   - acquire-featured-image.js  httpGetJson() / downloadFile()
 *   - publish-from-db.js         downloadImage()
 *   - wordpress-update-article.py download_image() (batch C rewrote it in Node)
 * Now unified into this module.
 *
 * Division of labor with wp/request.js: this module targets arbitrary off-site URLs
 * (image-library APIs, image binaries) with no auth concept; wp/request.js targets the
 * WordPress API (Basic Auth, unified error body).
 * ============================================================================
 */

const fs = require('fs');
const http = require('http');
const https = require('https');

/** Pick the module by protocol and build { mod, hostname, port, path } */
function resolveTarget(url) {
  const u = new URL(url);
  const useHttps = u.protocol === 'https:';
  return {
    mod: useHttps ? https : http,
    hostname: u.hostname,
    port: u.port || (useHttps ? 443 : 80),
    path: u.pathname + u.search,
    protocol: u.protocol,
  };
}

/**
 * GET a JSON endpoint
 * @param {string} url
 * @param {{headers?:object, timeout?:number, userAgent?:string}} [options]
 * @returns {Promise<any>} the parsed JSON
 */
function getJson(url, options = {}) {
  const { headers = {}, timeout = 0, userAgent } = options;
  return new Promise((resolve, reject) => {
    const target = resolveTarget(url);
    const finalHeaders = { ...headers };
    if (userAgent) finalHeaders['User-Agent'] = userAgent;

    const req = target.mod.request(
      { hostname: target.hostname, port: target.port, path: target.path, method: 'GET', headers: finalHeaders },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} ${url}`));
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON parse failed: ${e.message}`));
          }
        });
        res.on('error', reject);
      }
    );

    if (timeout > 0) {
      req.setTimeout(timeout, () => req.destroy(new Error(`request timed out: ${url}`)));
    }
    req.on('error', reject);
    req.end();
  });
}

/**
 * Download a file to a local path
 * On failure, cleans up the half-written file to avoid leaving a 0-byte remnant that
 * later code might mistake for valid output.
 * @param {string} url
 * @param {string} dest local destination path
 * @param {{headers?:object, timeout?:number, userAgent?:string}} [options]
 * @returns {Promise<string>} dest
 */
function download(url, dest, options = {}) {
  const { headers = {}, timeout = 0, userAgent } = options;
  return new Promise((resolve, reject) => {
    const target = resolveTarget(url);
    const finalHeaders = { ...headers };
    if (userAgent) finalHeaders['User-Agent'] = userAgent;

    const cleanup = () => fs.unlink(dest, () => {});

    const req = target.mod.get(
      { hostname: target.hostname, port: target.port, path: target.path, headers: finalHeaders },
      (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`download failed: HTTP ${res.statusCode}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(dest);
        });
        file.on('error', (err) => {
          cleanup();
          reject(err);
        });
        res.on('error', (err) => {
          cleanup();
          reject(err);
        });
      }
    );

    if (timeout > 0) {
      req.setTimeout(timeout, () => req.destroy(new Error(`download timed out: ${url}`)));
    }
    req.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}

module.exports = { getJson, download };
