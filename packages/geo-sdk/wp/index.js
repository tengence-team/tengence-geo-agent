/**
 * WordPress domain entry (tengence-geo-sdk/wp)
 * ============================================================================
 * The single WordPress exit of the whole SDK. Aggregated after batch B:
 *   target   endpoint & credential resolution (the only place that builds Basic Auth)
 *   request  low-level HTTP / JSON API / auto-pagination (the only set of timeout
 *            and error handling)
 *   posts    article read/write (findBySlug / get / update / create)
 *   media    media upload
 *
 * Usage:
 *   const wp = require('../tengence-geo-sdk/wp');
 *   const post = await wp.posts.findBySlug('my-slug');
 *   await wp.update(post.id, { title: 'New title' });
 *   await wp.media.uploadMedia('/path/to.webp', { alt: 'Description' });
 * ============================================================================
 */

const media = require('./media');
const target = require('./target');
const request = require('./request');
const posts = require('./posts');
const plugin = require('./plugin');

module.exports = {
  target,
  request: request.request,
  api: request.api,
  apiAll: request.apiAll,
  posts,
  media,
  plugin,
  ...media,
};
