/**
 * Image domain: DB dedupe / registration + image red-lines and pipeline
 * ============================================================================
 * Directory notes (2026-09-14 entry-layer refactor):
 *   - index.js (this file)  image DB repository (ported from the business repo,
 *                           logic verbatim unchanged)
 *   - redline.js            image red-line rules and scoring (**pure logic**, no I/O,
 *                           unit-testable)
 *   - sources.js            stock-source search (Unsplash preferred + Pexels /
 *                           Pixabay fallback)
 *   - acquire.js            five-step image-acquisition pipeline orchestration
 * The legacy-path compat shims were removed the same day (batch D).
 * ============================================================================
 */

const sharp = require('sharp');

const redline = require('./redline');
const sources = require('./sources');
const acquireModule = require('./acquire');
const { createConnection, driver } = require('../db/connection');

// Note: DB credentials are loaded from <sites>/<site>/.env by the entry scripts via
// site/config.js; this module only reads process.env at runtime and never loads .env
// itself.
// Multi-tenant: app_id comes from the APP_ID env var (site .env); the SQLite
// single-file multi-tenant isolation is per-column.

/** Current tenant ID (default 1, matching the schema DEFAULT) */
function appId() {
  return parseInt(process.env.APP_ID || '1', 10);
}

// config
const CONFIG = {
  platforms: {
    UNSPLASH: 'unsplash',
    PEXELS: 'pexels',
    PIXABAY: 'pixabay',
    FREEPIK: 'freepik',
    STOCKADOBO: 'stockadobio',
    CUSTOM: 'custom'
  }
};

/**
 * Create a DB connection
 */
async function getConnection() {
  return await createConnection();
}

/**
 * Find an image by its original URL
 */
async function getImageByUrl(url) {
  const conn = await getConnection();
  try {
    const [rows] = await conn.query(
      'SELECT * FROM tengence_geo_images WHERE original_url = ? AND app_id = ?',
      [url, appId()]
    );
    return rows.length > 0 ? rows[0] : null;
  } finally {
    await conn.end();
  }
}

/**
 * Find an image by its parameter-stripped URL (fast path)
 * The same external image (e.g. Unsplash) differing only in query params (w/q/fm
 * etc.) counts as the same image; the earliest uploaded record is returned.
 */
