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
 * Upload a local image to the WordPress media library
 * @param {string} localPath absolute path of the local image
 * @param {{alt?:string, title?:string}} [opts]
 * @returns {Promise<{id:number, source_url:string, guid:object|string, url:string}>}
 */
async function uploadMedia(localPath, opts = {}) {
  if (!fs.existsSync(localPath)) {
    throw new Error(`Local image does not exist: ${localPath}`);
  }
  const { alt = '', title = '' } = opts;
  const { apiUrl, AUTH_HEADER } = resolveWpUploadTarget();

  const form = new FormData();
  form.append('file', fs.createReadStream(localPath));
  form.append('alt_text', alt);
  form.append('title', title || alt);

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

module.exports = { uploadMedia, resolveWpUploadTarget };
