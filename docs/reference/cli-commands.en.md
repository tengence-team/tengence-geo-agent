# CLI Commands Reference — 24 commands

> English version. For 中文版 see [cli-commands.zh.md](cli-commands.zh.md).
>
> Authoritative source: `packages/geo-cli/bin/`. All commands share the `tengence-geo-`
> prefix (bin name) and the environment of `@tengence/geo-mcp` (`SITES_ROOT` /
> `TENGENCE_GEO_HOME` / `DB_DRIVER` …). `--site <key>` is accepted by site-dependent
> commands (default `tengence`).
>
> Flag syntax: `--flag`, `--key=value`, or `--key value`. The CLI is the **canonical
> orchestration path** that the MCP tools delegate to — every command below maps to one
> or more MCP tools.

| # | Command | Purpose | Maps to MCP |
| --- | --- | --- | --- |
| 1 | `tengence-geo-article-ingest` | Ingest a source article into the content library | `article_ingest` |
| 2 | `tengence-geo-article-export` | Export an article as a publish package (front matter + body) | `article_export` |
| 3 | `tengence-geo-article-save` | Save/update an article draft | `publish_update_fields` |
| 4 | `tengence-geo-check-article` | Run the G1–G14 editorial gate | `check_article` |
| 5 | `tengence-geo-plan` | Topic planning & scheduling | `plan_list` / `plan_import` / `plan_mark_status` |
| 6 | `tengence-geo-channel-plan` | Per-platform publishing calendar | `channel_plan_*` |
| 7 | `tengence-geo-channel-publish` | Publish to an external platform | `channel_publish` |
| 8 | `tengence-geo-publish-draft` | Publish a draft (WordPress) | `publish_draft` |
| 9 | `tengence-geo-publish-from-db` | Batch publish from the DB by slug/id | `publish_from_db` |
| 10 | `tengence-geo-publish-update-article` | Update an already-published article | `publish_update_article` |
| 11 | `tengence-geo-publish-wechat` | Publish to WeChat | `channel_publish`(wechat) |
| 12 | `tengence-geo-publish-juejin` | Publish to Juejin | `channel_publish`(juejin) |
| 13 | `tengence-geo-publish-devto` | Publish to Dev.to | `channel_publish`(devto) |
| 14 | `tengence-geo-promote-daily` | Daily scheduled promotion (draft → live) | `publish_daily` |
| 15 | `tengence-geo-submit-gsc` | Submit to Google Search Console | `search_submit_gsc` / `search_gsc_*` |
| 16 | `tengence-geo-submit-bing` | Submit to Bing Webmaster | `webmaster_bing_submit` |
| 17 | `tengence-geo-bing-webmaster` | Bing Webmaster API queries | `webmaster_bing_status` |
| 18 | `tengence-geo-submit-indexnow` | IndexNow instant indexing | `search_submit_indexnow` |
| 19 | `tengence-geo-submit-baidu` | Submit to Baidu | `search_submit_baidu` |
| 20 | `tengence-geo-geo-monitor` | Run AI-visibility monitoring | `monitor_run` |
| 21 | `tengence-geo-geo-monitor-report` | Generate a monitoring report | `monitor_report` |
| 22 | `tengence-geo-image-acquire` | Image acquisition pipeline | `image_acquire` |
| 23 | `tengence-geo-taxonomy` | Category/tag management | `article_terms_sync` / `term_*` |
| 24 | `tengence-geo-db-init` / `tengence-geo-db-query` | Database init & query | `db_init` / `db_status` / `db-query` |

## Command details

### 1. `tengence-geo-article-ingest`
Ingest one source article into the content library.
```
tengence-geo-article-ingest.js <slug> [<md-path>] [--lang zh-hans] [--research <path>] [--no-archive]
```
| Option | Description |
| --- | --- |
| `<slug>` | Article slug |
| `<md-path>` | Body Markdown path (optional if reading from stdin) |
| `--lang` | Language (default `zh-hans`) |
| `--research <path>` | Research brief path |
| `--no-archive` | Do not archive source files after ingest |

### 2. `tengence-geo-article-export`
Export an article + brief to `data/inbox` for rewriting/translation.
```
tengence-geo-article-export.js <slug> [--lang zh-hans] [--out <dir>]
```

### 3. `tengence-geo-article-save`
Save/update an article draft.
```
tengence-geo-article-save.js <article_id> <file_path> [--title] [--site <key>]
```

### 4. `tengence-geo-check-article`
Run the editorial gate.
```
tengence-geo-check-article.js <slug> [<dir=industry-insights>] [--type=T1..T7]
```

### 5. `tengence-geo-plan`
Topic planning & scheduling. Options: `--batch`, `--category`, `--cluster`, `--dry-run`, `--limit`, `--matrix`, `--node`, `--queue`, `--set`, `--status`.

### 6. `tengence-geo-channel-plan`
Per-platform publishing calendar. Subcommands:
```
channel-plan.js mark <id> <todo|draft|published|paused>
channel-plan.js import-wechat <issues.json>
```
Other options: `--platform`, `--status`, `--published`, `--all`, `--kind`, `--name`, `--prefix`, `--limit`, `--category`, `--tags`, `--keywords`, `--dry-run`.

### 7. `tengence-geo-channel-publish`
Publish/export to one external platform.
```
channel-publish.js --platform=<key> --slugs=a,b,c [--publish] [--dry-run] [--keep-order] [--from-md <path>]
```

