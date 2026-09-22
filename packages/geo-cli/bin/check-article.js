#!/usr/bin/env node
// Article gate check: word count (per article type) / banned words / meta length / the three
// blocks (summary·takeaways·FAQ) with materialization preview / citation source-link integrity
// Usage: tengence-geo check-article.js <slug> [<dir=industry-insights>] [--type=T1..T7]
//   --type: explicitly declares the article type (T1 definition / T2 how-to / T3 product
//           solution / T4 case study / T5 industry / T6 comparison / T7 documentation),
//           enforcing the word-count range by type (hard check); when omitted, infers by
//           directory (soft hint only, non-blocking).
// Exit code 0 = all passed, 1 = failures exist, 2 = usage error
//
// 2026-09-20 sink-down: the check logic moved entirely into tengence-geo-sdk/check
// (checkArticle, returning a structured report); this file only does "parse args →
// call checkArticle → render the report → exit by code".
// Rules, messages and thresholds are byte-identical to the pre-sink-down version;
// rendering and exit-code behavior are unchanged.

const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const t = require('@tengence/geo-sdk');

async function main() {
  const { positionals, flags } = t.cli.args.parse(
    { type: { type: 'string' } },
    process.argv.slice(2)
  );
  const slug = positionals[0];
  const dir = positionals[1] || 'industry-insights';
  const typeArg = (flags.type || '').trim().toUpperCase();
  if (!slug) {
    console.error('Usage: tengence-geo check-article.js <slug> [<dir>] [--type=T1..T7]');
    process.exit(2);
  }

  const report = await t.check.checkArticle({ slug, dir, type: typeArg || null });
  const { rows, warns } = report;

  if (report.unknownType) {
    console.error('⚠️ Unknown --type=' + report.unknownType + ' (choose T1..T7), ignored; inferring by directory');
  }

  console.log('===== ' + slug + ' =====');
  for (const [k, v, ok, soft] of rows) {
    // rows with soft=true (e.g. word count without explicit --type) are hints only and do not affect the exit code
    console.log((ok ? '✅' : (soft ? '⚠️' : '❌')) + ' ' + k + ': ' + v);
  }
  if (warns.length) {
    console.log('\n⚠️  Soft warnings (non-blocking, recommended to clean up):');
    for (const w of warns) console.log('   - ' + w);
  }
  console.log(report.ok ? '\n>>> All gate checks passed' : '\n>>> Some checks failed');
  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('❌ check-article failed:', e.message);
    process.exit(1);
  });
}

module.exports = { checkArticle: (opts) => t.check.checkArticle(opts) };
