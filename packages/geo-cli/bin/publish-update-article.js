#!/usr/bin/env node
/**
 * WordPress article update script — generic version
 * Usage: tengence-geo publish-update-article.js <markdown_file> [options]
 * Options: --slug / --post-id / --status / --dry-run / --no-upload / --site <key>
 *
 * Notes: the title comes from the body's first H1; the target article is located by
 * --slug or --post-id.
 * Front Matter (from 2026-09-17; focus_keyword retired 2026-09-20):
 *   - seo (title/keywords/meta_description): only a fallback source for the body meta;
 *     the actual seo fields written to WP are derived by buildSeoGeoMeta from the body
 *     + kept from the live values; (the primary keyword focus_keyword follows the article
 *     plan table, not in the seo object)
 *   - featured_image (canonical URL): synced as the WP featured image (own-host URLs are
 *     looked up by media ID; external links are downloaded and uploaded).
 * The body's "summary / key takeaways / FAQ / data sources" follow md and reverse-parse
 * to override geo on publish.
 *
 * C-batch refactor: rewritten from the Python bypass script (Python dependency removed;
 * the original wordpress-update-article.py is deleted).
 *   - Markdown → HTML: python-markdown → marked, consistent with the main chain (see content/md.js)
 *   - HTTP / auth / upload: uses the tengence-geo-sdk wp domain (including wp/media multipart upload)
 *   - image download: uses content/http download
 * CLI usage and args stay byte-compatible.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const t = require('@tengence/geo-sdk');

const { parseFrontMatter, extractTitle, extractImageUrls, buildPostHtml, isExternalUrl } = t.content.md;
const { download } = t.content.http;
const { uploadMedia } = t.wp.media;

const DEFAULT_SITE = t.site.DEFAULT_SITE;

function usage() {
  console.log(`Usage: tengence-geo publish-update-article.js <markdown_file> [options]
       tengence-geo publish-update-article.js --meta-only --meta-title <title> [--meta-desc <desc>] --slug <slug>

Options:
  --slug=<slug>          target article slug (either --slug or --post-id)
  --post-id=<id>         target article ID directly
  --status=draft|publish publish status (default publish)
  --dry-run              convert only, no update (HTML written to /tmp/converted-article.html)
  --no-upload            skip image upload
  --site <key>           site key (default ${DEFAULT_SITE})
  --meta-only            update ONLY SEO meta / title (DB seo JSON + WP meta + post title
                         via the plugin API); requires --slug or --post-id plus at least one of
                         --meta-title / --meta-desc / --post-title; body/status untouched
  --meta-title=<text>    the new SEO title (written to DB seo.title + WP seo_meta_title)
  --meta-desc=<text>     the new meta_description value (165-175 chars, hard gate)
  --post-title=<text>    the new WordPress post title itself (written to DB title + WP post_title,
                         also used as the fallback when no meta-title is given)`);
  process.exit(1);
}

function parseArgs(argv) {
  const { positionals, flags } = t.cli.args.parse(
    {
      slug: { type: 'string' },
      'post-id': { type: 'string', default: null },
      status: { type: 'string', default: 'publish' },
      'dry-run': { type: 'boolean' },
      'no-upload': { type: 'boolean' },
      'meta-only': { type: 'boolean' },
      'meta-title': { type: 'string' },
      'meta-desc': { type: 'string' },
      'post-title': { type: 'string' },
      site: { type: 'string', default: DEFAULT_SITE },
    },
    argv
  );

  if (positionals.length !== 1 && !flags['meta-only']) usage();
  const options = {
    slug: flags.slug,
    postId: flags['post-id'],
    status: flags.status,
    dryRun: flags['dry-run'],
    noUpload: flags['no-upload'],
    metaOnly: Boolean(flags['meta-only']),
    metaTitle: flags['meta-title'] || '',
    metaDesc: flags['meta-desc'] || '',
    postTitle: flags['post-title'] || '',
    site: flags.site,
    markdownFile: positionals.length ? path.resolve(positionals[0]) : null,
  };

  if (options.status !== 'draft' && options.status !== 'publish') {
    console.error(`Error: --status must be draft or publish (got ${options.status})`);
    process.exit(1);
  }
  if (options.postId !== null && Number.isNaN(Number(options.postId))) {
    console.error(`Error: --post-id must be a number (got ${options.postId})`);
    process.exit(1);
  }

  return options;
}

/** Convert a full WordPress URL to a relative path */
function getRelativeUrl(fullUrl) {
  try {
    return new URL(fullUrl).pathname;
  } catch (e) {
    return fullUrl;
  }
}

