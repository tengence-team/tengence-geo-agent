#!/usr/bin/env node
/**
 * GEO content engine MCP Server — HTTP transport (remote callers / Doubao Work custom connector)
 * ============================================================================
 * Usage:
 *   GEO_MCP_PORT=8787 GEO_MCP_TOKEN=sk-xxx SITES_ROOT=~/tengence/sites \
 *     npx -y @tengence/geo-mcp-http
 *
 * Protocol: MCP Streamable HTTP (POST /messages, JSON-RPC 2.0).
 * Auth: Bearer token (GEO_MCP_TOKEN); when unset, prints a warning and allows no-auth
 * (local debugging only).
 * Health check: GET / → { ok: true, server, version }.
 *
 * Doubao Work "custom connector" config:
 *   Base URL = http://127.0.0.1:8787/     Auth = Bearer <GEO_MCP_TOKEN>
 */

const http = require('http');
const { createServer, printStartupBanner } = require('../server');

const PORT = parseInt(process.env.GEO_MCP_PORT || '8787', 10);
const TOKEN = process.env.GEO_MCP_TOKEN || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

function unauthorized(res) {
  res.writeHead(401, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized: missing or wrong Bearer token (GEO_MCP_TOKEN)' }));
}

async function main() {
  const { server } = await createServer();
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => 'tengence-geo-mcp',
  });
  await server.connect(transport);

  const httpServer = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    // Auth (except the / health check)
    if (req.url !== '/' && TOKEN) {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${TOKEN}`) {
        unauthorized(res);
        return;
      }
    }

    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: 'tengence-geo-mcp', version: require('../package.json').version }));
      return;
    }

    // Everything else goes to the MCP transport (POST /messages, GET /sse)
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let parsedBody;
      if (bodyText.trim()) {
        try {
          parsedBody = JSON.parse(bodyText);
        } catch {
          parsedBody = bodyText; // let the transport report the standard JSON parse error
        }
      }
      transport
        .handleRequest(req, res, parsedBody)
        .catch((e) => {
          if (!res.headersSent) {
            res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
          }
          res.end(JSON.stringify({ error: e.message }));
        });
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