async function getImageByCleanUrl(url) {
  const cleanUrl = String(url).split('?')[0];
  const conn = await getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT * FROM tengence_geo_images
       WHERE app_id = ? AND SUBSTRING_INDEX(original_url, '?', 1) = ?
       ORDER BY id ASC LIMIT 1`,
      [appId(), cleanUrl]
    );
    return rows.length > 0 ? rows[0] : null;
  } finally {
    await conn.end();
  }
}

/**
 * 1-D DCT (type II)
 */
function dct1d(values) {
  const n = values.length;
  const out = new Array(n);
  for (let u = 0; u < n; u++) {
    let sum = 0;
    const cu = u === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n);
    for (let x = 0; x < n; x++) {
      sum += values[x] * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * n));
    }
    out[u] = cu * sum;
  }
  return out;
}

/**
 * Compute the perceptual hash of an image (pHash, DCT variant) → 16-char hex
 * Flow: 32x32 greyscale resize → 8x8 mean pooling → 8x8 DCT → compare 64 low-freq
 * coefficients against the mean → 64 bits
 * Platform-independent (Unsplash/Pexels/Pixabay etc.), robust to resizing and JPEG
 * compression
 */
async function computeImagePhash(imageInput) {
  const { data } = await sharp(imageInput)
    .resize(32, 32, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 8x8 mean pooling (average each 4x4 block, smoothing noise)
  const pooled = new Array(64);
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      let sum = 0;
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          sum += data[(by * 4 + py) * 32 + (bx * 4 + px)];
        }
      }
      pooled[by * 8 + bx] = sum / 16;
    }
  }

  // row transform
  const rows = [];
  for (let y = 0; y < 8; y++) {
    rows.push(dct1d(pooled.slice(y * 8, y * 8 + 8)));
  }
  // column transform → flatten (row-major): out[r*8+c] = DCT(u=r, v=c)
  const dct = new Array(64);
  for (let c = 0; c < 8; c++) {
    const col = rows.map((r) => r[c]);
    const t = dct1d(col);
    for (let r = 0; r < 8; r++) {
      dct[r * 8 + c] = t[r];
    }
  }

  // mean of the 63 coefficients excluding DC ([0][0])
  let mean = 0;
  for (let i = 1; i < 64; i++) mean += dct[i];
  mean /= 63;

  // bit-by-bit comparison → 64 bits → 16-char hex
  let bits = '';
  for (let i = 0; i < 64; i++) bits += dct[i] > mean ? '1' : '0';
  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/**
 * pHash Hamming-distance dedupe (local MySQL / SQLite dual driver)
 * MySQL: BIT_COUNT(a ^ b) <= threshold judged as same/highly similar;
 *        the 64-bit decimal returned by CONV must be CAST AS UNSIGNED before ^,
 *        otherwise MySQL converts it as a signed BIGINT in the comparison context and
 *        the result is unreliable.
 * SQLite: no BIT_COUNT/CONV; instead fetch all hashed images of the tenant and
 *         compute the Hamming distance in JS (fine for small local libraries; the
 *         MySQL production path keeps the original SQL unchanged).
 */
async function getImageByPhash(phashHex, threshold = 8) {
  const conn = await getConnection();
  try {
    if (driver() === 'sqlite') {
      const [rows] = await conn.query(
        `SELECT * FROM tengence_geo_images
         WHERE app_id = ? AND image_hash IS NOT NULL AND image_hash != ''`,
        [appId()]
      );
      let best = null;
      let bestDist = threshold + 1;
      for (const row of rows) {
        const d = hammingHex(row.image_hash, phashHex);
        if (d < bestDist) { bestDist = d; best = row; }
        if (d === 0) break;
      }
      return bestDist <= threshold ? best : null;
    }
    const [rows] = await conn.query(
      `SELECT *, BIT_COUNT(CAST(CONV(image_hash, 16, 10) AS UNSIGNED) ^ CAST(CONV(?, 16, 10) AS UNSIGNED)) AS hamming_dist
       FROM tengence_geo_images
       WHERE app_id = ? AND image_hash IS NOT NULL AND image_hash != ''
         AND BIT_COUNT(CAST(CONV(image_hash, 16, 10) AS UNSIGNED) ^ CAST(CONV(?, 16, 10) AS UNSIGNED)) <= ?
       ORDER BY hamming_dist ASC
       LIMIT 1`,
      [phashHex, appId(), phashHex, threshold]
    );
    return rows.length > 0 ? rows[0] : null;
  } finally {
    await conn.end();
  }
}

/** Hamming distance of two 16-char hex pHashes (bitwise XOR popcount) */
function hammingHex(a, b) {
  let dist = 0;
  const alen = a.length;
  for (let i = 0; i < alen; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    dist += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return dist;
}

/**
 * Find an image by ID
 */
async function getImageById(id) {
  const conn = await getConnection();
  try {
    const [rows] = await conn.query(
      'SELECT * FROM tengence_geo_images WHERE id = ? AND app_id = ?',
      [id, appId()]
    );
    return rows.length > 0 ? rows[0] : null;
  } finally {
    await conn.end();
  }
}

/**
 * Query which articles/positions use an image (for the featured-image uniqueness
 * gate: the same image must not be reused across articles, nor across positions
 * within one article).
 * @param {number} imageId
 * @returns {Promise<Array<{article_id:number, position:string, display_order:number}>>}
 */
async function getImageOccupancy(imageId) {
  const conn = await getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT article_id, position, display_order
         FROM tengence_geo_article_images WHERE image_id = ? AND app_id = ?`,
      [imageId, appId()]
    );
    return rows;
  } finally {
    await conn.end();
  }
}

