'use strict';
/**
 * One-draft-multi-publish (external platform sync) domain
 * (tengence-geo-sdk/syndicate) unified exit
 * ============================================================================
 * Sunk down from commands/publish-devto.js / publish-juejin.js / publish-wechat.js
 * on 2026-09-20: each platform's core logic (parsing / payload construction / API
 * calls / orchestration) moved into this domain's submodules; the CLIs keep only
 * argument parsing, input validation and exit codes.
 *
 * Conventions:
 *   - Consistent with the publish domain: platform orchestration and progress
 *     printing stay in the SDK (reusable, testable), but error/validation input
 *     errors throw Error, and exit codes are the caller's (CLI) job.
 *   - Printing uses console.log/error (ported as-is, keeping the CLI output
 *     byte-identical).
 * ============================================================================
 */
const devto = require('./devto');
const juejin = require('./juejin');
const wechat = require('./wechat');

module.exports = { devto, juejin, wechat };
