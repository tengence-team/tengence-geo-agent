#!/usr/bin/env node
/**
 * tengence-geo-sdk behavior snapshot — regression baseline (1/3)
 * ============================================================================
 * Purpose: run once before and once after a "zero behavioral change" refactor;
 * diffing the two outputs reveals any behavior drift.
 *
 *   node dev/sdk-snapshot.js > /tmp/before.json
 *   (do the refactor)
 *   node dev/sdk-snapshot.js > /tmp/after.json
 *   diff /tmp/before.json /tmp/after.json      # expected: zero difference
 *
 * Captures:
 *   - the exported symbol set and types of each module
 *   - function arity — signature-drift detection
 *   - pure-function returns: readSiteArg / sitePath / contentPaths / extractSourcePlatform
 *   - loadSite() result shape (key set, without credential content)
 *   - WP upload target (credentials redacted: protocol / path / auth header length only)
 *
 * ⚠️ The snapshot targets SDK implementation modules (site/config, images, wp/media) —
 *    consumers require these paths directly (no compatibility layer in this repo).
 *    **Re-baseline after every intentional structural change**, or the diff keeps
 *    reporting noise.
 * ============================================================================
 */

const path = require('path');

const REPO = path.resolve(__dirname, '..');
process.env.SITES_ROOT = path.join(REPO, 'examples');
const SDK = path.join(REPO, 'packages', 'geo-sdk');

const out = {};

function describe(m) {
  const e = { exports: Object.keys(m).sort(), types: {} };
  for (const k of Object.keys(m)) e.types[k] = typeof m[k];
  return e;
}

// ---- 1. exported symbols & types ----
const sc = require(path.join(SDK, 'site', 'config.js'));
const idb = require(path.join(SDK, 'images', 'index.js'));
const wm = require(path.join(SDK, 'wp', 'media.js'));
out['site/config.js'] = describe(sc);
out['images/index.js'] = describe(idb);
out['wp/media.js'] = describe(wm);

// ---- 2. module-level constants ----
out.constants = {
  REPO_ROOT_ok: sc.REPO_ROOT === REPO,
  SITES_ROOT_ok: sc.SITES_ROOT === path.join(REPO, 'examples'),
  DEFAULT_SITE: sc.DEFAULT_SITE,
  listSites: sc.listSites(),
};

// ---- 3. pure functions ----
out.pure = {
  readSiteArg: [
    sc.readSiteArg(['node', 'x', '--site', 'foo']),
    sc.readSiteArg(['node', 'x', '--site=bar']),
    sc.readSiteArg(['node', 'x']),
    sc.readSiteArg(['node', 'x', '--site']),
    sc.readSiteArg(['node', 'x', '--site=']),
  ],
  sitePath: sc.sitePath('/a', 'b', 'c'),
  extractSourcePlatform: [
    'https://images.unsplash.com/photo',
    'https://images.pexels.com/x',
    'https://pixabay.com/x',
    'https://www.freepik.com/x',
    'https://stockadobio.com/x',
    'https://example.com/x',
  ].map(idb.extractSourcePlatform),
  imageDbCONFIG: idb.CONFIG,
};

// ---- 4. loadSite / contentPaths shape ----
const s = sc.loadSite('site-template');
out.loadSite = {
  keys: Object.keys(s).sort(),
  siteKey: s.siteKey,
  siteDir_ok: s.siteDir === path.join(REPO, 'examples', 'site-template'),
  configDir_ok: s.configDir === path.join(REPO, 'examples', 'site-template', 'config'),
  envPath_ok: s.envPath === path.join(REPO, 'examples', 'site-template', '.env'),
  siteKeys: Object.keys(s.site).sort(),
  // 2026-09-20: taxonomy.yaml retired (allow-list lives in the DB categories/tags tables);
  // s.taxonomy no longer exists here
  wordpressKeys: Object.keys(s.wordpress).sort(),
  envKeys: Object.keys(s.env).sort(),
};
out.contentPaths = sc.contentPaths(s);

// ---- 5. WP upload target (redacted) ----
try {
  const t = wm.resolveWpUploadTarget();
  const u = new URL(t.apiUrl);
  out.wpUploadTarget = {
    keys: Object.keys(t).sort(),
    proto: u.protocol,
    path: u.pathname,
    authPrefix: t.AUTH_HEADER.slice(0, 5),
    authLen: t.AUTH_HEADER.length,
  };
} catch (e) {
  out.wpUploadTarget = 'ERR:' + e.message;
}

// ---- 6. function arity (signature-drift detection) ----
out.arities = {};
for (const [file, m] of [['site/config.js', sc], ['images/index.js', idb], ['wp/media.js', wm]]) {
  const a = {};
  for (const k of Object.keys(m)) if (typeof m[k] === 'function') a[k] = m[k].length;
  out.arities[file] = a;
}

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
