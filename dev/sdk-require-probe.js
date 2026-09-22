#!/usr/bin/env node
/**
 * require path resolution probe — regression baseline (2/3)
 * ============================================================================
 * Checks every relative-path `require` in all JS files under packages/, apps/, dev/
 * and reports unresolved links.
 *
 *   node dev/sdk-require-probe.js     # exit code 0 = no broken links
 *
 * ⚠️ Only calls require.resolve (never loads or executes module bodies), so it is
 *    safe for any script.
 * ⚠️ Comments MUST be stripped before scanning: example `require` calls inside
 *    JSDoc (e.g. `require('../lib/demo')`) are written for callers and would be
 *    misreported as broken links otherwise. — Already hit once; do not remove stripComments.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');

const files = execSync(`find ${REPO}/packages ${REPO}/apps ${REPO}/dev -name '*.js' | sort`, { encoding: 'utf8' })
  .trim()
  .split('\n')
  .map((f) => path.relative(REPO, f));

/** Strip block and line comments so example requires in docs are not treated as real code */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

let badTotal = 0;
const resolvedMap = [];

for (const rel of files) {
  const abs = path.join(REPO, rel);
  const src = stripComments(fs.readFileSync(abs, 'utf8'));
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const bad = [];
  const okList = [];
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue; // skip npm packages
    const target = path.resolve(path.dirname(abs), spec);
    try {
      require.resolve(target);
      okList.push(spec);
    } catch (e) {
      bad.push(spec);
    }
  }
  resolvedMap.push({ rel, ok: okList.length, bad });
  if (bad.length) {
    badTotal += bad.length;
    console.log(`❌ ${rel}\n     broken: ${bad.join(', ')}`);
  } else {
    console.log(`✅ ${rel}   (${okList.length} relative requires all resolvable)`);
  }
}

console.log(`\nTotal ${files.length} files, ${badTotal} broken links`);
process.exit(badTotal === 0 ? 0 : 1);
