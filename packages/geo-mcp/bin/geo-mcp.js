#!/usr/bin/env node
/**
 * GEO content engine MCP Server — stdio transport (local clients)
 * ============================================================================
 * Usage:
 *   node packages/geo-mcp/bin/geo-mcp.js
 *
 * Protocol: MCP 2026-07-28 (stateless core). strict modern-only: this entry serves
 * only 2026-07-28 clients via serveStdio with { legacy: 'reject' }; 2025-era
 * initialize-handshake clients are rejected. No SITES_ROOT / DB_PATH / APP_ID is
 * required: the user picks their working directory at runtime via the
 * `workspace_use` tool, and internal data lands in ~/.tengence/geo-mcp.
 *
 * Published distribution: once @tengence/geo-mcp is on npm, clients can also launch
 * it without a local checkout via `npx -y @tengence/geo-mcp` (the package resolves its
 * own script). Node 22.5+ enables the zero-native built-in SQLite driver; on Node 20/21
 * (or runtimes without node:sqlite) install the optional `better-sqlite3` dependency.
 */

const { buildServer, printStartupBanner } = require('../server');

async function main() {
  const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
  printStartupBanner();
  // Strict 2026-07-28: one factory per connection; legacy 2025-era openings rejected.
  serveStdio(() => buildServer(), { legacy: 'reject' });
}

main().catch((e) => {
  console.error(`[geo-mcp] failed to start: ${e.message}`);
  process.exit(1);
});