/**
 * Fetch this article's GEO config (key_takeaways / qa_pairs / citations) for body
 * materialization and reverse parsing.
 *
 * Why needed (2026-09-16 incident): this script originally wrote `markdownToHtml(markdownContent)`
 * directly, but the "key takeaways / FAQ" blocks only lived in GEO meta and were materialized
 * into the body on publish ⇒ updating the body with this script wiped both blocks entirely,
 * while the page still returned 200 — a silent failure.
 *
 * Lookup order (same source as the main chain; syncGeoFromMarkdown then overrides
 * same-named blocks from the body, including data sources → citations):
 *   ① `<stem>.meta.json` in the same dir — legacy compatibility (retired after migration);
 *   ② DB `tengence_geo_article_config`'s `config_keywords.geo` (needs --slug) — the
 *      runtime source of truth.
 * When neither is found, warn explicitly instead of silently sending a body missing blocks.
 */
async function loadGeoConfig(mdFile, slug) {
  const metaPath = mdFile.replace(/\.md$/, '.meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta && meta.geo) {
        console.log(`✓ GEO config source: ${path.basename(metaPath)} (body reverse-parse will override same-named blocks)`);
        return meta.geo;
      }
    } catch (e) {
      console.log(`⚠️ Failed to parse ${path.basename(metaPath)}: ${e.message}`);
    }
  }

  const appId = Number(process.env.APP_ID || 1);
  if (slug) {
    try {
      const geo = await t.db.withConn(async (conn) => {
        const articleId = await t.db.articles.findIdBySlug(conn, slug, appId);
        if (!articleId) return null;
        const config = await t.db.config.getFull(conn, articleId, appId);
        return config && config.geo ? config.geo : null;
      });
      if (geo) {
        console.log(`✓ GEO config source: DB config (slug=${slug}, body reverse-parse will override same-named blocks)`);
        return geo;
      }
    } catch (e) {
      console.log(`⚠️ Failed to read DB GEO config: ${e.message}`);
    }
  }

  console.log('⚠️ No GEO config found: this update will not contain the "key takeaways / FAQ" blocks');
  console.log('   add a <slug>.meta.json in the same dir, or use --slug to read from the DB');
  return {};
}

/**
 * Set the WP featured image from the front-matter featured_image.
 * Own-host URLs: look up the media ID (t.images.resolveWpMediaIdByUrl); skip when not
 * found (keep the live image); external URLs: download → uploadMedia → set featured_media.
 */
async function applyFeaturedImage(postId, featuredImageUrl) {
  let mediaId = 0;
  if (isExternalUrl(featuredImageUrl)) {
    const destPath = path.join(os.tmpdir(), 'wp-featured-' + Date.now() + '.jpg');
    try {
      console.log(`  Downloading featured image: ${featuredImageUrl.substring(0, 60)}...`);
      await download(featuredImageUrl, destPath, { timeout: 60000 });
      const result = await uploadMedia(destPath, { alt: 'featured' });
      mediaId = result.id;
      fs.unlinkSync(destPath, () => {});
    } catch (e) {
      console.log(`  ⚠️ Featured image download/upload failed, keeping the live image: ${e.message}`);
      return;
    }
  } else {
    mediaId = await t.images.resolveWpMediaIdByUrl(featuredImageUrl);
    if (!mediaId) {
      console.log(`  ⚠️ featured_image not found in the media library (${featuredImageUrl.substring(0, 60)}...), keeping the live image`);
      return;
    }
  }
  await t.wp.posts.update(postId, { featured_media: mediaId });
  console.log(`  ✓ Featured image updated (media ID ${mediaId})`);
}

