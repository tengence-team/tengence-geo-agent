/**
 * SQLite driver selection (geo-sdk/db/sqlite-driver)
 * ============================================================================
 * Why this file exists:
 *   The default storage used to hard-depend on the native module `better-sqlite3`
 *   (~12MB, plus platform-specific prebuilds). For a package designed to be run via
 *   `npx -y @tengence/geo-mcp`, a native build is the single largest install risk.
 *   Node >= 22.5 ships a built-in `node:sqlite` (DatabaseSync), so the default path is
 *   now zero-native; `better-sqlite3` stays available as an optional fallback for
 *   Node 20/21 and for environments where the built-in module is disabled.
 *
 * Selection order:
 *   1. `GEO_SQLITE_DRIVER=builtin|native` — explicit override (also used by tests to
 *      exercise both paths).
 *   2. built-in `node:sqlite` when importable.
 *   3. optional dependency `better-sqlite3` when installed.
 *   4. otherwise: throw one actionable error (never a bare MODULE_NOT_FOUND).
 *   Additionally, if the preferred driver fails to *open* the file (locked, missing
 *   prebuild for this platform), we fall back to the other one once before failing.
 *
 * Exposed handle API (the subset of better-sqlite3 this repo actually uses):
 *   kind              'builtin' | 'better-sqlite3'
 *   pragma(expr, {simple})   read → scalar/rows; write (contains '=') → exec
 *   exec(sql) / prepare(sql) → { run, all, get } / function(name, fn) / close()
 * ============================================================================
 */

/** Explicit override: 'builtin' (node:sqlite) or 'native' (better-sqlite3). */
const DRIVER_ENV = String(process.env.GEO_SQLITE_DRIVER || '').trim().toLowerCase();

/**
 * Import `node:sqlite` without leaking Node's "SQLite is an experimental feature"
 * warning into stderr — MCP clients spawn this over stdio and treat stderr noise as
 * diagnostics noise (stdout stays protocol-only, but stderr is what users read).
 */
function requireBuiltin() {
  const original = process.emitWarning;
  process.emitWarning = function suppressed(warning, ...rest) {
    if (typeof warning === 'string' && /SQLite/i.test(warning)) return undefined;
    if (warning && typeof warning === 'object' && /SQLite/i.test(String(warning.name || warning.message))) {
      return undefined;
    }
    return original.call(process, warning, ...rest);
  };
  try {
    return require('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}

/** @returns {boolean} true when the built-in node:sqlite is usable on this runtime */
function builtinAvailable() {
  try {
    const mod = requireBuiltin();
    return typeof mod.DatabaseSync === 'function';
  } catch (_) {
    return false;
  }
}

/** @returns {boolean} true when the optional native module is installed */
function nativeAvailable() {
  try {
    require.resolve('better-sqlite3');
    return true;
  } catch (_) {
    return false;
  }
}

/** Wrap a node:sqlite DatabaseSync in the better-sqlite3-shaped handle. */
function wrapBuiltin(db) {
  return {
    kind: 'builtin',
    raw: db,
    pragma(expr, opts) {
      const simple = !!(opts && opts.simple);
      const sql = `PRAGMA ${expr}`;
      if (expr.includes('=')) {
        db.exec(sql);
        return simple ? undefined : [];
      }
      const rows = db.prepare(sql).all();
      if (simple) {
        if (!rows.length) return undefined;
        const keys = Object.keys(rows[0]);
        return keys.length ? rows[0][keys[0]] : undefined;
      }
      return rows;
    },
    exec(sql) {
      return db.exec(sql);
    },
    prepare(sql) {
      return db.prepare(sql);
    },
    function(name, fn) {
      if (typeof db.function !== 'function') return undefined;
      return db.function(name, fn);
    },
    close() {
      return db.close();
    },
  };
}

/** Wrap a better-sqlite3 Database in the same handle shape (mostly pass-through). */
function wrapNative(db) {
  return {
    kind: 'better-sqlite3',
    raw: db,
    pragma(expr, opts) {
      return db.pragma(expr, opts);
    },
    exec(sql) {
      return db.exec(sql);
    },
    prepare(sql) {
      return db.prepare(sql);
    },
    function(name, fn) {
      return db.function(name, fn);
    },
    close() {
      return db.close();
    },
  };
}

function openBuiltin(dbPath) {
  const { DatabaseSync } = requireBuiltin();
  return wrapBuiltin(new DatabaseSync(dbPath));
}

function openNative(dbPath) {
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3');
  return wrapNative(new Database(dbPath));
}

function unavailableError() {
  return new Error(
    'No SQLite driver available: the built-in `node:sqlite` is missing (needs Node >= 22.5) ' +
      'and the optional dependency `better-sqlite3` is not installed. ' +
      'Fix either by upgrading to Node 22.5+ (recommended, no native build) or by running ' +
      '`npm i better-sqlite3` next to @tengence/geo-sdk. ' +
      'You can also switch to MySQL with DB_DRIVER=mysql.',
  );
}

/**
 * Open a SQLite database with the best available driver.
 * @param {string} dbPath absolute path of the .sqlite file
 * @returns {{kind:string, pragma:Function, exec:Function, prepare:Function, function:Function, close:Function}}
 */
function open(dbPath) {
  const forced = DRIVER_ENV === 'builtin' ? 'builtin' : DRIVER_ENV === 'native' ? 'native' : null;
  const order = forced === 'native' ? ['native', 'builtin'] : ['builtin', 'native'];
  const attempted = [];

  for (const kind of order) {
    if (kind === 'builtin' && !builtinAvailable()) continue;
    if (kind === 'native' && !nativeAvailable()) continue;
    try {
      return kind === 'builtin' ? openBuiltin(dbPath) : openNative(dbPath);
    } catch (e) {
      // A driver can be importable yet unusable (e.g. prebuild missing for this
      // platform) — try the other one before giving up.
      attempted.push(`${kind}: ${e.message}`);
    }
  }

  if (forced) {
    throw new Error(
      `SQLite driver "${forced}" was requested via GEO_SQLITE_DRIVER but could not be used. ` +
        `${attempted.join(' | ') || unavailableError().message}`,
    );
  }
  throw unavailableError();
}

/** Which driver would be used right now (without opening a file) — for diagnostics. */
function detect() {
  const forced = DRIVER_ENV === 'builtin' ? 'builtin' : DRIVER_ENV === 'native' ? 'native' : null;
  if (forced) return { kind: forced, available: forced === 'builtin' ? builtinAvailable() : nativeAvailable(), forced: true };
  if (builtinAvailable()) return { kind: 'builtin', available: true, forced: false };
  if (nativeAvailable()) return { kind: 'better-sqlite3', available: true, forced: false };
  return { kind: null, available: false, forced: false };
}

module.exports = { open, detect, builtinAvailable, nativeAvailable, DRIVER_ENV };
