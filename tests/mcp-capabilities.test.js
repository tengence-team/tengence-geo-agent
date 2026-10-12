/**
 * MCP capability surface + hardening invariants
 * ============================================================================
 * Locks in the MCP capability-surface refactor (Instructions / Prompts /
 * Resources / structuredContent / tool titles & groups) and the follow-up
 * hardening so they cannot silently regress:
 *   - 77 tools, all titled, no standards_* tools (standards are resources now)
 *   - TOOL_GROUPS cover every tool (no Uncategorized), and buildInstructions
 *     lists every tool (the instructions listing never drifts from the live set)
 *   - batch-A tools carry structured:true
 *   - 5 prompts with raw-shape argsSchema (not a z.object() instance)
 *   - 2 fixed + 3 template resources, shared language constant
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tools, registry, TOOL_GROUPS } = require('../packages/geo-mcp/tools/registry');
const { prompts } = require('../packages/geo-mcp/tools/prompts');
const { fixedResources, resourceTemplates, GLOSSARY_LANGS } = require('../packages/geo-mcp/tools/resources');
const { buildInstructions } = require('../packages/geo-mcp/server.js');

test('registry: 77 tools, all titled, no standards_* tools', () => {
  assert.equal(tools.length, 77);
  assert.ok(tools.every((t) => !!t.title), 'every tool must have a title');
  assert.ok(!tools.some((t) => t.name.startsWith('standards_')), 'no legacy standards tools');
});

test('TOOL_GROUPS cover every tool; instructions list every tool (no drift)', () => {
  const unmatched = tools.filter((t) => !TOOL_GROUPS.some((g) => g.match.test(t.name)));
  assert.deepEqual(unmatched.map((t) => t.name), [], 'every tool must match a group');
  const ins = buildInstructions(tools);
  const groupsBlock = ins.split('TOOL GROUPS')[1].split('CANONICAL PIPELINE')[0];
  const missing = tools.filter((t) => !groupsBlock.includes(t.name)).map((t) => t.name);
  assert.deepEqual(missing, [], 'instructions must list every registered tool');
  assert.ok(!ins.includes('Uncategorized'), 'no tool may land in Uncategorized');
});

test('batch-A tools carry structured:true', () => {
  const batchA = ['workspace_use', 'site_init', 'site_list', 'article_draft', 'check_article', 'article_ingest', 'publish_draft', 'monitor_report'];
  for (const n of batchA) assert.equal(registry.get(n).structured, true, `${n} not structured`);
});

test('prompts: 5 templates with raw-shape argsSchema', () => {
  assert.equal(prompts.length, 5);
  const names = prompts.map((p) => p.name).sort();
  assert.deepEqual(names, ['multilingual_publish', 'publish_to_channel', 'run_content_pipeline', 'site_health_diagnosis', 'write_geo_article']);
  for (const p of prompts) {
    // argsSchema must be a raw shape (object of zod fields), not a z.object() instance —
    // the SDK 1.30 registerPrompt path expects a shape, not a ZodObject.
    assert.equal(typeof p.argsSchema, 'object', `${p.name} argsSchema must be an object`);
    assert.ok(!p.argsSchema._zod && !p.argsSchema._def, `${p.name} argsSchema must be a raw shape, not a ZodObject`);
  }
});

test('resources: 2 fixed + 3 templates, shared language constant', () => {
  assert.deepEqual(fixedResources.map((r) => r.uri), ['geo://standard-index', 'geo://sites']);
  assert.deepEqual(
    resourceTemplates.map((r) => r.uriTemplate),
    ['geo://standard/{name}', 'geo://site/{key}', 'geo://glossary/{lang}']
  );
  assert.deepEqual(GLOSSARY_LANGS, ['zh-hans', 'en', 'zh-hant']);
});
