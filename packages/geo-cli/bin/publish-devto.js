#!/usr/bin/env node
/**
 * publish-devto.js — syndicate one article to Dev.to
 *
 * Usage:
 *   tengence-geo publish-devto.js <md-file-path> [--dry-run]
 *
 * 2026-09-20 sink-down: front-matter parsing / Dev.to tag inference / canonical-URL
 * building / payload construction / API call moved into tengence-geo-sdk/syndicate/devto
 * (publishDevto); this file only keeps argument parsing and exit codes. CLI usage and
 * output stay byte-identical.
 *
 * Env vars:
 *   DEVTO_API_KEY  — sites/tengence/.env
 *   SITE_DOMAIN    — the official site domain, used to build the canonical_url
 */

const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const t = require('@tengence/geo-sdk');
t.site.loadSite();

async function main() {
  const { positionals, flags } = t.cli.args.parse(
    { 'dry-run': { type: 'boolean' } },
    process.argv.slice(2)
  );
  const dryRun = flags['dry-run'];
  const mdPath = positionals[0];

  if (!mdPath) {
    console.error('Usage: tengence-geo publish-devto.js <md-file-path> [--dry-run]');
    process.exit(1);
  }

  await t.syndicate.devto.publishDevto({ mdPath, dryRun });
}

if (require.main === module) {
  main().catch((e) => process.exit(1));
}

module.exports = { publishDevto: (opts) => t.syndicate.devto.publishDevto(opts) };
