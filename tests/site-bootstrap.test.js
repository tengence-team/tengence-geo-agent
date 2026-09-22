/**
 * Site bootstrap (auto-init / lazy init) — @tengence/geo-sdk/site
 * ============================================================================
 * Pins the "first tool call auto-initializes the site" contract:
 *   1. siteKeyFromUrl: URL → { key (dots → underscores, lowercase), domain }
 *   2. initSite: minimal skeleton (.env + config/*.yaml + data/{inbox,reports}),
 *      idempotent, never overwrites, rejects unsafe keys
 *   3. loadSite(key, { autoInit }): missing site → bootstrap + _bootstrap.created
 *   4. default loadSite behaviour unchanged (throws "Site not found")
 *
 * Isolation: each test file runs in its own process under `node --test`, so
 * setSitesRoot(os.tmpdir()/...) only affects this file.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const site = require('../packages/geo-sdk/site');

let TMP;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-bootstrap-'));
  site.setSitesRoot(TMP);
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------------- siteKeyFromUrl ----------------

test('siteKeyFromUrl: hostname → lowercase, dots (and only dots) → underscores', () => {
  assert.deepEqual(site.siteKeyFromUrl('https://www.example.com/abc'), {
    key: 'www_example_com',
    domain: 'www.example.com',
  });
  assert.deepEqual(site.siteKeyFromUrl('HTTP://Example.COM'), {
    key: 'example_com',
    domain: 'example.com',
  });
  // ports and paths are ignored; hyphens are kept but become underscores too
  assert.deepEqual(site.siteKeyFromUrl('https://my-site.io:8443/x/y'), {
    key: 'my_site_io',
    domain: 'my-site.io',
  });
});

test('siteKeyFromUrl: rejects unsafe input', () => {
  assert.throws(() => site.siteKeyFromUrl('ftp://example.com'), /Unsupported protocol/);
  assert.throws(() => site.siteKeyFromUrl('file:///etc/passwd'), /Unsupported protocol/);
  assert.throws(() => site.siteKeyFromUrl('not a url'), /Invalid URL/);
  assert.throws(() => site.siteKeyFromUrl(''), /Invalid URL/);
  assert.throws(() => site.siteKeyFromUrl('https://a..b.com'), /Unsafe hostname/);
  assert.throws(() => site.siteKeyFromUrl('https://bad host.com'), /Invalid URL/);
  // path segments are normalized away by the WHATWG parser; only the hostname feeds
  // the key, so traversal cannot escape into a directory name
  assert.deepEqual(site.siteKeyFromUrl('https://example.com/../..'), {
    key: 'example_com',
    domain: 'example.com',
  });
});

// ---------------- initSite ----------------

test('initSite: creates the full skeleton once', () => {
  const r = site.initSite({ key: 'www_example_com', domain: 'www.example.com' });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.site_key, 'www_example_com');
  assert.equal(r.domain, 'www.example.com');

  for (const rel of r.structure) {
    assert.ok(
      fs.existsSync(path.join(TMP, 'www_example_com', rel)),
      `missing ${rel} under ${r.site_dir}`
    );
  }

  const siteYaml = fs.readFileSync(
    path.join(TMP, 'www_example_com', 'config', 'site.yaml'),
    'utf8'
  );
  assert.ok(siteYaml.includes('key: www_example_com'));
  assert.ok(siteYaml.includes('domain: www.example.com'));
  assert.ok(siteYaml.includes('default: zh-CN'));
  assert.ok(siteYaml.includes('posts: inbox'));

  const env = fs.readFileSync(path.join(TMP, 'www_example_com', '.env'), 'utf8');
  assert.ok(env.includes('APP_ID=1'));
});

test('initSite: idempotent and never overwrites existing files', () => {
  const r2 = site.initSite({ key: 'www_example_com', domain: 'www.example.com' });
  assert.equal(r2.created, false);

  // mutate site.yaml, then re-init → the file must stay untouched
  const siteYamlPath = path.join(TMP, 'www_example_com', 'config', 'site.yaml');
  const mutated = 'site: { custom: true }\n';
  fs.writeFileSync(siteYamlPath, mutated);
  site.initSite({ key: 'www_example_com' });
  assert.equal(fs.readFileSync(siteYamlPath, 'utf8'), mutated);
});

test('initSite: rejects unsafe keys', () => {
  assert.throws(() => site.initSite({ key: '../evil' }), /Invalid site key/);
  assert.throws(() => site.initSite({ key: 'a/b' }), /Invalid site key/);
  assert.throws(() => site.initSite({ key: 'UPPER' }), /Invalid site key/);
  assert.throws(() => site.initSite({ key: 'a b' }), /Invalid site key/);
  assert.throws(() => site.initSite({ key: '' }), /Invalid site key/);
});

// ---------------- loadSite + autoInit ----------------

test('loadSite: default behaviour unchanged (throws when site missing)', () => {
  assert.throws(() => site.loadSite('no_such_site'), /Site not found/);
});

test('loadSite: autoInit bootstraps a missing site and marks created', () => {
  const S = site.loadSite('fresh_site', { autoInit: true, domain: 'fresh.example.com' });
  assert.equal(S._bootstrap.created, true);
  assert.equal(S._bootstrap.site_key, 'fresh_site');
  assert.equal(S.siteKey, 'fresh_site');
  assert.equal(S.site.site.domain, 'fresh.example.com');
  assert.ok(fs.existsSync(path.join(TMP, 'fresh_site', 'data', 'reports')));
  assert.ok(fs.existsSync(path.join(TMP, 'fresh_site', 'config', 'site.yaml')));

  // second call on the same key → no new bootstrap, marker reports created:false
  const S2 = site.loadSite('fresh_site', { autoInit: true, domain: 'fresh.example.com' });
  assert.equal(S2._bootstrap.created, false);
  assert.equal(S2.siteKey, 'fresh_site');
});

test('end-to-end: URL → key → auto-init → site loads with the real domain', () => {
  const { key, domain } = site.siteKeyFromUrl('https://www.example.org/geo');
  assert.equal(key, 'www_example_org');

  const S = site.loadSite(key, { autoInit: true, domain });
  assert.equal(S._bootstrap.created, true);
  assert.equal(S.site.site.domain, 'www.example.org');
  assert.equal(S.site.site.key, 'www_example_org');
});
