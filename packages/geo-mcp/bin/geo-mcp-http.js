#!/usr/bin/env node
/**
 * GEO content engine MCP Server — HTTP transport (remote callers / Doubao Work custom connector)
 * ============================================================================
 * Usage:
 *   GEO_MCP_PORT=8787 GEO_MCP_TOKEN=sk-xxx SITES_ROOT=~/tengence/sites \
 *     npx -y @tengence/geo-mcp-http
 *
 * Protocol: MCP Streamable HTTP over protocol revision 2026-07-28 (stateless core,
 * strict modern-only). Requests are served by createMcpHandler with { legacy: 'reject' }
 * — a fresh stateless server instance is built per request via buildServer(); 2025-era
 * initialize-handshake clients are rejected. There is no Mcp-Session-Id and no session
 * map: every request is self-contained, so any instance behind a load balancer can
 * serve any call.
 *
 * Auth: Bearer token (GEO_MCP_TOKEN); when unset, prints a warning and allows no-auth
 * (local debugging only).
 * Health check: GET / → { ok: true, server, version }.
 *
 * Doubao Work "custom connector" config:
 *   Base URL = http://127.0.0.1:8787/     Auth = Bearer <GEO_MCP_TOKEN>
 */

const http = require('http');
const { buildServer, printStartupBanner } = require('../server');
const taskNotify = require('../tools/task-notify');

const PORT = parseInt(process.env.GEO_MCP_PORT || '8787', 10);
const TOKEN = process.env.GEO_MCP_TOKEN || '';

// S8: CORS is OFF by default. MCP endpoints are not CORS-enabled by the SDK, and
// unconditional permissive headers would be a security regression — CORS belongs to
// a fronting gateway (which also owns TLS / ACL / routing). For local development
// without a gateway, set GEO_MCP_CORS_ORIGIN=<origin> to enable CORS scoped to that
// origin. The 2026-07-28 routing headers below (Mcp-Method / Mcp-Name /
// MCP-Protocol-Version) are non-simple and MUST be allowed/exposed by the gateway.
const CORS_ORIGIN = process.env.GEO_MCP_CORS_ORIGIN || '';
const CORS = CORS_ORIGIN
  ? {
      'Access-Control-Allow-Origin': CORS_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Param-*',
      'Access-Control-Expose-Headers': 'MCP-Protocol-Version, Mcp-Method, Mcp-Name',
    }
  : null;

function unauthorized(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized: missing or wrong Bearer token (GEO_MCP_TOKEN)' }));
}

async function main() {
  const { createMcpHandler } = await import('@modelcontextprotocol/server');
  const { toNodeHandler } = await import('@modelcontextprotocol/node');

  // Strict 2026-07-28, stateless: one factory, a fresh server per request, no session state.
  const mcpHandler = createMcpHandler(() => buildServer(), { legacy: 'reject' });
  // S7 (方案 A): adopt the transport's notifier so task terminal-state changes publish
  // the standard notifications/resources/updated to subscriptions/listen subscribers.
  taskNotify.setNotifier(mcpHandler.notify);
  const mcp = toNodeHandler(mcpHandler);

  const httpServer = http.createServer((req, res) => {
    // S8: CORS only when GEO_MCP_CORS_ORIGIN is set (local dev without a gateway).
    if (CORS) Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth on every request except the GET / health check (POST / is an MCP call
    // and must be authenticated; OPTIONS preflight already returned above).
    if (!(req.method === 'GET' && req.url === '/') && TOKEN) {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${TOKEN}`) {
        unauthorized(res);
        return;
      }
    }

    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: 'tengence-geo-mcp', version: require('../package.json').version }));
      return;
    }

    // Any remaining request is a 2026-07-28 MCP call — hand it to the stateless handler.
    mcp(req, res).catch((e) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: null }));
      }
    });
  });

  httpServer.listen(PORT, () => {
    printStartupBanner();
    console.error(`[geo-mcp] HTTP listening on http://127.0.0.1:${PORT}/`);
    if (TOKEN) {
      console.error(`[geo-mcp] Auth: Bearer ${TOKEN.slice(0, 4)}… (GEO_MCP_TOKEN)`);
    } else {
      console.error('[geo-mcp] ⚠️ GEO_MCP_TOKEN not set; no auth (local debugging only)');
    }
  });
}

main().catch((e) => {
  console.error(`[geo-mcp] failed to start: ${e.message}`);
  process.exit(1);
});
