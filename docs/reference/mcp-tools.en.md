# MCP Tools Reference — 72 tools

> English version. For 中文版 see [mcp-tools.zh.md](mcp-tools.zh.md).
>
> Authoritative source: `packages/geo-mcp/tools/registry.js`. Each tool =
> `{ name, description, inputSchema, run }`; every response is a JSON string under
> `content[0].text`, with `ok: true` on success or `{ ok: false, error }` on failure
> (marked `isError`).
>
> **Workspace & site resolution:** most tools accept an optional `site`. The workspace
> comes from (a) `workspace_use` argument, (b) a previous `workspace_use` in this
> session, (c) persisted state, or (d) `SITES_ROOT`. The site is auto-selected when the
> workspace holds exactly one site; otherwise an explicit `site` is required.
>
> **Language codes** are unified to `zh-hans | en | zh-hant`; legacy region codes
> (`zh-cn`/`en-us`/`zh-hk`/`zh-tw`…) are rejected.

## 1. Workspace & Site (5)

### `workspace_use`
Bind the user workspace directory — all site config, credentials and output files live
under it. Call this first.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `path` | string | yes | Absolute directory chosen by the user (e.g. `~/my-geo-workspace`) |
| `create` | boolean | no | Create the directory when missing (default `false`) |

### `site_init`
Scaffold a site inside the bound workspace: `<workspace>/<key>/{config,data/inbox,data/reports,.env}`. Idempotent, never overwrites existing files.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `key` | string | yes | Site key (lowercase letters, digits, underscore) |
| `domain` | string | no | Canonical domain, defaults to the key |
| `name` | string | no | Display name, defaults to the domain |
| `lang` | string | no | Default language (default `zh-hans`) |

### `site_list`
List the sites inside the bound workspace (key, domain, app_id, storage driver). Returns a hint when no workspace is bound.

*Parameters:* none.

### `site_status`
Site status: config paths, `.env` readiness, DB driver and SQLite init state.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `site` | string | no | Site key; auto-selected when the workspace holds exactly one site |

### `util_ping`
Connectivity self-check: SDK version, driver, internal data directory, bound workspace and site count.

*Parameters:* none.

---

## 2. Diagnosis & Plan Generation (3)

### `diagnose_site`
Full GEO/SEO site diagnosis: domain (DNS/TLS/WHOIS), transport & server fingerprint (CMS/framework/platform/CDN), robots.txt, sitemap, homepage + representative pages (meta, H1–H6 structure, JSON-LD, OG, images/alt, links, mixed content), performance and security. Bootstraps the site on first use.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `url` | string | yes | Site URL, e.g. `https://www.example.com` |
| `site` | string | no | Site key |
| `pages` | array(string) | no | Extra page URLs to diagnose in addition to the homepage |
| `max_pages` | integer | no | Max representative pages to sample (default 4; the site is sampled, never fully crawled) |

### `site_geo_plan_skill`
Read-only access to the site-geo-plan skill specification (`SKILL.md` + `references/plan-template.md`) governing detailed GEO/SEO implementation plan generation (multi-part: 上篇技术修复/中篇关键词与内容/价值桥接/下篇实施保障/附录; every diagnosis issue expanded 现状→方案→步骤→验收; full keyword matrix; manpower person-day matrix). Returns both files verbatim.

*Parameters:* none.

### `report_write`
Write a Markdown report into `<site>/data/reports/` (path-safe). Auto-bootstraps the site on first use.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `content` | string | yes | Markdown report content |
| `filename` | string | no | Report filename (default `<YYYYMMDD>-<site>-diagnosis.md`) |
| `site` | string | no | Site key |

---

## 3. Writing Standards (3)

### `standards_list`
List the generic writing & GEO standards shipped with the engine (titles, whether a site-specific supplement exists).

*Parameters:* none.

