/**
 * Image ingest (shared core): ingest an already-on-disk local image into the WP
 * media library + the own image library
 * ============================================================================
 * Refactor batch 7 on 2026-09-14: extracted from the **duplicated logic** of
 * publish-from-db.js's processImages and image-acquire.js's "upload + ingest"
 * segments, converged here and shared by both.
 *
 * Behavior (verbatim-equivalent to the two original sites):
 *   1. pHash perceptual dedupe (getImageByPhash, Hamming distance ≤8): on a hit
 *      that is already uploaded, reuse and link, return { reused: true }, no upload;
 *   2. otherwise: upload the local file (uploadMedia) → save the image record
 *      (saveImage, with pHash) → link the article (saveArticleImage).
 *
 * Note: download, WebP/JPG transcode and the WP↔production URL mapping are the
 * caller's job (the two scenarios have different strategies and shouldn't be
 * stuffed into this function). This function only eats "a prepared local file +
 * the original external URL + article-link info".
 *
 * ⚠️ Circular dependency: this file belongs to the images domain, and t.images /
 *    t.wp.media use **in-function lazy require** to avoid a load-time cycle (same
 *    treatment as acquire.js).
 * ============================================================================
 */

const fs = require('fs');

/**
 * @param {string} localPath local image path (the caller has prepared the final
 *                           format: raw JPG or WebP/JPG)
 * @param {object} opts
 * @param {string}  opts.originalUrl   original external URL (for original_url
 *                                     registration and source_platform detection)
 * @param {string}  [opts.alt]         alt text
 * @param {number}  [opts.articleId]   article ID (for the article-image link;
 *                                     skipped when absent)
 * @param {string}  [opts.position]    link position (content / featured)
 * @param {number}  [opts.order]       display order
 * @param {number}  [opts.width]       image width (ingest record, optional)
 * @param {number}  [opts.height]      image height (ingest record, optional)
 * @param {number}  [opts.appId]
 * @param {Function}[opts.log]
 * @returns {Promise<{wpMediaId:number, wpUrl:string, imageId:number|null, reused:boolean}>}
 */
async function ingestExternalImage(localPath, opts = {}) {
  const {
    originalUrl = '',
    alt = '',
    articleId = null,
    position = 'content',
    order = 0,
    width = null,
    height = null,
    sourcePlatform = null,
    appId = Number(process.env.APP_ID || 1),
    log = console.error,
  } = opts;

  const t = require('../index');
  const { uploadMedia } = t.wp.media;
  const {
    computeImagePhash,
    getImageByPhash,
    getImageOccupancy,
    saveImage,
    saveArticleImage,
    incrementImageUsage,
    extractSourcePlatform,
  } = t.images;

  if (!fs.existsSync(localPath)) {
    throw new Error(`Local image does not exist: ${localPath}`);
  }

  // 1. pHash perceptual dedupe (pixel-based, so the file must be downloaded first)
  let phash = null;
  try {
    phash = await computeImagePhash(localPath);
  } catch (e) {
    log(`  ⚠️ pHash computation failed (degrading to a direct upload): ${e.message}`);
  }

  if (phash) {
    const dup = await getImageByPhash(phash, 8);
    if (dup && dup.wp_media_id) {
      // uniqueness hard floor (2026-09-20): the same image must not be reused across
      // articles, nor across positions within one article.
      // Reuse is allowed only when the existing occupancy matches this "article +
      // position" exactly (idempotent re-ingest) or the image is not occupied by any
      // article yet; otherwise throw, letting the upper layer (acquire) swap images —
      // never silently produce a duplicate featured image.
      const occupancy = await getImageOccupancy(dup.id);
      const conflicts = occupancy.filter((o) => !(o.article_id === articleId && o.position === position));
      if (conflicts.length > 0) {
        const who = conflicts.map((o) => `article#${o.article_id}/${o.position}`).join(', ');
        throw new Error(
          `PHASH_DUPLICATE: the image is within Hamming distance ≤8 of library img#${dup.id} ` +
          `(media ${dup.wp_media_id}), already occupied by: ${who}; ` +
          `cross-article/cross-position reuse refused (featured-image uniqueness hard floor)`
        );
      }
      log(`  ⚠️ pHash hit a similar image in the library (ID ${dup.id}, Hamming distance ≤8) → idempotent reuse, no duplicate upload`);
      if (articleId) {
        await incrementImageUsage(dup.id);
        await saveArticleImage(articleId, dup.id, position, order);
      }
      return { wpMediaId: dup.wp_media_id, wpUrl: null, imageId: dup.id, reused: true };
    }
  }

  // 2. no duplicate: upload the new image
  // table constraints: alt_text varchar(255), original_url varchar(512) (Pixabay's
  // tag strings often exceed 255; truncate)
  const safeAlt = String(alt || '').slice(0, 255);
  const safeOriginalUrl = String(originalUrl || '').slice(0, 512);
  const uploadResult = await uploadMedia(localPath, { alt: safeAlt });
  const wpUrl = uploadResult.source_url || (uploadResult.guid && uploadResult.guid.rendered) || uploadResult.url;
  const wpMediaId = uploadResult.id;
  log(`  ✓ URL: ${wpUrl}`);

  // 3. save the image record (with pHash)
  const imageData = {
    original_url: safeOriginalUrl,
    source_platform: sourcePlatform || extractSourcePlatform(originalUrl),
    wp_media_id: wpMediaId,
    image_hash: phash || null,
    width,
    height,
    alt_text: safeAlt,
  };
  const saved = await saveImage(imageData);

  // 4. link the article
  if (articleId && saved.id) {
    await saveArticleImage(articleId, saved.id, position, order);
  }

  return { wpMediaId, wpUrl, imageId: saved.id || null, reused: false };
}

module.exports = { ingestExternalImage };
