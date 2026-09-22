#!/usr/bin/env node
/**
 * One-click publish of a local draft to WordPress
 *
 * Wrapped chain:
 *   1. Read the draft (extract slug / title; parse front matter)
 *   2. Verify the article is registered in the plan table (category / tags come from the
 *      plan; allow-list from the DB categories/tags tables)
 *   3. Create an article record + config record (including seo / geo meta / featured_image)
 *   4. Write the body to the database
 *   5. Publish to WordPress
 *   6. Backfill the article plan table (queued / published, article_id + wp_post_id)
 *   7. db-register syncs categories/tags
 *   8. Move the draft from drafts to posts/<category>/
 *   9. Run taxonomy:verify
 *
 * Usage:
 *   tengence-geo publish-draft.js <draft-path> [--meta=<geo-json-path>] \
 *     [--status=draft|publish] [--site <key>]
 *
 * Single meta source (decided 2026-09-17; focus_keyword retired 2026-09-20):
 *   - front matter wins: seo (title/keywords/meta_description) + featured_image
 *   - <draft-stem>.meta.json is a compatibility fallback only (retired once legacy
 *     articles finish migrating)
 *   - summary / key takeaways / FAQ / data sources follow the body; reverse-parsed to geo.*
 *     on publish
 *   - the primary keyword focus_keyword follows the article plan table (not in the seo object)
 *
 * B-batch refactor: SQL / taxonomy.yaml surgery / Markdown extraction all go through
 * tengence-geo-sdk.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const t = require('@tengence/geo-sdk');

const { loadSite, contentPaths } = t.site;
const { extractTitle } = t.content.md;
const { saveArticleToDatabase } = require('./article-save');

const SITE = loadSite();
const ROOT = path.resolve(__dirname, '../..');
const CONTENT = contentPaths(SITE);
const APP_ID = Number(process.env.APP_ID || 1);

function usage() {
  console.log(`
Usage: tengence-geo publish-draft.js <draft-path> [options]

Options:
  --meta=<path>          geo meta JSON path (default <draft>.meta.json)
  --status=draft|publish publish status (default draft)
  --site <key>           site key (default tengence)
  --no-move              do not move the file to posts/<category>/ after publishing
  --auto-image           before publishing, auto search→filter→download→WebP→upload as the featured image
`);
  process.exit(1);
}

function parseArgs(argv) {
  const { positionals, flags } = t.cli.args.parse(
    {
      site: { type: 'string', default: 'tengence' },
      status: { type: 'string', default: 'draft' },
      meta: { type: 'string' },
      'no-move': { type: 'boolean' },
      'auto-image': { type: 'boolean' },
    },
    argv
  );
  if (positionals.length !== 1) usage();
  return {
    status: flags.status,
    meta: flags.meta,
    site: flags.site,
    move: !flags['no-move'],
    autoImage: flags['auto-image'],
    draftPath: path.resolve(positionals[0]),
  };
}

/**
 * Create / reuse an article record (idempotent: on an interrupted re-run, reuse the
 * existing record to avoid duplicate articles)
 */
async function createArticleRecord(slug, title) {
  return t.db.withConn(async (connection) => {
    const existing = await t.db.articles.findIdBySlug(connection, slug, APP_ID);
    if (existing) {
      await t.db.articles.updateTitle(connection, existing, title);
      return existing;
    }
    return t.db.articles.insert(connection, {
      appId: APP_ID,
      title,
      slug,
      lang: CONTENT.lang,
      region: 'cn',
      status: 'draft',
    });
  });
}

/**
 * Create / reuse a config record (idempotent: updates an existing full config instead of
 * a duplicate INSERT). The config_keywords shape is shared with the publish chain,
 * see tengence-geo-sdk/db/config.js
 */
