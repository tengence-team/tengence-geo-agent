'use strict';
/**
 * GEO content engine MCP Server factory (@tengence/geo-mcp/server.js)
 * ============================================================================
 * Built on @modelcontextprotocol/server (SDK v2, ESM-only) — pulled in from the
 * CJS side via dynamic import. Provides buildServer(): registers every tool from
 * tools/registry.js, every Prompt from tools/prompts.js and every Resource from
 * tools/resources.js, and returns an McpServer ready to be served per-request by
 * the transport layer (stdio / HTTP), per MCP protocol revision 2026-07-28.
 * The transport layer is chosen by the caller — nothing here depends on who the caller is:
 *   - stdio : bin/geo-mcp.js     (any 2026-07-28 client that can spawn a process)
 *   - HTTP  : bin/geo-mcp-http.js (any remote 2026-07-28 caller, bearer-token protected)
 *
 * Stateless by design (2026-07-28): the server is built fresh per request via the
 * factory, there is no initialize handshake and no Mcp-Session-Id; every request
 * carries its own _meta envelope (protocol version / capabilities / identity).
 */

const { tools, TOOL_GROUPS, LONG_TOOLS } = require('./tools/registry');
const { prompts } = require('./tools/prompts');
const { fixedResources, resourceTemplates } = require('./tools/resources');
const tasks = require('./tools/tasks');
const { z } = require('zod');

/**
 * Build the server-level instructions (MCP `Implementation.instructions`): the
 * protocol's endorsed mechanism for grouping tools and steering how a client
 * uses them. The TOOL GROUPS listing is aggregated from the registry's TOOL_GROUPS
 * matchers against the LIVE tool list, so it can never drift from what is really
 * registered (no hand-maintained tool inventory here).
 * Kept lean on purpose — deep rules live in resources (geo://standard/*) loaded
 * on demand, not here, to avoid burning context.
 */
function buildInstructions(toolsList) {
  const groups = TOOL_GROUPS.map((g) => {
    const names = toolsList.filter((t) => g.match.test(t.name)).map((t) => t.name);
    return `- ${g.group}: ${names.join(', ')}`;
  }).join('\n');
  const uncategorized = toolsList
    .filter((t) => !TOOL_GROUPS.some((g) => g.match.test(t.name)))
    .map((t) => t.name);
  const uncategorizedLine = uncategorized.length ? `\n- Uncategorized: ${uncategorized.join(', ')}` : '';
  return [
    'You are the Tengence GEO/SEO content engine MCP server. The work root is NOT assumed: call workspace_use once per environment, then operate on the bound site.',
    '',
    'TOOL GROUPS (read each tool description before calling):',
    groups + uncategorizedLine,
    '- Reference data: read via resources geo://standard/*, geo://site/*, geo://glossary/* — standards are NOT a system prompt; load only what a task needs.',
    '',
    'CANONICAL PIPELINE for a new article:',
    'workspace_use -> site_init (if no site) -> article_draft(type, topic) -> (author body following the brief) -> check_article -> article_ingest -> publish_draft.',
    'For multi-language, also run check_translation + translation_glossary_get, then publish with language codes zh-hans | en | zh-hant only.',
    '',
    'WHEN NOT TO CALL: do not call check_article on a translation row (translation rows skip the zh writing gate); do not guess a workspace or site — when multiple sites exist, pass an explicit site argument; publishing and mass-send require explicit user confirmation before executing.',
  ].join('\n');
}

/** Derive a readable display title from a snake_case tool name (fallback). */
function humanize(name) {
  return String(name)
    .split('_')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

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
 * Build a fresh MCP server instance with every tool, prompt and resource registered.
 * This is the per-request factory consumed by serveStdio / createMcpHandler — the
 * server is stateless (2026-07-28), so each request (or each stdio connection)
 * gets its own instance built here. The work root is never inferred from the
 * client here; it is bound at runtime by the workspace_use tool / SITES_ROOT env.
 * @returns {Promise<import('@modelcontextprotocol/server').McpServer>}
 */
async function buildServer() {
  const { McpServer, ResourceTemplate } = await import('@modelcontextprotocol/server');
  const server = new McpServer(
    { name: 'tengence-geo-mcp', version: require('./package.json').version },
    {
      instructions: buildInstructions(tools),
      capabilities: {
        extensions: { 'io.modelcontextprotocol/tasks': {} },
        resources: { subscribe: true }, // S7: honor subscriptions/listen resourceSubscriptions so
        // task terminal-state changes can push notifications/resources/updated.
      },
    }
  );

  // MCP Tasks extension methods. The SDK high-level does not register these method
  // names, and its wire encoder lets tools/call emit resultType:"task" verbatim for
  // long-running tools, so the durable task flow (see tools/tasks.js) plugs in here
  // without rebuilding the server layer. Registered on the low-level Server exposed
  // as McpServer.server.
  const core = server.server;
  const taskParams = z.object({ taskId: z.string() });
  core.setRequestHandler('tasks/get',
    { params: taskParams, result: z.any() },
    (req, ctx) => tasks.tasksGet(req, ctx));
  core.setRequestHandler('tasks/update',
    { params: z.object({ taskId: z.string(), inputResponses: z.record(z.string(), z.any()).optional() }), result: z.any() },
    (req, ctx) => tasks.tasksUpdate(req, ctx));
  core.setRequestHandler('tasks/cancel',
    { params: taskParams, result: z.any() },
    (req, ctx) => tasks.tasksCancel(req, ctx));

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title || humanize(tool.name),
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      async (args, ctx) => {
        // Structured tools already return structuredContent from their run
        // (registry okStructured); pass the result through untouched — no
        // server-side re-parsing of the text payload.
        // Long-running tools: when the client declared the Tasks extension, hand the
        // work to a durable background task and return a resultType:"task" handle
        // (SDK emits it verbatim); otherwise run synchronously (ordinary clients are
        // unaffected).
        try {
          if (LONG_TOOLS.has(tool.name) && tasks.clientDeclaresTasks(ctx)) {
            return await tasks.createTask(
              tasks.resolveCurrentAppId(),
              { name: tool.name },
              // S-进度: the durable task gives workFn an onProgress callback which the
              // long tool surfaces via its run(args, ctx) second argument.
              (onProgress) => tool.run(args || {}, { onProgress })
            );
          }
          return await tool.run(args || {}, {});
        } catch (e) {
          const message = e && e.message ? e.message : String(e);
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }],
            isError: true,
          };
        }
      }
    );
  }

  for (const p of prompts) {
    server.registerPrompt(
      p.name,
      { title: p.title, description: p.description, argsSchema: p.argsSchema },
      (args) => p.run(args || {})
    );
  }

  for (const r of fixedResources) {
    server.registerResource(r.name, r.uri, r.config, () => r.read());
  }

  for (const rt of resourceTemplates) {
    const template = new ResourceTemplate(rt.uriTemplate, { list: () => rt.list() });
    server.registerResource(rt.name, template, rt.config, (uri, variables) => rt.read(uri, variables));
  }

  return server;
}

module.exports = { buildServer, printStartupBanner, buildInstructions, tools };
