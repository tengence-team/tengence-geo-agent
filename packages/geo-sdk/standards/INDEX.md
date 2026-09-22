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
| `site-profile.md` | The contract listing what a site must supply as a supplement | done |
| `templates/research-brief.md` | Pre-writing research brief (hard-gated: publishing is blocked when missing) | done |
| `templates/skeletons/` | T1–T7 body skeletons: `definition` (T1), `howto` (T2), `product` (T3), `case` (T4), `industry` (T5), `comparison` (T6), `guide` (T7) | done |

## Conventions

- File names are English kebab-case; article files inside a site directory keep their
  own language.
- The generic files stay English. Supplements may be written in the site's language.
- A supplement is merged after the base file — it never replaces it, and it may only
  tighten or instantiate (see `site-profile.md` §2).
- Adding a new standard file means adding it to this index and to the package `files`
  whitelist, otherwise it will not be published.
