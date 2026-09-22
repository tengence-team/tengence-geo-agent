#!/usr/bin/env node
// Article content export (DB is the single source of truth → data/inbox workspace,
// for rewriting and re-ingesting)
// Usage: tengence-geo article-export.js <slug> [--lang zh-CN] [--out <dir>]
//   - defaults to exporting to <site>/data/inbox/<lang>/<slug>.md (+ <slug>.research.md if any)
//   - --out overrides the output directory (relative to the repo root)
// Exit code 0 = success, 1 = failure
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const t = require('@tengence/geo-sdk');

t.site.loadSite();
const APP_ID = Number(process.env.APP_ID || 1);

function parseArgs(argv) {
  const { positionals, flags } = t.cli.args.parse(
    { lang: { type: 'string', default: 'zh-CN' }, out: { type: 'string' } },
    argv
  );
  return { positional: positionals, opts: { lang: flags.lang, out: flags.out } };
}

async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const slug = positional[0];
  if (!slug) {
    console.error('Usage: tengence-geo article-export.js <slug> [--lang zh-CN] [--out <dir>]');
    process.exit(2);
  }
  const lang = opts.lang || 'zh-CN';
  const site = t.site.loadSite();
  const outDir = opts.out
    ? path.resolve(root, opts.out)
    : path.join(site.siteDir, 'data/inbox', lang);
  fs.mkdirSync(outDir, { recursive: true });

  const article = await t.db.withConn(async (conn) => {
    const [rows] = await conn.query(
      'SELECT title, content_longtext, research_md FROM tengence_geo_articles WHERE app_id = ? AND slug = ? AND lang = ? LIMIT 1',
      [APP_ID, slug, lang]
    );
    return rows[0] || null;
  });
  if (!article) {
    console.error(`❌ Article not found: ${slug} (lang=${lang})`);
    process.exit(1);
  }

  const mdOut = path.join(outDir, `${slug}.md`);
  fs.writeFileSync(mdOut, `${article.content_longtext || ''}\n`, 'utf8');
  console.log(`  ✅ Body exported: ${path.relative(root, mdOut)} (${(article.content_longtext || '').length} chars)`);

  if (article.research_md) {
    const researchOut = path.join(outDir, `${slug}.research.md`);
    fs.writeFileSync(researchOut, article.research_md, 'utf8');
    console.log(`  ✅ Brief exported: ${path.relative(root, researchOut)}`);
  } else {
    console.log('  ⏭️  no research_md, skipping brief export');
  }

  console.log(`\n✅ Export complete: ${slug} (re-ingest with article-ingest after rewriting)`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
  });
}

module.exports = { main };