### `standards_read`
Read a generic standard document (base + any site-specific supplement merged). Names are repository-relative without `.md`, e.g. `article-writing-standards`, `content-strategy`, `block-conventions`, `templates/skeletons/howto`, `templates/research-brief`.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Standard name without `.md` (e.g. `article-writing-standards`) |

### `article_draft`
Assemble a ready-to-use writing brief: the matched **T1–T7 body skeleton**, the pre-writing **research-brief template**, and the full **writing standard** (base + supplement). Call this first, then write the Markdown body, then `check_article`.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `type` | string | no | T1–T7 body type: `definition|howto|product|case|industry|comparison|guide` (default `guide`) |
| `topic` | string | no | Working topic / target keyword (echoed into the brief for context) |
| `site` | string | no | Site key |

---

## 4. Articles & Content (4)

### `article_list`
List articles (articles table), with status/lang/limit filters.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `site` | string | no | Site key |
| `status` | string | no | `draft|queued|published` etc. (optional) |
| `lang` | string | no | Language filter (`zh-hans|en|zh-hant`; default all) |
| `limit` | number | no | Max rows (default 50) |

### `wp_post_get`
Read-only WordPress post lookup by `wp_post_id`, or by `slug`+`lang` (resolved through the plugin language endpoint). Optionally returns the full body HTML.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `site` | string | no | Site key |
| `wp_post_id` | number | no | WordPress post ID |
| `slug` | string | no | Article slug (required when `wp_post_id` omitted) |
| `lang` | string | no | Language for a slug lookup: `zh-hans\|en\|zh-hant` (default `zh-hans`) |
| `include_content` | boolean | no | Also return the post body HTML (default `false`) |

### `article_ingest`
Content ingest (single entry): body md + research brief → articles table (CLI canonical orchestration).

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `slug` | string | yes | Article slug |
| `md_path` | string | yes | Absolute path to the body Markdown file |
| `research_path` | string | no | Absolute path to the research brief (required by the publish gate) |
| `site` | string | no | Site key |
| `lang` | string | no | Language (defaults to the site default) |

### `article_export`
Export an article md + brief from the DB to `<site>/data/inbox` (for rewriting / translation).

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `slug` | string | yes | Article slug |
| `site` | string | no | Site key |
| `lang` | string | no | Language (`zh-hans|en|zh-hant`; default the site default) |

---

## 5. Editorial & Translation Gates (3)

### `check_article`
Publish gate: enforces the editorial rules codified in `article-writing-standards` (citation dual-channel, word count by T1–T7 type, banned words, the GEO blocks — Summary/Key Takeaways/FAQ/Data Sources — and the research-brief hard check). Read the standard via `standards_read` before authoring, and run `article_draft` first.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `slug` | string | yes | Article slug |
| `site` | string | no | Site key |
| `type` | string | no | T1..T7 (hard word-count check by type when declared) |
| `lang` | string | no | Article language (default the site default) |

### `translation_glossary_get`
Translation glossary for a target language: merged global + site glossary (brands / phrases / product terms / forbidden words).

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `site` | string | no | Site key |
| `target_lang` | string | yes | Target language (`en|zh-hant`) |

### `check_translation`
Mechanical gate for a translated article (T1–T9): structure/blocks/numbering, link-set & image-set & number-set parity with the source, Simplified-Chinese & CJS residue, forbidden terms, per-section length, title & meta_description lengths. Run before `article_ingest --lang`.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `slug` | string | yes | Article slug (source and, when `md_path` absent, target DB row) |
| `source_lang` | string | yes | Source language (`zh-hans`) |
| `target_lang` | string | yes | Target language (`en|zh-hant`) |
| `md_path` | string | no | Absolute path to the translated Markdown (preferred; when absent the target is read from the DB) |
| `site` | string | no | Site key |

---

## 6. Image Acquisition (1)

### `image_acquire`
Auto image pipeline: **search → red-line filter → download → WebP crop → upload to WP media library**.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `query` | string | yes | Image search keyword |
| `slug` | string | yes | Target article slug (for registration) |
| `site` | string | no | Site key |
| `count` | number | no | Count (default 3) |
| `dry_run` | boolean | no | Preview only, nothing persisted |

