'use strict';
/**
 * Cross-platform channel registry (tengence-geo-sdk/syndicate/registry)
 * ============================================================================
 * The single source of truth for every external content platform the site can
 * syndicate to. Each entry declares:
 *   - api:      'official' | 'cookie' | 'none'   (none = no publish code exists)
 *   - status:   'ready' (publish implemented) | 'pending' (credentials/approval
 *               missing) | 'manual' (no API — human publishes from the export)
 *   - capabilities: what the platform supports (multi-article merge, limits,
 *               draft/cover/tags…) — callers introspect before acting
 *   - rewrite:  platform style rules consumed by the HARNESS (the MCP client)
 *               when rewriting an article for that platform. The MCP server
 *               itself never rewrites content; it only serves these rules.
 *
 * Design note: the MCP server has NO content-generation capability by design.
 * `channel_list` returns these rewrite rules so a client (Doubao harness) can
 * produce the platform-specific draft; `channel_publish` then accepts either the
 * original slugs (mode A, server reads the DB and uses the existing platform
 * pipelines) or pre-written articles (mode B, exported as a publish package).
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const STYLES_DIR = path.join(__dirname, 'styles');

/** Ordered platform keys (registry display order). */
const PLATFORM_KEYS = [
  'wechat',
  'juejin',
  'devto',
  'baijiahao',
  'zhihu',
  'csdn',
  'toutiao',
  'xiaohongshu',
];

function loadStyle(key) {
  const p = path.join(STYLES_DIR, `${key}.yaml`);
  if (!fs.existsSync(p)) {
    throw new Error(`Missing style file for platform "${key}": ${p}`);
  }
  return yaml.load(fs.readFileSync(p, 'utf8'));
}

/** key → full platform record (style file content merged in). */
const PLATFORMS = {};
for (const key of PLATFORM_KEYS) {
  const style = loadStyle(key);
  PLATFORMS[key] = { ...style, key };
}

/**
 * All platforms in registry order.
 * @returns {Array<object>}
 */
function listPlatforms() {
  return PLATFORM_KEYS.map((key) => PLATFORMS[key]);
}

/**
 * Get one platform record (or null).
 * @param {string} key
 * @returns {object|null}
 */
function getPlatform(key) {
  return PLATFORMS[key] || null;
}

/**
 * The rewrite rules for a platform (the `rewrite` block of its style file).
 * @param {string} key
 * @returns {object|null}
 */
function stylesFor(key) {
  const p = PLATFORMS[key];
  return p ? p.rewrite || {} : null;
}

/** True when the platform has a publish implementation (api !== 'none'). */
function hasPublish(key) {
  const p = PLATFORMS[key];
  return !!p && p.api !== 'none';
}

module.exports = {
  PLATFORM_KEYS,
  listPlatforms,
  getPlatform,
  stylesFor,
  hasPublish,
};
