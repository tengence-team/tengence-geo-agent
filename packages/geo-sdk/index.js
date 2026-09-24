/**
 * tengence-geo-sdk — unified library entry
 * ============================================================================
 * This library was extracted from the business repository. Goal: converge the
 * cross-cutting capabilities repeated across the CLIs into "one library + a few thin
 * CLI shells". This file is the library's only external entry, organized by domain:
 *
 *   site      sites & paths       loadSite / contentPaths / readSiteArg
 *   workspace user workspace bind use / current / require (never guessed)
 *   db        connection / tables / repositories  withConn · TABLES · articles · config · terms · images
 *   wp        WordPress exit      target / request / api / apiAll / posts / media
 *   content   content processing  md (Markdown→HTML/plain text) · meta (SEO/GEO)
 *   images    image dedupe & registration  pHash / saveImage / getImageByUrl
 *   search    Google inclusion    discoverSiteUrl / submitSitemap / listSitemaps / inspectUrl / notifyIndexing
 *   llm       LLM calls           providers (registry/enable parsing) / client (OpenAI-compatible unified client)
 *   monitor   GEO brand monitoring  config / prompts / extract / score / run / store
 *   cli       logging / args / errors  log / args / errors
 *
 * Usage:
 *   const t = require('@tengence/geo-sdk');
 *   const s = t.site.loadSite();
 *   await t.db.withConn(async (conn) => { ... });
 *   await t.wp.posts.findBySlug('my-slug');
 *   const html = t.content.md.markdownToHtml(md);
 *   await t.search.submitSitemap(s, 'https://www.tengence.com/sitemap_index.xml');
 *
 * ⚠️ Lazy loading: each domain is required only on first access, so scripts that only
 *    need site are not dragged into loading heavy deps like sharp / mysql2.
 * ⚠️ No compatibility layer: consumers connect to this package directly
 *    (@tengence/geo-sdk).
 * ============================================================================
 */

const api = {};

/**
 * Define a lazy read-only property: runs the loader on first read and caches the result
 */
function lazy(name, loader) {
  Object.defineProperty(api, name, {
    enumerable: true,
    configurable: true,
    get() {
      const value = loader();
      Object.defineProperty(api, name, {
        value,
        enumerable: true,
        configurable: true,
        writable: false,
      });
      return value;
    },
  });
}

lazy('site', () => require('./site'));
lazy('workspace', () => require('./site/workspace'));
lazy('paths', () => require('./paths'));
lazy('db', () => require('./db'));
lazy('plan', () => require('./plan'));
lazy('wp', () => require('./wp'));
lazy('content', () => require('./content'));
lazy('images', () => require('./images'));
lazy('search', () => require('./search'));
lazy('webmaster', () => require('./webmaster'));
lazy('publish', () => require('./publish'));
lazy('check', () => require('./check'));
lazy('syndicate', () => require('./syndicate'));
lazy('taxonomy', () => require('./taxonomy'));
lazy('llm', () => require('./llm'));
lazy('monitor', () => require('./monitor'));
lazy('standards', () => require('./standards'));
lazy('diagnose', () => require('./diagnose'));
lazy('util', () => require('./util'));
lazy('cli', () => ({
  log: require('./cli/log'),
  args: require('./cli/args'),
  errors: require('./cli/errors'),
}));

module.exports = api;