async function createConfigRecord(articleId, assignment, categories, tags, meta, markdown, frontMatter) {
  // md is authoritative: the body's "summary / key takeaways / FAQ / data sources" override
  // the same-named meta fields, keeping DB fields in sync with Markdown (no drift).
  const { content: bodyMarkdown } = t.content.md.parseFrontMatter(markdown || '');
  const synced = t.content.md.syncGeoFromMarkdown(bodyMarkdown || '', (meta && meta.geo) || {});
  if (synced.changed.length) {
    console.log(`  ✅ GEO follows Markdown: ${synced.changed.join(' / ')}`);
  }
  // seo: front matter wins (merged per-field), meta.json as compatibility fallback
  const fmSeo = (frontMatter && frontMatter.seo && typeof frontMatter.seo === 'object')
    ? frontMatter.seo
    : {};
  const metaSeo = (meta && meta.seo) || {};
  const seo = Object.assign({}, metaSeo, fmSeo);
  const configKeywords = {
    category: assignment.category,
    categories: [categories[assignment.category].name],
    tags: assignment.tags.map(tagSlug => tags[tagSlug].name),
    seo,
    geo: synced.geo
  };
  if (frontMatter && frontMatter.featured_image) {
    configKeywords.featured_image = String(frontMatter.featured_image).trim();
  }
  return t.db.withConn((connection) =>
    t.db.config.upsertFull(connection, articleId, APP_ID, configKeywords)
  );
}

