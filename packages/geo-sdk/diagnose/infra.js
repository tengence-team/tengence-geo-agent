/**
 * diagnose/infra.js — infrastructure-level evidence
 * ============================================================================
 *   - subdomain health sweep: DNS first (no site load), HTTP only for names
 *     that actually resolve; HEAD, bounded.
 *   - mobile (m.) subdomain redirect semantics: 301 good, 302 warnable.
 *   - certificate SAN usage audit: which SAN hostnames are actually served.
 * All network calls HEAD/GET only, soft-fail.
 */

const dns = require('dns').promises;
const { fetchPage } = require('./fetch');

/** Subdomains probed by default (cheap: DNS lookup is local, HTTP only when it resolves). */
const SUBDOMAIN_CANDIDATES = ['', 'www', 'm', 'static', 'api', 'cdn', 'img', 'blog', 'assets'];

function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout`)), ms)),
  ]);
}

/**
 * Host-existence check via the OS resolver (getaddrinfo). c-ares resolve4 can
 * hang indefinitely on GSLB/CNAME chains (e.g. *.cdngslb.com) in some network
 * environments, so we bound the lookup and prefer the system resolver, which
 * follows CNAME chains at the OS level.
 */
async function hostExists(host, timeoutMs = 3000) {
  try {
    const res = await withTimeout(dns.lookup(host, { family: 4, all: true }), timeoutMs, `dns ${host}`);
    return Array.isArray(res) && res.length > 0;
  } catch {
    return false;
  }
}

/**
 * @param {string} apex e.g. tengence.com
 * @param {{timeoutMs?:number, includeApex?:boolean}} [opts]
 * @returns {Promise<{probes:Array<{name:string, host:string, hasDns:boolean, a:string[],
 *           status:number, finalUrl:string, error?:string}>}>}
 */
async function probeSubdomains(apex, { timeoutMs = 8000, includeApex = true } = {}) {
  const probes = [];
  const names = [...SUBDOMAIN_CANDIDATES];
  if (!includeApex) names.splice(0, 1);
  for (const name of names) {
    const host = name ? `${name}.${apex}` : apex;
    const rec = { name: name || '(apex)', host, hasDns: false, a: [], status: 0, finalUrl: '' };
    rec.hasDns = await hostExists(host);
    if (rec.hasDns) {
      const res = await fetchPage(`https://${host}/`, { timeoutMs, method: 'HEAD' });
      rec.status = res.status || 0;
      rec.finalUrl = res.finalUrl || host;
      rec.error = res.error || null;
    }
    probes.push(rec);
  }
  return { probes };
}

/**
 * Mobile subdomain redirect audit.
 * @param {string} apex
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{host:string, hasDns:boolean, status:number, finalUrl:string, redirects:Array<{from:string,status:number,location:string}>, error?:string}|null>}
 */
async function probeMobileRedirect(apex, { timeoutMs = 8000 } = {}) {
  const host = `m.${apex}`;
  if (!(await hostExists(host))) return null; // no m. subdomain — not an error, just absent
  const res = await fetchPage(`https://${host}/`, { timeoutMs, method: 'HEAD' });
  return {
    host,
    hasDns: true,
    status: res.status || 0,
    finalUrl: res.finalUrl || host,
    redirects: res.redirects || [],
    error: res.error || null,
  };
}

/**
 * Certificate SAN usage audit: every SAN hostname with an actual service behind
 * it (resolves + answers). Pure computation + tiny DNS checks.
 * @param {Array<{name:string, sans?:string[]}>} certInfo certificate probe output
 * @param {string} apex
 * @returns {Promise<{sans:string[], used:string[], unused:string[]}>}
 */
async function checkSanUsage(certInfo, apex) {
  const sans = [...new Set((certInfo && certInfo.sans) || [])];
  const used = [];
  const unused = [];
  for (const s of sans) {
    const host = String(s).toLowerCase();
    if (!host.endsWith(apex)) continue;
    if (await hostExists(host)) used.push(host);
    else unused.push(host);
  }
  return { sans, used, unused };
}

/**
 * External (third-party) resource health: HEAD against a small sample of the
 * cross-origin assets the page depends on. Deliberately tiny (≤2 by default) —
 * these requests hit OTHER sites, so restraint matters more than coverage.
 * @param {string[]} urls cross-origin asset URLs from the page
 * @param {{timeoutMs?:number, maxUrls?:number}} [opts]
 * @returns {Promise<{probes:Array<{url:string,host:string,status:number,error?:string}>}>}
 */
async function probeExternalResources(urls = [], { timeoutMs = 8000, maxUrls = 2 } = {}) {
  const probes = [];
  for (const u of (urls || []).slice(0, Math.max(1, maxUrls))) {
    let host = '';
    try {
      host = new URL(u).hostname;
    } catch {
      /* noop */
    }
    const res = await fetchPage(u, { timeoutMs, method: 'HEAD' });
    probes.push({ url: u, host, status: res.status || 0, error: res.error || null });
  }
  const failed = probes.filter((p) => (p.status >= 400 && p.status !== 404) || p.error).map((p) => p.url);
  return { probes, failed };
}

module.exports = {
  probeSubdomains, probeMobileRedirect, checkSanUsage, probeExternalResources, SUBDOMAIN_CANDIDATES,
};
