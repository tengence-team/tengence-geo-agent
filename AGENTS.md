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
- **How they are consumed:** AI clients read them through the MCP tools
  `standards_list`, `standards_read`, and `article_draft` (see §4). **The engine code
  never parses these docs for rules** — it returns their text to the model.

## 2. Base + supplement — a supplement never replaces the base

- The package's `standards/` is the **base** (authoritative source of truth).
- A deployment may add a **supplement** at `$TENGENCE_GEO_HOME/standards/`
  (default `~/.tengence/geo-mcp/standards/`).
- **Merge rule:** the supplement is appended *after* the base, delimited by a
  `## Site-specific Additions` section. It may only **tighten or instantiate** the base
  — never relax a hard requirement. Where it intentionally conflicts, it must declare an
  `Overrides:` note so `standards_read` surfaces the conflict.
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
   **research-brief template**, and the full **`article-writing-standards`** (the G1–G14
   editorial gates). Write the Markdown body following them.
3. Optionally `standards_read('content-strategy')` / `standards_read('block-conventions')`
   for format selection and parser details.
4. `article_ingest` the body + research brief.
5. `check_article` — enforces the **same** G1–G14 rules codified in
   `article-writing-standards` (citation dual-channel, word count by type, banned words,
   the four blocks, research-brief hard check). **Do not skip it.**
6. `publish_draft`.

The gate (`packages/geo-sdk/check/index.js`) is the *codified mirror* of
`article-writing-standards.md`. Keep the two in sync by hand and record the link in
`standards/block-conventions.md` — the code does not read the doc to generate checks.

## 5. Red lines

- Generic standards stay brand-free: no `通智云` / `Tengence` / specific-site domains.
  Supplements may name the deployment's own brand.
- `@tengence/geo-sdk` is published to npm; every new standard file must be added to
  `standards/INDEX.md` **and** to the package `files` whitelist, or it will not ship.
- `TENGENCE_GEO_HOME` is the single environment variable every internal path derives
  from (legacy `GEO_HOME` kept as an alias until 0.2.0).

## 6. Adding a standard

1. Drop the file under `packages/geo-sdk/standards/` (kebab-case, English).
2. Add it to `standards/INDEX.md` and to `geo-sdk/package.json` → `files`.
3. If it tightens an existing gate, mirror the rule into `check/index.js` and record the
   link in `standards/block-conventions.md`.