/** WP media URL → production URL (/wp-content/uploads/... → /blog/static/images/...; same as the image-acquire CLI) */
function toProductionUrl(wpMediaUrl) {
  if (!wpMediaUrl) return null;
  const m = String(wpMediaUrl).match(/\/wp-content\/uploads\/(.+)$/);
  if (!m) return wpMediaUrl;
  return `https://www.${SITE.site.domain}/blog/static/images/${m[1]}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.status === 'publish') {
    console.warn('⚠️ Explicit direct publish (--status=publish): bypasses the promote-daily schedule and the internal-link/gate re-check; use only when the user explicitly asks.');
  }
  const draftPath = options.draftPath;

  if (!fs.existsSync(draftPath)) {
    console.error(`❌ Draft file not found: ${draftPath}`);
    process.exit(1);
  }

  const slug = path.basename(draftPath, '.md');
  const rawContent = fs.readFileSync(draftPath, 'utf8');
  // front-matter parsing: seo + featured_image come from here; the body uses parseFrontMatter().content
  const { data: frontMatter, content: bodyMarkdown } = t.content.md.parseFrontMatter(rawContent);
  const title = extractTitle(bodyMarkdown);
  if (!title) {
    console.error('❌ Draft is missing an H1 title');
    process.exit(1);
  }

  console.log(`\n📄 Draft: ${path.relative(ROOT, draftPath)}`);
  console.log(`🔗 slug: ${slug}`);
  console.log(`📝 Title: ${title}`);

  // Category / tag source: the article plan table (single source of truth), allow-list
  // from the DB categories / tags tables
  const planRow = await t.plan.get(slug);
  if (!planRow) {
    console.error(`❌ Please register ${slug} in the article plan table (tengence-geo plan.js import or t.plan.upsert)`);
    process.exit(1);
  }
  const assignment = { category: planRow.category, tags: planRow.tags || [] };
  const whitelistCats = await t.plan.categoryWhitelist();
  const whitelistTags = await t.plan.tagWhitelist();
  const categories = Object.fromEntries(whitelistCats.map((c) => [c.slug, c]));
  const tags = Object.fromEntries(whitelistTags.map((t) => [t.slug, t]));
  if (!categories[assignment.category]) {
    console.error(`❌ Plan category ${assignment.category} not in the allow-list (${whitelistCats.map((c) => c.slug).join(' / ')})`);
    process.exit(1);
  }
  for (const tagSlug of assignment.tags || []) {
    if (!tags[tagSlug]) {
      console.error(`❌ Plan tag ${tagSlug} not in the allow-list`);
      process.exit(1);
    }
  }

  // Single meta source (decided 2026-09-17): front matter wins; meta.json is only a
  // compatibility fallback (retired after migration)
  let meta = {};
  const fmSeo = (frontMatter && frontMatter.seo && typeof frontMatter.seo === 'object')
    ? frontMatter.seo
    : {};
  const metaPath = options.meta || draftPath.replace(/\.md$/, '.meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      console.log(`  ℹ️ Compatibly reading meta file: ${path.relative(ROOT, metaPath)} (front matter wins)`);
    } catch (e) {
      console.error(`❌ Failed to parse meta file: ${metaPath} (${e.message})`);
      process.exit(1);
    }
  }
  if (!Object.keys(fmSeo).length && !(meta && meta.seo && Object.keys(meta.seo).length)) {
    console.warn('  ⚠️ No seo meta found (neither front matter nor meta.json)');
    console.warn('     seo description / keywords keep their live values; consider adding them to front matter');
  }

  console.log('\n[1/7] Creating the article record...');
  const articleId = await createArticleRecord(slug, title);
  console.log(`  ✅ Article ID: ${articleId}`);

  console.log('\n[2/7] Creating the config record (including seo / geo meta / featured_image)...');
  // Fixes a legacy bug: the original referenced undefined taxonomy.categories/tags
  // (ReferenceError); the allow-list maps were built above (categories / tags) and are
  // passed per the createConfigRecord signature
  await createConfigRecord(articleId, assignment, categories, tags, meta, rawContent, frontMatter);
  console.log('  ✅ Config written');

  console.log('\n[3/7] Saving the body to the database...');
  await saveArticleToDatabase(articleId, draftPath, { updateTitle: true });

  // Gate: hard block before publishing (2026-09-20 scripted AGENTS.md "must pass the gate
  // before publishing"; same source as the promote-daily re-check; unpublished → no WP —
  // including drafts. The earlier steps are idempotent, so fix and re-run)
  console.log('\n🔍 Gate check (check-article)...');
  const gateReport = await t.check.checkArticle({ slug, dir: assignment.category });
  for (const [k, v, ok, soft] of gateReport.rows) {
    console.log((ok ? '✅' : (soft ? '⚠️' : '❌')) + ' ' + k + ': ' + v);
  }
  if (gateReport.warns.length) {
    console.log('\n⚠️  Soft warnings (non-blocking, recommended to clean up):');
    for (const w of gateReport.warns) console.log('   - ' + w);
  }
  if (!gateReport.ok) {
    console.error('\n❌ Gate failed, aborting the publish (no WP draft). Fix and re-run (earlier steps are idempotent)');
    process.exit(1);
  }
  console.log('  ✅ Gate passed');

  // Auto image: run the image pipeline before publishing to produce a featured-media ID
  // (direct t.images.acquire call, de-subprocessed 2026-09-20)
  let featuredMediaFlag = '';
  let featuredMediaId = null;
  if (options.autoImage) {
    console.log('\n[3.5/7] Auto image (search→filter→download→WebP→upload)...');
    const siteFlagForCmd = options.site === 'tengence' ? '' : ` --site ${options.site}`;
    const resultJson = path.join(os.tmpdir(), `${slug}-featured.json`);
    console.log(`\n$ tengence-geo image-acquire.js --slug=${slug} --out-json=${resultJson}${siteFlagForCmd}`);
    const media = await t.images.acquire({ slug, appId: APP_ID, log: console.error });
    // replicates the original CLI's stdout (result JSON) + stderr (ready / backfill)
    console.log(JSON.stringify(media));
    if (media.dryRun) {
      console.error(`\n[Dry Run] produced a local ${String(process.env.IMAGE_FORMAT || 'jpg').toLowerCase() === 'webp' ? 'WebP' : 'JPG'}; not uploaded/registered`);
    } else {
      console.error(`\n✅ Featured image ready: media ID ${media.wp_media_id}`);
      try {
        const productionUrl = toProductionUrl(media.url);
        await t.plan.setFeaturedImage(slug, productionUrl);
        console.error(`  ✅ Plan table backfilled with featured image: ${productionUrl}`);
      } catch (e) {
        console.error(`  ⚠️ Failed to backfill the plan table (does not affect the acquisition result): ${e.message}`);
      }
    }
    if (media.wp_media_id) {
      featuredMediaFlag = ` --featured-media ${media.wp_media_id}`;
      featuredMediaId = media.wp_media_id;
      console.log(`  ✅ Featured media ID: ${media.wp_media_id}`);
    }
  }

  console.log('\n[4/7] Publishing to WordPress...');
  const siteFlag = options.site === 'tengence' ? '' : ` --site ${options.site}`;
  console.log(`\n$ tengence-geo publish-from-db.js ${articleId} --status=${options.status} --force${siteFlag}${featuredMediaFlag}`);
  // direct t.publish.publishArticle call (2026-09-20 de-subprocessed; output replicates the publish-from-db CLI)
  let connection;
  try {
    connection = await t.db.createConnection({ connectTimeout: 60000 });
    console.log('✓ Database connected');
  } catch (error) {
    console.error('✗ Database connection failed:', error.message);
    process.exit(1);
  }
  let publishResult;
  try {
    publishResult = await t.publish.publishArticle(connection, articleId, {
      status: options.status,
      force: true,
      featuredMedia: featuredMediaId,
    });
  } catch (error) {
    console.error(`\n✗ Failed to publish article ID ${articleId}: ${error.message}`);
    console.log('\n========================================');
    console.log('Publish summary');
    console.log('========================================');
    console.log('Total: 1');
    console.log('Succeeded: 0');
    console.log('Failed: 1');
    console.log('\nFailed articles:');
    console.log(`  - ID ${articleId}: ${error.message}`);
    throw error;
  } finally {
    await connection.end();
  }
  console.log('\n========================================');
  console.log('Publish summary');
  console.log('========================================');
  console.log('Total: 1');
  console.log('Succeeded: 1');
  console.log('Failed: 0');
  const wpPostId = publishResult.id;
  console.log(`  ✅ WP post ID: ${wpPostId}`);

  console.log('\n[5/7] Backfilling the article plan table...');
  let planWrite;
  if (options.status === 'publish') {
    planWrite = await t.plan.markPublished(slug, {
      wpPostId,
      publishedUrl: `https://www.${SITE.site.domain}/blog/article/${slug}/`,
    });
  } else {
    planWrite = await t.plan.markQueued(slug, { articleId, wpPostId });
  }
  if (!planWrite.updated) {
    console.error(`❌ Plan write-back failed: ${slug} not found`);
    process.exit(1);
  }
  console.log(`  ✅ Plan updated: ${slug} → ${options.status === 'publish' ? 'published' : 'queued'} (article_id=${articleId}, wp_post_id=${wpPostId})`);

  console.log('\n[6/7] db-register syncs categories/tags...');
  console.log(`\n$ tengence-geo taxonomy.js db-register --slugs=${slug}${siteFlag}`);
  await t.taxonomy.registerDatabase({ slugFilter: [slug], appId: APP_ID });

  if (options.move) {
    // From 2026-09-20: working files are archived to data/archive/<date>/ after
    // publishing (gitignore; DB is the single source of truth)
    console.log('\n[7/7] Archiving working files to data/archive (DB is the single source of truth)...');
    const archiveDir = path.join(SITE.siteDir, 'data/archive', new Date().toISOString().slice(0, 10));
    fs.mkdirSync(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, `${slug}.md`);
    fs.renameSync(draftPath, archivePath);
    console.log(`  ✅ Archived to ${path.relative(ROOT, archivePath)}`);
  } else {
    console.log('\n[7/7] Skipping archive (--no-move keeps the working file)');
  }

  console.log('\n🔍 Running taxonomy:verify...');
  console.log('\n$ npm run taxonomy:verify');
  await t.taxonomy.verify({ appId: APP_ID });

  console.log(`\n✅ Published: https://www.${SITE.site.domain}/blog/article/${slug}/`);
}

if (require.main === module) {
  main().catch(error => {
    console.error('\n❌ Publish failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  });
}

module.exports = { main };