---

## 7. Article Plan Table (3)

### `plan_list`
Article plan table list (status/batch/node/lang filters). Each language is its own row.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `site` | string | no | Site key |
| `status` | string | no | `todo|written|queued|published` etc. |
| `batch` | string | no | Batch |
| `lang` | string | no | `zh-hans|en|zh-hant` (default: all languages) |
| `limit` | number | no | Max rows (default 100) |

### `plan_import`
Import/update the plan table (idempotent upsert by `(slug, lang)`). Two modes: (a) no `rows` — DB-only maintenance (backfill article_id/wp_post_id/published_url/featured_image, reconcile status, assign publish_order); (b) `rows[]` — write explicit plan rows directly (how a translation row is created/updated). Never reads a plan document — convert a markdown/JSON plan to `rows[]` first.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `site` | string | no | Site key |
| `rows` | array(object) | no | Explicit plan rows to upsert (per-language). Each row: `slug` (string, req), `lang` (zh-hans|en|zh-hant, default zh-hans), `node_type` (spoke\|hub, default spoke), `title`, `publish_order` (queue position; translations share the source value), `publish_batch`, `category`, `tags` (array), `article_id`, `wp_post_id`, `published_url`, `plan_status` (todo|written|queued|published|paused), `queued_at`, `published_at`, `languages` (WP locale list), `notes` |

### `plan_mark_status`
Update a plan row status (`todo/written/queued/published/archived`).

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `slug` | string | yes | Article slug |
| `status` | string | yes | Target status |
| `site` | string | no | Site key |

---

## 8. WordPress Publishing (5)

### `publish_draft`
Publish a draft (default `draft` → WP; can `--status=publish` directly, must pass the gate first).

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `md_path` | string | yes | Absolute path to the body Markdown |
| `site` | string | no | Site key |
| `status` | string | no | `draft|publish` (default `draft`) |

### `publish_from_db`
Publish an article from the DB to WordPress (`--force` updates an existing article). For translations (en/zh-hant) the zh-hans source's publish+update time is inherited by default; pass `sync_source_dates=false` to opt out.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `article_id` | number | yes | `articles.id` |
| `site` | string | no | Site key |
| `status` | string | no | `draft|publish` (default `draft`) |
| `force` | boolean | no | Force-update when it already exists |
| `translation_group` | string | no | Translation-group UUID shared by the languages of one article |
| `sync_source_dates` | boolean | no | Inherit the zh-hans source publish/update time (default true; translations only) |

### `publish_update_article`
Update an existing article (title/content/status + sync SEO/GEO meta). When `meta_title`/`meta_description`/`post_title` is provided it runs **meta-only mode** (updates only those fields, body untouched). For single-field edits prefer `publish_update_fields`.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `md_path` | string | no | Body Markdown (required for full update; omit in meta-only mode) |
| `meta_title` | string | no | New SEO title (≤200 chars). Providing it switches to meta-only mode |
| `meta_description` | string | no | New meta_description (165–175 chars). Meta-only mode |
| `post_title` | string | no | New WP post title (≤200 chars, also updates DB title). Meta-only mode |
| `site` | string | no | Site key |
| `article_id` | number | no | `articles.id` (resolved to slug+lang+wp_post_id) |
| `slug` | string | no | Target slug |
| `lang` | string | no | Article language for slug lookup (default the site default) |
| `post_id` | number | no | Target WP post id (either slug or post_id) |

