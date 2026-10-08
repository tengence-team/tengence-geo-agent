# End-to-End Workflow / SOP

> English version. For 中文版 see [pipeline.zh.md](pipeline.zh.md).
>
> This is the **single place that describes the full SOP** in order. For the complete
> parameter reference of every tool/command mentioned here, see
> [../reference/mcp-tools.en.md](../reference/mcp-tools.en.md) and
> [../reference/cli-commands.en.md](../reference/cli-commands.en.md).

## 0. Orientation

The pipeline is a closed loop. It starts from a site and a diagnosis, produces a plan
and articles, publishes them (draft first, then a scheduled live publish), submits them
to search engines, and measures AI visibility — whose results feed back into the next
round of planning.

The canonical phase machine on the **article plan** is:

```
todo → written → queued → published
```

- `todo` — a planned article not yet written.
- `written` — body written (image may be pending).
- `queued` — a WordPress **draft** is in place, waiting for its scheduled slot.
- `published` — the article went live.

The publishing calendar on `config/wordpress.yaml` (`publish.per_day` / `publish.skip_dates`)
controls how many queued drafts are promoted per day and which days are skipped.

---

## Phase A — Diagnosis & Implementation Plan (诊断与方案)

### A1. Bind the workspace and (re)create the site

The engine never guesses a directory. First bind the user workspace, then ensure the
site exists.

- **MCP:** `workspace_use { path }` → `site_init { key, domain? }` → `site_list` / `site_status`
- **CLI:** (workspace is taken from `SITES_ROOT`; site scaffolded via template copy)

`site_status` reports config paths, `.env` readiness, the DB driver and SQLite init
state, so you can verify the site is usable before diagnosing.

### A2. Diagnose the site

- **MCP:** `diagnose_site { url, site?, pages?, max_pages? }`
- **CLI:** none (diagnosis is an MCP/SDK capability)

It performs a full GEO/SEO health check: domain (DNS/TLS/WHOIS), transport & server
fingerprint (CMS/framework/CDN), robots.txt, sitemap, homepage + representative pages
(meta, H1–H6 structure, JSON-LD, OG, images/alt, links, mixed content), plus
performance and security checks. On first use it bootstraps the site from the URL.

### A3. Generate the implementation plan

- **MCP:** `site_geo_plan_skill { }` — read the canonical plan spec
- **MCP:** `report_write { content, filename? }` — persist a Markdown plan to
  `<site>/data/reports/`

`site_geo_plan_skill` returns the site-geo-plan skill specification
(`SKILL.md` + `references/plan-template.md`) that governs detailed plan generation: a
multi-part structure (**上篇技术修复 / 中篇关键词与内容 / 价值桥接 / 下篇实施保障 / 附录**),
every diagnosis issue expanded as **现状 → 方案 → 步骤 → 验收**, a **full keyword matrix**,
and a **manpower person-day matrix**. Callers implement/verify plans against this spec.

---

## Phase B — Planning: Keyword Matrix & Publishing Plan (关键词矩阵与发布计划)

### B1. Keyword matrix & format selection

- **MCP:** `standards_read { name: "content-strategy" }` — format selection rules & cadence
- **MCP:** `standards_list` / `standards_read` — the progressive-load index of all standards

The keyword matrix comes from the implementation plan (Phase A3) and is turned into
concrete rows in the article plan table. The `content-strategy` standard drives
article-type routing (T1–T7) and cadence.

### B2. Load the article plan (publishing schedule)

- **MCP:** `plan_import { rows[] }` — upsert plan rows (idempotent by `slug`+`lang`); every language is its own row
- **MCP:** `plan_list { status?, batch?, lang?, limit? }` — inspect the queue
- **MCP:** `plan_mark_status { slug, status }` — move a row (`todo|written|queued|published|archived`)
- **CLI:** `tengence-geo-plan` — plan maintenance from the terminal

Key plan fields: `slug`, `lang`, `node_type` (spoke|hub), `title`, `focus_keyword`,
`content_type`, `publish_order`, `category`, `tags`, `plan_status`.

