/**
 * User workspace binding (tengence-geo-sdk/site/workspace)
 * ============================================================================
 * The server-side counterpart of "let the user choose where the work happens".
 *
 * A spawned server process cannot infer anything useful from process.cwd(): that is
 * whatever directory the caller happened to start it in, which for a GUI-installed
 * client is the client's own directory. So the workspace is never derived from cwd —
 * it must be handed to us, and we remember what we were told.
 *
 * Resolution order (first hit wins):
 *   1. explicit argument (a tool parameter for this one call)
 *   2. already bound in this process (setSitesRoot / SITES_ROOT env)
 *   3. MCP client workspace roots (roots/list, bound at server startup by
 *      geo-mcp/server.js bindFromClientRoots — the user's working directory as
 *      exposed by the client, MCP-standard mechanism, no env needed)
 *   4. last bound value persisted in ~/.tengence/geo-mcp/state.json
 *   5. nothing found → require() throws an actionable error; nothing is invented
 *
 * There is deliberately no fallback directory: pointing writes at some guessed
 * location is worse than asking.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const paths = require('../paths');
const siteConfig = require('./config');

/**
 * Bind the workspace: validate, activate it, and remember it for later sessions.
 * @param {string} dir absolute / `~` / relative path — the user's working directory
 * @param {object} [opts] { create?: boolean }
 * @returns {{ok:boolean, workspace:string, sites:string[], persisted:string, hint:string}}
 */
function use(dir, opts = {}) {
  if (!dir || !String(dir).trim()) {
    throw new Error(
      'workspace_use requires an absolute directory path, e.g. ' +
        'workspace_use({"path": "~/my-geo-workspace"}). Ask the user which directory to use.'
    );
  }
  const target = paths.resolvePath(dir);

  const exists = fs.existsSync(target);
  if (!exists && !opts.create) {
    throw new Error(
      `Workspace directory does not exist: ${target}\n` +
        'Create it first, or re-run with create=true so it is made for you.'
    );
  }
  if (!exists) fs.mkdirSync(target, { recursive: true });

  const stat = fs.statSync(target);
  if (!stat.isDirectory()) throw new Error(`Workspace path is not a directory: ${target}`);
  try {
    fs.accessSync(target, fs.constants.W_OK);
  } catch (_) {
    throw new Error(`Workspace directory is not writable: ${target}`);
  }

  siteConfig.setSitesRoot(target);
  paths.writeState({ workspace: target });

  return {
    ok: true,
    workspace: target,
    sites: siteConfig.listSites(),
    persisted: paths.statePath(),
    hint:
      'Workspace bound. Use site_init to scaffold a site here, or continue directly when one already exists.',
  };
}

/**
 * Bind from the persisted state file if it points at a usable directory.
 * @returns {string|null}
 */
function fromState() {
  try {
    const remembered = paths.readState().workspace;
    if (!remembered) return null;
    const target = paths.resolvePath(remembered);
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      siteConfig.setSitesRoot(target);
      return target;
    }
  } catch (_) {
    /* corrupt/unreadable state simply means "not bound" */
  }
  return null;
}

/** Currently bound workspace, or null. Falls back to the persisted value once. */
function current() {
  if (siteConfig.getSitesRoot()) return siteConfig.getSitesRoot();
  return fromState();
}

/** Bound workspace; throws the actionable error when none is known. */
function require_() {
  const found = current();
  if (!found) throw new Error(siteConfig.NOT_BOUND_HINT);
  return found;
}

module.exports = {
  NOT_BOUND_HINT: siteConfig.NOT_BOUND_HINT,
  use,
  current,
  fromState,
  require: require_,
  statePath: paths.statePath,
};