### `publish_update_fields`
Update **any** article attribute through one entry point. Fields are routed to the only API that can write them: WP native (`/wp/v2`: title/content/excerpt/slug/status/categories/tags/sticky/featured_media), plugin meta (`PUT /tengence/v1/posts/{id}`: image, image_alt, reading_time, author, i18n, regions, cta, `seo_*`, `geo_*`), plugin dates API (date, date_gmt, modified, modified_gmt). Only the passed fields are touched.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `site` | string | no | Site key |
| `article_id` | number | no | `articles.id` — resolved to its `wp_post_id`; omit when `wp_post_id` given |
| `wp_post_id` | number | no | Target WP post id; overrides the DB mapping when given |
| `lang` | string | no | Article language for the DB mirror |
| `title`/`content`/`excerpt`/`slug` | string | no | WP native fields |
| `status` | string | no | `draft|publish|pending|private` (WP native) |
| `categories`/`tags` | array(number\|string) | no | Term IDs or slugs; slugs resolved, pass `create_terms` to auto-create |
| `create_terms` | boolean | no | Create missing category/tag slugs instead of failing |
| `sticky` | boolean | no | Sticky flag (WP native) |
| `featured_media` | number | no | Featured image **media ID** (WP native); pair with `image` (URL) to keep both in sync |
| `image`/`image_alt`/`reading_time`/`author` | — | no | Plugin meta: base |
| `i18n`/`regions`/`cta` | — | no | Plugin meta |
| `seo_meta_title`/`seo_meta_description` | string | no | SEO group |
| `seo_meta_keywords` | array(string) | no | SEO keywords |
| `seo_canonical_url`/`seo_og_type`/`seo_og_locale`/`seo_og_image` | string | no | SEO group |
| `seo_noindex` | boolean | no | noindex flag |
| `geo_ai_summary` | string | no | GEO AI summary |
| `geo_qa_pairs` | array(any) | no | `[{question,answer}]` |
| `geo_citations` | any | no | GEO citations (array or object) |
| `geo_key_takeaways` | array(string) | no | GEO key takeaways |
| `geo_schema_data`/`geo_entity` | any | no | GEO schema / entity |
| `date`/`date_gmt`/`modified`/`modified_gmt` | string | no | Dates (plugin dates API) |
| `copy_dates_from` | number | no | WP post id to copy all four date values from (e.g. the zh-hans source) |
| `language` | string | no | Set the post language via the plugin language API |
| `translation_group` | string | no | Translation-group UUID |
| `sync_db` | boolean | no | Mirror title/seo_meta_title/seo_meta_description into the DB (default true) |
| `dry_run` | boolean | no | Validate and report the routing without writing anything |

### `publish_daily`
Run the daily promotion task (promotes due drafts to publish by plan `publish_order`; default 1/day). Optional `date` sets the promoted article's publish/modified time (site timezone). Optional `slug` switches to slug mode (publish that slug in every language it has).

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `site` | string | no | Site key |
| `date` | string | no | Publish/modified time `YYYY-MM-DDTHH:MM:SS` (site timezone); omit to leave WP untouched |
| `slug` | string | no | Slug mode: publish this slug in all languages (comma-separated); omit for the plan-order queue |
| `count` | number | no | How many to promote in queue mode (default `wordpress.publish.per_day`, usually 1) |
| `dry_run` | boolean | no | Report only, do not write |

---

## 9. Database (2)

### `db_init`
Explicitly initialize the database (sqlite idempotent table creation / mysql DDL; `--drop` rebuilds).

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `site` | string | no | Site key |
| `drop` | boolean | no | Drop and rebuild (dangerous) |

### `db_status`
Database status: driver, path, schema version, table list, missing tables.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `site` | string | no | Site key |

---

## 10. Search Inclusion Submission (7)

### `search_gsc_stats`
Read Google Search Console Search Analytics data (clicks/impressions/CTR/avg position) grouped by query/page/date/country/device. The only Google source for search performance. GSC data is finalised 2–3 days late; default window = the 28 days ending 3 days ago. Requires a GSC service account.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `site` | string | no | Site key |
| `dimensions` | array(enum) | no | Group-by: `query|page|date|country|device` (default `["query"]`) |
| `start_date` | string | no | `YYYY-MM-DD` (default: 27 days before end_date) |
| `end_date` | string | no | `YYYY-MM-DD` (default: 3 days ago) |
| `row_limit` | number | no | Max rows (default 100) |

