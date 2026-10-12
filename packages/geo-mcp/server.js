'use strict';
/**
 * GEO content engine MCP Server factory (@tengence/geo-mcp/server.js)
 * ============================================================================
 * Built on @modelcontextprotocol/sdk (ESM-only) — pulled in from the CJS side via
 * dynamic import. Provides createServer(): registers every tool from tools/registry.js,
 * every Prompt from tools/prompts.js and every Resource from tools/resources.js,
 * and returns { server, registry }.
 * The transport layer is chosen by the caller — nothing here depends on who the caller is:
 *   - stdio : bin/geo-mcp.js     (any local client that can spawn a process)
 *   - HTTP  : bin/geo-mcp-http.js (any remote caller, bearer-token protected)
 */

const { tools, TOOL_GROUPS } = require('./tools/registry');
const { prompts } = require('./tools/prompts');
const { fixedResources, resourceTemplates } = require('./tools/resources');

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
 * Create the MCP Server with every tool, prompt and resource registered.
 * @returns {Promise<{server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer, tools: Array}>}
 */
async function createServer() {
  const { McpServer, ResourceTemplate } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({
    name: 'tengence-geo-mcp',
    version: require('./package.json').version,
    instructions: buildInstructions(tools),
  });

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
      async (args) => {
        // Structured tools already return structuredContent from their run
        // (registry okStructured); pass the result through untouched — no
        // server-side re-parsing of the text payload.
        try {
          return await tool.run(args || {});
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

module.exports = { createServer, printStartupBanner, bindFromClientRoots, buildInstructions };
