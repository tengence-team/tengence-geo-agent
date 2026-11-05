# AGENTS.md — Engineering & authoring conventions

> Human-readable conventions for this repository. Machine-facing requirement docs
> live under `packages/geo-sdk/standards/` (see that directory's `INDEX.md`); this
> file explains *how* those docs are organized, versioned, and actually consumed.

## 1. Generic standards — the requirements an article must satisfy

- **Location:** `packages/geo-sdk/standards/`, shipped inside `@tengence/geo-sdk` and
  **versioned with the package**. Everything there is **site-agnostic**: no brand
  names, no domains, no product lines.
- **Language / naming:** English, kebab-case file names. Article files *inside a site*
  keep their own language.
- **Index:** `standards/INDEX.md` defines the progressive load order — read it first.
- **How they are consumed:** AI clients read them through the MCP resources
  `geo://standard-index`, `geo://standard/{name}`, and the `article_draft` tool (see §4). **The engine code
  never parses these docs for rules** — it returns their text to the model.

## 2. Base + supplement — a supplement never replaces the base

- The package's `standards/` is the **base** (authoritative source of truth).
- A deployment may add a **supplement** at `$TENGENCE_GEO_HOME/standards/`
  (default `~/.tengence/geo-mcp/standards/`).
- **Merge rule:** the supplement is appended *after* the base, delimited by a
  `## Site-specific Additions` section. It may only **tighten or instantiate** the base
  — never relax a hard requirement. Where it intentionally conflicts, it must declare an
  `Overrides:` note so the merged standard (`geo://standard/{name}`) surfaces the conflict.
- The contract of what a supplement must supply is `standards/site-profile.md`.

## 3. GEO block headings — canonical (EN + ZH)

These headings appear in the **article body** (not the standards docs) and are parsed by
the engine. Keep the label words exact; the parser is bold-agnostic but the words are
fixed. The full parser contract is `standards/block-conventions.md`.

| Block | EN | ZH |
| --- | --- | --- |
| Summary (first line after the H1) | `> **Summary**:` | `> **摘要**：` |
| Key Takeaways | `## Key Takeaways` | `## 关键要点` |
| FAQ | `## FAQ` | `## 常见问题` |
| Data Sources | `## Data Sources` | `## 数据来源` |
| Related Reading | `## Related Reading` | `## 相关阅读` |
| Get Started | `## Get Started` | `## 立即行动` |
| About | `## About <Brand>` | `## 关于 <Brand>` |

## 4. Authoring loop — how the standards are actually used

1. `workspace_use` → `site_init` (or reuse an existing site).
2. `article_draft { type, topic }` → returns the matched **T1–T7 skeleton**, the
   **research-brief template**, and the full **`article-writing-standards`** (the G1–G16
   editorial gates). Write the Markdown body following them.
3. Optionally `geo://standard/content-strategy` / `geo://standard/block-conventions`
   for format selection and parser details.
4. `article_ingest` the body + research brief.
5. `check_article` — enforces the **same** G1–G18 rules codified in
   `article-writing-standards` (citation dual-channel, word count by type, banned words,
   the four blocks, research-brief hard check, **internal-link language prefix,
   CTA single-link-per-line layout**, and the **G18 always-hard tag/category
   topic semantics gate**, see §4.5). **Do not skip it.**
6. `publish_draft`.

The gate (`packages/geo-sdk/check/index.js`) is the *codified mirror* of
`article-writing-standards.md`. Keep the two in sync by hand and record the link in
`standards/block-conventions.md` — the code does not read the doc to generate checks.

## 4.5 G18 taxonomy semantics is a HARD gate (2026-11-05, red line)

The 2026-11 batch generated tags from **category templates**: an Algolia
site-search comparison shipped with `ai-ask` (Tengence Insight), and `plan.tags`
contained `search-recommend` — a *category* slug. The old gate only checked
"non-empty / whitelisted / category matches plan", so all of it was green.

- `check_article` now emits four **always-hard** G18 rows (tags configured, no
  category slug as a tag, strong-domain tags match the article topic, product
  category matches the article topic). **They are never demoted for
  already-published articles** (`alwaysHard`, 5th row element) — do not change
  them back to soft/advisory. All publish paths call this one `checkArticle`.
- Rule SSOT: `packages/geo-sdk/check/tag-semantics.js` (pure, unit-tested in
  `tests/tag-semantics.test.js`); standard: `article-writing-standards.md` §8 / G18.
- Cross-domain rebuttal evidence is taken from the **zh-hans source body** —
  translations share the slug/topic/tag set, and judging an English translation
  by its own sparser vocabulary produces false positives.
- On a G18 failure fix the **taxonomy**, not the body: use
  `tagSemantics` in the gate result, write `plan.tags` / `plan.category` per
  **(slug, lang)** row and mirror into WP with `article_terms_sync`. Never
  create a pseudo tag term to satisfy the gate.
- A taxonomy-lookup failure is advisory with an explicit warning (infrastructure
  fault), never an editorial pass-by-default. Never silently disable G18.
- **After changing the gate code, restart the local geo-mcp HTTP server (8787)**;
  `publish-next-article.mjs` reuses a running server, so a stale process keeps
  the old gate until it is restarted.

## 5. Red lines

- Generic standards stay brand-free: no `通智云` / `Tengence` / specific-site domains.
  Supplements may name the deployment's own brand.
- `@tengence/geo-sdk` is published to npm; every new standard file must be added to
  `standards/INDEX.md` **and** to the package `files` whitelist, or it will not ship.
- `TENGENCE_GEO_HOME` is the single environment variable every internal path derives
  from (legacy `GEO_HOME` kept as an alias until 0.2.0).

## 5.5 Gate-failure → rewrite → republish loop (unpublished articles only, 2026-11-04)

The MCP server never calls an LLM — the **agent driving the MCP** closes the loop.
Scope: only articles **not live on WP** (WP status != publish); already-published
articles are never pulled back or rewritten by this loop.

When a publish path (`publish_draft` / `publish_from_db` / `publish_daily` /
`publish_update_article` / `publish_update_fields` / `channel_publish`) returns a
gate failure:

1. Classify from the `check_article` rows: G17-4/5/6 → rewrite the body; B2 ledger
   → add each missing citation URL verbatim to the research brief (per-language,
   cascading to zh-hans); G18 → fix the taxonomy per §4.5 (not the body);
   any other hard row → fix per its standard.
2. Rewrite the body (floor zh ≥150 chars / en ≥80 words per content section,
   facts with sources, a position, article-specific citations) and save to
   `<site>/data/inbox/<lang>/<slug>.<lang>.md`.
3. `article_ingest` → `check_article` again — must be fully green.
4. **Publish immediately when green** (fully automatic, no manual confirmation);
   plan rows move queued/blocked → published.

Full rubric lives in `packages/geo-sdk/standards/article-writing-standards.md`
(§6, "Rewrite-and-republish loop").

## 6. Adding a standard

1. Drop the file under `packages/geo-sdk/standards/` (kebab-case, English).
2. Add it to `standards/INDEX.md` and to `geo-sdk/package.json` → `files`.
3. If it tightens an existing gate, mirror the rule into `check/index.js` and record the
   link in `standards/block-conventions.md`.

## 7. Multilingual publish — shared featured image (no re-upload)

- An article's languages (zh-hans / en / zh-hant) share **one** featured image, and
  `publishArticle` (`packages/geo-sdk/publish/index.js`) never re-uploads it per language:
  1. `--featured-media <id>` forces a media ID directly — the URL download / media upload
     is skipped entirely.
  2. Otherwise, when another language of the **same slug** is already published on this WP
     site, its `featured_media` is looked up via
     `GET /wp-json/wp/v2/posts?slug=<slug>&status=any&per_page=100` and **reused** as-is
     (multilingual shared featured image; no download, no re-upload).
  3. Fallback (first language publish): the `featured_image` URL is downloaded and uploaded
     to the media library once.
- Translation rows (`en` / `zh-hant`) are gated by `check_translation` (T1–T11), which the
  harness runs before ingest; since 2026-11-04 the writing gate no longer skips them —
  `publish-from-db.js` runs the **same `checkArticle`** on every language (B7 cascade:
  the research brief resolves per language, falling back to the zh-hans group brief), and
  the G17 / citation / related-reading hard rows apply to all languages.
- **Same-language internal links (every language, published or draft)** — every on-site
  article link (`tengence.com/blog/article/<slug>/`) carries the article's own language
  prefix: zh-hans → `/zh-hans/`, en → `/en/`, zh-hant → `/zh-hant/`. No bare links, no
  cross-language hops; a translation rewrites the source's prefix to the target language
  (slug unchanged). **CTA layout** — the Get Started / 立即行动 block lists each link on
  its own line; never join links with `|` on one line. Both rules are enforced by the
  translation gate (T10 / T11) and `check_article` rows, and normalized automatically on
  the WP write exit (`buildPostHtml`).
- Translation rows are ingested via `article-ingest.js <slug> <md> --lang en|zh-hant`
  (file in `<site>/data/inbox/<lang>/<slug>.md`, YAML front matter per
  `standards/translation-standards.md` §10).

## 8. Release & Distribution（2026-10-07 起，按此执行，勿再探索）

发布形态：**根单包 `tengence-geo-agent`**（bundle 四个 @tengence/* workspace 包）；已不用四包分开发。

- **npm 发布只走 CI**：bump（package.json + lock 顶层 version 同步）→ commit → push → `git tag vX.Y.Z` →
  `release.yml` 自动 test + `npm publish --provenance --access public`（secret `NPM_TOKEN`）。
  本机无 npm token，**禁止尝试本地 publish**。
- **tag 版本**：v0.1.0 / v0.1.1 被旧四包发布占用，单包从 v0.1.2 起递增；tag 冲突就升号，**不要 force 覆盖**。
- **npm Staged Publishing**：首版新包发布后卡在 `0.0.0-stage`，需 maintainer 在 npmjs.com
  「Staged Packages」批准（2FA，用户操作）；同包后续版本直接上线免批准。判定：registry API 出现真实版本号。
- **MCP Registry（com.tengence/geo-agent）**：npm 包上线（含 `mcpName`）+ server.json 就绪后，
  **本机背靠背** `mcp-publisher login http --domain tengence.com` + `publish ./server.json`（JWT 短效）。
- 完整流程与全部踩坑（server.json 字段、验证文件/服务器挂载、版本同步、验证清单）见
  `docs/release.md` 与 `docs/mcp-publication-guide.md` —— 发版前先读，不要重新探索。
