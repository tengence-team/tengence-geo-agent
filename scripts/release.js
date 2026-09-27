#!/usr/bin/env node
/**
 * Lockstep release helper (tengence-geo-agent/scripts/release.js)
 * ============================================================================
 * The four published packages pin their internal dependencies to EXACT versions
 * (e.g. geo-mcp depends on "@tengence/geo-sdk": "0.1.0"). A partial bump would
 * silently mismatch a new MCP with an old SDK. This script bumps all four packages
 * together, rewrites the internal pinned deps to the new version, and syncs the two
 * version fields in root server.json (top-level + packages[0]).
 *
 * Usage:
 *   node scripts/release.js 0.2.0            # set an explicit version
 *   node scripts/release.js --bump minor     # patch | minor | major (from current)
 *   node scripts/release.js 0.2.0 --dry-run  # show the plan, write nothing
 *   node scripts/release.js 0.2.0 --tag      # also create a local git tag v0.2.0
 *
 * NOTE: this script never pushes to a remote and never runs `npm publish`. With `--tag`
 * it will also create a release commit for the version-bump files (pass `--no-commit`
 * to keep the manual flow). Run publish yourself after reviewing the diff (and after
 * `npm ci` + `npm test` are green).
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Ordered: base first. Internal deps are only forward (sdk ← cli ← mcp ← agent).
const PACKAGES = [
  { file: 'packages/geo-sdk/package.json', name: '@tengence/geo-sdk' },
  { file: 'packages/geo-cli/package.json', name: '@tengence/geo-cli' },
  { file: 'packages/geo-mcp/package.json', name: '@tengence/geo-mcp' },
  { file: 'apps/agent/package.json', name: '@tengence/geo-agent' },
];

const INTERNAL = new Set(PACKAGES.map((p) => p.name));

function parseArgs(argv) {
  const out = { version: null, bump: null, dryRun: false, tag: false, noCommit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--tag') out.tag = true;
    else if (a === '--no-commit') out.noCommit = true;
    else if (a === '--bump') out.bump = argv[++i];
    else if (/^\d+\.\d+\.\d+/.test(a)) out.version = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.version && !out.bump) throw new Error('provide a version (x.y.z) or --bump patch|minor|major');
  return out;
}

function bumpVersion(current, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!m) throw new Error(`cannot bump from non-semver "${current}"`);
  let [_, M, m2, p] = m.map(Number);
  if (kind === 'major') { M += 1; m2 = 0; p = 0; }
  else if (kind === 'minor') { m2 += 1; p = 0; }
  else if (kind === 'patch') { p += 1; }
  else throw new Error(`--bump must be patch|minor|major, got "${kind}"`);
  return `${M}.${m2}.${p}`;
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}
function writeJson(rel, obj, dryRun) {
  const p = path.join(ROOT, rel);
  const text = JSON.stringify(obj, null, 2) + '\n';
  if (dryRun) {
    console.log(`  (dry-run) would write ${rel}`);
    return;
  }
  fs.writeFileSync(p, text);
  console.log(`  wrote ${rel}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const current = readJson(PACKAGES[0].file).version;
  const next = args.version || bumpVersion(current, args.bump);
  console.log(`Release plan: ${current} → ${next}${args.dryRun ? ' (dry-run)' : ''}`);

  // 1) Bump each package + rewrite internal pinned deps to the new version.
  for (const pkg of PACKAGES) {
    const json = readJson(pkg.file);
    json.version = next;
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
      const deps = json[field];
      if (!deps) continue;
      for (const dep of Object.keys(deps)) {
        if (INTERNAL.has(dep)) {
          deps[dep] = next;
          console.log(`  ${pkg.name}: ${dep} → ${next}`);
        }
      }
    }
    writeJson(pkg.file, json, args.dryRun);
  }

  // 2) Sync server.json (top-level version + packages[0].version).
  const srv = readJson('server.json');
  srv.version = next;
  if (Array.isArray(srv.packages) && srv.packages[0]) srv.packages[0].version = next;
  writeJson('server.json', srv, args.dryRun);

  // 3) Optional local git tag (never push).
  //    IMPORTANT: a tag created BEFORE the version bump is committed would point at the
  //    pre-bump HEAD and break the CI publish (seen on v0.1.1). So we commit the
  //    version-bump files first, then tag — guaranteeing the tag lands on a commit that
  //    actually contains version ${next}. Use --no-commit to keep the old manual flow.
  if (args.tag && !args.dryRun) {
    const tag = `v${next}`;
    const touched = [...PACKAGES.map((p) => p.file), 'server.json'];
    if (!args.noCommit) {
      execFileSync('git', ['add', ...touched], { cwd: ROOT });
      let hasStagedChanges = false;
      try {
        execFileSync('git', ['diff', '--cached', '--quiet', '--', ...touched], { cwd: ROOT, stdio: 'ignore' });
      } catch (e) {
        hasStagedChanges = true; // exit 1 = there are staged changes to commit
      }
      if (hasStagedChanges) {
        execFileSync('git', ['commit', '-m', `release: ${tag}`], { cwd: ROOT, stdio: 'inherit' });
        console.log(`  committed version bump as "release: ${tag}"`);
      } else {
        console.log('  (no staged version changes to commit — tagging current HEAD)');
      }
    } else {
      console.log('  (--no-commit: skipping the automatic release commit)');
    }
    execFileSync('git', ['tag', tag], { cwd: ROOT, stdio: 'inherit' });
    console.log(`  created local tag ${tag} (push with: git push origin ${tag})`);
  } else if (args.tag) {
    console.log(`  (dry-run) would create local tag v${next}`);
  }

  console.log('\nNext steps (review the diff first):');
  console.log('  npm ci && npm test');
  console.log('  npm publish --access public -w packages/geo-sdk');
  console.log('  npm publish --access public -w packages/geo-cli');
  console.log('  npm publish --access public -w packages/geo-mcp');
  console.log('  npm publish --access public -w apps/agent');
  console.log('  # then: mcp-publisher publish   (updates registry.modelcontextprotocol.io)');
  if (!args.tag) console.log(`  git tag v${next} && git push origin v${next}   # when ready`);
}

try {
  main();
} catch (e) {
  console.error(`release.js: ${e.message}`);
  process.exit(1);
}
