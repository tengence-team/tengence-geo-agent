/**
 * Cover probe (G20) — single implementation in geo-sdk/util.js
 *
 * The 公众号 cover gate, article-state.setFeaturedImage and publish_update_fields all
 * judge a cover URL through this one function. These tests pin the four verdicts plus
 * the cache and the kill switch, because a divergence between callers is exactly how
 * "the field has a value but the URL is dead" slipped through before.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { probeCover, clearCoverProbeCache, coverProbeEnabled } = require('../packages/geo-sdk/util');

const IMG = Buffer.from('89504e470d0a1a0a', 'hex'); // 8-byte PNG magic, enough for HEAD

let server;
let base;
let hits = 0;

test.before(async () => {
  server = http.createServer((req, res) => {
    hits += 1;
    if (req.url === '/ok.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': IMG.length });
      return res.end();
    }
    if (req.url === '/page.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html>');
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    return res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((r) => server.close(r)));

test('200 + image/* → usable', async () => {
  delete process.env.COVER_PROBE;
  clearCoverProbeCache();
  const v = await probeCover(`${base}/ok.png`);
  assert.equal(v.ok, true);
  assert.equal(v.status, 200);
  assert.equal(v.type, 'image/png');
});

test('404 → unusable (the exact case that let ai-marketing ship coverless)', async () => {
  clearCoverProbeCache();
  const v = await probeCover(`${base}/missing.png`);
  assert.equal(v.ok, false);
  assert.match(v.reason, /http 404/);
});

test('200 but text/html → unusable (a soft-404 page is not a cover)', async () => {
  clearCoverProbeCache();
  const v = await probeCover(`${base}/page.html`);
  assert.equal(v.ok, false);
  assert.match(v.reason, /not an image/);
});

test('network error → skipped but not fatal (a blip must not kill a good article)', async () => {
  clearCoverProbeCache();
  const v = await probeCover('http://127.0.0.1:9/nothing-here.png', { timeoutMs: 500 });
  assert.equal(v.ok, true);
  assert.equal(v.skipped, true);
});

test('empty / non-http url → unusable', async () => {
  assert.equal((await probeCover('')).ok, false);
  assert.equal((await probeCover('/blog/static/images/x.jpg')).ok, false);
});

test('cache: a second probe of the same URL does not hit the network', async () => {
  clearCoverProbeCache();
  const before = hits;
  await probeCover(`${base}/ok.png`);
  const afterFirst = hits;
  await probeCover(`${base}/ok.png`);
  assert.equal(afterFirst, before + 1);
  assert.equal(hits, afterFirst, 'second probe must be served from the LRU');
  await probeCover(`${base}/ok.png`, { force: true });
  assert.equal(hits, afterFirst + 1, 'force=true must bypass the cache');
});

test('COVER_PROBE=0 → skipped and allowed (offline / kill switch)', async () => {
  const old = process.env.COVER_PROBE;
  process.env.COVER_PROBE = '0';
  try {
    clearCoverProbeCache();
    assert.equal(coverProbeEnabled(), false);
    const v = await probeCover(`${base}/missing.png`);
    assert.equal(v.ok, true);
    assert.equal(v.skipped, true);
  } finally {
    if (old === undefined) delete process.env.COVER_PROBE;
    else process.env.COVER_PROBE = old;
  }
});
