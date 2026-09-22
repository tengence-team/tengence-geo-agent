#!/usr/bin/env node
/**
 * Juejin auto-publish script
 * Usage: node publish-juejin.js <markdown_file> [--title "Title"] [--draft] [--publish]
 *
 * 2026-09-20 sink-down: the HTTP helper (native https/http) and the three-step
 * orchestration (create draft / write body / publish) moved into
 * tengence-geo-sdk/syndicate/juejin (publishJuejin); this file only keeps argument
 * parsing and exit codes. CLI usage and output stay byte-identical.
 */

const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const t = require('@tengence/geo-sdk');
t.site.loadSite();

// Main
async function main() {
  const { positionals, flags } = t.cli.args.parse(
    { title: { type: 'string' }, draft: { type: 'boolean' }, publish: { type: 'boolean' } },
    process.argv.slice(2)
  );
  if (positionals.length === 0) {
    console.log('Usage: node publish-juejin.js <markdown_file> [--title "Title"] [--draft] [--publish]');
    process.exit(1);
  }

  const mdFile = positionals[0];
  const title = flags.title || null;
  const publish = flags.draft ? false : flags.publish;

  await t.syndicate.juejin.publishJuejin({ mdFile, title, publish });
}

if (require.main === module) {
  main().catch((e) => {
    // pre-sink-down exit semantics kept byte-for-byte: missing cookie exits 1;
    // everything else (file read, etc.) prints the error object and exits 0 naturally
    if (e && e.message === 'JUEJIN_COOKIE_MISSING') process.exit(1);
    console.error(e);
  });
}

module.exports = { publishJuejin: (opts) => t.syndicate.juejin.publishJuejin(opts) };
