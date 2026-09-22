# Site Profile — What a Site Must Supply

> The files under `standards/` are **generic**: no brand, no domain, no product line.
> Everything that depends on *which* site you are publishing to lives outside this
> package. This document is the contract listing exactly what a site has to supply.

## 1. Where site-specific content goes

```
$TENGENCE_GEO_HOME/standards/   # TENGENCE_GEO_HOME defaults to the agent's internal
                                # home directory; override it with the
                                # TENGENCE_GEO_HOME env var
  <same file name>.md           # supplement, not a replacement
```

A supplement file is **merged** with the generic file of the same name: the reader
gets the generic base first, then the site's additions. A supplement never hides or
deletes the base.

## 2. Supplement rules

1. A supplement may only **tighten or instantiate** the base — never loosen a hard
   requirement. "Our FAQ block uses 6 pairs" is fine; "we skip the FAQ block" is not.
2. If a supplement genuinely contradicts a base rule, it must declare it explicitly:

   ```markdown
   Overrides: G4 — FAQ block uses 3 pairs for product-doc articles (T7).
   ```

   Declared conflicts are surfaced to the reader; undeclared ones are a bug.
3. Supplements are written in the site's own language. The base stays English.
4. A supplement without a matching base file is ignored (with a warning) — it cannot
   introduce a brand-new standard file.

## 3. The checklist

| # | Item | Supplies |
|---|---|---|
| 1 | Delivery path & category registry | where the file lands, which category/tags |
| 2 | `## About <Brand>` standard paragraph | fixed wording incl. the topic-binding sentence |
| 3 | `## Get Started` CTA block | the fixed link set, not to be added to or trimmed |
| 4 | Front-matter site values | title suffix, default author, canonical URL pattern |
| 5 | Internal-link format & link pool | URL shape, ≥2 links to the hub, no dead links |
| 6 | Brand voice & banned words | red lines, wording taboos, misdescription guard |
| 7 | Template selection table | T1–T7 → word-count gate range, per language |
| 8 | Product-line routing | which CTA goes on product topics vs. industry topics |
| 9 | Domain & canonical host | used for `featured_image`, internal links, JSON-LD |
| 10 | Script gate overrides | if the site deviates from the default hard gates |

Items 1–6 come straight from the writing SOP; 7–10 come from the strategy document.
Anything not listed here is intentionally generic and must not be re-specified per
site.

## 4. Anti-patterns

- Putting brand facts, domains or product names into the generic files.
- Using a supplement to *remove* a gate instead of satisfying it.
- Duplicating the whole base file into the supplement — copy only the delta.
