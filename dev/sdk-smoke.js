#!/usr/bin/env node
/**
 * tengence-geo-sdk export smoke test — regression baseline (3/3)
 * ============================================================================
 * Verifies:
 *   ① the unified entry require('@tengence/geo-sdk') lazily loads every domain
 *   ② each domain's public symbols exist with the right types
 *   ③ cli/args key parsing behaviors
 *
 *   node dev/sdk-smoke.js      # exit code 0 = all green
 *
 * Note: SITES_ROOT points at examples/site-template (fixture site); no external
 * site directory is required.
 * ============================================================================
 */

const path = require('path');

process.env.SITES_ROOT = path.resolve(__dirname, '..', 'examples');

const REPO = path.resolve(__dirname, '..');
const SDK = path.join(REPO, 'packages', 'geo-sdk');

const t = require(SDK);

const results = [];
const check = (name, cond, extra = '') => {
  results.push(`${cond ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`);
  return cond;
};

// Baseline re-laid on structural changes: batch 5 added search, batch 7 added util,
// P1 (2026-09-16) added llm/monitor, P2 (2026-09-20) added publish/check/syndicate/taxonomy
check('top-level domains', JSON.stringify(Object.keys(t)) === '["site","db","plan","wp","content","images","search","publish","check","syndicate","taxonomy","llm","monitor","util","cli"]', Object.keys(t).join(','));

const s = t.site.loadSite('site-template');
check('t.site.loadSite()', s.siteKey === 'site-template', s.siteKey);
check('t.site.contentPaths()', t.site.contentPaths(s).lang === 'zh-CN');
check('t.db.TABLES.articles', t.db.TABLES.articles === 'tengence_geo_articles', t.db.TABLES.articles);
check('t.db.withConn is a function', typeof t.db.withConn === 'function');
check('t.db.CREATED_BY_DB_INIT = 16 (article_config retired 2026-09-20)', t.db.CREATED_BY_DB_INIT.length === 16, String(t.db.CREATED_BY_DB_INIT.length));
check('t.db.MISSING_IN_DB_INIT cleared', t.db.MISSING_IN_DB_INIT.length === 0, t.db.MISSING_IN_DB_INIT.join(','));
check('createTablesSQL includes images + article_images tables', /tengence_geo_images/.test(t.db.createTablesSQL) && /article_images/.test(t.db.createTablesSQL));
check('t.db.createTablesSQL non-empty', typeof t.db.createTablesSQL === 'string' && t.db.createTablesSQL.length > 1000);
check('t.db.articles.getById is a function', typeof t.db.articles.getById === 'function');
check('t.db.config.getFull is a function', typeof t.db.config.getFull === 'function');
check('t.db.terms.register is a function', typeof t.db.terms.register === 'function');
check('t.wp.uploadMedia is a function', typeof t.wp.uploadMedia === 'function');
check('t.wp.media.uploadMedia same reference', t.wp.media.uploadMedia === t.wp.uploadMedia);
check('t.wp.api / apiAll / request are functions', [t.wp.api, t.wp.apiAll, t.wp.request].every((f) => typeof f === 'function'));
check('t.wp.posts.findBySlug is a function', typeof t.wp.posts.findBySlug === 'function');
check('t.content.md.markdownToHtml is a function', typeof t.content.md.markdownToHtml === 'function');
check('t.content.meta.buildSeoGeoMeta is a function', typeof t.content.meta.buildSeoGeoMeta === 'function');
check('t.content.http.download is a function', typeof t.content.http.download === 'function');
check('t.content.md.markdownToHtml works', t.content.md.markdownToHtml('# T').includes('<h1>'));
check('t.images.getImageByUrl is a function', typeof t.images.getImageByUrl === 'function');
check('t.db.images === t.images', t.db.images === t.images);
// Batch 2 sink-down: the image pipeline (red-line / sources / five-step orchestration) moved into the images domain
check('t.images.acquire is a function', typeof t.images.acquire === 'function');
check('t.images.redline.redLineCheck is a function', typeof t.images.redline.redLineCheck === 'function');
check('t.images.sources.searchUnsplash is a function', typeof t.images.sources.searchUnsplash === 'function');
check('red-line rule decides', t.images.redline.redLineCheck({ width: 2000, height: 1200, alt: 'a modern office desk' }, '').ok === true);
// Batch 2 sink-down: db-query SQL moved into the db domain
check('t.db.articles.list is a function', typeof t.db.articles.list === 'function');
check('t.db.articles.getDetail is a function', typeof t.db.articles.getDetail === 'function');
check('t.db.terms.listCategories is a function', typeof t.db.terms.listCategories === 'function');
check('t.db.terms.listTags is a function', typeof t.db.terms.listTags === 'function');
check('t.cli.log.step is a function', typeof t.cli.log.step === 'function');
check('t.cli.args.parse is a function', typeof t.cli.args.parse === 'function');
check('t.cli.errors.run is a function', typeof t.cli.errors.run === 'function');

// ---- Deleted compatibility layer must not come back (prevents falling back to old paths) ----
const fs = require('fs');
check(
  'all SDK domain entries present',
  ['site/index.js', 'db/index.js', 'wp/index.js', 'content/index.js', 'images/index.js', 'cli/log.js', 'cli/args.js', 'cli/errors.js']
    .every((p) => fs.existsSync(path.join(SDK, p)))
);

// ---- cli/args small cases (no external environment) ----
const { parse } = t.cli.args;
const p = parse(
  { force: { type: 'boolean', alias: ['f'] }, status: { type: 'string', default: 'draft' }, slug: { type: 'array' } },
  ['318', '--force', '--status=publish', '--slug', 'a', '--slug=b']
);
check('cli/args positionals', JSON.stringify(p.positionals) === '["318"]', JSON.stringify(p.positionals));
check(
  'cli/args boolean/equals/array',
  p.flags.force === true && p.flags.status === 'publish' && JSON.stringify(p.flags.slug) === '["a","b"]',
  JSON.stringify(p.flags)
);

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('❌')).length;
console.log(`\nTotal ${results.length} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
