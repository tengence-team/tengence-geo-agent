/**
 * diagnose/dns.js — free, local, deterministic domain intelligence
 * ============================================================================
 * Node built-ins only (dns / tls / net — no third-party or paid APIs):
 *   - DNS: A / AAAA / CNAME / NS / MX / TXT
 *   - TLS: certificate (issuer / validity / SAN) + negotiated protocol
 *   - WHOIS: port-43 lookup (IANA referral → registry server) — free protocol
 * Every probe fails softly (errors recorded, never blocks the diagnosis).
 */

const dns = require('dns').promises;
const tls = require('tls');
const net = require('net');

const IP_RE = /^[\d.]+$/;
const LOCALHOST = 'localhost';

/** Connect to a WHOIS server (port 43), send the query, collect the raw reply. */
function whoisQuery(server, query, { timeoutMs = 8000, maxBytes = 60000 } = {}) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* noop */
      }
      resolve(val);
    };
    const sock = net.connect({ host: server, port: 43 }, () => {
      try {
        sock.write(query + '\r\n');
      } catch {
        finish('');
      }
    });
    sock.setTimeout(timeoutMs, () => finish(''));
    sock.on('data', (c) => {
      data += c.toString('latin1');
      if (data.length > maxBytes) finish(data);
    });
    sock.on('error', () => finish(''));
    sock.on('close', () => finish(data));
    sock.on('end', () => finish(data));
  });
}

/** TLS certificate probe over a raw socket (no CA verification needed for diagnosis). */
function certProbe(host, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const opts = { host, port: 443, rejectUnauthorized: false };
    // RFC 6066: ServerName must not be an IP literal
    if (!IP_RE.test(host) && host !== LOCALHOST) opts.servername = host;
    const sock = tls.connect(opts);
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* noop */
      }
      resolve(val);
    };
    sock.setTimeout(timeoutMs, () => done({ error: 'timeout' }));
    sock.on('secureConnect', () => {
      const cert = sock.getPeerCertificate();
      const proto = sock.getProtocol() || null;
      const daysLeft =
        cert && cert.valid_to
          ? Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86400000)
          : null;
      done({
        protocol: proto,
        issuer: cert.issuer || null,
        subject: cert.subject || null,
        subjectaltname: cert.subjectaltname || null,
        sans: (cert.subjectaltname || '')
          .split(',')
          .map((s) => s.trim().replace(/^DNS:/i, ''))
          .filter(Boolean),
        valid_from: cert.valid_from || null,
        valid_to: cert.valid_to || null,
        daysLeft,
      });
    });
    sock.on('error', (e) => done({ error: e.message }));
  });
}

/**
 * WHOIS lookup via IANA referral (free). Falls back to verisign-grs for misses.
 */
async function whoisLookup(domain) {
  if (IP_RE.test(domain) || domain === LOCALHOST) return null;
  const iana = await whoisQuery('whois.iana.org', domain);
  const m = /whois:\s*([^\s]+)/i.exec(iana);
  const server = m ? m[1].trim() : 'whois.verisign-grs.com';
  const raw = await whoisQuery(server, domain);
  if (!raw) return { error: 'empty whois response', server };
  const pick = (re) => {
    const mm = re.exec(raw);
    return mm ? mm[1].trim() : null;
  };
  const all = (re) =>
    (raw.match(re) || []).map((s) => s.replace(/^[^:]+:\s*/i, '').trim());
  return {
    server,
    registrar: pick(/Registrar:\s*(.+)/i),
    created: pick(/(?:Creation Date|Created On|Registered On|Created|Registration Date):\s*(.+)/i),
    updated: pick(/(?:Updated Date|Last Updated|Updated On):\s*(.+)/i),
    expires: pick(/(?:Registry Expiry Date|Expiration Date|Expires On|Expiry Date|Expiration Time):\s*(.+)/i),
    status: all(/Domain Status:\s*.+/gi),
    nameServers: all(/Name Server:\s*.+/gi),
    rawSnippet: raw.slice(0, 500),
  };
}

/** Resolve a CNAME chain recursively (bounded) down to the terminal A/AAAA record.
 *  Marks CDN/GSLB-style intermediate targets so a report can name the CDN vendor
 *  from the chain itself, not just from response headers. Every DNS step is
 *  time-bounded (c-ares can hang on GSLB chains in some environments). */