### `search_gsc_inspect`
Query one URL's Google indexing status (URL Inspection API, read-only): verdict, coverageState, indexingState, lastCrawlTime, googleCanonical. Quota: 2000 calls/day.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `url` | string | yes | Fully-qualified URL to inspect |
| `site` | string | no | Site key |

### `search_submit_gsc`
Submit the sitemap to Google Search Console (soft-fail).

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `site` | string | no | Site key |
| `sitemap_url` | string | no | Sitemap URL (default: auto-derived) |

### `search_submit_indexnow`
Submit URLs to IndexNow (requires `INDEXNOW_KEY`).

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `url` | string | yes | URLs to submit (multiple, comma-separated) |
| `site` | string | no | Site key |

### `search_submit_baidu`
Submit URLs to Baidu normal inclusion (requires `BAIDU_TOKEN`/`BAIDU_SITE`). Two modes: explicit `url` list, or `all=true` sitemap incremental mode (recursively flattens `sitemap_index.xml`, skips URLs already logged in `data/baidu-log.jsonl`, pushes ≤`limit`).

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `url` | string | no | URLs to submit (comma-separated, ≤2000 per call); omit when `all=true` |
| `all` | boolean | no | Sitemap incremental mode: push only URLs not yet logged |
| `limit` | number | no | Max URLs to push when `all=true` (default 10) |
| `site` | string | no | Site key |

### `webmaster_bing_status`
Read Bing Webmaster console data (verified sites / URL submission quota / query stats / crawl issues). Requires `BING_WEBMASTER_API_KEY`. Note: Bing trimmed its JSON API on 2026-08-31.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `action` | enum | yes | `sites|quota|stats|issues` |
| `site` | string | no | Site key |

### `webmaster_bing_submit`
Write to Bing Webmaster: submit URL(s) (comma-separated = batch, ≤10000 per call). Requires `BING_WEBMASTER_API_KEY`.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `url` | string | yes | URL(s) to submit; multiple allowed, comma-separated |
| `site` | string | no | Site key |

---

## 11. GEO Monitoring (2)

### `monitor_run`
Run GEO monitoring (one round of site prompts × models; results persisted).

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `site` | string | no | Site key |
| `run_id` | string | no | `YYYYMMDD` (default today) |
| `models` | array(string) | no | Subset of model keys |
| `layers` | array(string) | no | Subset of layers |

### `monitor_report`
Read monitoring results (latest round or a given `run_id`).

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `site` | string | no | Site key |
| `run_id` | string | no | `YYYYMMDD` (default latest) |

---

## 12. Cross-Platform Syndication (15)

### `channel_list`
List all external content platforms in the syndicate registry: API type (official|cookie|none), status, capabilities and the full platform rewrite rules. READY: wechat (official API), juejin (cookie), csdn (cookie).

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `platform` | string | no | Filter to one platform key |

### `channel_style_get`
Return the FULL platform style / rewrite rules for ONE platform (wechat / juejin / blog…). The server only serves the rules; the harness/Skill does the rewriting. Always call before rewriting.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `platform` | string | yes | Platform key, e.g. `wechat / juejin / blog` |

### `channel_check`
Validate a title/body against a platform's style rules (deterministic, no content generation). Returns errors (HARD) and warnings (SOFT) plus the checklist and rewrite strategy.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `platform` | string | yes | Platform key |
| `title` | string | no | Article title to validate |
| `body` | string | no | Article body (markdown) to validate |

