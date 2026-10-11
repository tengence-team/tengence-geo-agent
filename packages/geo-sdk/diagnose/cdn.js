/**
 * diagnose/cdn.js — CDN / caching / transport-quality evidence
 * ============================================================================
 *   - cache hit-rate sampling over repeated probes of one URL (x-cache & friends)
 *   - static-asset cache policy sampling (HEAD — Cache-Control / immutable / ETag)
 *   - HTTP/3 presence (alt-svc header, complements proto.js ALPN probe)
 *   - CSP policy parse (report-only vs enforce readiness)
 * All probes are GET/HEAD, bounded, soft-fail.
 */

const { fetchPage } = require('./fetch');

const CACHE_HEADERS = ['x-cache', 'cf-cache-status', 'x-cache-status', 'x-cache-hits', 'age', 'x-swift-cachetime'];

function cacheHitsFromHeaders(headers) {
  const out = [];
  for (const h of CACHE_HEADERS) {
    const v = headers[h] || headers[h.toLowerCase()];
    if (v !== undefined && v !== null && v !== '') out.push({ header: h, value: String(v) });
  }
  return out;
}

/** Classify an x-cache-ish value into HIT / MISS / dynamic / unknown. */
function classifyCacheValue(value) {
  const v = String(value || '').toUpperCase();
  if (v.includes('HIT')) return 'hit';
  if (v.includes('MISS') || v.includes('BYPASS')) return 'miss';
  if (v.includes('DYNAMIC') || v.includes('STALE')) return 'dynamic';
  return 'unknown';
}

/**
 * @param {string} url
 * @param {{samples?:number, intervalMs?:number, timeoutMs?:number, firstSample?:{headers:object}|null}} [opts]
 *        firstSample: headers from an already-fetched response (e.g. the homepage
 *        fetch) — reused as sample #1 so we never duplicate an existing request.
 * @returns {Promise<{url:string, samples:Array<{index:number,status:number,cache:Array<{header:string,value:string}>}>,
 *           hit:number, miss:number, other:number, hitRate:number|null}>}
 */
async function probeCdnHits(url, { samples = 3, intervalMs = 500, timeoutMs = 10000, firstSample = null } = {}) {
  const out = { url, samples: [], hit: 0, miss: 0, other: 0, hitRate: null };
  const pushSample = (index, status, headers, error, ttfbMs) => {
    const cache = cacheHitsFromHeaders(headers || {});
    // classify from the first header whose value actually says HIT/MISS —
    // auxiliary values like x-swift-cachetime (a TTL in seconds) or age must
    // never drive the hit/miss verdict
    let cls = 'unknown';
    for (const h of cache) {
      const k = classifyCacheValue(h.value);
      if (k !== 'unknown') {
        cls = k;
        break;
      }
    }
    if (cls === 'hit') out.hit++;
    else if (cls === 'miss') out.miss++;
    else out.other++;
    out.samples.push({ index, status: status || 0, cache, ttfbMs: ttfbMs || null, error: error || null });
  };
  let i = 0;
  if (firstSample) {
    pushSample(1, firstSample.status, firstSample.headers, null, firstSample.ttfbMs);
    i = 1;
  }
  for (; i < samples; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, intervalMs));
    const res = await fetchPage(url, { timeoutMs });
    pushSample(i + 1, res.status, res.headers || {}, res.error, res.ttfbMs);
  }
  if (out.samples.length) out.hitRate = out.hit / out.samples.length;
  return out;
}

/**
 * @param {string[]} urls sample of static assets (js/css/img from the page)
 * @param {{timeoutMs?:number, maxUrls?:number}} [opts]
 * @returns {Promise<{probes:Array<{url:string,status:number,cacheControl:string|null,
 *           etag:string|null,immutable:boolean,error?:string}>}>}
 */
async function probeCachePolicy(urls = [], { timeoutMs = 8000, maxUrls = 3 } = {}) {
  const probes = [];
  for (const u of (urls || []).slice(0, Math.max(1, maxUrls))) {
    const res = await fetchPage(u, { timeoutMs, method: 'HEAD' });
    const cc = (res.headers && (res.headers['cache-control'] || res.headers['Cache-Control'])) || null;
    const etag = (res.headers && (res.headers.etag || res.headers.ETag)) || null;
    probes.push({
      url: u,
      status: res.status || 0,
      cacheControl: cc,
      etag,
      immutable: /immutable/i.test(cc || ''),
      error: res.error || null,
    });
  }
  return { probes };
}