### 8. `tengence-geo-publish-draft`
One-click publish a local draft to WordPress.
```
tengence-geo publish-draft.js <draft-path> [options]
  --meta=<path>       geo meta JSON path (default <draft>.meta.json)
  --status=draft|publish  publish status (default draft)
  --no-move           do not move the file after publishing
  --auto-image        auto search→filter→download→WebP→upload as featured image
  --site <key>        site key (default tengence)
```

### 9. `tengence-geo-publish-from-db`
Batch publish from the DB by slug/id.
```
tengence-geo publish-from-db.js <article_id> [options]
  --status=draft|publish        (default draft)
  --force                       force-update existing
  --dry-run
  --batch <ids>                 multiple ids
  --all                         all queued
  --featured-media <id>         force a media id (skips URL download/upload)
  --translation-group <uuid>
  --no-sync-dates               do not inherit zh-hans source dates
  --skip-gsc / --skip-indexnow / --skip-baidu   skip post-publish submission
  --site <key>
```

### 10. `tengence-geo-publish-update-article`
Update an already-published article.
```
tengence-geo publish-update-article.js <markdown_file> [options]
  --slug <s> / --post-id <id>    target
  --status=publish
  --meta-only                   update only meta fields
  --meta-title <t> / --meta-desc <d> / --post-title <t>
  --no-upload
  --dry-run
  --lang <lang> (default zh-hans)
  --site <key>
```

### 11. `tengence-geo-publish-wechat`
Publish to WeChat.
```
node publish-wechat.js <slug> [--publish] [--dry-run]
```
(`--publish` pushes to followers — a high-risk action; by default it only creates a draft.)

### 12. `tengence-geo-publish-juejin`
Publish to Juejin.
```
node publish-juejin.js <markdown_file> [--title "Title"] [--draft] [--publish]
```

### 13. `tengence-geo-publish-devto`
Publish to Dev.to.
```
tengence-geo publish-devto.js <md-file-path> [--dry-run]
```

### 14. `tengence-geo-promote-daily`
Daily scheduled promotion — turns queued drafts into published articles.
```
tengence-geo promote-daily.js [--site <key>] [--date <YYYY-MM-DDTHH:MM:SS>] [--slug <s>] [--count <n>] [--dry-run]
```
- Queue mode (default): promote the next `count` queued rows by `publish_order` (honors `per_day`/`skip_dates` from `wordpress.yaml`).
- `--slug` mode: publish that slug in every language version it has.
- `--date`: set the promoted article's publish/modified time (site timezone) — scheduled live publish.

### 15. `tengence-geo-submit-gsc`
Submit to Google Search Console.
```
tengence-geo submit-gsc.js [options]
  --site <key>  --dry-run  --sitemap  --status  --all  --limit  --indexing <url>  --url <url>
```

### 16. `tengence-geo-submit-bing`
Submit to Bing Webmaster. Options: `--site`, `--dry-run`, `--all`, `--limit`, `--submit <url>`.

### 17. `tengence-geo-bing-webmaster`
Bing Webmaster API queries. Options: `--site`, `--dry-run`, `--sites`, `--status`, `--stats`, `--issues`, `--all`, `--resubmit`, `--limit`, `--submit <url>`.

### 18. `tengence-geo-submit-indexnow`
IndexNow instant indexing.
```
tengence-geo submit-indexnow.js [options]
  --site <key>  --dry-run  --all  --limit (default 1000)  --url <url>
```

### 19. `tengence-geo-submit-baidu`
Submit to Baidu normal inclusion.
```
tengence-geo submit-baidu.js [options]
  --site <key>  --dry-run  --all  --resubmit  --limit  --url <url>
```
`--all` pushes sitemap incrementally (≤`limit` URLs, default 10, within daily quota).

### 20. `tengence-geo-geo-monitor`
Run GEO monitoring.
```
tengence-geo geo-monitor.js run --run-id=20260921 [--site <key>] [--dry-run] [--mock] [--models <m>] [--layer <l>]
```

### 21. `tengence-geo-geo-monitor-report`
Generate a monitoring report. Options: `--mock`, `--models <m>`.

### 22. `tengence-geo-image-acquire`
Image acquisition pipeline (search → red-line → download → WebP crop → upload).
```
tengence-geo image-acquire.js [options]
  --query <kw>  --slug <slug>  --keywords <k>  --count <n>  --format <fmt>
  --out-json <path>  --dry-run  --site <key>
```

### 23. `tengence-geo-taxonomy`
Category/tag management.
```
tengence-geo taxonomy.js <db-register|wp-cleanup|verify> [--slugs=a,b,c] [--site <key>]
```

### 24. `tengence-geo-db-init` / `tengence-geo-db-query`
Database init & query.
```
tengence-geo db-init.js [--drop] [--site <key>]
tengence-geo db-query.js [--list] [--slug=xxx] [--category=xxx] [--status=xxx]
                 [--lang <l>] [--limit <n>] [--categories] [--tags] [--plan] [--site <key>]
```

## Notes

- Most commands need `tengence-geo-db-init` (or they auto-init on first use) and a site
  directory under `SITES_ROOT`.
- `publish-wechat --publish`, external live publishes, and deletions are **high-risk**
  actions — verify targets first and confirm before executing.