### `channel_publish`
Publish/export to one external platform. **Mode A:** pass `slugs[]`, the server reads the DB and runs the platform pipeline (wechat drafts box; juejin draft→publish; csdn draft→publish; devto publish). **Mode B:** pass pre-written `articles[]` (harness-rewritten) and the server exports publish packages to `<site>/data/channel-export/<platform>/<slug>.md`. `asDraft` defaults true (never mass-sends). Every outcome is logged to `channel_plan` under its own platform.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `platform` | string | yes | Platform key (see `channel_list`) |
| `slugs` | array(string) | no | Mode A: article slugs to publish through the pipeline |
| `articles` | array(object) | no | Mode B: pre-written articles `{slug,title,contentMd,summary?,tags?,sourceUrl?,cover?,rewrite?,mode?}` |
| `asDraft` | boolean | no | Default true: create draft (wechat/juejin), never mass-send |
| `keepOrder` | boolean | no | Wechat only: keep slugs order (1st = headline) |
| `dryRun` | boolean | no | Print the plan, no external calls |
| `site` | string | no | Site key |

### `channel_plan_next`
Per-platform publishing calendar: return the next article to publish for a platform plus all calendar rows. Each platform derives its queue from the blog article_plan (nextDue = next blog-published article not yet published on that platform).

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `platform` | string | no | Filter rows to one platform (default all) |
| `count` | number | no | How many articles the NEXT send should contain (wechat merges them into one 图文 message; default 1) |

### `channel_plan_mark`
Update a channel_plan row status (`todo|draft|published|paused`) and optionally record its draft ids (e.g. wechat media_id).

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `id` | number | yes | channel_plan row id |
| `status` | enum | yes | `todo|draft|published|paused` |
| `draftIds` | array(string) | no | Draft/media ids to record (e.g. wechat media_id); omit to keep existing |

### `channel_plan_reconcile`
Reconcile a platform channel_plan with what is actually published on that platform (juejin | csdn). Seeds the publish log with already-published articles. Idempotent (upsert by slug). Run once per platform before the first `channel_plan_next`.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `platform` | string | yes | Platform key, e.g. `juejin` or `csdn` |
| `map` | array(object) | no | Explicit known published `{slug,title?,blogOrder?}`; omit to live-read the platform |
| `site` | string | no | Site key |

### `channel_taxonomy_sync`
Refresh the cached dictionary of an external platform's own taxonomy (category + tag id/name) into `channel_taxonomy`. Currently juejin: 8 categories + ~725 tags. Idempotent; requires `JUEJIN_COOKIE`.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `platform` | string | no | Platform key (default juejin) |
| `site` | string | no | Site key |

### `channel_taxonomy_list`
Read the cached external-platform taxonomy dictionary, filtered by `kind`, exact `name`, or `prefix`.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `platform` | string | no | Platform key (default juejin) |
| `kind` | enum | no | `category|tag` (omit for both) |
| `name` | string | no | Exact name lookup (case-insensitive) |
| `prefix` | string | no | Name prefix lookup, e.g. `"搜索"` |
| `limit` | number | no | Max rows (default 100) |
| `site` | string | no | Site key |

### `channel_taxonomy_resolve`
Preview how OUR taxonomy maps onto a platform's (`article_plan.category/tags` → platform category_id/tag_ids) WITHOUT publishing. Returns chosen ids/names plus per-item origin (alias/exact/token/fuzzy/default/env/first/hardcoded). Never makes external calls, never writes.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `category` | string | no | Our category slug, e.g. `geo-ai-search` |
| `tags` | array(string) | no | Our tag slugs, e.g. `["geo-seo","search-system"]` |
| `keywords` | array(string) | no | Extra keywords (article target_keywords) |
| `platform` | string | no | Platform key (default juejin) |
| `site` | string | no | Site key |

### `juejin_status`
Read the Juejin backend: the draft box and the published list. Read-only. Requires `JUEJIN_COOKIE` + `JUEJIN_UID`.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `page` | number | no | Page index (default 0, 50 per page) |
| `site` | string | no | Site key |

### `juejin_draft_delete`
Delete a Juejin draft. **IRREVERSIBLE** — `confirm=true` only after verifying the id via `juejin_status`.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `draftId` | string | yes | Draft id from `juejin_status` |
| `confirm` | boolean | yes | Must be `true` to actually delete |
| `site` | string | no | Site key |