function resolveCnameChain(host, { maxHops = 5, hopTimeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const chain = [];
    let current = host;
    (async () => {
      for (let i = 0; i < maxHops; i++) {
        let cname = null;
        try {
          const ans = await Promise.race([
            dns.resolveCname(current),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), hopTimeoutMs)),
          ]);
          cname = ans && ans[0] ? ans[0] : null;
        } catch {
          cname = null; // not a CNAME target — terminal record expected next
        }
        if (!cname) break;
        chain.push({ from: current, to: cname, kind: classifyCname(cname) });
        current = cname;
      }
      // terminal A/AAAA for the last hop (time-bounded too)
      let a = [];
      let aaaa = [];
      try {
        a = await Promise.race([
          dns.resolve4(current),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), hopTimeoutMs)),
        ]);
      } catch {
        a = [];
      }
      try {
        aaaa = await Promise.race([
          dns.resolve6(current),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), hopTimeoutMs)),
        ]);
      } catch {
        aaaa = [];
      }
      resolve({ host, chain, terminal: current, a, aaaa });
    })().catch(() => resolve({ host, chain, terminal: host, a: [], aaaa: [] }));
  });
}

/** Tag well-known CDN/GSLB/LB CNAME suffixes (used for the chain-kind column). */
function classifyCname(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.cdngslb.com')) return 'aliyun-cdn-gslb';
  if (n.endsWith('.alicdn.com')) return 'aliyun-cdn';
  if (n.endsWith('.cdn.cloudflare.net')) return 'cloudflare';
  if (n.endsWith('.cloudfront.net')) return 'aws-cloudfront';
  if (n.endsWith('.fastly.net')) return 'fastly';
  if (n.endsWith('.edgekey.net') || n.endsWith('.edgesuite.net')) return 'akamai';
  if (n.endsWith('.qtlcdn.com')) return 'tencent-cdn';
  if (n.endsWith('.kunlun.com')) return 'tencent-cdn';
  if (n.endsWith('.dnspod.net')) return 'dnspod';
  if (n.endsWith('.aliyuncs.com')) return 'aliyun';
  return 'cname';
}

/**
 * Full domain probe: DNS records + TLS certificate + WHOIS.
 */
async function dnsProbe(host) {
  const out = {
    host,
    a: [],
    aaaa: [],
    cname: [],
    cnameChain: null,
    ns: [],
    mx: [],
    txt: [],
    certificate: null,
    apexCertificate: null,
    whois: null,
    errors: [],
  };
  const grab = async (fn, key) => {
    try {
      out[key] = await Promise.race([
        fn,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
      ]);
    } catch (e) {
      out.errors.push(`${key}: ${e.code || e.message}`);
    }
  };

  // A/AAAA/CNAME are host-specific; NS/MX/TXT and WHOIS live on the apex (registrable) domain
  const apex = host.replace(/^www\./i, '');
  await grab(dns.resolve4(host), 'a');
  await grab(dns.resolve6(host), 'aaaa');
  await grab(dns.resolveCname(host), 'cname');
  out.cnameChain = await resolveCnameChain(host).catch((e) => ({ error: e.message }));
  await grab(dns.resolveNs(apex), 'ns');
  await grab(dns.resolveMx(apex), 'mx');
  await grab(dns.resolveTxt(apex), 'txt');

  if (!IP_RE.test(host) && host !== LOCALHOST) {
    out.certificate = await certProbe(host).catch((e) => ({ error: e.message }));
    // apex HTTPS availability is a separate signal (e.g. www works but apex 443
    // has no valid cert → direct `example.com` visits fail)
    if (apex !== host) {
      out.apexCertificate = await certProbe(apex).catch((e) => ({ error: e.message }));
    } else {
      out.apexCertificate = out.certificate;
    }
    // WHOIS is per registrable domain: strip the common www subdomain
    out.whois = await whoisLookup(apex).catch((e) => ({ error: e.message }));
  }
  return out;
}

module.exports = { dnsProbe, whoisLookup, certProbe, whoisQuery, resolveCnameChain, classifyCname };