> A translation row (`lang=en|zh-hant`) must be written through `plan_import`'s keyed
> upsert with the same slug — never by slug alone, or it silently overwrites the
> zh-hans source row.

---

## Phase C — Content Production (内容生产)

### C1. Draft an article

- **MCP:** `article_draft { type?, topic? }` — returns the matched **T1–T7 body skeleton**,
  the **research-brief template**, and the full **`article-writing-standards`**
- **MCP:** `standards_read { name }` — pull any individual standard as needed

Author the Markdown body against the brief. Body blocks must use the canonical GEO block
headings (see `standards/block-conventions.md`): Summary, Key Takeaways, FAQ, Data
Sources, Related Reading, Get Started, About.

### C2. Ingest the article

- **MCP:** `article_ingest { slug, md_path, research_path?, lang? }` — body + research brief → `articles` table
- **MCP:** `article_export { slug, lang? }` — export an article + brief to `data/inbox` (for rewriting/translation)
- **CLI:** `tengence-geo-article-ingest <slug> <md> --research <brief>`
- **CLI:** `tengence-geo-article-save <article_id> <file>`

`article_ingest` auto-archives the source files after ingest (unless `--no-archive`).

### C3. Multilingual translation

- **MCP:** `translation_glossary_get { target_lang }` — merged global + site glossary (brands/phrases/product terms/forbidden words)
- (Translate with your own LLM to `en` / `zh-hant`.)
- **MCP:** `check_translation { slug, source_lang, target_lang, md_path? }` — mechanical gate T1–T11 before ingest
- **MCP:** `article_ingest { slug, md_path, lang }` — ingest the translation (`--lang en|zh-hant`)
- **CLI:** `tengence-geo-article-ingest <slug> <md> --lang en|zh-hant`

The translation gate checks structure/blocks/numbering, link-set & image-set & number-set
parity with the source, Simplified-Chinese & CJS residue, forbidden terms, per-section
length, and title/meta lengths. A translation shares **one featured image** with its
source; internal links are rewritten to the target language prefix.

---

## Phase D — Image & Gate (配图与门禁)

### D1. Acquire featured images

- **MCP:** `image_acquire { query, slug, count?, dry_run? }`
- **CLI:** `tengence-geo-image-acquire --query <kw> --slug <slug> --count <n>`

Runs the auto image pipeline: **search → red-line filter → download → WebP crop →
upload to the WordPress media library**. `dry_run` previews without persisting.

### D2. Run the editorial gate

- **MCP:** `check_article { slug, type?, lang? }`
- **CLI:** `tengence-geo-check-article <slug> [--type=T1..T7]`

Enforces the editorial rules codified in `article-writing-standards` (G1–G16): citation
dual-channel, word count by T1–T7 type, banned words, the GEO blocks, and the
research-brief hard check. **A draft that fails this gate must not be published.** An
already-published row is gated *advisory* (metadata fixes are not blocked by rules that
postdate the body); drafts stay hard-gated.

> Translations are checked by `check_translation` (T1–T11), not by `check_article`.

---

## Phase E — Publishing (发布)

### E1. Publish as a draft

- **MCP:** `publish_draft { md_path, status?, site? }` — default `draft`
- **MCP:** `publish_from_db { article_id, status?, force?, translation_group?, sync_source_dates? }`
- **CLI:** `tengence-geo-publish-draft <md> --site <key> [--status=draft]`
- **CLI:** `tengence-geo-publish-from-db <article_id> --status=draft`

This creates a **WordPress draft** (`wp_post_id` set, plan status `queued`). Nothing is
live yet. `--force` updates an existing article; for translations the zh-hans source
publish/update times are inherited by default (`sync_source_dates=false` to opt out).

### E2. Scheduled live publish

- **MCP:** `publish_daily { site?, date?, slug?, count?, dry_run? }`
- **CLI:** `tengence-geo-promote-daily [--date <ts>] [--slug <slug>] [--count <n>]`

