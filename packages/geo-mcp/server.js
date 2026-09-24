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

/**
 * Bind the work root from the MCP client's exposed workspace roots (generic,
 * protocol-level — nothing site- or directory-specific lives here).
 *
 * MCP clients that declare the `roots` capability hand the server the directory
 * the user is currently working in (the "workspace root"). We ask for it once at
 * startup and bind the first usable root through the same validated path as the
 * workspace_use tool (activates + persists to state.json). This is what lets a
 * GUI client start this server with zero env config while still getting the
 * user's actual working directory as the work root.
 *
 * Resolution order used elsewhere (site/workspace.js):
 *   1. explicit SITES_ROOT env           (override, automation/multi-root)
 *   2. client roots/list  (this function, MCP-standard workspace mechanism)
 *   3. persisted state.json              (last workspace_use binding)
 *   4. workspace_use tool at runtime     (final fallback, never guessed)
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server connected server
 * @returns {Promise<string|null>} bound workspace path, or null when the client exposes none
 */
async function bindFromClientRoots(server) {
  const t = require('@tengence/geo-sdk');
  const fs = require('fs');
  // McpServer wraps the low-level Server (Protocol) in `.server`
  const core = server.server;
  const cap = core.getClientCapabilities();
  if (!cap || !cap.roots || !cap.roots.listChanged) return null;
  let res;
  try {
    const { ListRootsResultSchema } = await import('@modelcontextprotocol/sdk/types.js');
    res = await core.request({ method: 'roots/list' }, ListRootsResultSchema);
  } catch (e) {
    return null; // client declined / protocol error — fall through to state/env
  }
  const roots = (res && res.roots) || [];
  for (const root of roots) {
    let dir = root && root.uri ? String(root.uri) : '';
    if (dir.startsWith('file://')) dir = dir.slice('file://'.length);
    if (!dir) continue;
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        console.error(`[geo-mcp] workspace root not usable (skipped): ${dir}`);
        continue;
      }
      t.workspace.use(dir); // validates, activates, persists to state.json
      return dir;
    } catch (e) {
      console.error(`[geo-mcp] workspace root bind failed (skipped): ${e.message}`);
      continue;
    }
  }
  return null;
}

module.exports = { createServer, printStartupBanner, bindFromClientRoots };
