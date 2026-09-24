'use strict';
/**
 * Search-engine webmaster console domain (tengence-geo-sdk/webmaster)
 * ============================================================================
 * Unified exit for managing the search-engine 站长后台 consoles — a dedicated
 * category, separate from search/ (which today is the Google inclusion-submission
 * domain that also happens to host baidu/indexnow).
 *
 *   bing   Bing Webmaster Tools API (read: pages/sitemaps/query stats/traffic/
 *          crawl issues/URL status; write: submit URL/batch/sitemap + sitemap
 *          incremental submission) — implemented 2026-09-24.
 *
 * Planned (not moved yet, to keep the publish chain stable): GSC / Baidu /
 * IndexNow from search/ will migrate here so all console-type integrations share
 * one domain and one util layer.
 * ============================================================================
 */
const bing = require('./bing');
const util = require('./util');

module.exports = { bing, util };
