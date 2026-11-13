/**
 * Status single-entry guard (2026-11-13)
 * ============================================================================
 * All status reads/writes must go through packages/geo-sdk/article-state.
 * This test fails CI when a raw UPDATE reappears on either status column,
 * because that is exactly how plan_status and articles.status drifted apart
 * (54 rows plan=published / articles=draft; 415 rows with another language's
 * article_id).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['packages/geo-sdk', 'packages/geo-mcp', 'packages/geo-cli'];
const ALLOW = [path.join('packages', 'geo-sdk', 'article-state')];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const FORBIDDEN = [
  { name: 'raw articles.status write', re: /UPDATE[^;]*tengence_geo_articles[^;]*?\bstatus\s*=[^;]*;/is },
  { name: 'raw plan_status write', re: /UPDATE[^;]*tengence_geo_article_plan[^;]*?\bplan_status\s*=[^;]*;/is },
];

test('no raw status UPDATE outside article-state', () => {
  const hits = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file);
      if (ALLOW.some((a) => rel.includes(a))) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const rule of FORBIDDEN) {
        const m = rule.re.exec(text);
        if (m) hits.push(`${rel}: ${rule.name} → ${m[0].replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(hits, [], `status must be written only through article-state:\n${hits.join('\n')}`);
});

test('article-state exports the single read/write surface', () => {
  const api = require('../packages/geo-sdk/article-state');
  for (const fn of ['read', 'list', 'setState', 'setFeaturedImage', 'audit', 'syncPlanMirror']) {
    assert.equal(typeof api[fn], 'function', `article-state must export ${fn}()`);
  }
});

test('plan status helpers are thin shims (no status vocabulary of their own)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'packages/geo-sdk/plan/index.js'), 'utf8');
  assert.ok(/articleState\.setState/.test(src), 'plan.updateStatus must delegate to articleState.setState');
  assert.ok(!/repo\.updateStatus\([^)]*plan_status/.test(src), 'plan/index.js must not hand plan_status to repo.updateStatus');
});

// Cover probing is the same class of problem as status: two implementations drift,
// and then one caller says "cover ok" while another says "404". Only geo-sdk/util.js
// may perform the HEAD request.
test('cover HEAD probe lives only in geo-sdk/util.js', () => {
  const ALLOW_PROBE = path.join('packages', 'geo-sdk', 'util.js');
  const hits = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file);
      if (rel === ALLOW_PROBE) continue;
      const text = fs.readFileSync(file, 'utf8');
      // diagnose/* legitimately HEAD arbitrary URLs (CDN / TLS / infra probes).
      // Only a COVER probe is forbidden outside util.js.
      if (/method:\s*['"]HEAD['"]/.test(text) && /\bcover\b|featured_image/i.test(text)) hits.push(rel);
    }
  }
  assert.deepEqual(hits, [], `cover probes must call util.probeCover instead of their own HEAD request:\n${hits.join('\n')}`);
});
