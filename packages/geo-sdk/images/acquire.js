/**
 * Auto image-acquisition pipeline (five-step orchestration)
 * ============================================================================
 * 2026-09-14 entry-layer refactor: sunk down from commands/image-acquire.js,
 * **step order, judgment thresholds and log copy all preserved verbatim**. The CLI
 * (packages/geo-cli/bin/image-acquire.js) is now just "parse args → call this
 * function → print the result".
 *
 * The five steps:
 *   1. Search images: Unsplash (preferred) + Pexels / Pixabay (fallback)
 *   2. Red-line screening: brand/Logo block-list, reject abstract·3D·AI·light
 *      effects·gradients, landscape ≥1200px
 *   3. Download: take the top 5 by score, pHash-dedupe each one, skip on hit
 *   4. Crop & transcode: sharp center-crop 1600×900 (16:9) + JPG/WebP (IMAGE_FORMAT
 *      configurable, default JPG q85)
 *   5. Upload & ingest: wp.media.uploadMedia → images.saveImage (pHash + credit)
 *      → output { wp_media_id, url }
 *
 * ⚠️ Circular dependency: this file belongs to the images domain, and the DB image
 *    repository also lives in images/index.js. So './index' and '../wp/media' use
 *    **in-function lazy require** to avoid a load-time cycle.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const redline = require('./redline');
const sources = require('./sources');

const {
  sanitizeQuery,
  redLineCheck,
  scoreCandidate,
  buildFileName,
  WEBP_WIDTH,
  WEBP_HEIGHT,
  WEBP_QUALITY,
  JPG_QUALITY,
} = redline;

/** Default temp dir (identical to pre-refactor, keeping behavior unchanged) */
const DEFAULT_TEMP_DIR = path.join('/tmp', 'wp-images');

/**
 * Determine the search topic: explicit query > keywords > article title by slug
 * (falls back to slug word-splitting)
 */
async function deriveQuery({ slug, query, keywords, appId = Number(process.env.APP_ID || 1) } = {}) {
  if (query) return sanitizeQuery(query);
  if (keywords) return sanitizeQuery(String(keywords).split(',').map((s) => s.trim()).join(' '));
  if (slug) {
    const t = require('../index');
    const title = await t.db.withConn((connection) =>
      t.db.articles.findTitleBySlug(connection, slug, appId)
    );
    if (title) {
      return sanitizeQuery(`${title} ${slug.split('-').slice(0, 3).join(' ')}`);
    }
    return sanitizeQuery(slug.split('-').join(' '));
  }
  throw new Error('Provide one of --query / --keywords / --slug to determine the search topic');
}

/** Look up article_id by slug (null when no slug) */
async function getArticleIdBySlug(slug, appId = Number(process.env.APP_ID || 1)) {
  if (!slug) return null;
  const t = require('../index');
  return t.db.withConn((connection) =>
    t.db.articles.findIdBySlug(connection, slug, appId)
  );
}

/**
 * Run the image-acquisition pipeline.
 *
 * @param {object}  opts
 * @param {string}  [opts.slug]      article slug (decides file name and ingest link;
 *                                   also used to derive the search term)
 * @param {string}  [opts.query]     explicit search term (highest priority)
 * @param {string}  [opts.keywords]  comma-separated keywords
 * @param {boolean} [opts.dryRun]    only run to "transcode": no upload, no ingest
 *                                   (output format follows IMAGE_FORMAT)
 * @param {number}  [opts.appId]     APP_ID (default env.APP_ID or 1)
 * @param {function}[opts.log]       progress output (default stderr)
 * @param {string}  [opts.tempDir]   temp dir (default /tmp/wp-images)
 * @param {object}  [opts.keys]      stock-library key overrides (default from env)
 * @returns {Promise<object>} dryRun → {dryRun,platform,author,webpPath,phash}
 *                            real   → {wp_media_id,url,platform,author,author_url,alt,article_id}
 */
