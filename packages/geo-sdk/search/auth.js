'use strict';
/**
 * Google service-account auth (zero new dependencies)
 * ============================================================================
 * Signs an RS256 JWT with the service-account JSON's RSA private key and exchanges
 * it at oauth2.googleapis.com for an access_token. Tokens are cached in memory per
 * scope (default 1h validity, renewed 60s early).
 *
 * Design points:
 *   - No googleapis / jwt dependency; plain node:crypto + global fetch.
 *   - Key path: GOOGLE_SA_JSON (absolute or relative to SITES_ROOT) → default
 *     <site>/secrets/gsc-service-account.json
 *   - Read-only; the private key is never printed.
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const siteConfig = require('../site/config');
const { gFetch, envProxy } = require('./http');

/**
 * Resolve the service-account JSON path.
 *
 * GOOGLE_SA_JSON is documented as relative to SITES_ROOT, but in practice it is
 * written inside a site's .env as "secrets/gsc-service-account.json" (site-relative,
 * i.e. <SITES_ROOT>/<site>/secrets/...). Resolving that against SITES_ROOT points at a
 * non-existent path and breaks every GSC call with "the file pointed to by
 * GOOGLE_SA_JSON does not exist". So: keep the SITES_ROOT-relative path when the file
 * is really there, otherwise fall back to the site directory before giving up.
 */
function resolveSaPath(site) {
  const fromEnv = process.env.GOOGLE_SA_JSON;
  if (fromEnv) {
    const p = path.isAbsolute(fromEnv) ? fromEnv : path.resolve(siteConfig.requireSitesRoot(), fromEnv);
    if (fs.existsSync(p)) return p;
    const siteRelative = path.resolve(site.siteDir, fromEnv);
    if (fs.existsSync(siteRelative)) return siteRelative;
    return p; // unchanged behaviour: the caller's error message stays accurate
  }
  return path.join(site.siteDir, 'secrets', 'gsc-service-account.json');
}

/** Load and validate the service-account JSON */
function loadServiceAccount(site) {
  const p = resolveSaPath(site);
  if (!fs.existsSync(p)) {
    const hint = process.env.GOOGLE_SA_JSON
      ? `The file pointed to by GOOGLE_SA_JSON does not exist: ${p}`
      : `No GSC service-account key found. Put the key at ${path.join(site.siteDir, 'secrets', 'gsc-service-account.json')}, or set GOOGLE_SA_JSON in .env.`;
    throw new Error(hint);
  }
  const sa = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const k of ['client_email', 'private_key', 'token_uri']) {
    if (!sa[k]) throw new Error(`Service-account key is missing a required field: ${k}`);
  }
  return sa;
}

/** Build an RS256 JWT (not sent; signed locally only) */
function makeJWT(sa, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope,
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const seg = b64(header) + '.' + b64(payload);
  const sig = crypto.createSign('RSA-SHA256').update(seg).sign(sa.private_key, 'base64url');
  return seg + '.' + sig;
}

// scope -> { token, exp }
const tokenCache = new Map();

/** Get an access_token (with an in-memory cache) */
async function getAccessToken(site, scope) {
  const sa = loadServiceAccount(site);
  const cached = tokenCache.get(scope);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;

  const jwt = makeJWT(sa, scope);
  const res = await gFetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    proxy: envProxy(site && site.env),
    body:
      'grant_type=' +
      encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
      '&assertion=' +
      encodeURIComponent(jwt),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google token fetch failed ${res.status}: ${text}`);
  }
  const json = JSON.parse(text);
  tokenCache.set(scope, {
    token: json.access_token,
    exp: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  });
  return json.access_token;
}

/** Clear the token cache (tests / multi-account scenarios) */
function resetCache() {
  tokenCache.clear();
}

module.exports = { resolveSaPath, loadServiceAccount, makeJWT, getAccessToken, resetCache };
