/**
 * Site domain entry (tengence-geo-sdk/site)
 * ============================================================================
 * Exposes site config loading. The original business repo's site-config was moved
 * to ./config.js; this file only aggregates and forwards, keeping
 * `require('.../site')` and `require('.../site/config')` returning the same symbols.
 * ============================================================================
 */

module.exports = require('./config');
