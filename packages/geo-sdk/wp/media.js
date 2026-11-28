#!/usr/bin/env node
/**
 * WordPress media upload (wp domain)
 * ============================================================================
 * The WP /media upload logic extracted from publish-from-db.js, shared by the
 * "publish chain" and the "image pipeline" to avoid duplicated upload code (the old
 * upload-media.js and publish-from-db.js's uploadImageToWP duplicated each other;
 * uploadImageToWP / upload-media.js were removed during the refactor).
 *
 * Batch-B changes: endpoint & credential resolution now comes from ../wp/target.js
 * (this file used to carry its own copy duplicating publish-from-db.js); the upload
 * implementation itself is byte-identical.
 *
 * Usage:
 *   const { uploadMedia } = require('../wp/media');
 *   const res = await uploadMedia('/path/to/img.webp', { alt: 'Description', title: 'Title' });
 *   // res.id / res.source_url / res.guid
 * ============================================================================
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const FormData = require('form-data');
const { wpTarget } = require('./target');

/**
 * Resolve the WP upload target (apiUrl + Basic Auth header)
 * Consistent with publish-from-db.js: apiUrl = <WP_API_URL>/wp/v2
 * @returns {{apiUrl:string, AUTH_HEADER:string}}
 */
function resolveWpUploadTarget() {
  // loadSite injects sites/<site>/.env into process.env (only when unset)
  const { apiUrl, authHeader } = wpTarget();
  return { apiUrl, AUTH_HEADER: authHeader };
}

/**
 * READ an already-uploaded media item back from the WordPress media library.
 *
 * WordPress — not our local DB — is the source of truth for a post's featured image:
 * drafts are prepared inside wp-admin (image included) long before anything is
 * published, so translations must reuse THAT image instead of acquiring a new one.
 *
 * @param {number|string} mediaId WP media (attachment) id — a post's `featured_media`
 * @param {{siteKey?:string}} [opts]
 * @returns {Promise<{id:number, url:string|null, alt:string|null}|null>} null when WP has no such media
 */
async function getMedia(mediaId, opts = {}) {
  if (!mediaId) return null;
  const { api } = require('./request');
  const m = await api(`/media/${mediaId}?_fields=id,source_url,alt_text,title`, { siteKey: opts.siteKey });
  if (!m || !m.source_url) return null;
  return {
    id: Number(m.id || mediaId),
    url: m.source_url,
    alt: m.alt_text || null,
    title: (m.title && (m.title.rendered || m.title.raw)) || null,
  };
}

/**
 * Upload a local image to the WordPress media library
 * @param {string} localPath absolute path of the local image
 * @param {{alt?:string, title?:string, filename?:string, caption?:string, description?:string}} [opts]
 *   filename — the file name stored in WP (and therefore in the URL). Callers that
 *   care about image SEO pass a normalised, descriptive ASCII name; when omitted the
 *   local basename is used (legacy behaviour).
 * @returns {Promise<{id:number, source_url:string, guid:object|string, url:string}>}
 */
async function uploadMedia(localPath, opts = {}) {
  if (!fs.existsSync(localPath)) {
    throw new Error(`Local image does not exist: ${localPath}`);
  }
  const { alt = '', title = '', filename = '', caption = '', description = '' } = opts;
  const { apiUrl, AUTH_HEADER } = resolveWpUploadTarget();

  const form = new FormData();
  const streamOpts = filename ? { filename } : undefined;
  form.append('file', fs.createReadStream(localPath), streamOpts);
  form.append('alt_text', alt);
  form.append('title', title || alt);
  if (caption) form.append('caption', caption);
  if (description) form.append('description', description);

  const wpApi = new URL(apiUrl);
  const useHttps = wpApi.protocol === 'https:';
  const httpMod = useHttps ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = httpMod.request(
      {
        hostname: wpApi.hostname,
        port: wpApi.port || (useHttps ? 443 : 80),
        path: `${wpApi.pathname}/media`,
        method: 'POST',
        headers: {
          ...form.getHeaders(),
          Authorization: AUTH_HEADER
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 201) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('Failed to parse the response'));
            }
          } else {
            reject(new Error(`Upload failed: ${res.statusCode} - ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    form.pipe(req);
  });
}

/**
 * Normalise a media file name for WP / image SEO.
 * Rules: ASCII lowercase; spaces/underscores → hyphen; only [a-z0-9-._]; collapse
 * repeated hyphens; trim; keep a 3–4 character image extension; max 80 chars.
 * @param {string} name proposed file name (extension optional)
 * @param {string} fallbackExt extension to enforce, e.g. ".png"
 * @returns {string}
 */
function normalizeMediaFilename(name, fallbackExt = '.png') {
  const ext = fallbackExt.startsWith('.') ? fallbackExt.toLowerCase() : `.${fallbackExt.toLowerCase()}`;
  const raw = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  let base = raw.replace(/[^a-z0-9.-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  base = base.replace(new RegExp(`${ext.replace('.', '\\.')}$`, 'i'), '');
  base = base.slice(0, 80 - ext.length).replace(/-+$/, '');
  return `${base || 'media'}${ext}`;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

/**
 * Upload one local image with complete, normalised media metadata.
 * Shared by the MCP content_media_upload tool and `tengence-geo-content media-upload`.
 * No post type, no DB image records, no stock-site assumptions: file + alt + title
 * + optional filename, nothing else.
 *
 * @param {string} localPath
 * @param {{alt:string, title:string, filename?:string}} opts
 * @returns {Promise<{media_id:number, url:string, url_path:string, filename:string, title:string, alt:string}>}
 */
async function uploadMediaWithMeta(localPath, opts = {}) {
  if (!localPath || !fs.existsSync(localPath)) throw new Error(`Local image does not exist: ${localPath}`);
  const stat = fs.statSync(localPath);
  if (!stat.isFile()) throw new Error(`Not a file: ${localPath}`);
  const ext = path.extname(localPath).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) throw new Error(`Unsupported image extension: ${ext} (png/jpg/jpeg/webp only)`);
  if (stat.size > MAX_MEDIA_BYTES) throw new Error(`Image too large: ${(stat.size / 1048576).toFixed(1)} MB (max 8 MB)`);
  const alt = String(opts.alt || '').trim();
  const title = String(opts.title || '').trim();
  if (!alt) throw new Error('alt is required: describe the image itself in the page language');
  if (!title) throw new Error('title is required: the media title in the page language');
  const rawName = opts.filename ? String(opts.filename) : path.basename(localPath);
  const filename = normalizeMediaFilename(rawName, ext);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tengence-media-'));
  const tmpPath = path.join(tmpDir, filename);
  try {
    fs.copyFileSync(localPath, tmpPath);
    const res = await uploadMedia(tmpPath, { alt, title, filename });
    if (!res || !res.id || !res.source_url) throw new Error('Upload returned no media id / source_url');
    let urlPath = '';
    try { urlPath = new URL(res.source_url).pathname; } catch (e) {}
    return { media_id: Number(res.id), url: res.source_url, url_path: urlPath, filename, title, alt };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

module.exports = { uploadMedia, getMedia, resolveWpUploadTarget, normalizeMediaFilename, uploadMediaWithMeta };
