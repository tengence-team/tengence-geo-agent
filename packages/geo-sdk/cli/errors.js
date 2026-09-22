/**
 * Unified error handling
 * ============================================================================
 * New module added in batch A, no callers yet; later batches replace the scattered
 * `console.error(...); process.exit(1)` in each script.
 *
 * Usage:
 *   const { run } = require('../cli/errors');
 *   run(async () => { ... });   // uncaught exception → print and exit(1)
 * ============================================================================
 */

const log = require('./log');

/** Business error (can carry an exit code, distinguished from unexpected exceptions) */
class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/**
 * Wrap a CLI entry: catch exceptions, print, exit with the right code
 * @param {Function} main async function
 * @param {{label?:string}} [opts]
 */
function run(main, opts = {}) {
  const label = opts.label || '';
  Promise.resolve()
    .then(main)
    .catch((err) => {
      if (err instanceof CliError) {
        log.fail(err.message);
        process.exit(err.exitCode);
      }
      log.fail(`${label ? label + ': ' : ''}${err && err.message ? err.message : err}`);
      if (err && err.stack && process.env.DEBUG) console.error(err.stack);
      process.exit(1);
    });
}

module.exports = { run, CliError };
