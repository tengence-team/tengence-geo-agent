# tengence-geo-sdk

The shared library of the Tengence content pipeline — the only dependency layer for every
CLI script under `packages/geo-cli/bin`.

> Extracted from the legacy business scripts into the open-source monorepo
> `tengence-geo-agent` on 2026-09-21 (table prefix `tengence_geo_*`, dual-driver storage,
> `SITES_ROOT` decoupled). No compatibility layer — consumers all require this package directly.

## Structure

```
tengence-geo-sdk/
├── index.js            only public entry: t.site / t.db / t.wp / t.content / t.images / t.cli
├── site/config.js     site & paths: loadSite / contentPaths / readSiteArg / listSites
├── db/
│   ├── connection.js  connection helpers: configFromEnv / createConnection / withConn
│   │                   + DB_DRIVER dispatch (sqlite default / mysql)
│   ├── schema.js      table-name constants TABLES + create/drop DDL
│   ├── sqlite-schema.js  SQLite 16-table DDL (structure aligned with MySQL)
│   ├── sqlite.js      better-sqlite3 facade with mysql2-compatible surface +
│   │                   SQL dialect translation + lazy auto-initialization
│   ├── articles.js    article repository: getById / saveContent / markPublished / list / getDetail
│   ├── config.js      article config repository (config_keywords)
│   ├── terms.js       term repository: getOrCreateTerm / register / listCategories / listTags
│   └── index.js       domain entry
├── wp/
│   ├── target.js      WP endpoint & Basic Auth target resolution (the only place auth headers are built)
│   ├── request.js     request / api / apiAll (the only set of timeout & error handling)
│   ├── posts.js       post body read/write (findBySlug / get / update / create)
│   │                   + SEO/GEO meta (getMeta / saveMeta, via the plugin API)
│   ├── plugin.js      Tengence plugin REST API client (tengence/v1, meta read/write)
│   ├── media.js       media upload: uploadMedia / resolveWpUploadTarget
│   └── index.js       domain entry
├── content/
│   ├── md.js          Markdown: markdownToHtml / stripFrontMatter / extractTitle ...
│   ├── meta.js        SEO·GEO meta: buildSeoGeoMeta / pickMeta / parseFaqFromBody ...
│   ├── http.js        external resource download
│   └── index.js       domain entry
├── images/
│   ├── index.js       image dedup & registration: pHash / saveImage / getImageByUrl ...
│   ├── redline.js     image red-line rules: redLineCheck / scoreCandidate / buildFileName / word lists
│   ├── sources.js     three image-library searches: searchUnsplash / searchPexels / searchPixabay
│   ├── acquire.js     five-step acquisition orchestration: acquire / deriveQuery / getArticleIdBySlug
│   └── (index.js re-exports the public symbols of the above)
├── monitor/           GEO monitoring: config / prompts / run / store (SQLite-compatible)
├── search/            GSC sitemap / IndexNow / Baidu submission, auth
├── plan/              article plan repository (import / list / status transitions)
├── check/             publish gate checks (citation dual-channel / word count / GEO blocks)
├── publish/           publish orchestration (publishArticle, 8 steps + 3 submission hooks)
└── cli/               output log / args / errors
```

## Usage

```js
const t = require('@tengence/geo-sdk');

const site = t.site.loadSite();               // site config (reads SITES_ROOT/<site>/.env + config/*.yaml)
const paths = t.site.contentPaths(site);      // content paths

await t.db.withConn(async (conn) => {         // borrow a connection, auto-closed
  const [rows] = await conn.query('SELECT 1');
});

const post = await t.wp.posts.findBySlug('what-is-geo');
await t.wp.media.uploadMedia(localPath, { alt: 'description' });

// SEO/GEO meta: via the plugin API (tengence/v1), no longer mixed into WP native meta fields
const meta = await t.wp.posts.getMeta(post.id);          // unprefixed keys, arrays/objects decoded
await t.wp.posts.saveMeta(post.id, {                      // partial update; empty value clears
  seo_meta_title: 'New Title',
  geo_qa_pairs: [{ question: 'Q?', answer: 'A.' }],
});
// ⚠️ posts.update / posts.create do not accept meta (stripped with a warning)

// one-call image acquisition (search → red-line filter → download → WebP → upload + register)
const res = await t.images.acquire({ slug: 'what-is-geo', dryRun: false });
```

## Conventions

- **Lazy loading**: each domain is `require`d on first access, so scripts that only need
  `site` are not forced to load `sharp` / `mysql2` / `better-sqlite3`.
- **No fallback defaults**: DB / WP endpoints and credentials all come from
  `SITES_ROOT/<site>/.env` (injected into `process.env` by `loadSite`); missing values throw
  instead of being guessed or filled in.
- **Multi-site**: the library accepts no hard-coded site name; the site key is passed via
  `--site <key>` or `loadSite(key)`.
- **Pure Node**: the library and all CLIs have no Python dependency.
- **Repositories never open connections**: every repository function under `db/` receives a
  caller-supplied `conn` and never calls `createConnection` itself — connection lifecycle is
  uniformly managed by `t.db.withConn` (unit tests can therefore assert SQL sequences with a
  stub conn).
- **Testable**: run `npm test` before touching the library (`tests/`, zero-dependency
  `node:test`); run the `dev/` three-piece toolkit before and after refactors
  (see `dev/README.md`).