/**
 * Save an image record
 */
async function saveImage(imageData) {
  const conn = await getConnection();
  try {
    // dual-driver upsert: MySQL via ON DUPLICATE KEY; SQLite via ON CONFLICT
    // (app_id+original_url unique key)
    const isSqlite = driver() === 'sqlite';
    const sql = isSqlite
      ? `
      INSERT INTO tengence_geo_images
      (app_id, original_url, source_platform, wp_media_id, image_hash, width, height, quality_score, alt_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(app_id, original_url) DO UPDATE SET
        wp_media_id = excluded.wp_media_id,
        usage_count = usage_count + 1,
        last_used_at = NOW()
    `
      : `
      INSERT INTO tengence_geo_images
      (original_url, source_platform, wp_media_id, image_hash, width, height, quality_score, alt_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        wp_media_id = VALUES(wp_media_id),
        usage_count = usage_count + 1,
        last_used_at = NOW()
    `;

    const values = [
      imageData.original_url,
      imageData.source_platform || 'unsplash',
      imageData.wp_media_id || null,
      imageData.image_hash || null,
      imageData.width || null,
      imageData.height || null,
      imageData.quality_score || 0.80,
      imageData.alt_text || null
    ];

    const [result] = await conn.query(sql, isSqlite ? [appId(), ...values] : values);

    // fetch the inserted ID
    if (result.insertId) {
      imageData.id = result.insertId;
    } else {
      // UPDATE case: need to query the ID
      const [rows] = await conn.query('SELECT id FROM tengence_geo_images WHERE original_url = ? AND app_id = ?', [imageData.original_url, appId()]);
      imageData.id = rows[0].id;
    }

    console.log(`✓ Image saved: ID ${imageData.id}, URL: ${imageData.original_url.substring(0, 60)}...`);
    return imageData;
  } finally {
    await conn.end();
  }
}

/**
 * Save the article-image link
 */
async function saveArticleImage(articleId, imageId, position = 'content', displayOrder = 0) {
  const conn = await getConnection();
  try {
    if (driver() === 'sqlite') {
      await conn.query(
        `INSERT INTO tengence_geo_article_images (article_id, app_id, image_id, position, display_order)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(article_id, image_id) DO UPDATE SET display_order = excluded.display_order`,
        [articleId, appId(), imageId, position, displayOrder]
      );
    } else {
      await conn.query(
        `INSERT INTO tengence_geo_article_images (article_id, image_id, position, display_order)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE display_order = VALUES(display_order)`,
        [articleId, imageId, position, displayOrder]
      );
    }
  } finally {
    await conn.end();
  }
}

/**
 * Get all images of an article
 */
