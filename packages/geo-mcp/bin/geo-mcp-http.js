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
 * Sessions: every client gets its own transport + server instance (multi-session).
 * A single shared transport would reject the second client's initialize with
 * "Server already initialized" (the SDK's WebStandardStreamableHttp transport is
 * single-session: once _initialized is set, all later initialize calls fail).
 *
 * Doubao Work "custom connector" config:
 *   Base URL = http://127.0.0.1:8787/     Auth = Bearer <GEO_MCP_TOKEN>
 */

const http = require('http');
const crypto = require('node:crypto');
const { createServer, printStartupBanner } = require('../server');

const PORT = parseInt(process.env.GEO_MCP_PORT || '8787', 10);
const TOKEN = process.env.GEO_MCP_TOKEN || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

function unauthorized(res) {
  res.writeHead(401, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized: missing or wrong Bearer token (GEO_MCP_TOKEN)' }));
}

function jsonError(res, status, code, message) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

async function main() {
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );

  /** @type {Map<string, {transport: import('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport, server: any}>} */
  const sessions = new Map();

  // Each session gets a fresh transport + server so every client can initialize
  // exactly once on its own transport (the SDK transport is single-session).
  async function createSession() {
    const { server } = await createServer();
    let entry;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, entry);
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
    });
    entry = { transport, server };
    await server.connect(transport);
    return entry;
  }

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

    // Compatibility: the Streamable HTTP transport requires clients to send
    // Accept: application/json, text/event-stream. Some GUI connectors (e.g.
    // Doubao Work custom connector) omit it, which makes the transport answer
    // "Not Acceptable". Normalize the header here so those clients connect.
    if (!/text\/event-stream/.test(req.headers.accept || '')) {
      req.headers.accept = 'application/json, text/event-stream';
    }

    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: 'tengence-geo-mcp', version: require('../package.json').version }));
      return;
    }

    // Session routing: requests with an Mcp-Session-Id header go to that
    // session's transport; requests without one create a new session.
    const sessionId = req.headers['mcp-session-id'];
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && !existing) {
      jsonError(res, 404, -32001, 'Session not found');
      return;
    }

    let entryPromise;
    if (existing) {
      entryPromise = Promise.resolve(existing);
    } else {
      entryPromise = createSession();
    }

    entryPromise
      .then((entry) => {
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
          entry.transport
            .handleRequest(req, res, parsedBody)
            .catch((e) => {
              if (!res.headersSent) {
                jsonError(res, 500, -32603, e.message);
              }
            });
        });
      })
      .catch((e) => {
        if (!res.headersSent) {
          jsonError(res, 500, -32603, e.message);
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
