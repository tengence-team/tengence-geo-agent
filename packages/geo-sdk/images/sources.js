/**
 * Image stock-source search (Unsplash preferred + Pexels / Pixabay fallback)
 * ============================================================================
 * 2026-09-14 entry-layer refactor: sunk down verbatim from commands/image-acquire.js,
 * **request and parsing logic unchanged to the letter**.
 *
 * The only difference from pre-refactor is the "input shape": module-level constants
 * (API keys / UA) became explicit parameters for reuse and testing; request URLs,
 * field mappings, fallback order and log copy all stay as-is.
 *
 * Uniform normalized candidate: { platform, id, url, width, height, alt, author,
 * authorUrl, sourceUrl }
 * ============================================================================
 */

const { getJson } = require('../content/http');

/** Unified stock-API UA (keeps each script's pre-refactor identifier) */
const IMAGE_PIPELINE_UA = 'tengence-image-pipeline/1.0';

/** Stock-API default timeout (ms): avoids hanging forever when the network stalls
 * (content.http default 0 = no timeout). Overridable via IMAGE_API_TIMEOUT */
const IMAGE_API_TIMEOUT = Number(process.env.IMAGE_API_TIMEOUT || 15000);

/** Fetch JSON (thin wrapper over content.http, keeping the original call signature) */
function httpGetJson(url, headers = {}) {
  return getJson(url, { headers, userAgent: IMAGE_PIPELINE_UA, timeout: IMAGE_API_TIMEOUT });
}

/**
 * Unsplash search: tries the three-stage fallback "sanitized original → 5 words →
 * 3 words" in order; the first success wins.
 * Measured: Unsplash returns 410 "Content removed" for long queries with full-width
 * punctuation.
 */
async function searchUnsplash(query, { key, perPage = 8, log = console.error, sanitizeQuery, shortenQuery } = {}) {
  if (!key) return [];
  const build = (q) =>
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=${perPage}&orientation=landscape`;

  const fetchOnce = async (q) => {
    const data = await httpGetJson(build(q), { Authorization: `Client-ID ${key}` });
    return (data.results || []).map((p) => ({
      platform: 'unsplash',
      id: p.id,
      url: p.urls.full || p.urls.regular,
      width: p.width,
      height: p.height,
      alt: (p.alt_description || p.description || '').toString(),
      author: p.user ? p.user.name : '',
      authorUrl: p.user && p.user.links ? p.user.links.html : '',
      sourceUrl: p.links ? p.links.html : ''
    }));
  };

  const attempts = [];
  const clean = sanitizeQuery(query);
  if (clean) attempts.push(clean);
  const short = shortenQuery(query, 5);
  if (short && short !== clean) attempts.push(short);
  const shorter = shortenQuery(query, 3);
  if (shorter && shorter !== short) attempts.push(shorter);

  for (const q of attempts) {
    try {
      const res = await fetchOnce(q);
      if (res.length) return res;
    } catch (e) {
      log(`  ⚠️ Unsplash search failed (query "${q}"): ${e.message}`);
    }
  }
  if (!attempts.length) log('  ⚠️ Unsplash search failed: query is empty');
  return [];
}

/** Pexels search (fallback) */
async function searchPexels(query, { key, perPage = 8, log = console.error } = {}) {
  if (!key) return [];
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape`;
  try {
    const data = await httpGetJson(url, { Authorization: key });
    return (data.photos || []).map((p) => ({
      platform: 'pexels',
      id: p.id,
      url: p.src && (p.src.large2x || p.src.large || p.src.original),
      width: p.width,
      height: p.height,
      alt: (p.alt || '').toString(),
      author: p.photographer || '',
      authorUrl: p.photographer_url || '',
      sourceUrl: p.url || ''
    }));
  } catch (e) {
    log(`  ⚠️ Pexels search failed: ${e.message}`);
    return [];
  }
}

/** Pixabay search (fallback) */
async function searchPixabay(query, { key, perPage = 8, log = console.error } = {}) {
  if (!key) return [];
  const url = `https://pixabay.com/api/?key=${key}&q=${encodeURIComponent(query)}&image_type=photo&orientation=horizontal&per_page=${perPage}&safesearch=true`;
  try {
    const data = await httpGetJson(url);
    return (data.hits || []).map((h) => ({
      platform: 'pixabay',
      id: h.id,
      url: h.largeImageURL || h.webformatURL,
      width: h.imageWidth,
      height: h.imageHeight,
      alt: (h.tags || '').toString(),
      author: h.user || '',
      authorUrl: `https://pixabay.com/users/${h.user || ''}`,
      sourceUrl: h.pageURL || ''
    }));
  } catch (e) {
    log(`  ⚠️ Pixabay search failed: ${e.message}`);
    return [];
  }
}

module.exports = { searchUnsplash, searchPexels, searchPixabay, IMAGE_PIPELINE_UA };
