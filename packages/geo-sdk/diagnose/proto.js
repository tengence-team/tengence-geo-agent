/**
 * diagnose/proto.js — HTTP protocol version probe via TLS ALPN
 * ============================================================================
 * HTTP/1.1 vs HTTP/2 matters for transport quality (multiplexing, TTFB on
 * international links). The fetch API does not expose the negotiated protocol,
 * so we do a tiny TLS handshake with an ALPN list and read what the server
 * advertises. Fails softly (null protocol = unknown, not a finding).
 */

const tls = require('tls');

/**
 * @param {string} host
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{protocol:('h2'|'http/1.1'|null), alpn:boolean, error?:string}>}
 */
function alpnProbe(host, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const opts = {
      host,
      port: 443,
      rejectUnauthorized: false,
      ALPNProtocols: ['h2', 'http/1.1'],
    };
    // RFC 6066: ServerName must not be an IP literal
    if (!/^[\d.]+$/.test(host) && host !== 'localhost') opts.servername = host;
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
    sock.setTimeout(timeoutMs, () => done({ protocol: null, alpn: false, error: 'timeout' }));
    sock.on('secureConnect', () => {
      const p = sock.alpnProtocol || null;
      done({ protocol: p === 'h2' ? 'h2' : p === 'http/1.1' ? 'http/1.1' : null, alpn: !!p });
    });
    sock.on('error', (e) => done({ protocol: null, alpn: false, error: e.message }));
  });
}

module.exports = { alpnProbe };
