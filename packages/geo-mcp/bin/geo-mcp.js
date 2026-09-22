#!/usr/bin/env node
/**
 * GEO content engine MCP Server — stdio transport (local clients)
 * ============================================================================
 * Usage:
 *   node packages/geo-mcp/bin/geo-mcp.js
 *
 * No workspace setting is required: the user picks their working directory at
 * runtime (the `workspace_use` tool), and internal data lands in ~/.tengence/geo-mcp.
 * Any MCP client configures the same way — one stdio command plus the entry script:
 *
 *   {
 *     "mcpServers": {
 *       "tengence-geo": {
 *         "command": "node",
 *         "args": ["<absolute path>/packages/geo-mcp/bin/geo-mcp.js"]
 *       }
 *     }
 *   }
 *
 * Only two rules apply regardless of which client you use:
 *   - `args` must resolve to this script; use the absolute path unless you know the
 *     client starts the process in this repository.
 *   - `node` must be v20+ and visible to the spawned process. GUI-installed clients do
 *     not read shell rc files, so if the client cannot see node, put its absolute
 *     path in `command` instead.
 * Nothing else is required — no SITES_ROOT, no DB_PATH, no APP_ID.
 *
 * Note: the packages are private and not published yet, so `npx -y @tengence/geo-mcp`
 * fails with 404 — point at the local script as shown above.
 */

const { createServer, printStartupBanner } = require('../server');

async function main() {
  const { server } = await createServer();
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const transport = new StdioServerTransport();
  printStartupBanner();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(`[geo-mcp] failed to start: ${e.message}`);
  process.exit(1);
});
