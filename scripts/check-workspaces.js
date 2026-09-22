#!/usr/bin/env node
/**
 * Workspace consistency check (npm run build)
 * ============================================================================
 * Requires and inspects each package's key entry and dependency resolution:
 *   - every workspace package can be required (@tengence/geo-sdk / geo-cli / geo-mcp / geo-agent)
 *   - SDK domains lazy-load and instantiate (site/db/content/... without throwing)
 *   - all CLI bins exist and resolve
 *   - MCP registry tool count and names are consistent
 * Exits 1 on failure.
 */

const fs = require('fs');
const path = require('path');

let failed = 0;
const fail = (msg) => {
  failed++;
  console.error(`✗ ${msg}`);
};
const ok = (msg) => console.log(`✓ ${msg}`);

// 1. SDK loading & domain instantiation
try {
  const t = require('@tengence/geo-sdk');
  const domains = ['site', 'workspace', 'paths', 'db', 'plan', 'wp', 'content', 'images', 'search', 'publish', 'check', 'syndicate', 'taxonomy', 'llm', 'monitor', 'diagnose', 'util', 'cli'];
  const missing = domains.filter((d) => !t[d]);
  if (missing.length) fail(`geo-sdk missing domains: ${missing.join(', ')}`);
  else ok(`geo-sdk: all ${domains.length} domains ready`);
  ok(`geo-sdk version=${t.site && require('@tengence/geo-sdk/package.json').version}`);
} catch (e) {
  fail(`geo-sdk require: ${e.message}`);
}

// 2. CLI bin existence
try {
  const cliPkg = require('@tengence/geo-cli/package.json');
  const bins = Object.keys(cliPkg.bin || {});
  const binRoot = path.dirname(require.resolve('@tengence/geo-cli/package.json'));
  const missingBins = bins.filter((b) => !fs.existsSync(path.join(binRoot, cliPkg.bin[b])));
  if (missingBins.length) fail(`geo-cli missing bins: ${missingBins.join(', ')}`);
  else ok(`geo-cli: all ${bins.length} bins exist`);
} catch (e) {
  fail(`geo-cli require: ${e.message}`);
}

// 3. MCP registry
try {
  const { tools } = require('@tengence/geo-mcp/tools/registry');
  const names = new Set(tools.map((t) => t.name));
  if (names.size !== tools.length) fail('MCP duplicate tool names');
  else ok(`geo-mcp: ${tools.length} tools registered`);
} catch (e) {
  fail(`geo-mcp require: ${e.message}`);
}

// 4. Agent launcher existence
try {
  const agentPkg = require('@tengence/geo-agent/package.json');
  const launcher = path.join(path.dirname(require.resolve('@tengence/geo-agent/package.json')), agentPkg.bin['tengence-geo-agent']);
  if (!fs.existsSync(launcher)) fail('geo-agent launcher missing');
  else ok('geo-agent launcher ready');
} catch (e) {
  fail(`geo-agent require: ${e.message}`);
}

if (failed) {
  console.error(`\n✗ Check failed (${failed} item(s))`);
  process.exit(1);
}
console.log('\n✓ All checks passed');
