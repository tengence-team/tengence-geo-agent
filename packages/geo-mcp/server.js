'use strict';
/**
 * GEO content engine MCP Server factory (@tengence/geo-mcp/server.js)
 * ============================================================================
 * Built on @modelcontextprotocol/sdk (ESM-only) — pulled in from the CJS side via
 * dynamic import. Provides createServer(): registers every tool from tools/registry.js
 * and returns { server, registry }.
 * The transport layer is chosen by the caller — nothing here depends on who the caller is:
 *   - stdio : bin/geo-mcp.js     (any local client that can spawn a process)
 *   - HTTP  : bin/geo-mcp-http.js (any remote caller, bearer-token protected)
 */

const { tools } = require('./tools/registry');

/** Environment check: prints key config at startup so misconfiguration is easy to debug */
function printStartupBanner() {
  const t = require('@tengence/geo-sdk');
  const workspace = t.workspace.current();
  console.error(`[geo-mcp] internal_home=${t.paths.internalHome()}`);
  console.error(`[geo-mcp] driver=${t.db.driver()}`);
  console.error(`[geo-mcp] workspace=${workspace || '(not bound — call workspace_use to pick one)'}`);
  if (!workspace) {
    console.error('[geo-mcp] hint: nothing is assumed about the working directory; ' +
      'the user must point us at it once per environment.');
    return;
  }
  console.error(`[geo-mcp] sites=${t.site.listSites().join(', ') || '(none yet — call site_init)'}`);
  if (t.db.driver() === 'sqlite') {
    console.error(`[geo-mcp] sqlite=${t.db.sqliteDbStatus().dbPath} (schema v${t.db.sqliteDbStatus().schemaVersion})`);
  }
}

/**
 * Create the MCP Server with every tool registered.
 * @returns {Promise<{server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer, tools: Array}>}
 */
async function createServer() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({
    name: 'tengence-geo-mcp',
    version: require('./package.json').version,
  });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args) => {
        try {
          return await tool.run(args || {});
        } catch (e) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }, null, 2) }],
            isError: true,
          };
        }
      }
    );
  }

  return { server, tools };
}

module.exports = { createServer, printStartupBanner };