function line() {
  console.log('-'.repeat(70));
}

/**
 * Meta-only mode: update ONLY SEO meta (title and/or description) of an existing article.
 *   - DB: read the row by slug (app_id from APP_ID), replace seo.title / seo.meta_description
 *     inside the existing seo JSON, write back via db.articles.saveContent with
 *     { seo } only → body/title/status/excerpt untouched (saveContent merges fields).
 *   - WP: locate the post via the DB row's wp_post_id (fallback: wp.posts.findBySlug),
 *     then wp.posts.saveMeta(postId, { seo_meta_title?, seo_meta_description? }) through
 *     the plugin API — only the provided meta keys change, body/title/status stay live.
 *   - Hard gates: meta_title non-empty (≤200 chars per plugin schema);
 *     meta_description must be 165–175 characters when provided.
 */
async function metaOnlyUpdate(options) {
  const appId = Number(process.env.APP_ID || 1);
  const desc = String(options.metaDesc || '').trim();
  const title = String(options.metaTitle || '').trim();
  const postTitle = String(options.postTitle || '').trim();

  if (!options.slug && !options.postId) {
    console.error('Error: meta-only mode requires --slug (or --post-id)');
    process.exit(1);
  }
  if (!desc && !title && !postTitle) {
    console.error('Error: meta-only mode requires --meta-title, --meta-desc and/or --post-title');
    process.exit(1);
  }
  if (desc && (desc.length < 165 || desc.length > 175)) {
    console.error(`Error: meta_description must be 165–175 characters (got ${desc.length})`);
    process.exit(1);
  }
  if (title.length > 200) {
    console.error(`Error: meta_title must be ≤200 characters (got ${title.length})`);
    process.exit(1);
  }
  if (postTitle.length > 200) {
    console.error(`Error: post_title must be ≤200 characters (got ${postTitle.length})`);
    process.exit(1);
  }

  console.log('='.repeat(70));
  console.log('Article meta-only update (SEO title / description)');
  console.log('='.repeat(70));
  console.log(`  slug: ${options.slug || '(by post-id)'}`);
  if (title) console.log(`  meta-title len: ${title.length}`);
  if (desc) console.log(`  desc len: ${desc.length}`);
  if (postTitle) console.log(`  post-title len: ${postTitle.length}`);

  if (options.dryRun) {
    console.log('\n[ Dry Run mode - skipping update ]');
    if (title) console.log(`  Would write meta_title (${title.length} chars) to DB seo.title + WP seo_meta_title`);
    if (desc) console.log(`  Would write meta_description (${desc.length} chars) to DB seo + WP seo_meta_description`);
    if (postTitle) console.log(`  Would write post_title (${postTitle.length} chars) to DB title + WP post_title`);
    return;
  }

  // step 1: locate the DB row and update seo.title / seo.meta_description
  let dbRow = null;
  let dbAffected = 0;
  await t.db.withConn(async (conn) => {
    const [rows] = await conn.query(
      'SELECT id, seo, wp_post_id FROM tengence_geo_articles WHERE app_id = ? AND slug = ? LIMIT 1',
      [appId, options.slug]
    );
    if (!rows.length) throw new Error(`Article not found in the DB: slug=${options.slug} app_id=${appId}`);
    dbRow = rows[0];
    const seo = JSON.parse(dbRow.seo || '{}');
    if (title) seo.title = title;
    if (desc) seo.meta_description = desc;
    const saveFields = { seo: JSON.stringify(seo) };
    if (postTitle) saveFields.title = postTitle;
    dbAffected = await t.db.articles.saveContent(conn, dbRow.id, appId, saveFields);
  });
  console.log(`  ✓ DB seo/title updated (affected rows: ${dbAffected}); body/status untouched`);

  // step 2: update WP meta only
  let postId = options.postId ? Number(options.postId) : (dbRow.wp_post_id || null);
  if (!postId && options.slug) {
    const p = await t.wp.posts.findBySlug(options.slug);
    if (p) postId = p.id;
  }
  if (!postId) {
    console.error('✗ No WP post id found (DB wp_post_id empty and findBySlug failed); DB already updated');
    process.exit(1);
  }

  const metaPatch = {};
  if (title) metaPatch.seo_meta_title = title;
  if (desc) metaPatch.seo_meta_description = desc;
  if (Object.keys(metaPatch).length) {
    const saved = await t.wp.posts.saveMeta(postId, metaPatch);
    console.log(`  ✓ WP meta written via plugin API (post ${postId})`);
    if (saved && typeof saved === 'object') console.log(`    keys written: ${Object.keys(saved).join(', ')}`);
  }
  if (postTitle) {
    await t.wp.posts.update(postId, { title: postTitle });
    console.log(`  ✓ WP post title updated (post ${postId})`);
  }

  // step 3: verify
  const meta = await t.wp.posts.getMeta(postId);
  if (title) {
    const readT = (meta && meta.seo_meta_title) || '';
    console.log(`  ✓ Verify: WP meta title len=${readT.length} ${readT === title ? '(match)' : '(MISMATCH!)'}`);
  }
  if (desc) {
    const readD = (meta && meta.seo_meta_description) || '';
    console.log(`  ✓ Verify: WP meta description len=${readD.length} ${readD === desc ? '(match)' : '(MISMATCH!)'}`);
  }
  if (postTitle) {
    const readPost = await t.wp.posts.get(postId);
    const readPT = (readPost && readPost.title && readPost.title.rendered) || '';
    console.log(`  ✓ Verify: WP post title len=${readPT.length} ${readPT === postTitle ? '(match)' : '(MISMATCH!)'}`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('Meta-only update complete!');
  console.log('='.repeat(70));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const mdFile = options.markdownFile;

  // meta-only mode: no markdown file required
  if (options.metaOnly) {
    await metaOnlyUpdate(options);
    return;
  }

  if (!fs.existsSync(mdFile)) {
    console.error(`Error: file not found - ${mdFile}`);
    process.exit(1);
  }

  console.log('='.repeat(70));
  console.log('WordPress article update');
  console.log('='.repeat(70));

  // step 1: read the Markdown file
  console.log('\n[Step 1] Read Markdown file');
  line();

  const rawContent = fs.readFileSync(mdFile, 'utf8');
  console.log(`✓ File read: ${mdFile}`);
  console.log(`  Raw chars: ${rawContent.length}`);

  // Front Matter (YAML): seo + featured_image come from here; the body uses the stripped content
  const { data: frontMatter, content: markdownContent } = parseFrontMatter(rawContent);
  console.log(`  Body chars: ${markdownContent.length}`);
  if (frontMatter && frontMatter.seo && Object.keys(frontMatter.seo).length) {
    console.log(`  ✓ front-matter seo read (${Object.keys(frontMatter.seo).length} fields)`);
  }
  if (frontMatter && frontMatter.featured_image) {
    console.log(`  ✓ front-matter featured_image: ${String(frontMatter.featured_image).substring(0, 60)}...`);
  }

  // Title comes from the body's first H1; slug from --slug
  const title = extractTitle(markdownContent) || path.basename(mdFile, path.extname(mdFile));
  const slug = options.slug || '';

  console.log(`  Title: ${title}`);
  console.log(`  Slug: ${slug || '(not set; located in step 6 via --slug or --post-id)'}`);

  // step 2: extract image URLs
  console.log('\n[Step 2] Extract image URLs');
  line();

  const imageUrls = extractImageUrls(markdownContent);
  console.log(`✓ Found ${imageUrls.length} Unsplash images`);

  const uploadedImages = [];

  // step 3: upload images (if any and not skipped)
  if (imageUrls.length && !options.noUpload) {
    console.log('\n[Step 3] Upload images to WordPress');
    line();

    const tempDir = path.join(os.tmpdir(), 'wp-images');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    for (let i = 0; i < imageUrls.length; i++) {
      const img = imageUrls[i];
      const destPath = path.join(tempDir, `image${i + 1}.jpg`);
      try {
        console.log(`  Downloading: ${img.originalUrl.substring(0, 60)}...`);
        await download(img.originalUrl, destPath, { timeout: 60000 });
        console.log(`  ✓ Saved to: ${destPath}`);

        const result = await uploadMedia(destPath, { alt: img.alt });
        const mediaUrl = result.source_url || (result.guid && result.guid.rendered);
        const relativeUrl = getRelativeUrl(mediaUrl);
        console.log(`  ✓ Upload succeeded! ID: ${result.id}`);
        console.log(`  ✓ Relative path: ${relativeUrl}`);

        uploadedImages.push({ id: result.id, url: relativeUrl, alt: img.alt });
      } catch (e) {
        console.log(`  ✗ Failed to process image: ${e.message}`);
        uploadedImages.push(null);
      }
    }

    console.log(`\n✓ Uploaded ${uploadedImages.filter(Boolean).length} / ${imageUrls.length} images`);
  }

  // step 4: replace image URLs
  if (uploadedImages.length && uploadedImages.some(Boolean)) {
    console.log('\n[Step 4] Replace image URLs');
    line();

    for (let i = 0; i < imageUrls.length; i++) {
      const info = imageUrls[i];
      if (i < uploadedImages.length && uploadedImages[i]) {
        const wpInfo = uploadedImages[i];
        const oldUrl = info.originalUrl;
        // matches the Python version: replace every occurrence (String.replace only
        // replaces the first, hence split/join)
        markdownContent = markdownContent.split(oldUrl).join(wpInfo.url);
        console.log(`  ✓ Replaced: ${oldUrl.substring(0, 50)}... → ${wpInfo.url}`);
      }
    }
  }

  // step 5: convert Markdown to HTML (via the single entry, including GEO block materialization)
  console.log('\n[Step 5] Convert Markdown to HTML (including GEO block materialization)');
  line();

  const loadedGeo = await loadGeoConfig(mdFile, slug);
  // seo: front matter wins, meta.json as compatibility fallback (retired after migration)
  const fmSeo = (frontMatter && frontMatter.seo && typeof frontMatter.seo === 'object')
    ? frontMatter.seo
    : {};
  let metaJsonSeo = {};
  const seoMetaPath = mdFile.replace(/\.md$/, '.meta.json');
  if (fs.existsSync(seoMetaPath)) {
    try { metaJsonSeo = (JSON.parse(fs.readFileSync(seoMetaPath, 'utf8')).seo) || {}; } catch (e) { metaJsonSeo = {}; }
  }
  const seoConfig = Object.keys(fmSeo).length ? fmSeo : metaJsonSeo;
  // md is authoritative: blocks written in the body ("summary / key takeaways / FAQ /
  // data sources → citations") override the same-named meta fields
  const synced = t.content.md.syncGeoFromMarkdown(markdownContent, loadedGeo);
  const geo = synced.geo;
  if (synced.changed.length) {
    console.log(`✓ GEO follows Markdown: ${synced.changed.join(' / ')}`);
  }
  const htmlContent = buildPostHtml(markdownContent, geo);
  console.log(`✓ Converted, HTML length: ${htmlContent.length}`);
  // ⚠️ The block titles are literal Chinese content markers ("key takeaways" / "FAQ"):
  // they are produced by buildPostHtml from Chinese-markdown blocks, so the check
  // strings must stay Chinese to match the materialized HTML.
  console.log(
    `  Body has takeaways block: ${htmlContent.includes('<h2>关键要点</h2>')}` +
    ` / has FAQ block: ${htmlContent.includes('常见问题</h2>')}`
  );

  if (options.dryRun) {
    console.log('\n[ Dry Run mode - skipping update ]');
    const outputFile = path.join('/tmp', 'converted-article.html');
    fs.writeFileSync(outputFile, htmlContent, 'utf8');
    console.log(`HTML saved to: ${outputFile}`);
    return;
  }

  // step 6: locate the article
  console.log('\n[Step 6] Locate the article');
  line();

  let postId = options.postId ? Number(options.postId) : null;
  if (postId) {
    console.log(`Using the given article ID: ${postId}`);
  } else if (slug) {
    const existingPost = await t.wp.posts.findBySlug(slug);
    if (existingPost) {
      postId = existingPost.id;
      console.log(`✓ Article found: ${slug} (ID: ${postId})`);
    } else {
      console.log(`✗ Article not found: ${slug}`);
      console.log('  use --post-id to specify the article ID');
      process.exit(1);
    }
  } else {
    console.log('✗ Specify either --slug or --post-id');
    process.exit(1);
  }

  // step 7: update the article
  console.log('\n[Step 7] Update article');
  line();

  console.log(`  Updating article ID: ${postId}`);
  console.log(`  Title: ${title}`);
  console.log(`  Status: ${options.status}`);

  // GEO fields are synced into WP meta (the head FAQPage JSON-LD / plugin / mobile app
  // take their data from here), same source as the body, so the visible FAQ and the
  // schema FAQ never diverge. Live values are read via the plugin API (no prefixes,
  // arrays/objects already decoded); writes also go through the plugin API.
  let geoMeta = {};
  try {
    const existingMeta = await t.wp.posts.getMeta(postId);
    geoMeta = t.content.meta.buildSeoGeoMeta(
      { title, content: markdownContent },
      { geo, seo: seoConfig },
      existingMeta
    );
  } catch (e) {
    console.log(`  ⚠️ Failed to read live meta, skipping GEO field sync: ${e.message}`);
  }

  let result;
  try {
    result = await t.wp.posts.update(postId, {
      title,
      content: htmlContent,
      status: options.status,
    });
    console.log('  ✓ Article updated!');
  } catch (e) {
    console.log(`  ✗ Update failed: ${e.message}`);
    process.exit(1);
  }

  // meta is written separately via the plugin API (skipped when empty; keeping live
  // values is handled inside buildSeoGeoMeta)
  if (Object.keys(geoMeta).length) {
    try {
      const saved = await t.wp.posts.saveMeta(postId, geoMeta);
      console.log(`  ✓ SEO/GEO meta written via plugin API (${Object.keys(saved).length} fields)`);
    } catch (e) {
      console.log(`  ✗ SEO/GEO meta write failed: ${e.message}`);
    }
  }

  // featured image: front-matter featured_image (canonical URL) → featured_media
  if (frontMatter && frontMatter.featured_image) {
    console.log('\n[Step 7.5] Sync featured image (front-matter featured_image)');
    line();
    await applyFeaturedImage(postId, String(frontMatter.featured_image).trim());
  }

  // step 8: verify
  console.log('\n[Step 8] Verify');
  line();

  const verified = await t.wp.posts.get(postId);
  if (verified) {
    console.log('✓ Verification passed');
    console.log(`\n${'='.repeat(70)}`);
    console.log('Article update complete!');
    console.log('='.repeat(70));
    console.log(`\nArticle ID: ${verified.id}`);
    console.log(`Link: ${verified.link}`);
  } else {
    console.log('✗ Verification failed');
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('\n✗ Update failed:', error.message);
    if (process.env.DEBUG) console.error(error.stack);
    process.exit(1);
  });
}

module.exports = { main };