async function acquire({
  slug = null,
  query = null,
  keywords = null,
  dryRun = false,
  appId = Number(process.env.APP_ID || 1),
  log = console.error,
  tempDir = DEFAULT_TEMP_DIR,
  keys = {},
} = {}) {
  const t = require('../index');
  const { uploadMedia } = t.wp.media;
  const { getImageByPhash, computeImagePhash, ingestExternalImage } = t.images;
  const { download } = require('../content/http');

  const unsplashKey = keys.unsplash !== undefined ? keys.unsplash : (process.env.UNSPLASH_ACCESS_KEY || '');
  const pexelsKey = keys.pexels !== undefined ? keys.pexels : (process.env.PEXELS_API_KEY || '');
  const pixabayKey = keys.pixabay !== undefined ? keys.pixabay : (process.env.PIXABAY_API_KEY || '');

  log('\n[1/5] Determining the search topic...');
  const q = await deriveQuery({ slug, query, keywords, appId });
  log(`  topic: ${q}`);

  log('\n[2/5] Multi-platform image search + red-line screening...');
  const all = []
    .concat(await sources.searchUnsplash(q, { key: unsplashKey, log, sanitizeQuery, shortenQuery: redline.shortenQuery }))
    .concat(await sources.searchPexels(q, { key: pexelsKey, log }))
    .concat(await sources.searchPixabay(q, { key: pixabayKey, log }));

  const scored = all
    .map((c) => ({ ...c, _redline: redLineCheck(c), _score: scoreCandidate(c, q) }))
    .filter((c) => c._redline.ok)
    .sort((a, b) => b._score - a._score);

  if (scored.length === 0) {
    throw new Error('No candidates passed the red-line screening (check the API key or broaden the keywords)');
  }
  // uniqueness hard floor (2026-09-20): on a DB hit, move to the next candidate; the
  // candidate pool is enlarged (default 15, IMAGE_CANDIDATE_POOL adjustable).
  const poolSize = Math.max(5, Number(process.env.IMAGE_CANDIDATE_POOL || 15));
  log(`  ${all.length} candidates, ${scored.length} passed; pixel-deduping the top ${poolSize} by score`);

  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  let chosen = null;
  let chosenPath = null;
  const pool = scored.slice(0, poolSize);
  let dupHits = 0;
  for (const cand of pool) {
    const rawPath = path.join(tempDir, `cand-${cand.platform}-${cand.id}.jpg`);
    try {
      await download(cand.url, rawPath, { userAgent: sources.IMAGE_PIPELINE_UA, timeout: Number(process.env.IMAGE_DL_TIMEOUT || 20000) });
      const phash = await computeImagePhash(rawPath);
      const dup = await getImageByPhash(phash, 8);
      if (dup) {
        dupHits++;
        log(`  ⚠️ pHash hit a similar image in the library (ID ${dup.id}) → moving to the next candidate`);
        continue;
      }
      cand._phash = phash;
      chosen = cand;
      chosenPath = rawPath;
      break;
    } catch (e) {
      log(`  ⚠️ Candidate processing failed: ${e.message}`);
    }
  }

  // the whole pool hit: never fall back to a duplicate; rather fail than produce a
  // featured image duplicating an existing one.
  if (!chosen) {
    throw new Error(
      `Image acquisition failed: all ${pool.length} pool candidates hit similar images in the library (${dupHits} duplicates). ` +
      `To uphold the "featured image must not duplicate existing article images" hard floor, no duplicate is produced. ` +
      `Try different keywords and retry.`
    );
  }

  log(`  ✓ Chosen: ${chosen.platform} #${chosen.id} ${chosen.width}x${chosen.height} | ${chosen.author}`);

  // output format configurable: IMAGE_FORMAT=webp uses WebP, otherwise default JPG
  // (external platforms reject WebP, so JPG is the default to cover every channel).
  const fmt = String(process.env.IMAGE_FORMAT || 'jpg').toLowerCase() === 'webp' ? 'webp' : 'jpg';
  const sharpMethod = fmt === 'webp' ? 'webp' : 'jpeg'; // the sharp method is .jpeg(), not .jpg()
  const outQuality = fmt === 'webp' ? WEBP_QUALITY : JPG_QUALITY;
  const ext = fmt === 'webp' ? 'webp' : 'jpg';

  log(`\n[3/5] Cropping + converting to ${fmt.toUpperCase()} (q${outQuality})...`);
  // semantic naming: article slug when present (doesn't expose the stock source);
  // falls back to img-<image-id> without a slug
  const outName = buildFileName(slug, chosen, ext);
  const outPath = path.join(tempDir, outName);
  await sharp(chosenPath)
    .resize(WEBP_WIDTH, WEBP_HEIGHT, { fit: 'cover', position: 'centre' })
    [sharpMethod]({ quality: outQuality })
    .toFile(outPath);
  log(`  ✓ ${outPath}`);

  if (dryRun) {
    return { dryRun: true, platform: chosen.platform, author: chosen.author, format: fmt, outPath, phash: chosen._phash };
  }

  const alt = chosen.alt || q;
  const articleId = await getArticleIdBySlug(slug, appId);

  log('\n[4/5] Uploading to WordPress...');
  let uploadPath = outPath;
  let uploadRes;
  try {
    uploadRes = await uploadMedia(outPath, { alt, title: alt });
  } catch (e) {
    // primary-format upload failed → fall back to the other format (jpg/webp mutual
    // fallback; no more "WebP first")
    const fallbackFmt = fmt === 'webp' ? 'jpg' : 'webp';
    const fallbackExt = fallbackFmt === 'webp' ? 'webp' : 'jpg';
    const fallbackMethod = fallbackFmt === 'webp' ? 'webp' : 'jpeg';
    const fallbackQuality = fallbackFmt === 'webp' ? WEBP_QUALITY : JPG_QUALITY;
    log(`  ⚠️ ${fmt.toUpperCase()} upload failed (${e.message}), falling back to ${fallbackFmt.toUpperCase()}`);
    const fallbackPath = path.join(tempDir, buildFileName(slug, chosen, fallbackExt));
    await sharp(chosenPath)
      .resize(WEBP_WIDTH, WEBP_HEIGHT, { fit: 'cover', position: 'centre' })
      [fallbackMethod]({ quality: fallbackQuality })
      .toFile(fallbackPath);
    uploadPath = fallbackPath;
    uploadRes = await uploadMedia(fallbackPath, { alt, title: alt });
  }

  log('\n[5/5] Ingesting (pHash dedupe + credit, unified into SDK ingestExternalImage)...');
  const r = await ingestExternalImage(uploadPath, {
    originalUrl: chosen.sourceUrl || chosen.url,
    alt,
    articleId,
    position: 'featured',
    order: 0,
    width: chosen.width,
    height: chosen.height,
    sourcePlatform: chosen.platform,
    appId,
    log
  });

  return {
    wp_media_id: r.wpMediaId,
    url: r.wpUrl,
    platform: chosen.platform,
    author: chosen.author,
    author_url: chosen.authorUrl,
    alt,
    article_id: articleId
  };
}

module.exports = { acquire, deriveQuery, getArticleIdBySlug, DEFAULT_TEMP_DIR };
