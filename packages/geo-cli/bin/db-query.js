#!/usr/bin/env node
/**
 * Article query script (CLI thin shell)
 * Usage: tengence-geo db-query.js [--list] [--slug=xxx] [--category=xxx] [--status=xxx] [--site <key>]
 *
 * 2026-09-14 entry-layer refactor: SQL moved down to the tengence-geo-sdk db domain
 * (t.db.articles.list / getDetail, t.db.terms.listCategories / listTags);
 * this file only keeps "argument parsing + output formatting".
 */

const t = require('@tengence/geo-sdk');

// Load site config (--site <key>, default tengence): reads DB credentials from sites/<site>/.env
t.site.loadSite();
const { parseJsonValue } = t.db.value;

// App ID
const APP_ID = parseInt(process.env.APP_ID || '1');

/**
 * Format the article list output
 */
function formatArticleList(articles) {
  console.log('\n' + '='.repeat(120));
  console.log(`ID    Slug                                    Title                                      Status      Lang    Region`);
  console.log('='.repeat(120));

  for (const a of articles) {
    const id = String(a.id).padEnd(5);
    const slug = (a.slug || '').slice(0, 38).padEnd(40);
    const title = (a.title || '').slice(0, 42).padEnd(44);
    const status = (a.status || '').padEnd(11);
    const lang = (a.lang || '').padEnd(7);
    const region = a.region_market || '';

    console.log(`${id}${slug}${title}${status}${lang}${region}`);
  }

  console.log('='.repeat(120));
  console.log(`Total: ${articles.length} articles\n`);
}

/**
 * Safe JSON parse — delegates to the single implementation in tengence-geo-sdk/db/value
 * (the original double-parsed already-object JSON columns → threw → always returned [];
 * fixed). Backwards compatible: when no default is passed, falls back to []
 */
function safeParse(value) {
  return parseJsonValue(value, []);
}

/**
 * Strip HTML tags (for printing fields like GEO answers that contain tags)
 */
function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '');
}

/**
 * Format the article detail output
 */
function formatArticleDetail(article) {
  console.log('\n' + '='.repeat(80));
  console.log(`Article detail: ${article.title}`);
  console.log('='.repeat(80));

  console.log(`\nBasic info:`);
  console.log(`  ID:          ${article.id}`);
  console.log(`  Slug:        ${article.slug}`);
  console.log(`  Title:       ${article.title}`);
  console.log(`  Status:      ${article.status}`);
  console.log(`  Language:    ${article.lang}`);
  console.log(`  Region:      ${article.region_market}`);
  console.log(`  Difficulty:  ${article.difficulty_level}`);

  console.log(`\nTimestamps:`);
  console.log(`  Date:        ${article.date || 'N/A'}`);
  console.log(`  Lastmod:     ${article.lastmod || 'N/A'}`);
  console.log(`  Published:   ${article.published_at || 'N/A'}`);

  console.log(`\nCategory & tags:`);
  console.log(`  Categories:  ${article.categories || 'N/A'}`);
  console.log(`  Tags:        ${article.tags || 'N/A'}`);

  console.log(`\nSEO:`);
  if (article.seo) {
    console.log(`  Title:       ${article.seo.title || 'N/A'}`);
    console.log(`  Description: ${(article.seo.meta_description || 'N/A').slice(0, 60)}...`);
    const keywords = safeParse(article.seo.keywords);
    console.log(`  Keywords:    ${Array.isArray(keywords) && keywords.length > 0 ? keywords.join(', ') : 'N/A'}`);
  } else {
    console.log(`  (no SEO data)`);
  }

  console.log(`\nGEO:`);
  if (article.geo) {
    console.log(`  AI Summary:  ${(article.geo.ai_summary || 'N/A').slice(0, 60)}...`);
    const takeaways = safeParse(article.geo.key_takeaways);
    console.log(`  Takeaways:   ${Array.isArray(takeaways) && takeaways.length > 0 ? takeaways.slice(0, 2).join(', ') : 'N/A'}`);
  } else {
    console.log(`  (no GEO data)`);
  }

  if (article.qa_pairs && article.qa_pairs.length > 0) {
    console.log(`\nQA Pairs (${article.qa_pairs.length}):`);
    for (const qa of article.qa_pairs.slice(0, 2)) {
      const q = (qa.question || '').slice(0, 50);
      const a = stripHtml(qa.answer || '').slice(0, 60);
      console.log(`  Q: ${q}${q.length >= 50 ? '...' : ''}`);
      console.log(`  A: ${a}${a.length >= 60 ? '...' : ''}`);
    }
  }

  if (article.citations && article.citations.length > 0) {
    console.log(`\nCitations (${article.citations.length}):`);
    for (const c of article.citations.slice(0, 3)) {
      const text = (c.text || '').slice(0, 50);
      const url = c.url || '';
      console.log(`  • ${text}${url ? ` — ${url}` : ''}`);
    }
  }

  console.log(`\nVector index:`);
  if (article.vector) {
    console.log(`  Vector ID:   ${article.vector.vector_id || 'N/A'}`);
    console.log(`  Provider:    ${article.vector.embedding_provider || 'N/A'}`);
    console.log(`  Indexed At:  ${article.vector.indexed_at || 'N/A'}`);
  } else {
    console.log(`  (not indexed)`);
  }

  console.log('\n' + '='.repeat(80) + '\n');
}

