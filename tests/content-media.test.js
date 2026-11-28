/**
 * Media upload metadata + filename normalisation.
 * Locks the SEO contract: filename is ASCII lowercase / hyphenated / <=80 chars,
 * alt and title are mandatory and describe the image in the page language.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const media = require('../packages/geo-sdk/wp/media');

test('media filename: normalises case, spaces, underscores and Chinese text', () => {
  assert.equal(
    media.normalizeMediaFilename('Tengence Docs_Quickstart Step1 工作台.PNG', '.png'),
    'tengence-docs-quickstart-step1.png'
  );
  assert.equal(
    media.normalizeMediaFilename('Tengence-docs-quickstart-step3-create-app-EN', '.png'),
    'tengence-docs-quickstart-step3-create-app-en.png'
  );
});

test('media filename: keeps a valid extension and caps length at 80', () => {
  const long = 'a'.repeat(120);
  const name = media.normalizeMediaFilename(`${long}.webp`, '.webp');
  assert.ok(name.endsWith('.webp'));
  assert.ok(name.length <= 80);
});

test('media upload: rejects a missing file, unsupported type, empty alt/title', async () => {
  await assert.rejects(() => media.uploadMediaWithMeta('/no/such/file.png', { alt: 'a', title: 't' }), /does not exist/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  const bad = path.join(dir, 'vector.svg');
  fs.writeFileSync(bad, '<svg/>');
  await assert.rejects(() => media.uploadMediaWithMeta(bad, { alt: 'a', title: 't' }), /Unsupported image extension/);

  const png = path.join(dir, 'shot.png');
  fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
  await assert.rejects(() => media.uploadMediaWithMeta(png, { alt: '', title: 't' }), /alt is required/);
  await assert.rejects(() => media.uploadMediaWithMeta(png, { alt: 'a', title: '' }), /title is required/);
  fs.rmSync(dir, { recursive: true, force: true });
});
