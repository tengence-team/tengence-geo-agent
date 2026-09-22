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
    const sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false });
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

/**
 * Full domain probe: DNS records + TLS certificate + WHOIS.
 */
async function dnsProbe(host) {
  const out = {
    host,
    a: [],
    aaaa: [],
    cname: [],
    ns: [],
    mx: [],
    txt: [],
    certificate: null,
    whois: null,
    errors: [],
  };
  const grab = async (fn, key) => {
    try {
      out[key] = await fn;
    } catch (e) {
      out.errors.push(`${key}: ${e.code || e.message}`);
    }
  };

  // A/AAAA/CNAME are host-specific; NS/MX/TXT and WHOIS live on the apex (registrable) domain
  const apex = host.replace(/^www\./i, '');
  await grab(dns.resolve4(host), 'a');
  await grab(dns.resolve6(host), 'aaaa');
  await grab(dns.resolveCname(host), 'cname');
  await grab(dns.resolveNs(apex), 'ns');
  await grab(dns.resolveMx(apex), 'mx');
  await grab(dns.resolveTxt(apex), 'txt');

  if (!IP_RE.test(host) && host !== LOCALHOST) {
    out.certificate = await certProbe(host).catch((e) => ({ error: e.message }));
    // WHOIS is per registrable domain: strip the common www subdomain
    out.whois = await whoisLookup(apex).catch((e) => ({ error: e.message }));
  }
  return out;
}

module.exports = { dnsProbe, whoisLookup, certProbe, whoisQuery };