/**
 * Format the article plan table (--plan view; replaces manually maintained doc status columns)
 */
function formatPlan(rows) {
  console.log('\n' + '='.repeat(150));
  console.log(`Article plan (${rows.length} rows)`);
  console.log('='.repeat(150));
  console.log('status    batch cluster code type  category             tags                     title                             slug');
  console.log('='.repeat(150));
  for (const p of rows) {
    const status = (p.plan_status || '').padEnd(9);
    const batch = p.publish_batch ? String(p.publish_batch) : '-';
    const cluster = (p.hub_cluster || '-').padEnd(2);
    const code = (p.matrix_code || '-').padEnd(4);
    const type = (p.node_type || '').padEnd(5);
    const cat = (p.category || '-').slice(0, 18).padEnd(18);
    const tagsRaw = Array.isArray(p.tag_names) ? p.tag_names.join(',') : (p.tag_names || (Array.isArray(p.tags) ? p.tags.join(',') : ''));
    const tags = tagsRaw.slice(0, 24).padEnd(24);
    const title = (p.title || '').slice(0, 32).padEnd(32);
    console.log(`${status} ${batch} ${cluster} ${code} ${type} ${cat} ${tags} ${title} ${p.slug}`);
  }
  console.log('='.repeat(150));
}

/**
 * Main
 */
async function main() {
  const { flags } = t.cli.args.parse(
    {
      list: { type: 'boolean', alias: ['l'] },
      slug: { type: 'string' },
      category: { type: 'string' },
      status: { type: 'string' },
      lang: { type: 'string' },
      limit: { type: 'string' },
      categories: { type: 'boolean', alias: ['c'] },
      tags: { type: 'boolean', alias: ['t'] },
      plan: { type: 'boolean', alias: ['p'] },
      help: { type: 'boolean', alias: ['h'] },
    },
    process.argv.slice(2)
  );

  const options = {
    list: flags.list,
    slug: flags.slug,
    category: flags.category,
    status: flags.status,
    lang: flags.lang,
    limit: flags.limit,
    categories: flags.categories,
    tags: flags.tags,
    plan: flags.plan,
  };

  if (flags.help) {
    console.log('Usage: tengence-geo db-query.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  --list, -l         list all articles');
    console.log('  --slug=xxx         query a specific article detail');
    console.log('  --category=xxx     filter by category');
    console.log('  --status=xxx       filter by status (draft|review|publish|archived)');
    console.log('  --lang=xxx         filter by language');
    console.log('  --limit=N          limit the count');
    console.log('  --categories, -c   list all categories');
    console.log('  --tags, -t         list all tags');
    console.log('  --plan, -p         list the article plan (Hub & Spoke publishing plan; DB is the single source of truth)');
    console.log('  --help, -h         show help');
    process.exit(0);
  }

  try {
    if (options.plan) {
      const rows = await t.plan.list({
        appId: APP_ID,
        status: options.status || undefined,
        category: options.category || undefined,
        nodeType: options.status === 'hub' ? 'hub' : undefined,
        limit: options.limit ? parseInt(options.limit, 10) : undefined
      });
      formatPlan(rows);
      return;
    }
    await t.db.withConn(async (connection) => {
      if (options.categories) {
        const categories = await t.db.terms.listCategories(connection, APP_ID);
        console.log('\nCategory list:');
        console.log('ID    Name                                      Slug');
        console.log('='.repeat(80));
        for (const cat of categories) {
          console.log(`${String(cat.id).padEnd(5)}${cat.name.padEnd(42)}${cat.slug}`);
        }
        console.log(`\nTotal: ${categories.length} categories\n`);
      } else if (options.tags) {
        const tags = await t.db.terms.listTags(connection, APP_ID);
        console.log('\nTag list:');
        console.log('ID    Name                                      Slug');
        console.log('='.repeat(80));
        for (const tag of tags) {
          console.log(`${String(tag.id).padEnd(5)}${tag.name.padEnd(42)}${tag.slug}`);
        }
        console.log(`\nTotal: ${tags.length} tags\n`);
      } else if (options.slug) {
        const article = await t.db.articles.getDetail(connection, APP_ID, options.slug);
        if (article) {
          formatArticleDetail(article);
        } else {
          console.log(`\nArticle not found: ${options.slug}\n`);
        }
      } else {
        // default: list articles
        const filters = {};
        if (options.category) filters.category = options.category;
        if (options.status) filters.status = options.status;
        if (options.lang) filters.lang = options.lang;
        if (options.limit) filters.limit = options.limit;

        const articles = await t.db.articles.list(connection, APP_ID, filters);
        formatArticleList(articles);
      }
    });
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