### `juejin_article_delete`
Delete a published Juejin article. **IRREVERSIBLE** — `confirm=true` only after verifying via `juejin_status`.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `articleId` | string | yes | Article id from `juejin_status` |
| `confirm` | boolean | yes | Must be `true` to actually delete |
| `site` | string | no | Site key |

### `csdn_status`
Read the CSDN blog backend: draft box and published list. Read-only. Requires `CSDN_COOKIE`. An expired login surfaces as `cookieExpired=true`.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `page` | number | no | 1-based page index (default 1) |
| `pageSize` | number | no | Page size (default 20) |
| `site` | string | no | Site key |

### `csdn_article_delete`
Delete a CSDN article. **IRREVERSIBLE** — `confirm=true` only after verifying via `csdn_status`.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `articleId` | string | yes | Article id from `csdn_status` |
| `deep` | boolean | no | Also purge from the recycle bin (default false) |
| `confirm` | boolean | yes | Must be `true` to actually delete |
| `site` | string | no | Site key |

---

## 13. Multilingual Term Names — categories / tags / authors (11)

These wrap the Tengence plugin endpoints (`/tengence/v1/term-names`, `/author-names`), driven by `TENGENCE_SITE_ID` / `TENGENCE_SECRET` in the site `.env`. Language keys accept `en / zh-hans / zh-hant`.

### `term_names_list`
List the multilingual display-name table for WP categories & tags.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `taxonomy` | enum | no | `category|post_tag` (omit for both) |
| `site` | string | no | Site key |

### `article_terms_sync`
Read and/or set an article's WP classification (category + post_tag) using **term slugs**. Three modes: read (target only), write (category_slugs/tag_slugs), mirror (copy_from). Returns a before/after diff.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `site` | string | no | Site key |
| `wp_post_id` | number | no | Target WP post id; omit when `slug` given |
| `slug` | string | no | Target article slug (required when `wp_post_id` omitted) |
| `lang` | string | no | Language for slug lookup (default `zh-hans`) |
| `copy_from` | number | no | Source wp_post_id whose categories+tags should be mirrored |
| `category_slugs` | array(string) | no | Category slugs to set |
| `tag_slugs` | array(string) | no | Tag slugs to set |
| `create_terms` | boolean | no | Create missing term slugs instead of failing |
| `dry_run` | boolean | no | Resolve + report without touching WP |

### `term_name_get`
Read the multilingual display names of ONE WP term.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `taxonomy` | enum | yes | `category` or `post_tag` |
| `slug` | string | yes | Term slug, e.g. `geo-ai-search` |
| `site` | string | no | Site key |

### `term_name_set`
Set (upsert) the multilingual display names of ONE term: `{"names":{"en":"...","zh-hans":"...","zh-hant":"..."}}`. Empty string clears that language.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `taxonomy` | enum | yes | `category` or `post_tag` |
| `slug` | string | yes | Term slug |
| `names` | object | yes | Language code → display name; `""` clears that language |
| `site` | string | no | Site key |

### `term_name_delete`
Delete the multilingual display names of ONE term. `lang` removes only that language.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `taxonomy` | enum | yes | `category` or `post_tag` |
| `slug` | string | yes | Term slug |
| `lang` | string | no | Remove only this language (omit to remove all configured names) |
| `site` | string | no | Site key |

### `term_names_batch`
Batch-set multilingual display names for many terms: `{"category":{"<slug>":{"<lang>":"<name>"}},"post_tag":{...}}`.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `category` | object | no | Category slug → `{lang: name}` |
| `post_tag` | object | no | Tag slug → `{lang: name}` |
| `site` | string | no | Site key |

### `author_names_list`
List the multilingual display names for all WP authors.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `site` | string | no | Site key |

### `author_name_get`
Read the multilingual display names of ONE WP author.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `id` | integer | yes | WP author/user ID |
| `site` | string | no | Site key |