async function getArticleImages(articleId) {
  const conn = await getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT ai.*, aii.position, aii.display_order
       FROM tengence_geo_article_images aii
       JOIN tengence_geo_images ai ON aii.image_id = ai.id
       WHERE aii.article_id = ? AND aii.app_id = ?
       ORDER BY aii.position DESC, aii.display_order`,
      [articleId, appId()]
    );
    return rows;
  } finally {
    await conn.end();
  }
}

/**
 * Get available featured images (not used by other articles)
 */
async function getAvailableFeaturedImage(excludeImageIds = []) {
  const conn = await getConnection();
  try {
    const excludeList = excludeImageIds.length > 0 ? excludeImageIds : [0];
    // expand placeholders one by one (SQLite doesn't expand array params; MySQL-compatible)
    const placeholders = excludeList.map(() => '?').join(', ');

    const [rows] = await conn.query(`
      SELECT i.*,
             (SELECT COUNT(*) FROM tengence_geo_article_images ai
              WHERE ai.image_id = i.id AND ai.position = 'content' AND ai.app_id = i.app_id) as article_count
      FROM tengence_geo_images i
      WHERE i.app_id = ? AND i.id NOT IN (${placeholders})
      AND i.source_platform = 'unsplash'
      AND i.quality_score >= 0.75
      HAVING article_count <= 1
      ORDER BY i.quality_score DESC, i.usage_count ASC
      LIMIT 10
    `, [appId(), ...excludeList]);

    return rows;
  } finally {
    await conn.end();
  }
}

/**
 * Bump an image's usage count
 */
async function incrementImageUsage(imageId) {
  const conn = await getConnection();
  try {
    await conn.query(
      'UPDATE tengence_geo_images SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = ? AND app_id = ?',
      [imageId, appId()]
    );
  } finally {
    await conn.end();
  }
}

/**
 * Extract the image source platform
 */
function extractSourcePlatform(url) {
  if (url.includes('unsplash.com')) return 'unsplash';
  if (url.includes('pexels.com')) return 'pexels';
  if (url.includes('pixabay.com')) return 'pixabay';
  if (url.includes('freepik.com')) return 'freepik';
  if (url.includes('stockadobio.com')) return 'stockadobio';
  return 'custom';
}

/**
 * Resolve the WP media ID for a "site-owned image URL" (front-matter
 * featured_image / body owned addresses).
 * Looks up the own library tengence_geo_images first (file-name match), then falls
 * back to WP /media?search by file name.
 * Returns 0 when not found (the caller treats it as no media ID).
 * @param {string} prodUrl site-owned image URL (e.g. https://www.tengence.com/blog/static/images/…)
 * @returns {Promise<number>} WP media ID, 0 when not found
 */
async function resolveWpMediaIdByUrl(prodUrl) {
  const fname = String(prodUrl || '').split('/').pop().split('?')[0];
  if (!fname) return 0;

  let found = null;
  const conn = await getConnection();
  try {
    const [rows] = await conn.query(
      'SELECT wp_media_id FROM tengence_geo_images WHERE original_url LIKE ? AND app_id = ? ORDER BY id DESC LIMIT 1',
      [`%${fname}`, appId()]
    );
    found = rows.length && rows[0].wp_media_id ? rows[0].wp_media_id : null;
  } catch (e) {
    // ignore; fall back to the WP /media search
  } finally {
    await conn.end();
  }
  if (found) return found;

  try {
    const t = require('../index');
    const list = await t.wp.api(`/media?search=${encodeURIComponent(fname)}&per_page=20`);
    if (Array.isArray(list)) {
      const hit = list.find(
        (m) => (m.source_url || '').includes(fname) || ((m.guid && m.guid.rendered) || '').includes(fname)
      );
      if (hit) return hit.id;
      if (list.length) return list[0].id;
    }
  } catch (e) {
    // ignore
  }
  return 0;
}

/**
 * Get all images (for reporting)
 */
async function getAllImages() {
  const conn = await getConnection();
  try {
    const [rows] = await conn.query(
      'SELECT * FROM tengence_geo_images WHERE app_id = ? ORDER BY usage_count DESC',
      [appId()]
    );
    return rows;
  } finally {
    await conn.end();
  }
}

module.exports = {
  CONFIG,
  getConnection,
  getImageByUrl,
  getImageByCleanUrl,
  getImageById,
  getImageOccupancy,
  saveImage,
  saveArticleImage,
  getArticleImages,
  getAvailableFeaturedImage,
  incrementImageUsage,
  extractSourcePlatform,
  computeImagePhash,
  getImageByPhash,
  resolveWpMediaIdByUrl,
  getAllImages,

  // image-acquisition pipeline (sunk down from commands/image-acquire.js 2026-09-14)
  redline,
  sources,
  acquire: acquireModule.acquire,
  deriveQuery: acquireModule.deriveQuery,
  getArticleIdBySlug: acquireModule.getArticleIdBySlug,

  // shared ingest core (batch 7 on 2026-09-14: shared by publish-from-db's
  // processImages and acquire)
  ingestExternalImage: require('./ingest').ingestExternalImage
};
