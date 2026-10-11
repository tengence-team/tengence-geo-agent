/**
 * diagnose/exposure.js — admin/backend exposure sweep
 * ============================================================================
 * HEAD-probes a bounded list of sensitive or non-public paths (WordPress and
 * generic admin/login/version endpoints) and reports which are reachable.
 * Politeness: HEAD only (status code, never content), robots paths respected
 * as a signal (reachable-but-robots-blocked is exactly the finding), no
 * login attempts, no POSTs. Soft-fail per path.
 */

const { fetchPage } = require('./fetch');

const EXPOSURE_PATHS = [
  '/wp-json/', '/wp-admin/', '/wp-login.php', '/wp-content/', '/wp-includes/',
  '/xmlrpc.php', '/feed/', '/user/login', '/admin/', '/.git/HEAD', '/.env', '/server-status',
];

/**
 * @param {string} baseUrl
 * @param {{timeoutMs?:number, paths?:string[], method?:'HEAD'|'GET'}} [opts]
 * @returns {Promise<{probes:Array<{path:string,status:number,finalUrl:string,error?:string}>}>}
 */
async function probeExposure(baseUrl, { timeoutMs = 8000, paths = EXPOSURE_PATHS, method = 'HEAD' } = {}) {
  const probes = [];
  for (const p of paths) {
    const url = new URL(p, baseUrl).href;
    const res = await fetchPage(url, { timeoutMs, method });
    probes.push({
      path: p,
      status: res.status || 0,
      finalUrl: res.finalUrl || p,
      error: res.error || null,
    });
  }
  return { probes };
}

module.exports = { probeExposure, EXPOSURE_PATHS };