### `author_name_set`
Set (upsert) the multilingual display names of ONE author: `{"names":{"en":"...","zh-hans":"..."}}`. Empty string clears that language.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `id` | integer | yes | WP author/user ID |
| `names` | object | yes | Language code → display name; `""` clears that language |
| `site` | string | no | Site key |

### `author_name_delete`
Delete the multilingual display names of ONE author. `lang` removes only that language.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `id` | integer | yes | WP author/user ID |
| `lang` | string | no | Remove only this language |
| `site` | string | no | Site key |

### `author_names_batch`
Batch-set multilingual display names for many authors: `{"authors":{"<id>":{"<lang>":"<name>"}}}`.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `authors` | object | yes | Author id (numeric string) → `{lang: name}` |
| `site` | string | no | Site key |

---

## 14. WeChat (8)

### `wechat_status`
Read the WeChat official-account backend: the draft box and the mass-sent list. Requires `WECHAT_APP_ID`/`SECRET` and the outbound IP whitelisted.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `site` | string | no | Site key |

### `wechat_stats`
Read official-account statistics from the WeChat backend (`datacube/*`). T+1 data; most endpoints allow a ≤7d window; `article_read`/`article_share`/`article_detail` require `begin_date === end_date`.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `action` | enum | no | `overview|user_summary|user_cumulate|upstream_msg|interface_summary|biz_summary|article_read|article_share|article_detail` (default `overview`) |
| `begin_date` | string | no | `YYYY-MM-DD` (default: 6 days before end_date) |
| `end_date` | string | no | `YYYY-MM-DD` (default: yesterday; today never available) |
| `site` | string | no | Site key |

### `wechat_sync_progress`
Reconcile the channel_plan calendar with the real WeChat backend and auto-fix the DB. `dryRun=true` previews without writing.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `site` | string | no | Site key |
| `dryRun` | boolean | no | Compute and report, do not write |

### `wechat_mass_preview`
Send a draft (media_id) to one user as a preview. Requires a verified account.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `media_id` | string | yes | Draft box media_id |
| `openid` | string | no | Receiver openid |
| `wxname` | string | no | Receiver wxname |
| `dryRun` | boolean | no | Print the payload, do not send |
| `site` | string | no | Site key |

### `wechat_mass_send`
Mass-send (push to followers) a draft. Subscription accounts get 1 per day; after success the draft is consumed. **High-risk** — requires `confirm="YES"`.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `media_id` | string | yes | Draft box media_id |
| `tag_id` | number | no | Send to one user tag only (omit = all followers) |
| `to_users` | array(string) | no | Specific openids |
| `client_msg_id` | string | no | De-duplicates repeated sends |
| `confirm` | enum | no | Must be `"YES"` to push to followers (not needed for `dryRun`) |
| `dryRun` | boolean | no | Print the payload, do not send |
| `site` | string | no | Site key |

### `wechat_mass_status`
Query a mass-send task status.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `msg_id` | number | yes | Mass-send task msg_id |
| `site` | string | no | Site key |

### `wechat_article_delete`
Delete a published article. **IRREVERSIBLE** — `confirm="YES"`. `index` (1-based) deletes one article of a multi-article message; omit to delete the whole message.

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `article_id` | string | yes | Published article_id |
| `index` | number | no | 1-based position within the message |
| `confirm` | enum | no | Must be `"YES"` (irreversible) |
| `dryRun` | boolean | no | Print the payload, do not delete |
| `site` | string | no | Site key |

### `wechat_draft_publish`
Publish a draft box media_id to the account homepage via `freepublish/submit` (no push to followers).

| Parameter | Type | Req. | Description |
| --- | --- | --- | --- |
| `media_id` | string | yes | Draft box media_id |
| `dryRun` | boolean | no | Print the payload, do not publish |
| `site` | string | no | Site key |

---

## Response format

Every tool returns MCP text content holding a JSON string. Success shape is
domain-specific but always includes `ok: true`; errors are `{ ok: false, error }` with
`isError` set, so AI clients can react deterministically.
