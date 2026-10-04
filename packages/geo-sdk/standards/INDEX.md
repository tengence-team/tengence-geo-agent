# standards/ — Generic Writing & GEO Standards

> Shipped with this package and versioned with it. Everything here is
> **site-agnostic**: no brand names, no domains, no product lines. Anything that depends
> on *which* site you publish to is a **supplement** under `$TENGENCE_GEO_HOME/standards/`
> — see `site-profile.md`.

## Load order (progressive, do not load everything at once)

1. `INDEX.md` (this file) — pick what you need
2. `article-writing-standards.md` — when writing or gate-checking an article
3. the matching skeleton in `templates/skeletons/`
4. `templates/research-brief.md` — before writing the body
5. `block-conventions.md` — when block parsing or rendering behaves unexpectedly

## Files

| File | Contents | Status |
|---|---|---|
| `content-strategy.md` | Content strategy: formats ranked by AI-citation probability, dual-engine model, keyword-matrix method, production pipeline, three-level quality gates, refresh & retirement | done |
| `article-writing-standards.md` | The writing execution spec: deliverable, body skeleton, front matter, citation and internal-link rules, content-quality bar, plus the G1–G14 editorial gates | done |
| `search-engine-integration.md` | Search-engine integration: indexing baselines, domestic & overseas engines, automatic push channels, indexing-quality optimization, entity & authority signals | done |
| `llm-visibility-monitoring.md` | LLM monitoring: AI-crawler policy, model priority lists, AI search engines, GEO visibility dimensions, content engineering for citability | done |
| `content-platform-integration.md` | Content-platform integration: entity-claim platforms, general & technical platforms, encyclopedias, four integration modes, one-draft-many-places SOP | done |
| `block-conventions.md` | Canonical GEO block headings + the bilingual (EN/ZH) parser contract | done |
| `translation-standards.md` | Multi-language translation spec: en-us & zh-hk (HK-style) target profiles, four hard rules, GEO-domain glossary (zh-cn/en-us/zh-hk), simplified→traditional table, T1–T8 mechanical gate summary, per-language block headings | done |
| `site-profile.md` | The contract listing what a site must supply as a supplement | done |
| `templates/research-brief.md` | Pre-writing research brief (hard-gated: publishing is blocked when missing) | done |
| `templates/skeletons/` | T1–T7 body skeletons: `definition` (T1), `howto` (T2), `product` (T3), `case` (T4), `industry` (T5), `comparison` (T6), `guide` (T7) | done |

## L2/L3 consumption map

Higher layers (`harness/` at the repo root) **never copy rule text** — they point at
these files and let the model fetch them at runtime via `standards_read()`. This table
is the mirror of `harness/README.md` §6; keep the two in sync.

| Consumer (L2/L3 asset) | Standards it reads |
|---|---|
| `harness/work-modes/topic-planning.md` | `content-strategy` |
| `harness/work-modes/writing-gate.md` | `article-writing-standards`, `block-conventions`, `templates/research-brief`, `templates/skeletons/<type>` |
| `harness/work-modes/publishing.md` | `content-platform-integration`, `block-conventions` |
| `harness/work-modes/monitoring.md` | `llm-visibility-monitoring`, `search-engine-integration` |
| `harness/skills/geo-article-writing` | `article-writing-standards`, `block-conventions` |
| `harness/skills/geo-article-translation` | `translation-standards`, `block-conventions` |
| `harness/skills/geo-search-submit` | `search-engine-integration` |
| `harness/skills/geo-visibility-monitor` | `llm-visibility-monitoring`, `search-engine-integration` |
| `harness/expert/geo-expert.md` | this index first, then whichever the task needs |

Why the rules are not duplicated up there: the whole set is ~68k characters, loading it
into a System Prompt would cost tens of thousands of tokens per turn, and users on other
platforms (Coze, Bailian, Claude Desktop) have no Buddy-app prompt at all — they only
learn the rules from what this package returns.

## Conventions

- File names are English kebab-case; article files inside a site directory keep their
  own language.
- The generic files stay English. Supplements may be written in the site's language.
- A supplement is merged after the base file — it never replaces it, and it may only
  tighten or instantiate (see `site-profile.md` §2).
- Adding a new standard file means adding it to this index and to the package `files`
  whitelist, otherwise it will not be published.