Promotes due drafts to **published**, picking the front-most `queued` row by
`publish_order` (`plan.nextDue`), honoring `per_day` / `skip_dates`. Options:
- **Queue mode (default):** promote the next N queued drafts (`count`, default from
  `wordpress.yaml`).
- **Slug mode (`--slug`):** publish that slug in **every language version** it has
  (zh-hans/en/zh-hant), still running the internal-link check and gate re-check.
- **`--date`:** set the promoted article's publish/modified time
  (`YYYY-MM-DDTHH:MM:SS`, site timezone) — this is the **scheduled** live publish.
- **`--dry-run`:** report only.

Plan rows move `queued → published`.

### E3. Publish to external platforms (syndication)

- **MCP:** `channel_list` → `channel_style_get { platform }` → `channel_check { platform, title?, body? }` → `channel_publish { platform, slugs[]? , articles[]?, asDraft?, keepOrder?, dryRun? }`
- **CLI:** `tengence-geo-channel-publish --platform=<key> --slugs=a,b,c`
- **CLI:** `tengence-geo-publish-wechat <slug>` / `tengence-geo-publish-juejin` / `tengence-geo-publish-devto`

Read the platform rewrite rules via `channel_style_get`, rewrite per platform, validate
with `channel_check`, then publish. WeChat uses a **draft → preview → mass-send** flow
(`wechat_draft_publish` / `wechat_mass_preview` / `wechat_mass_send` — the last is a
high-risk, irreversible push requiring explicit confirmation). Every publish outcome is
logged into `channel_plan` under its own platform, giving each platform an independent
publishing calendar.

### E4. Verify publish state

- **MCP:** `wp_post_get { slug, lang? | wp_post_id }` — confirm an article is no longer a draft
- **MCP:** `wechat_status` / `csdn_status` / `juejin_status` — read each platform's backend
- **CLI:** `tengence-geo-publish-update-article <md> --slug <s>` — update an existing article
  (or `publish_update_fields` for any single attribute)

---

## Phase F — Search Submission (收录提交)

Run after publishing so pages get indexed:

- **MCP:** `search_submit_gsc { sitemap_url? }` — Google Search Console sitemap (soft-fail)
- **MCP:** `search_submit_indexnow { url }` — IndexNow (requires `INDEXNOW_KEY`)
- **MCP:** `search_submit_baidu { url? | all, limit? }` — Baidu normal inclusion (needs `BAIDU_TOKEN`)
- **MCP:** `webmaster_bing_submit { url }` — Bing Webmaster (needs `BING_WEBMASTER_API_KEY`)
- **CLI:** `tengence-geo-submit-gsc` / `tengence-geo-submit-indexnow` / `tengence-geo-submit-baidu` / `tengence-geo-bing-webmaster`

Read-side tools for verification: `search_gsc_stats` (analytics), `search_gsc_inspect`
(indexing status of one URL), `webmaster_bing_status` (sites/quota/stats/issues).

---

## Phase G — Monitoring Loop (监测闭环)

- **MCP:** `monitor_run { run_id?, models?, layers? }` — one round of site prompts × models
- **MCP:** `monitor_report { run_id? }` — read the latest (or a given) round
- **CLI:** `tengence-geo-geo-monitor run` / `tengence-geo-geo-monitor-report`

Results measure AI visibility (indexing baseline + visibility). Monitoring feeds back
into **Phase B** (`topic-planning` refresh) and **Phase D2** (retire/rework articles that
no longer meet the gate), closing the loop.

---

## High-risk / irreversible actions

These are external, one-way actions and must be confirmed before execution
(`confirm=true` / `confirm="YES"`, or explicit user acknowledgement):

- `wechat_mass_send` (push to followers — irreversible)
- `channel_publish` with `asDraft=false` (live external publish)
- `wechat_article_delete` / `csdn_article_delete` / `juejin_article_delete`
- `juejin_draft_delete`
- `db_init { drop: true }` (drop & rebuild the database)
