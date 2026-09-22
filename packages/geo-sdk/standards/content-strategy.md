# Content Strategy (Generic Methodology)

> Site-agnostic. Everything that depends on *which* site you publish to lives in a
> supplement — see `site-profile.md`. The hands-on writing rules are in
> `article-writing-standards.md`.

## 1. Content strategy: formats ranked by GEO value

### 1.1 Ranked by AI-citation probability

Not all content is equal. Rank by **"probability of being cited in an AI answer ×
commercial value"** and push the limited production capacity to the top of that list:

1. **Definition** (What is X): the first thing AI cites for explanatory questions, with
   broad long-tail coverage → highest priority.
2. **Comparison** (X vs Y, which is better): mid-decision readers; high citation
   probability, high commercial value.
3. **How-to**: operational; medium-high citation probability, high conversion value.
4. **Industry insight** (trends / forecasts / round-ups): builds authority and is easily
   cited in summaries, but needs continuous investment.

### 1.2 Three iron rules

1. **Citable**: every paragraph carries a self-contained conclusion sentence
   (answer-first) that AI can lift directly; key figures carry a source and a date.
2. **Verifiable**: every fact, number and comparison traces back to a public source. No
   invented cases, no fabricated data.
3. **Closable**: every article ends with an explicit CTA and internal links, so the
   traffic AI sends is captured and routed onward.

### 1.3 Content red lines (corrected against measurement)

- **No fabrication**: "we have no real case yet" is a fact; do not invent customer names
  or figures to fill the page. Use generic descriptors instead.
- **No inflated credentials**: never imply an endorsement ("officially certified") that
  does not exist.
- **No keyword stuffing**: natural language wins; AI detection has zero tolerance for
  stuffing.

### 1.4 Geographic framing

- Default to a **global** view. Every figure carries country + institution + year;
  single-market data must be labelled with its country.

## 2. Dual-engine strategy and content architecture

### 2.1 The dual-engine model

| Engine | Logic | Content supply |
|---|---|---|
| **SEO engine** | the user searches → ranking in search engines | keyword matrix + deep long-form + internal links |
| **GEO engine** | AI answers → citation in AI assistants | structured + citable + fact density + entities |

Both engines are **fed by one production line**: one article satisfies SEO and GEO at
the same time. Never write two versions.

### 2.2 Content architecture (hub & spoke)

- **Hub**: one definition-format hub page per business topic, maintained long-term,
  carrying the head terms.
- **Spoke**: belongs to a content cluster and passes internal-link weight up to its hub.
- **Category pages become hubs**: an existing category page must be filled with
  aggregated content and an internal-link matrix so it can act as a hub.

### 2.3 Commercial landing

- Commercial intent raised by content needs a landing page; the CTA routes by product
  line (site-defined).

## 3. Keyword-matrix method

### 3.1 Seed library

| Seed class | Contents |
|---|---|
| Core brand | brand name, product names |
| Capability | core capabilities and methodology terms (GEO, generative-engine optimization, AI citation…) |
| Scenario | application and technical scenarios |
| Pain | the reader's own wording for the problem |
| Industry | target industries |

### 3.2 Combination formula

`[pain / scenario] + [capability] + [industry / role]`

### 3.3 Intent tiers

| Intent | Meaning | Format |
|---|---|---|
| Informational (I) | understand a concept | long-form definition |
| Commercial (C) | evaluate and compare | comparison / review |
| Navigational (N) | find a product or site | product page / landing page |
| Transactional (T) | buy or enquire | solution page / CTA |

### 3.4 Levels and priority

- **L0 brand terms**: defend the ranking, prevent impersonation.
- **L1 head terms**: nurture; do not open a dedicated article — the hub page carries
  them.
- **L2 / L3 long-tail terms**: cover them one article at a time; this is the bulk of the
  work.

## 4. Single-article template SOP

### 4.1 Template selection (T1–T7)

Generic skeletons live in `templates/skeletons/`. Pick by type:

| Type | Use for | Skeleton |
|---|---|---|
| T1 Definition | what is X — the first choice for explanatory questions | `templates/skeletons/definition.md` |
| T2 How-to | how to do X — operational (the default) | `templates/skeletons/howto.md` |
| T3 Product-solution | capabilities, technical solutions, rollout | `templates/skeletons/product.md` |
| T4 Case-study | implementations, growth retrospectives | `templates/skeletons/case.md` |
| T5 Industry-insights | trends, market analysis, round-ups | `templates/skeletons/industry.md` |
| T6 Comparison | X vs Y, selection guides | `templates/skeletons/comparison.md` |
| T7 Product-guides | API, console walkthroughs, configuration | `templates/skeletons/guide.md` |

- Site-specific values inside a skeleton (domain, brand name, the fixed CTA link set,
  related-reading URLs, length range) are placeholders — `<site-domain>`,
  `About <Brand>`, the site's CTA set — filled in from the site supplement.
- **In one line**: concept → T1, operation → T2, solution → T3, result → T4, trend → T5,
  selection → T6, integration → T7. When in doubt, default to T2.
- **Length gate**: enforced by the script gate (`--type`). The shipped default ranges are
  **Chinese-character** counts (T1 2200–3200 / T2 3000–4200 / T3 3200–4500 / T4
  2500–3500 / T5 2600–3800 / T6 2200–3200 / T7 1500–2500). An English-language site
  **must** define its own word-count ranges in its supplement — do not reuse these
  numbers.

### 4.2 Title and lead

- The title carries the target keyword naturally, without stuffing. The lead states the
  conclusion + the data + the value directly.

### 4.3 Body structure (definition-format example)

- **Lead**: industry background + core question + what this article delivers. No
  metadata block.
- **Body**: section by section; every H2 opens with a self-contained 40–60 character
  answer.
- **Key takeaways**: 4–8 bullets, after the lead and before the first H2.
- **FAQ**: 4–8 pairs in blockquote form.
- **CTA**: routes to the product / the owned channel.

### 4.4 Writing for GEO

- Answer-first: the first sentence of every H2 is the conclusion.
- Entity and byline: real author name + Organization / sameAs.
- Evidence density: concrete figures, dates, comparison tables, named entities.
- Freshness: `dateModified` reflects a real update.

### 4.5 Internal links and citations

- Internal links follow the site's hub & spoke topology (§2.2); citations are text
  hyperlinks — never bare URLs.

### 4.6 Self-check list

- [ ] Title carries the target keyword
- [ ] First sentence is answer-first
- [ ] 4–8 key takeaways
- [ ] 4–8 FAQ pairs
- [ ] ≥2 internal links pointing at the hub
- [ ] Citations verifiable and dated

> The full body skeleton, front-matter template and the citation / internal-link rules
> are in `article-writing-standards.md`.

## 5. Production pipeline and the three-level quality gate

### 5.1 Pipeline

```
topic (matrix) → outline (GEO structure) → writing (template SOP)
  → self-check (gates G1–G14) → images → publish → indexing / citation monitoring
```

### 5.2 Cadence and capacity

- Target ≥8 articles per week; publish on a rolling batch plan.
- Retro-fitting existing articles runs in parallel and does not consume new-production
  slots.

### 5.3 Three-level quality gate

| Level | Gate | When | Owner | Standard |
|---|---|---|---|---|
| 1 | GEO gate | before publishing | the writer | G1–G14 all green |
| 2 | Editorial review | before publishing | an editor | facts / logic / formatting |
| 3 | Sampling audit | after publishing | the writer | originality ≥85%, no AI fingerprints |

## 6. Refresh and retirement

### 6.1 What triggers an update

- Data older than 6 months, a competitor moved, an algorithm update, user feedback.

### 6.2 Refresh flow

Re-review the old article → add new data / cases → update `dateModified` → run the gates
again → re-submit for indexing.

### 6.3 Retirement

- Long-term zero traffic with no recovery value → merge or take down. Never leave dead
  links behind.
