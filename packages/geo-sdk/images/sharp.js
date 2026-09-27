/**
 * Lazy `sharp` loader (geo-sdk/images/sharp)
 * ============================================================================
 * `sharp` is a native module pulling ~30MB of platform-specific binaries
 * (`@img/sharp-*`). It is an **optional dependency** of @tengence/geo-sdk so that
 * `npx -y @tengence/geo-mcp` stays a small, pure-JS install; only the image-pipeline
 * paths actually need it.
 *
 * Usage is unchanged from a direct require — call it like the module:
 *
 *   const sharp = require('./sharp');
 *   await sharp(input).resize(32, 32).greyscale().raw().toBuffer({ resolveWithObject: true });
 *
 * The native module is loaded on first *call* (not at require time), and a missing
 * install produces one actionable error instead of MODULE_NOT_FOUND.
 * ============================================================================
 */

let _sharp = null;

/** @returns {boolean} true when the optional native module is installed */
function sharpAvailable() {
  try {
    require.resolve('sharp');
    return true;
  } catch (_) {
    return false;
  }
}

/** Load (and memoize) the native module. @throws {Error} with install instructions */
function loadSharp() {
  if (_sharp) return _sharp;
  try {
    _sharp = require('sharp');
  } catch (e) {
    throw new Error(
      'Image processing requires `sharp`, which is an optional dependency of ' +
        '@tengence/geo-sdk (native module, ~30MB) and is not installed. ' +
        'Install it with `npm i sharp`, then retry the image command. ' +
        `Original error: ${e.message}`,
    );
  }
  return _sharp;
}

/** Callable drop-in replacement for the module itself. */
function sharp(...args) {
  return loadSharp()(...args);
}

module.exports = sharp;
module.exports.loadSharp = loadSharp;
module.exports.sharpAvailable = sharpAvailable;
