/**
 * Publish domain (tengence-geo-sdk/publish)
 * ============================================================================
 * Sunk down from commands/publish-from-db.js on 2026-09-20: **step order, judgment
 * thresholds and log copy all preserved verbatim**. The CLI
 * (packages/geo-cli/bin/publish-from-db.js) is now just "parse args → open a
 * connection → call publishArticle → print a summary".
 *
 * Responsibility: the full orchestration of publishing a DB article to WordPress
 * (8 steps + 3 inclusion-submission hooks):
 *   0    slug duplicate check (idempotence gate)
 *   1    read the article from the DB
 *   1.5  slug conflict check (inside the DB)
 *   2    read config; category/tags per the article plan table (config fallback when
 *        no plan row)
 *   3    image processing (dedupe detection / download / upload / first-image
 *        promotion / front-matter featured_image)
 *   3.5  GEO blocks written back to the DB with Markdown authoritative
 *   4    → HTML (the single buildPostHtml exit)
 *   5    fetch category and tag IDs (canonical allow-list)
 *   6    find/create the WP article (--force updates)
 *   7    publish/update (postData + SEO/GEO meta via the plugin API)
 *   8    write back to the DB (wp_post_id / featured image / plan status)
 *   9-11 post-publish inclusion submissions (GSC sitemap / IndexNow / Baidu normal
 *        inclusion; all soft-fail)
 *
 * Conventions:
 *   - Lazy state: requiring this file has zero side effects; loadSite + config load
 *     happen on the first publishArticle call (SDK-wide convention).
 *   - Repositories don't open connections: publishArticle receives the caller's conn
 *     (either t.db.withConn or createConnection).
 *   - Logging: progress goes through the internal logger (default console.log,
 *     injectable via publishArticle options.log or setLogger); errors/warnings keep
 *     console.error/warn (stderr).
 *   - No exit: input validation like missing credentials is the caller's (CLI) job.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

/** Max tags per article (was taxonomy.yaml rules.max_tags_per_article; now a constant) */
const MAX_TAGS_PER_ARTICLE = 3;

/** Module-level lazy state (require has zero side effects; initialized on first business call) */
let state = null;

/**
 * Initialize and cache publish-domain state: site config (.env injected) / WP
 * endpoints / log paths. Idempotent: repeated calls return the same instance.
 */
function getState() {
  if (state) return state;
  const t = require('../index');
  const SITE = t.site.loadSite();
  const WP_URL = process.env.WP_URL || '';
  const WP_API_URL = process.env.WP_API_URL || `${WP_URL}/wp-json`;
  const SITE_DOMAIN =
    process.env.SITE_DOMAIN ||
    (SITE.site && SITE.site.site && SITE.site.site.domain) ||
    '';
  const SITE_ORIGIN = SITE_DOMAIN ? `https://www.${SITE_DOMAIN}` : '';
  const CONFIG = {
    // WordPress config (endpoints and credentials all from the site .env)
    wp: {
      url: WP_URL,
      apiUrl: `${WP_API_URL.replace(/\/$/, '')}/wp/v2`,
      username: process.env.WP_USERNAME,
      password: process.env.WP_PASSWORD,
    },
    // URL-prefix config (derived from the site domain, not hard-coded)
    urls: {
      article: `${SITE_ORIGIN}/blog/article/`,
      image: `${SITE_ORIGIN}/blog/static/images`,
    },
    app_id: parseInt(process.env.APP_ID || '1'),
    // category mapping (single source of truth: the DB categories table; filled by
    // loadTaxonomyWhitelist)
    categories: {},
    // temp directory
    tempDir: path.join('/tmp', 'wp-images'),
  };
  // site-level runtime data dir (was the repo-root data/; with the open-sourcing it
  // follows the site for multi-site isolation)
  const GSC_DATA_DIR = path.join(SITE.siteDir, 'data');
  const GSC_LOG_PATH = path.join(GSC_DATA_DIR, 'submit-log.jsonl');
  state = {
    t,
    SITE,
    SITE_DOMAIN,
    SITE_ORIGIN,
    CONFIG,
    GSC_DATA_DIR,
    GSC_LOG_PATH,
    WHITELIST: null,
    logger: (...a) => console.log(...a),
  };
  return state;
}

/** Replace the progress-log sink (default console.log; tests / future frameworks can inject) */
function setLogger(fn) {
  getState().logger = fn;
}

/** Append one GSC/IndexNow/Baidu submission log (never throws; warns only) */
function appendGscLog(entry) {
  const s = getState();
  try {
    fs.mkdirSync(s.GSC_DATA_DIR, { recursive: true });
    fs.appendFileSync(
      s.GSC_LOG_PATH,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'
    );
  } catch (e) {
    console.warn(`  ⚠️ Failed to write the GSC submission log (does not affect publishing): ${e.message}`);
  }
}

// ==================== category/tag allow-list (DB categories / tags tables) ====================

/** Load the allow-list from the DB categories / tags tables (slug ↔ display name ↔ description) */
async function loadTaxonomyWhitelist() {
  const s = getState();
  const cats = await s.t.plan.categoryWhitelist();
  const tags = await s.t.plan.tagWhitelist();
  s.CONFIG.categories = Object.fromEntries(cats.map((c) => [c.slug, c.name]));
  s.WHITELIST = {
    categories: Object.fromEntries(cats.map((c) => [c.slug, c])),
    tagsBySlug: Object.fromEntries(tags.map((t) => [t.slug, t])),
    tagsByName: Object.fromEntries(tags.map((t) => [t.name, t])),
  };
  return s.WHITELIST;
}

