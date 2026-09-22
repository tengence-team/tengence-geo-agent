#!/usr/bin/env node
/**
 * Tengence GEO Agent — Harness launcher
 * ============================================================================
 * Usage:
 *   HARNESS=dsh|opencode|pi DEEPSEEK_API_KEY=sk-xxx tengence-geo-agent
 *
 * Behavior:
 *   1. Reads env: HARNESS (default dsh), DEEPSEEK_API_KEY (deepseek-chat),
 *      SITES_ROOT / DB_DRIVER / DB_PATH / GEO_MCP_* (passed through to the MCP server).
 *   2. Renders/validates the preset for HARNESS (apps/agent/presets/*) and injects env vars.
 *   3. Starts the harness CLI (dsh / opencode / pi), pointing its MCP server config at
 *      @tengence/geo-mcp (spawned via npx — no local geo package install needed).
 *   4. When the binary is missing, prints install guidance instead of silently degrading.
 *
 * Env passed through: SITES_ROOT / DB_DRIVER / DB_PATH / APP_ID / GEO_MCP_TOKEN / GEO_MCP_PORT
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PRESETS_DIR = path.join(__dirname, 'presets');

/** Load .env (reuses the SDK parser for consistent behavior) */
function loadEnv() {
  const t = require('@tengence/geo-sdk');
  // Prefer the repo-root .env; site-level .env is read by the SDK itself in loadSite
  const rootEnv = path.resolve(__dirname, '..', '..', '.env');
  if (fs.existsSync(rootEnv)) t.site.loadEnvFile(rootEnv);
}

/** Expand ${VAR:-default} placeholders in a preset template */
function expand(text) {
  return text.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g, (m, name, def) => {
    const v = process.env[name];
    return v !== undefined && v !== '' ? v : def !== undefined ? def : '';
  });
}

/** Render a preset to the working dir (referencable by the harness) */
function renderPreset(file, dest) {
  const src = path.join(PRESETS_DIR, file);
  const text = fs.readFileSync(src, 'utf8');
  const out = expand(text);
  fs.writeFileSync(dest, out);
  return dest;
}

function requireKey(key) {
  if (!process.env[key]) {
    console.error(`✗ Missing ${key}. Set it in the environment (or the repo-root .env) and retry.`);
    console.error(`  export ${key}=sk-xxxxxxxx`);
    process.exit(1);
  }
}

function spawnHarness(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', env: process.env });
  if (res.error && res.error.code === 'ENOENT') {
    console.error(`✗ Command "${cmd}" not found.`);
    console.error(`  dsh    : install DeepSeek Harness (see https://deepseek.com/harness) and retry`);
    console.error(`  opencode: npm i -g opencode-ai`);
    console.error(`  pi     : npm i -g @mariozechner/pi or follow the Pi install guide`);
    process.exit(1);
  }
  return res.status ?? 0;
}

function main() {
  loadEnv();
  const harness = (process.env.HARNESS || 'dsh').toLowerCase();
  requireKey('DEEPSEEK_API_KEY');

  // Pass through and validate storage config (SQLite auto-initializes by default)
  process.env.SITES_ROOT = process.env.SITES_ROOT || path.resolve(process.cwd(), 'sites');
  process.env.DB_DRIVER = process.env.DB_DRIVER || 'sqlite';

  console.error(`[tengence-geo-agent] harness=${harness} driver=${process.env.DB_DRIVER}`);
  console.error(`[tengence-geo-agent] sites_root=${process.env.SITES_ROOT}`);

  switch (harness) {
    case 'dsh': {
      const preset = renderPreset('dsh.json', path.join(PRESETS_DIR, 'dsh.generated.json'));
      console.error(`[tengence-geo-agent] preset=${preset}`);
      return spawnHarness('dsh', ['--config', preset]);
    }
    case 'opencode': {
      const preset = renderPreset('opencode.json', path.join(PRESETS_DIR, 'opencode.generated.json'));
      console.error(`[tengence-geo-agent] preset=${preset}`);
      return spawnHarness('opencode', ['run', '--config', preset]);
    }
    case 'pi': {
      renderPreset('pi.json', path.join(PRESETS_DIR, 'pi.generated.json'));
      renderPreset('mcp.json', path.join(PRESETS_DIR, 'mcp.generated.json'));
      console.error(`[tengence-geo-agent] preset=presets/pi.generated.json + mcp.generated.json`);
      return spawnHarness('pi', []);
    }
    default:
      console.error(`✗ Unsupported HARNESS=${harness} (choose from: dsh | opencode | pi)`);
      return 1;
  }
}

process.exit(main());
