# Data Model Reference

> English version. For 中文版 see [data-model.zh.md](data-model.zh.md).
>
> Authoritative source: `packages/geo-sdk/db/sqlite-schema.js` (field-isomorphic with
> `db/schema.js` / MySQL). Table prefix: `tengence_geo_`.

## Overview

18 tables in total: **16 business tables** (shared with the MySQL production schema,
namespace `tengence_geo_*`) + **2 workspace-local tables** (SQLite-only) that hold the
per-platform publishing calendar and the external-platform taxonomy dictionary.

Key design points:

- **Multi-tenant:** every table carries `app_id`; business unique keys all include
  `app_id` (the single-file multi-tenant isolation basis).
- **`(app_id, slug, lang)` is the unique key** of both `articles` and `article_plan` —
  one row per language.
- SQLite uses local time (`strftime ... 'localtime'`) with the same semantics as MySQL
  `NOW()`; ENUMs become TEXT with validation at the app layer.
- Schema version stamped in `PRAGMA user_version` (currently `SCHEMA_VERSION = 5`).

## Business tables (16)

| Table | Purpose | Key fields |
| --- | --- | --- |
| `tengence_geo_articles` | Content library, one row per slug+lang | id, app_id, slug, title, content_path, content_longtext, content_html, research_md, excerpt, featured_image, target_keywords, lang, translation_group, region_market, status (draft…), author, wp_post_id, published_at, created_at, updated_at |
| `tengence_geo_categories` | Categories | id, app_id, name, slug |
| `tengence_geo_tags` | Tags | id, app_id, name, slug |
| `tengence_geo_article_categories` | Article ↔ category join | article_id, category_id, app_id |
| `tengence_geo_article_tags` | Article ↔ tag join | article_id, tag_id, app_id |
| `tengence_geo_seo` | Per-article SEO meta | article_id, title, meta_title, meta_description, keywords, canonical_url, og_*, noindex… |
| `tengence_geo_geo` | Per-article GEO meta | article_id, ai_summary, key_takeaways, qa (link), citations (link), schema_data, entity… |
| `tengence_geo_qa_pairs` | FAQ Q&A rows | article_id, question, answer |
| `tengence_geo_citations` | Citation rows (dual-channel evidence) | article_id, title, url, channel… |
| `tengence_geo_social` | Social/OG meta | article_id, og_* |
| `tengence_geo_vectors` | Content vectors | article_id, embedding… |
| `tengence_geo_images` | Media library mirror | id, app_id, url, file, format, width, height, alt, wp_media_id… |
| `tengence_geo_article_images` | Article ↔ image join | article_id, image_id, is_featured… |
| `tengence_geo_geo_monitor_answers` | Raw monitoring answers (prompt × model × layer) | run_id, model, layer, prompt, answer… |
| `tengence_geo_geo_monitor_results` | Aggregated monitoring results (indexing baseline + visibility) | run_id, model, layer, score… |
| `tengence_geo_article_plan` | The publishing plan / queue (`todo → written → queued → published`) | id, app_id, slug, node_type (spoke|hub), hub_cluster, matrix_code, title, focus_keyword, keyword_volume, keyword_competition, search_intent, content_type, target_word_count, publish_batch, publish_order, category, tags, lang, article_id, wp_post_id, published_url, plan_status, queued_at, published_at |

## Workspace-local tables (2, SQLite only)

| Table | Purpose | Key fields |
| --- | --- | --- |
| `tengence_geo_channel_plan` | Per-platform publishing calendar (wechat/juejin/csdn…) — **workspace-local**, not in MySQL | id, app_id, platform, period, topic, weekday, article_slugs, status (todo|draft|published|paused), draft_ids, article_id, notes, schedule_at. Unique `(app_id, platform, period)` |
| `tengence_geo_channel_taxonomy` | Dictionary of an **external** platform's own taxonomy (category/tag id+name), platform-scoped and shared by every site | id, app_id, platform, kind (category|tag), external_id, name, parent_id, extra, synced_at. Unique `(app_id, platform, kind, external_id)`; name indexed `COLLATE NOCASE` for exact/prefix/order lookups |

## The plan status machine

`article_plan.plan_status` drives the whole SOP:

```
todo → written → queued → published   (archived/paused are terminal or hold states)
```

- `todo` — planned, not yet written.
- `written` — body written (image may be pending).
- `queued` — a WordPress **draft** exists, awaiting its scheduled slot.
- `published` — live.

`publish_daily`/`promote-daily` picks the front-most `queued` row by `publish_order`
(`plan.nextDue`), honoring `wordpress.yaml` `per_day`/`skip_dates`.

## Site directory layout

```
<workspace>/<site>/
├── .env                    # secrets (gitignored)
├── config/
│   ├── site.yaml           # site identity, default lang
│   ├── wordpress.yaml      # WP connection + publish calendar (per_day/skip_dates)
│   └── monitor.yaml        # monitoring models/layers
├── data/
│   ├── inbox/              # ingested article sources (+ <lang>/ subdirs for translations)
│   ├── reports/            # diagnosis & plan reports
│   └── channel-export/     # per-platform publish packages
└── ...
```

The WordPress connection parameters can be overridden per-site by `.env` (`WP_URL`,
`WP_USERNAME`, `WP_PASSWORD`, …) and are resolved at publish time.