// ==================== HTTP requests ====================
// Unified through the SDK t.wp.api (same signature as the original wpAPI(endpoint,
// method, data), so call sites stay unchanged)

function wpAPI(endpoint, method = 'GET', data = null) {
  return getState().t.wp.api(endpoint, { method, body: data });
}

// ==================== image processing ====================

/**
 * Convert a WordPress-returned URL into the production URL
 * Supports two inputs: a URL string or a wp_media_id
 */
function convertToProductionUrl(wpUrlOrId) {
  const s = getState();
  // if a numeric ID was passed, build the URL
  if (typeof wpUrlOrId === 'number') {
    // build the production URL from the ID (the WordPress media library stores by
    // date); simplified here — a DB lookup may be needed for the real path
    return `${s.CONFIG.urls.image}/wp-${wpUrlOrId}.jpg`;
  }

  // WordPress returns: <WP_URL>/wp-content/uploads/2026/06/image.jpg
  // convert to: <SITE_ORIGIN>/blog/static/images/2026/06/image.jpg
  const uploadsBase = `${s.CONFIG.wp.url.replace(/\/$/, '')}/wp-content/uploads/`;
  return wpUrlOrId
    .replace(uploadsBase, s.CONFIG.urls.image + '/')
    .replace(uploadsBase.replace(/^http:\/\//, 'https://'), s.CONFIG.urls.image + '/');
}

/**
 * Fetch the real media URL by WP media ID and convert it to the production URL
 * (falls back to a guessed path on failure).
 */
async function resolveMediaProductionUrl(wpMediaId) {
  const s = getState();
  if (!wpMediaId) {
    return `${s.CONFIG.urls.image}/wp-${wpMediaId}.jpg`;
  }
  try {
    const mediaInfo = await wpAPI(`/media/${wpMediaId}`);
    const wpUrl = mediaInfo.source_url || mediaInfo.guid?.rendered || mediaInfo.url;
    return convertToProductionUrl(wpUrl);
  } catch (e) {
    console.error(`    ⚠️ Failed to fetch the media URL: ${e.message}`);
    return `${s.CONFIG.urls.image}/wp-${wpMediaId}.jpg`;
  }
}

/**
 * Read the article's existing featured image from the DB (used when the article has
 * no Unsplash image, keeping the existing featured image)
 */
async function getExistingFeaturedImage(articleId) {
  const s = getState();
  return s.t.db.withConn(
    async (connection) => {
      const [rows] = await connection.query(
        `SELECT i.wp_media_id
         FROM ${s.t.db.TABLES.articleImages} ai
         JOIN ${s.t.db.TABLES.images} i ON ai.image_id = i.id
         WHERE ai.article_id = ? AND ai.app_id = ? AND ai.position = 'featured'
         LIMIT 1`,
        [articleId, s.CONFIG.app_id]
      );
      if (rows.length === 0 || !rows[0].wp_media_id) {
        return null;
      }
      const wpMediaId = rows[0].wp_media_id;
      return {
        id: wpMediaId,
        productionUrl: await resolveMediaProductionUrl(wpMediaId),
      };
    },
    { connectTimeout: 60000 }
  );
}

/**
 * Whether an image URL is external (not the site's own media).
 */
function isExternalImageUrl(url) {
  const s = getState();
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !(host === s.SITE_DOMAIN || host.endsWith(`.${s.SITE_DOMAIN}`));
  } catch (e) {
    return true; // unparseable counts as external; route to download-migrate
  }
}

/**
 * Resolve the WP media ID for an already-owned (site-domain) image URL.
 * Implementation converged into the SDK t.images.resolveWpMediaIdByUrl (DB lookup +
 * WP /media fallback).
 */
async function resolveWPMediaId(prodUrl) {
  return getState().t.images.resolveWpMediaIdByUrl(prodUrl);
}

/**
 * Resolve the front-matter featured_image (canonical URL) into a featured-image
 * object { id, productionUrl }.
 * Owned URLs: look up the media ID by URL (id=0 when not found, keeping the URL for
 * display, consistent with the "first image owned-URL" behavior);
 * external links: download → ingest (position=featured) → media ID (no download on dry-run).
 */
async function resolveFeaturedFromUrl(url, articleId, dryRun = false) {
  const s = getState();
  if (isExternalImageUrl(url)) {
    if (dryRun) return { id: 0, productionUrl: url };
    const localPath = path.join(s.CONFIG.tempDir, `featured-${Date.now()}.jpg`);
    await s.t.util.retry(
      () => s.t.content.http.download(url, localPath, { timeout: 30000 }),
      { retries: 3, delay: 2000 }
    );
    const r = await s.t.util.retry(
      () => s.t.images.ingestExternalImage(localPath, {
        originalUrl: url,
        alt: 'featured',
        articleId,
        position: 'featured',
        order: 0,
      }),
      { retries: 3, delay: 2000 }
    );
    fs.unlinkSync(localPath, () => {});
    return {
      id: r.wpMediaId,
      productionUrl: r.wpUrl
        ? convertToProductionUrl(r.wpUrl)
        : await resolveMediaProductionUrl(r.wpMediaId),
    };
  }
  const wpMediaId = await resolveWPMediaId(url);
  return { id: wpMediaId, productionUrl: url };
}

/**
 * Process all images in an article (with dedupe detection)
 * @param {string} content
 * @param {number} articleId
 * @param {boolean} [dryRun]
 * @param {string|null} [featuredImageUrl] front-matter featured_image (canonical URL):
 *   when present it is the featured-image source, and body images are all kept (no
 *   first-image promotion)
 */
async function processImages(content, articleId, dryRun = false, featuredImageUrl = null) {
  const s = getState();
  const t = s.t;
  const { extractImageUrls, extractFirstImage, removeFirstImage, removeImageByUrl } = t.content.md;
  const {
    getImageByUrl,
    getImageByCleanUrl,
    ingestExternalImage,
    incrementImageUsage,
    saveArticleImage,
  } = t.images;
  const { retry } = t.util;

  const urls = extractImageUrls(content);
  const firstBodyImg = extractFirstImage(content);
  if (urls.length === 0) {
    // featured image from front matter (canonical URL): body images all kept, no
    // first-image promotion
    if (featuredImageUrl) {
      const featuredImage = await resolveFeaturedFromUrl(featuredImageUrl, articleId, dryRun);
      s.logger(`  Featured image from front matter: ${featuredImageUrl.substring(0, 60)}...`);
      return { content, uploadedImages: [], featuredImage };
    }
    // no Unsplash external links in the body: if the first image is an owned URL,
    // set it as the featured image and remove it from the body
    if (firstBodyImg && !isExternalImageUrl(firstBodyImg.url)) {
      const wpMediaId = await resolveWPMediaId(firstBodyImg.url);
      const updated = removeFirstImage(content, firstBodyImg);
      s.logger(`  First body image is an owned URL; set as featured image (media ID ${wpMediaId}) and removed from the body`);
      return { content: updated, uploadedImages: [], featuredImage: { id: wpMediaId, productionUrl: firstBodyImg.url } };
    }
    // no body image, or first image external without an Unsplash marker: keep the
    // DB's existing featured image so it's never overwritten/lost
    const featuredImage = await getExistingFeaturedImage(articleId);
    return { content, uploadedImages: [], featuredImage };
  }

  s.logger(`  Found ${urls.length} images, starting dedupe detection...`);

  // dry-run only detects and previews: no download, no upload, no DB writes, no vectors
  if (dryRun) {
    const first = extractFirstImage(content);
    for (let i = 0; i < urls.length; i++) {
      const img = urls[i];
      const existing = await getImageByUrl(img.originalUrl) || await getImageByCleanUrl(img.originalUrl);
      if (existing && existing.wp_media_id) {
        s.logger(`  [${i + 1}/${urls.length}] will reuse the existing image (media ID ${existing.wp_media_id})`);
      } else {
        s.logger(`  [${i + 1}/${urls.length}] will download and upload: ${img.originalUrl.substring(0, 60)}...`);
      }
    }
    if (featuredImageUrl) {
      s.logger(`  [featured] will come from front matter: ${featuredImageUrl.substring(0, 60)}...`);
    } else if (first) {
      s.logger(`  [first image] will become the featured image${isExternalImageUrl(first.url) ? ' (external→download/upload)' : ' (owned URL)'}: ${first.url.substring(0, 60)}...`);
    } else {
      s.logger('  [first image] no body image; no featured image will be set');
    }
    s.logger('  [Dry Run] skipping image download/upload/ingest/dedupe writes');
    const featuredImage = featuredImageUrl
      ? { id: 0, productionUrl: featuredImageUrl }
      : (first ? { id: 0, productionUrl: first.url } : await getExistingFeaturedImage(articleId));
    return { content, uploadedImages: [], featuredImage };
  }

  // make sure the temp dir exists
  if (!fs.existsSync(s.CONFIG.tempDir)) {
    fs.mkdirSync(s.CONFIG.tempDir, { recursive: true });
  }

  const uploadedImages = [];
  const failedImages = []; // images that failed processing and keep their external links
  let updatedContent = content;
  const contentImageUrls = []; // body image URLs, for featured-image dedupe
  let firstMigrated = null;    // first-image migration result (to become the featured image)

  for (let i = 0; i < urls.length; i++) {
    const img = urls[i];

    try {
      // 1. URL dedupe: exact URL → parameter-stripped URL fast path
      const existing = await getImageByUrl(img.originalUrl) || await getImageByCleanUrl(img.originalUrl);

      let productionUrl;
      let wpMediaId;

      if (existing && existing.wp_media_id) {
        // image already exists and is uploaded to WordPress; reuse directly (real
        // media URL → production URL)
        s.logger(`  [${i + 1}/${urls.length}] ✓ reusing the existing image: ${img.originalUrl.substring(0, 50)}...`);
        wpMediaId = existing.wp_media_id;
        productionUrl = await resolveMediaProductionUrl(wpMediaId);

        // bump the usage count + save the article-image link
        await incrementImageUsage(existing.id);
        await saveArticleImage(articleId, existing.id, 'content', i);

      } else {
        // 2. download the image (pHash is pixel-based, so it must be downloaded
        // first; keeps the 30s timeout and retry)
        const localPath = path.join(s.CONFIG.tempDir, `image${Date.now()}-${i}.jpg`);
        s.logger(`  [${i + 1}/${urls.length}] downloading: ${img.originalUrl.substring(0, 60)}...`);
        await retry(
          () => t.content.http.download(img.originalUrl, localPath, { timeout: 30000 }),
          { retries: 3, delay: 2000 }
        );

        // 3. ingest (pHash dedupe / upload / register, unified into the SDK
        // t.images.ingestExternalImage, shared with image-acquire's acquire,
        // eliminating duplicated implementations)
        const r = await retry(
          () => ingestExternalImage(localPath, {
            originalUrl: img.originalUrl,
            alt: img.alt,
            articleId,
            position: 'content',
            order: i,
          }),
          { retries: 3, delay: 2000 }
        );
        wpMediaId = r.wpMediaId;
        productionUrl = r.wpUrl
          ? convertToProductionUrl(r.wpUrl)
          : await resolveMediaProductionUrl(r.wpMediaId);

        // clean up the temp file
        fs.unlinkSync(localPath, () => {});
      }

      // first image: set as featured image and remove from the body (avoid
      // duplicating the featured image); the rest: rewrite the URL and keep in body.
      // When a front-matter featured_image exists, the first body image is neither
      // promoted nor removed (the featured image has another source).
      if (firstBodyImg && !featuredImageUrl && img.originalUrl === firstBodyImg.url) {
        firstMigrated = { wpMediaId, productionUrl };
        // ⚠️ Must delete the **whole** <img …> tag. Previously `<img src="${url}"`
        // (up to the src closing quote) was replaced with an empty string, leaving
        // ` alt="…">` behind; after markdown escaping the body showed visible
        // mojibake `<p> alt=&quot;…&quot;&gt;</p>` (proven by WP 289/294/299,
        // fixed 2026-09-16).
        updatedContent = removeImageByUrl(updatedContent, {
          url: img.originalUrl,
          alt: img.alt,
          format: img.format,
        });
      } else if (img.format === 'html') {
        updatedContent = updatedContent.replace(`<img src="${img.originalUrl}"`, `<img src="${productionUrl}"`);
      } else {
        updatedContent = updatedContent.replace(`![${img.alt}](${img.originalUrl})`, `![${img.alt}](${productionUrl})`);
      }

      uploadedImages.push({
        id: wpMediaId,
        productionUrl: productionUrl,
      });

      // record the body image URL (for featured-image dedupe)
      contentImageUrls.push(img.originalUrl);

    } catch (err) {
      console.error(`  [${i + 1}/${urls.length}] ✗ processing failed: ${err.message}`);
      // degrade: keep the original external link so the image doesn't vanish
      console.error(`    → degraded: original URL kept (not migrated to the media library; handle manually)`);
      console.error(`      ${img.originalUrl}`);
      failedImages.push({ url: img.originalUrl, alt: img.alt, reason: err.message });
    }
  }

  if (failedImages.length > 0) {
    console.warn(`\n  ⚠️ ${failedImages.length} image(s) not migrated to the media library, still external links:`);
    failedImages.forEach((f) => console.warn(`    - ${f.url}  (${f.reason})`));
  }

  // featured image: front-matter featured_image > first body image (migrated/owned)
  // > existing DB value
  let featuredImage = null;
  if (featuredImageUrl) {
    featuredImage = await resolveFeaturedFromUrl(featuredImageUrl, articleId);
    s.logger(`  ✓ Featured image from front matter: ${featuredImage.productionUrl || featuredImage.id}`);
  } else if (firstMigrated) {
    featuredImage = { id: firstMigrated.wpMediaId, productionUrl: firstMigrated.productionUrl };
    s.logger(`  ✓ Featured image = first body image: ${firstMigrated.productionUrl}`);
  } else {
    // first-image migration failed or no body image: keep the DB's existing featured
    // image, never overwrite/lose it
    console.error('  ⚠️ First image not migrated; featured image falls back to the DB value (if any)');
    featuredImage = await getExistingFeaturedImage(articleId);
  }

  return { content: updatedContent, uploadedImages, featuredImage };
}

// ==================== categories and tags ====================

/**
 * Get or create a category
 */
async function getCategory(categorySlug) {
  const s = getState();
  try {
    const categories = await wpAPI('/categories?slug=' + categorySlug);
    if (categories && categories.length > 0) {
      s.logger(`  Category "${categorySlug}" already exists (ID: ${categories[0].id})`);
      return categories[0].id;
    }
  } catch (e) {
    console.warn(`  Category lookup failed: ${e.message}`);
  }

  // create the category
  try {
    const catName = s.CONFIG.categories[categorySlug] || categorySlug;
    s.logger(`  Creating category: ${categorySlug} (${catName})`);

    const newCategory = await wpAPI('/categories', 'POST', {
      name: catName,
      slug: categorySlug,
      description: '',
    });

    s.logger(`  ✓ Category created (ID: ${newCategory.id})`);
    return newCategory.id;
  } catch (e) {
    console.error(`  ✗ Category creation failed: ${e.message}`);
    return null;
  }
}

/**
 * Get or create a tag
 * Only canonical tags defined in the DB tags table are allowed (taxonomy.yaml retired).
 * @param {{slug:string, name:string, description?:string}} tagEntry tag entry
 * Queries and creations use the English slug to avoid same-name tags and paginated
 * lookups missing.
 */
async function getTag(tagEntry) {
  const s = getState();
  const slug = tagEntry.slug;
  if (!slug) {
    throw new Error(`Tag "${tagEntry.name}" is not in the canonical tag allow-list`);
  }

  try {
    const existing = await wpAPI('/tags?slug=' + encodeURIComponent(slug));
    if (existing && existing.length > 0) {
      return existing[0].id;
    }
  } catch (e) {
    console.warn(`  Tag lookup failed: ${e.message}`);
  }

  try {
    s.logger(`  Creating tag: ${tagEntry.name} (slug: ${slug})`);
    const newTag = await wpAPI('/tags', 'POST', {
      name: tagEntry.name,
      slug,
      description: tagEntry.description || '',
    });

    s.logger(`  ✓ Tag created (ID: ${newTag.id})`);
    return newTag.id;
  } catch (e) {
    console.error(`  ✗ Tag creation failed: ${e.message}`);
    return null;
  }
}

// ==================== publishing articles ====================

/**
 * Check whether the slug already exists in the DB
 * @returns {object|null} the duplicate article record, or null when none
 */
function checkSlugExistsInDB(connection, slug, excludeId = null) {
  const s = getState();
  return s.t.db.articles.checkSlugExists(connection, slug, excludeId, s.CONFIG.app_id);
}

/**
 * Smart WordPress article lookup
 * Supports exact and fuzzy matching (handles slugs with numeric suffixes)
 */
async function findPostBySlugSmart(slug) {
  const s = getState();
  try {
    // 1. exact match
    const exact = await s.t.wp.posts.findBySlug(slug);
    if (exact) {
      s.logger(`  ✓ Exact match: WP ID ${exact.id}`);
      return exact;
    }

    // 2. fetch all posts for fuzzy matching
    const posts = await wpAPI('/posts?per_page=100&_fields=id,slug,status');

    // extract the base slug (strip a possible numeric suffix)
    const baseSlug = slug.replace(/-\d+$/, '');

    // find the matching post
    const matched = posts.find((p) => {
      const pSlug = p.slug || '';
      const pBase = pSlug.replace(/-\d+$/, '');

      // exact match
      if (pSlug === slug) return true;

      // base-slug match
      if (pBase === baseSlug && pBase !== '') return true;

      // original-slug match (the other side may carry a suffix)
      if (pBase === slug) return true;

      return false;
    });

    if (matched) {
      s.logger(`  ✓ Fuzzy match: WP ID ${matched.id} (slug: ${matched.slug})`);
      return matched;
    }

    s.logger(`  - No matching article found`);
    return null;
  } catch (e) {
    console.warn(`  Article lookup failed: ${e.message}`);
    return null;
  }
}

/**
 * Find an existing article (kept for backward compatibility)
 */
async function findExistingPost(slug) {
  return await findPostBySlugSmart(slug);
}

/**
 * Publish an article to WordPress
 * @param {import('mysql2').Connection} connection caller-provided connection (repositories don't open one)
 * @param {number} articleId
 * @param {object} [options]
 *   - status        draft|publish (default draft)
 *   - force         force-update when it already exists
 *   - dryRun        validation mode, no real publishing
 *   - skipDuplicateCheck  skip the slug duplicate check (when the caller already ran
 *                         the idempotence gate)
 *   - featuredMedia force a specific WP media ID as the featured image
 *   - skipGsc / skipIndexnow / skipBaidu  skip the corresponding post-publish
 *                                         inclusion submission
 *   - log           override the progress-log sink
 * @returns {Promise<object>} the WP article object; dry-run returns
 *   { dryRun: true, slug, htmlLength }
 */
async function publishArticle(connection, articleId, options = {}) {
  const s = getState();
  if (options.log) s.logger = options.log;
  const { status = 'draft', force = false, dryRun = false, skipDuplicateCheck = false, featuredMedia = null } = options;

  s.logger(`\n========================================`);
  s.logger(`Publishing article ID: ${articleId}`);
  s.logger(`========================================\n`);

  // 0. check slug duplication (legacy behavior: slug not yet read here; the real
  // check is step 1.5)
  if (!skipDuplicateCheck) {
    s.logger('[0/8] Checking slug duplication...');
    await checkSlugExistsInDB(connection, null, articleId);
  }

  // 1. read the article from the DB
  s.logger('[1/8] Reading the article from the DB...');
  const article = await s.t.db.articles.getById(connection, articleId, s.CONFIG.app_id);
  s.logger(`  ✓ Title: ${article.title}`);
  s.logger(`  ✓ Slug: ${article.slug}`);

  // 1.5 check whether the slug is used by another article
  if (!skipDuplicateCheck) {
    const dbDuplicate = await checkSlugExistsInDB(connection, article.slug, article.id);
    if (dbDuplicate) {
      console.error(`\n✗ Slug "${article.slug}" is already used by article ID ${dbDuplicate.id}`);
      console.error(`  Change the current article's slug before publishing`);
      throw new Error(`Duplicate slug: "${article.slug}" is already used by article ID ${dbDuplicate.id}`);
    }
    s.logger(`  ✓ Slug not used by any other article`);
  }

  // 2. fetch the article config; category/tags per the article plan table (config
  // fallback when no plan row, for legacy compatibility)
  s.logger('\n[2/8] Reading the article config...');
  const config = await s.t.db.config.getFull(connection, articleId, s.CONFIG.app_id);
  const planRow = await s.t.plan.getByArticleId(articleId);
  let category;
  let tagEntries; // [{slug, name, description}]
  if (planRow && planRow.category) {
    category = planRow.category;
    tagEntries = (planRow.tags || []).map((slug) => s.WHITELIST.tagsBySlug[slug]).filter(Boolean);
    s.logger('  ℹ️ category/tag source: article plan table');
  } else {
    category = config.category || 'product-solutions';
    tagEntries = (config.tags || []).map((name) => s.WHITELIST.tagsByName[name]).filter(Boolean);
    s.logger('  ℹ️ category/tag source: config (legacy fallback)');
  }
  if (!s.CONFIG.categories[category]) {
    throw new Error(`Category "${category}" is not in the canonical category allow-list`);
  }
  if (tagEntries.length > MAX_TAGS_PER_ARTICLE) {
    throw new Error(`Each article allows at most ${MAX_TAGS_PER_ARTICLE} tags`);
  }
  if (planRow && planRow.category && tagEntries.length !== (planRow.tags || []).length) {
    throw new Error(`Non-canonical tags in the plan table: ${(planRow.tags || []).join(', ')}`);
  }
  if (!planRow && tagEntries.length !== (config.tags || []).length) {
    throw new Error(`Non-canonical tags found: ${(config.tags || []).join(', ')}`);
  }
  s.logger(`  ✓ Category: ${category}`);
  s.logger(`  ✓ Tags: ${tagEntries.map((t) => t.name).join(', ')}`);

  // 3. process images (with dedupe detection); featured_image from front matter
  // (config), takes priority over the first body image
  s.logger('\n[3/8] Processing images (dedupe detection)...');
  const featuredImageUrl = config.featured_image || null;
  const { content: processedContent, uploadedImages, featuredImage: bodyFeatured } = await processImages(article.content, articleId, dryRun, featuredImageUrl);
  let featuredImage = bodyFeatured;
  // an explicitly specified featured image (from the auto image pipeline) wins,
  // skipping the body-image-as-featured path
  if (featuredMedia) {
    const fmId = parseInt(featuredMedia, 10);
    if (!isNaN(fmId)) {
      featuredImage = { id: fmId, productionUrl: null };
      s.logger(`  ✓ Using the specified featured image (media ID ${fmId})`);
    }
  }

  // 3.5 md authoritative: reverse-parse "summary / key takeaways / FAQ" from the
  // body, override geo and write back to the DB
  s.logger('\n[3.5/8] Syncing GEO blocks (Markdown → DB)...');
  const synced = s.t.content.md.syncGeoFromMarkdown(processedContent, config.geo || {});
  const geo = synced.geo;
  if (synced.changed.length) {
    s.logger(`  ✓ Updated per Markdown: ${synced.changed.join(' / ')}`);
    if (dryRun) {
      s.logger('  - Dry Run: skipping the DB write-back');
    } else {
      const raw = await s.t.db.config.getRawFull(connection, articleId, s.CONFIG.app_id);
      if (raw) {
        await s.t.db.config.updateRaw(
          connection,
          raw.id,
          Object.assign({}, raw.config_keywords, { geo })
        );
        s.logger('  ✓ config.geo written back (DB)');
      } else {
        s.logger('  ⚠️ config row not found; skipping the DB write-back (GEO still goes into WP meta)');
      }
    }
  } else {
    s.logger('  ✓ Body and GEO config consistent; no write-back needed');
  }

  // 4. convert to HTML
  s.logger('\n[4/8] Converting Markdown to HTML...');
  // the single exit for writing a body into WP: markdownToHtml + GEO-block fallback
  // completion. The two are bound together in buildPostHtml, so doing it halfway
  // can't drop the "key takeaways / FAQ" blocks.
  const htmlContent = s.t.content.md.buildPostHtml(processedContent, geo);
  s.logger(`  ✓ HTML length: ${htmlContent.length} chars`);
  const geoTakeaways = geo.key_takeaways || [];
  const geoQa = geo.qa_pairs || [];
  s.logger(
    `  ✓ GEO materialized: ${geoTakeaways.length} takeaways / ${geoQa.length} FAQ pairs` +
    ` (body has takeaways block: ${htmlContent.includes('<h2>关键要点</h2>') || htmlContent.includes('<h2>Key Takeaways</h2>')}, ` +
    `has FAQ block: ${htmlContent.includes('常见问题</h2>') || htmlContent.includes('FAQ</h2>') || htmlContent.includes('Frequently Asked Questions</h2>')})`
  );

  if (dryRun) {
    s.logger('\n[Dry Run] skipping the actual publish');
    s.logger('\nHTML preview (first 500 chars):');
    s.logger(htmlContent.substring(0, 500) + '...');
    // return a marker object instead of null so the empty run isn't misreported as a
    // failure by the summary stats
    return { dryRun: true, slug: article.slug, htmlLength: htmlContent.length };
  }

  // 4.1 persist the HTML cache (re-render when md changes; later publishes reuse it,
  // avoiding duplicate rendering)
  try {
    await connection.query(
      'UPDATE tengence_geo_articles SET content_html = ? WHERE id = ?',
      [htmlContent, articleId]
    );
    s.logger(`  ✓ HTML cache persisted (${htmlContent.length} chars)`);
  } catch (e) {
    s.logger(`  ⚠️ HTML cache persist failed (does not affect publishing): ${e.message}`);
  }

  // 5. fetch category and tag IDs
  s.logger('\n[5/8] Fetching category and tag IDs...');
  const categoryId = await getCategory(category);
  const tagIds = [];
  for (const tagEntry of tagEntries) {
    const tagId = await getTag(tagEntry);
    if (tagId) tagIds.push(tagId);
  }
  s.logger(`  ✓ Category ID: ${categoryId}`);
  s.logger(`  ✓ Tag IDs: ${tagIds.join(', ')}`);

  // 6. find or create the article
  s.logger('\n[6/8] Checking whether it exists in WordPress...');
  let existing = await findExistingPost(article.slug);

  // prefer the DB's wp_post_id when present
  if (article.wpPostId) {
    try {
      const wpPost = await s.t.wp.posts.get(article.wpPostId);
      if (wpPost && wpPost.id) {
        s.logger(`  ✓ DB already maps: WP ID ${article.wpPostId}`);
        existing = wpPost;
      }
    } catch (e) {
      s.logger(`  - DB WP ID ${article.wpPostId} does not exist; will create a new article`);
    }
  }

  if (existing && !force) {
    s.logger(`  ⚠️ Article already exists (WP ID: ${existing.id}, Status: ${existing.status})`);
    s.logger(`  Use --force to force an update`);
    return existing;
  }

  // 7. publish or update
  s.logger('\n[7/8] Publishing the article...');

  // featured image: prefer the newly chosen one; when there's no new featured image
  // and the article already exists, keep its existing one so it's never overwritten/lost
  let featuredMediaId = featuredImage ? featuredImage.id : 0;
  if (!featuredImage && existing && existing.featured_media) {
    s.logger(`  Keeping the existing featured image: ${existing.featured_media}`);
    featuredMediaId = existing.featured_media;
  }

  // excerpt (post_excerpt): canonical source is config_keywords.seo.meta_description
  // (the SEO short description); falls back to the DB excerpt column, then to empty
  // (the theme fills in the first 55 words of the body).
  const postExcerpt = s.t.content.meta.deriveExcerpt(config, article.excerpt);

  // SEO/GEO metadata (Tengence plugin keys): goes through the plugin API
  // (tengence/v1/posts/{id}) instead of mixing into the WP postData (the native WP
  // API silently drops unregistered keys).
  let existingMeta = {};
  if (existing && existing.id) {
    try {
      existingMeta = await s.t.wp.posts.getMeta(existing.id);
    } catch (e) {
      s.logger(`  ⚠️ Failed to read live meta (via the plugin API); treated as no existing values: ${e.message}`);
    }
  }
  const geoMeta = s.t.content.meta.buildSeoGeoMeta(article, Object.assign({}, config, { geo }), existingMeta);

  const postData = {
    title: article.title,
    content: htmlContent,
    excerpt: postExcerpt,
    slug: article.slug,
    status: status,
    categories: categoryId ? [categoryId] : [],
    tags: tagIds,
    featured_media: featuredMediaId, // strategy B: standalone featured image
  };

  if (featuredImage) {
    s.logger(`  Featured image: ${featuredImage.productionUrl || `media ID ${featuredImage.id}`}`);
  } else if (uploadedImages.length > 0) {
    s.logger(`  Featured image: ${uploadedImages[0].productionUrl} (fallback)`);
  }

  let result;
  if (existing && force) {
    s.logger(`  Updating article ID: ${existing.id}...`);
    result = await wpAPI(`/posts/${existing.id}`, 'POST', postData);
  } else {
    s.logger(`  Creating a new article...`);
    result = await wpAPI('/posts', 'POST', postData);
  }

  // meta written separately through the plugin API (skipped when empty)
  if (Object.keys(geoMeta).length) {
    try {
      await s.t.wp.posts.saveMeta(result.id, geoMeta);
      s.logger(`  ✓ SEO/GEO meta written via the plugin API (${Object.keys(geoMeta).length} fields)`);
    } catch (e) {
      s.logger(`  ✗ SEO/GEO meta write failed: ${e.message}`);
      s.logger('    (the article body itself is published; re-run publish-update-article.js --slug later to backfill)');
    }
  }

  s.logger(`\n✓ Published successfully!`);
  s.logger(`  Article ID: ${result.id}`);
  s.logger(`  Status: ${result.status}`);
  s.logger(`  Link: ${result.link}`);

  // 8. update the DB
  s.logger('\n[8/8] Updating the DB...');
  await s.t.db.articles.markPublished(connection, articleId, s.CONFIG.app_id, {
    wpPostId: result.id,
    status: result.status,
    excerpt: postExcerpt,
  });
  // 8.1 write back articles.featured_image (post-publish/update, per the actual binding)
  if (featuredImage && featuredImage.productionUrl) {
    await connection.query(
      'UPDATE tengence_geo_articles SET featured_image = ? WHERE id = ?',
      [featuredImage.productionUrl, articleId]
    );
    s.logger(`  ✓ Featured image written back to articles: ${featuredImage.productionUrl}`);
  }
  s.logger(`  ✓ DB updated`);

  // 8.5 write back the article plan table (the single write entry for plan status/URL;
  // idempotent)
  try {
    if (result.status === 'publish') {
      await s.t.plan.markPublished(article.slug, {
        wpPostId: result.id,
        publishedUrl: `${s.CONFIG.urls.article}${article.slug}/`,
      });
      s.logger(`  ✓ Plan table updated: ${article.slug} → published`);
    } else {
      await s.t.plan.markQueued(article.slug, { articleId, wpPostId: result.id });
      s.logger(`  ✓ Plan table updated: ${article.slug} → queued`);
    }
  } catch (e) {
    console.warn(`  ⚠️ Plan write-back failed (does not affect the publish result): ${e.message}`);
  }

  // 9. after a successful publish, submit the Google Search Console sitemap (soft
  // fail: network/permission issues don't block publishing)
  //    Only triggered by a real publish (status=publish); drafts have no live URL.
  if (!options.dryRun && !options.skipGsc && result.status === 'publish') {
    s.logger('\n[9/11] Submitting the Google Search Console sitemap...');
    const gscSitemap =
      process.env.GSC_SITEMAP_URL ||
      `https://www.${s.SITE_DOMAIN || 'tengence.com'}/sitemap_index.xml`;
    try {
      const gscResult = await s.t.search.submitSitemap(s.SITE, gscSitemap);
      s.logger(`  ✓ GSC sitemap submitted (HTTP ${gscResult.httpStatus})`);
      appendGscLog({
        action: 'sitemap',
        input: gscSitemap,
        ok: true,
        detail: gscResult,
        trigger: 'publish-from-db',
      });
    } catch (e) {
      console.warn(`  ⚠️ GSC sitemap submission failed (does not affect the publish result): ${e.message}`);
      appendGscLog({
        action: 'sitemap',
        input: gscSitemap,
        ok: false,
        error: e.message,
        trigger: 'publish-from-db',
      });
    }
  }

  // 10. after a successful publish, submit to IndexNow (Bing etc.; soft fail, doesn't
  // block publishing)
  //     Needs INDEXNOW_KEY in .env; URL uses the final link returned by WP.
  if (!options.dryRun && !options.skipIndexnow && result.status === 'publish' && process.env.INDEXNOW_KEY) {
    s.logger('\n[10/11] Submitting to IndexNow...');
    const inKey = process.env.INDEXNOW_KEY;
    const inHost = process.env.INDEXNOW_HOST || `www.${s.SITE_DOMAIN || 'tengence.com'}`;
    const inKeyLoc = process.env.INDEXNOW_KEY_LOCATION || `https://${inHost}/${inKey}.txt`;
    try {
      const inResult = await s.t.search.indexnow.submitUrls({
        host: inHost,
        key: inKey,
        keyLocation: inKeyLoc,
        urlList: [result.link],
      });
      s.logger(`  ✓ IndexNow accepted (HTTP ${inResult.httpStatus}, ${inResult.count} URLs)`);
      appendGscLog({
        action: 'indexnow',
        input: result.link,
        ok: true,
        detail: inResult,
        trigger: 'publish-from-db',
      });
    } catch (e) {
      console.warn(`  ⚠️ IndexNow submission failed (does not affect the publish result): ${e.message}`);
      appendGscLog({
        action: 'indexnow',
        input: result.link,
        ok: false,
        error: e.message,
        trigger: 'publish-from-db',
      });
    }
  }

  // 11. after a successful publish, submit to the Baidu Search Resource Platform
  // "normal inclusion" (soft fail, doesn't block publishing)
  //     Needs BAIDU_TOKEN in .env; data.zz.baidu.com is directly reachable from CN
  //     networks, no proxy.
  //     2026-09-20: the protocol layer sank into t.search.baidu.submitBatch
  //     (including the site-not-URL-encoded constraint); reused here.
  if (!options.dryRun && !options.skipBaidu && result.status === 'publish' && process.env.BAIDU_TOKEN) {
    s.logger('\n[11/11] Submitting to Baidu normal inclusion...');
    const baiduSite = process.env.BAIDU_SITE || `www.${s.SITE_DOMAIN || 'tengence.com'}`;
    try {
      const bRes = await s.t.search.baidu.submitBatch([result.link], {
        token: process.env.BAIDU_TOKEN,
        site: baiduSite,
      });
      s.logger(`  ✓ Baidu submitted ${bRes.success} URLs (today's remaining quota ${bRes.remain})`);
      appendGscLog({
        action: 'baidu',
        input: result.link,
        ok: true,
        detail: { httpStatus: bRes.httpStatus, success: bRes.success, remain: bRes.remain },
        trigger: 'publish-from-db',
      });
    } catch (e) {
      console.warn(`  ⚠️ Baidu submission failed (does not affect the publish result): ${e.message}`);
      appendGscLog({
        action: 'baidu',
        input: result.link,
        ok: false,
        error: e.message,
        trigger: 'publish-from-db',
      });
    }
  }

  return result;
}

/**
 * Get all draft article IDs
 */
function getDraftArticleIds(connection) {
  const s = getState();
  return s.t.db.articles.findDraftIds(connection, s.CONFIG.app_id);
}

module.exports = {
  getState,
  setLogger,
  MAX_TAGS_PER_ARTICLE,
  loadTaxonomyWhitelist,
  publishArticle,
  getDraftArticleIds,
};
