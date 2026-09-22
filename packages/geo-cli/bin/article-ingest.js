#!/usr/bin/env node
// Article content ingest (DB is the single source of truth since 2026-09-20;
// md/brief are authoring workspace files, auto-archived after ingest)
// Usage: tengence-geo article-ingest.js <slug> [<md-path>] [--lang zh-CN] [--research <path>] [--no-archive]
//   - md path defaults to: <site>/data/inbox/<lang>/<slug>.md
//   - research path defaults to: <site>/data/inbox/<lang>/<slug>.research.md (ingested only if present)
//   - when no articles row exists, creates one matching the plan title (lang defaults to zh-CN)
//   - working files are auto-archived to data/archive/<date>/ after ingest (skipped with --no-archive)
// Exit code 0 = success, 1 = failure
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const t = require('@tengence/geo-sdk');
const { saveArticleToDatabase } = require('./article-save');

t.site.loadSite();
const APP_ID = Number(process.env.APP_ID || 1);

function parseArgs(argv) {
  const { positionals, flags } = t.cli.args.parse(
    {
      lang: { type: 'string', default: 'zh-CN' },
      research: { type: 'string' },
      'no-archive': { type: 'boolean' },
    },
    argv
  );
  // Note: the original implementation stored --no-archive as opts['no-archive'] while the
  // body read opts.noArchive, so the option never actually took effect (everything was
  // archived regardless). The 1f mechanical unification kept the original key;
  // fixed 2026-09-20: the reader now uses the same key, so --no-archive works as documented.
  return { positional: positionals, opts: { lang: flags.lang, research: flags.research, 'no-archive': flags['no-archive'] } };
}

async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const slug = positional[0];
  if (!slug) {
    console.error('Usage: tengence-geo article-ingest.js <slug> [<md-path>] [--lang zh-CN] [--research <path>] [--no-archive]');
    process.exit(2);
  }
  const lang = opts.lang || 'zh-CN';
  const site = t.site.loadSite();
  const { content, extractTitle, stripFrontMatter } = t.content.md;
  const inboxDir = path.join(site.siteDir, 'data/inbox', lang);

  // 1. locate the md working file
  const mdPath = positional[1] ? path.resolve(positional[1]) : path.join(inboxDir, `${slug}.md`);
  if (!fs.existsSync(mdPath)) {
    console.error(`❌ Working file not found: ${path.relative(root, mdPath)}`);
    process.exit(1);
  }
  const researchPath = opts.research
    ? path.resolve(opts.research)
    : path.join(inboxDir, `${slug}.research.md`);

  // 2. find / create the articles row
  const rawMd = fs.readFileSync(mdPath, 'utf8');
  const headingTitle = extractTitle(stripFrontMatter(rawMd));

  const articleId = await t.db.withConn(async (conn) => {
    const [rows] = await conn.query(
      'SELECT id FROM tengence_geo_articles WHERE app_id = ? AND slug = ? AND lang = ? LIMIT 1',
      [APP_ID, slug, lang]
    );
    if (rows.length) return rows[0].id;

    // No row: create one matching the plan title (priority: md H1 → plan.title → slug)
    const [planRows] = await conn.query(
      'SELECT title FROM tengence_geo_article_plan WHERE app_id = ? AND slug = ? AND node_type = ? LIMIT 1',
      [APP_ID, slug, 'spoke']
    );
    const title = headingTitle || (planRows[0] && planRows[0].title) || slug;
    const newId = await t.db.articles.insert(conn, { appId: APP_ID, title, slug, lang, region: 'cn', status: 'draft' });
    console.log(`  ✅ Created articles row id=${newId} (title: ${title})`);
    return newId;
  });

  // 3. ingest the body + seo/geo reverse parsing (reuses the main-pipeline parser; md is authoritative)
  await saveArticleToDatabase(articleId, mdPath, { updateTitle: true });

  // 4. ingest the research brief (only when the file exists; keeps an existing DB value)
  let researchIngested = false;
  if (fs.existsSync(researchPath)) {
    const researchMd = fs.readFileSync(researchPath, 'utf8');
    await t.db.withConn((conn) =>
      t.db.articles.saveContent(conn, articleId, APP_ID, { research_md: researchMd })
    );
    researchIngested = true;
  }

  // 5. plan status: todo → written (only promotes; published/queued untouched)
  await t.db.withConn((conn) =>
    conn.query(
      "UPDATE tengence_geo_article_plan SET plan_status = 'written' WHERE app_id = ? AND slug = ? AND plan_status = 'todo'",
      [APP_ID, slug]
    )
  );

  // 6. archive the working files (skipped with --no-archive; the option was fixed on 2026-09-20,
  //    previously it never took effect)
  if (!opts['no-archive']) {
    const archiveDir = path.join(site.siteDir, 'data/archive', new Date().toISOString().slice(0, 10));
    fs.mkdirSync(archiveDir, { recursive: true });
    const moved = [mdPath];
    if (researchIngested) moved.push(researchPath);
    for (const f of moved) {
      const dest = path.join(archiveDir, path.basename(f));
      fs.renameSync(f, dest);
      console.log(`  📦 Archived: ${path.relative(root, dest)}`);
    }
  } else {
    console.log('  ⏭️  --no-archive: keeping working files');
  }

  // Gate soft preview (added 2026-09-20: ingest ≠ publish, non-blocking; only shows the
  // publish-gate gaps for authoring reference)
  const planInfo = await t.plan.get(slug);
  const gateDir = (planInfo && planInfo.category) || 'industry-insights';
  const gate = await t.check.checkArticle({ slug, dir: gateDir });
  console.log('\n🔍 Gate preview (non-blocking at ingest; must all pass before publishing):');
  for (const [k, v, ok, soft] of gate.rows) {
    console.log((ok ? '✅' : (soft ? '⚠️' : '❌')) + ' ' + k + ': ' + v);
  }
  if (!gate.ok) console.log('\n>>> Some checks failed (fix before publishing, see AGENTS.md)');
  else console.log('\n>>> All gate checks passed');

  console.log(`\n✅ Ingest complete: ${slug} (article_id=${articleId}, lang=${lang}${researchIngested ? ', research_md ingested' : ''})`);
  console.log('   Next: tengence-geo check-article.js ' + slug + ' (gate) → publish-from-db.js ' + articleId + ' (publish)');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
  });
}

module.exports = { main };