/**
 * HTTP/3 readiness: does the origin advertise QUIC via alt-svc?
 * @param {object} headers homepage response headers
 * @returns {{h3:boolean, altSvc:string|null}}
 */
function probeHttp3(headers = {}) {
  const altSvc = headers['alt-svc'] || headers['Alt-Svc'] || null;
  return { h3: /h3(=|,|\s|$)/i.test(altSvc || ''), altSvc };
}

/**
 * Parse a CSP header and judge enforce-readiness. report-only with wide
 * directives is a deliberate rollout stage — flag what blocks enforcement.
 * @param {string|null} csp raw CSP header value
 * @param {string|null} cspReportOnly raw Content-Security-Policy-Report-Only value
 * @returns {{enforced:boolean, reportOnly:boolean, directives:Record<string,string[]>,
 *           enforceReady:boolean|null, blockers:string[]}}
 */
function parseCspPolicy(csp, cspReportOnly) {
  const parse = (v) => {
    const out = {};
    for (const part of String(v || '').split(';')) {
      const seg = part.trim();
      if (!seg) continue;
      const sp = seg.indexOf(' ');
      const name = (sp === -1 ? seg : seg.slice(0, sp)).toLowerCase();
      const values = sp === -1 ? [] : seg.slice(sp + 1).split(/\s+/).filter(Boolean);
      out[name] = values;
    }
    return out;
  };
  const enforced = !!(csp && String(csp).trim());
  const reportOnly = !!(cspReportOnly && String(cspReportOnly).trim());
  const dirs = parse(enforced ? csp : cspReportOnly || csp);
  const blockers = [];
  if (dirs['script-src'] && dirs['script-src'].includes("'unsafe-inline'")) blockers.push("script-src 含 unsafe-inline");
  if (dirs['style-src'] && dirs['style-src'].includes("'unsafe-inline'")) blockers.push('style-src 含 unsafe-inline');
  if (!dirs['default-src'] && !dirs['script-src']) blockers.push('缺少 default-src 兜底');
  return {
    enforced,
    reportOnly,
    directives: dirs,
    enforceReady: enforced ? null : reportOnly ? blockers.length === 0 : false,
    blockers,
  };
}

const EXT_TO_TYPE = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon',
  bmp: 'image/bmp',
};

/**
 * Lightweight image-format check: declared extension vs served Content-Type.
 * HEAD only — never downloads image bodies (magic-byte sniffing would).
 * @param {string[]} urls sample image URLs
 * @param {{timeoutMs?:number, maxUrls?:number}} [opts]
 * @returns {Promise<{probes:Array<{url:string,declared:string|null,contentType:string|null,mismatch:boolean,status:number,error?:string}>}>}
 */
async function probeImageTypes(urls = [], { timeoutMs = 8000, maxUrls = 2 } = {}) {
  const probes = [];
  for (const u of (urls || []).slice(0, Math.max(1, maxUrls))) {
    let declared = null;
    try {
      const pathname = new URL(u).pathname.toLowerCase();
      const ext = pathname.split('.').pop();
      declared = EXT_TO_TYPE[ext] || null;
    } catch {
      declared = null;
    }
    const res = await fetchPage(u, { timeoutMs, method: 'HEAD' });
    const ct = (res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || null;
    const normCt = ct ? String(ct).split(';')[0].trim().toLowerCase() : null;
    probes.push({
      url: u,
      declared,
      contentType: normCt,
      mismatch: !!(declared && normCt && !normCt.includes(declared)),
      status: res.status || 0,
      error: res.error || null,
    });
  }
  const mismatches = probes.filter((p) => p.mismatch);
  return { probes, mismatches };
}

module.exports = {
  probeCdnHits, probeCachePolicy, probeHttp3, parseCspPolicy, classifyCacheValue, probeImageTypes,
};
