/**
 * WordPress endpoint & credential resolution (the only entry of the wp domain)
 * ============================================================================
 * Consolidation note (batch B): pre-refactor, the `apiUrl` and the `Basic` auth
 * header were assembled in 4 places:
 *   - publish-from-db.js   CONFIG.wp + AUTH_HEADER
 *   - wp/media.js          resolveWpUploadTarget()
 *   - taxonomy.js          authHeader()
 *   - wordpress-update-article.py create_auth_header()
 * Now resolved by this module only; everything is read from sites/<site>/.env
 * (injected into process.env by loadSite), no hard-coding, no plaintext fallback.
 *
 * Usage:
 *   const { wpTarget } = require('../wp/target');
 *   const { apiUrl, authHeader, siteKey } = wpTarget();
 * ============================================================================
 */

const { loadSite } = require('../site/config');

/**
 * Resolve the WP API target
 * @returns {{siteKey:string, wpUrl:string, wpApiUrl:string, apiUrl:string, authHeader:string}}
 * @throws when WP_URL / WP_USERNAME / WP_PASSWORD are missing (no fallback)
 */
function wpTarget() {
  const SITE = loadSite();
  const username = process.env.WP_USERNAME;
  const password = process.env.WP_PASSWORD;
  const wpUrl = process.env.WP_URL || '';

  if (!username || !password) {
    throw new Error(
      `Missing WordPress credentials: set WP_USERNAME / WP_PASSWORD in sites/${SITE.siteKey}/.env`
    );
  }
  if (!wpUrl) {
    throw new Error(
      `Missing WordPress endpoint: set WP_URL (and optionally WP_API_URL) in sites/${SITE.siteKey}/.env`
    );
  }

  const wpApiUrl = process.env.WP_API_URL || `${wpUrl}/wp-json`;
  return {
    siteKey: SITE.siteKey,
    wpUrl,
    wpApiUrl,
    apiUrl: `${wpApiUrl.replace(/\/$/, '')}/wp/v2`,
    authHeader: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
  };
}

module.exports = { wpTarget };
