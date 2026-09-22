/**
 * Internal runtime paths (tengence-geo-sdk/paths)
 * ============================================================================
 * Single source of truth for every location this SDK/MCP server owns, split into
 * two disjoint worlds:
 *
 *   1. INTERNAL runtime data — owned by the MCP server, never user content:
 *        ~/.tengence/geo-mcp/
 *          ├── geo.sqlite   single-file multi-tenant DB (shared by all app_ids/sites)
 *          ├── state.json   last bound user workspace + misc session state
 *          └── logs/
 *   2. USER workspace — the directory the user chooses; holds per-site data:
 *        <user workspace>/<site-key>/{config,data,.env}
 *      Never guessed, never defaulted: if it is unknown, callers surface an
 *      actionable error asking the user to provide it.
 *
 * Deliberately no assumptions about any caller: nothing here reads a client-specific
 * env var, config file, or working directory. cwd is irrelevant to internal paths;
 * it is used only to resolve genuinely relative user-supplied paths.
 *
 * HOME expansion: MCP clients inject env values verbatim and do NOT expand `~`, so
 * every path crossing this layer goes through expandHome() first.
 * ============================================================================
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Internal root: <home>/.tengence/geo-mcp (override via TENGENCE_GEO_HOME; `~` supported). */
const INTERNAL_DIR_NAME = path.join('.tengence', 'geo-mcp');

/**
 * Expand a leading `~` to the user home directory.
 * @param {string} p
 */
function expandHome(p) {
  const s = String(p == null ? '' : p).trim();
  if (!s) return s;
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** Expand `~`, then resolve to an absolute path (relative inputs resolve against cwd). */
function resolvePath(p) {
  return path.resolve(expandHome(p));
}

/**
 * TENGENCE_GEO_HOME — the single variable every path in this SDK derives from.
 * ============================================================================
 * Resolved exactly once, here, with this precedence:
 *   1. `process.env.TENGENCE_GEO_HOME` (`~` expanded, relative → resolved against cwd)
 *   2. `process.env.GEO_HOME` — legacy alias, deprecated, removal planned for 0.2.0
 *   3. the agent's internal directory `<home>/.tengence/geo-mcp`
 *
 * No other module may read these env vars directly: import `TENGENCE_GEO_HOME` (or
 * call `internalHome()`) so that the database, the state file, the logs and the
 * standards supplements all resolve against one and the same root for the process.
 */
const TENGENCE_GEO_HOME = resolvePath(
  process.env.TENGENCE_GEO_HOME ||
    process.env.GEO_HOME ||
    path.join(os.homedir(), INTERNAL_DIR_NAME),
);

/** Absolute path of the internal directory (i.e. TENGENCE_GEO_HOME). */
function internalHome() {
  return TENGENCE_GEO_HOME;
}

/** Create the internal directory tree once; returns the root path. */
function ensureInternalHome() {
  const dir = internalHome();
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  return dir;
}

/**
 * SQLite file location.
 * Honours DB_PATH when set (absolute, `~`, or relative to cwd); otherwise the
 * internal default ~/.tengence/geo-mcp/geo.sqlite.
 */
function dbPath() {
  return process.env.DB_PATH ? resolvePath(process.env.DB_PATH) : path.join(internalHome(), 'geo.sqlite');
}

/** Persistent state file (last bound workspace etc.). */
function statePath() {
  return path.join(internalHome(), 'state.json');
}

/** Internal log directory. */
function logsDir() {
  return path.join(internalHome(), 'logs');
}

/** Read the persisted state object; returns {} when missing or corrupt. */
function readState() {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

/** Shallow-merge `patch` into the persisted state; returns the merged object. */
function writeState(patch) {
  ensureInternalHome();
  const next = { ...readState(), ...(patch || {}) };
  fs.writeFileSync(statePath(), JSON.stringify(next, null, 2), { encoding: 'utf8' });
  return next;
}

module.exports = {
  TENGENCE_GEO_HOME,
  INTERNAL_DIR_NAME,
  expandHome,
  resolvePath,
  internalHome,
  ensureInternalHome,
  dbPath,
  statePath,
  logsDir,
  readState,
  writeState,
};
