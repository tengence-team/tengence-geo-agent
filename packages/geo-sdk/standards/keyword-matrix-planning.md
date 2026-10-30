# Keyword-Matrix Planning

> Converts raw keyword candidates into a publishable, deduplicated, data-backed
> article matrix, and keeps every later batch from cannibalizing earlier ones.
> Site-specific values (product lines, tag registry, link pool, word-count ranges)
> come from the site supplement with the same file name — never from this base.

## 1. Output of this step

A matrix row per article (CSV or table) carrying at least:

| Field | Meaning |
|---|---|
| slug | the article's canonical slug |
| head keyword | the primary term the article ranks for — **one per article** |
| intent / type / word count | intent tier (I/C/N/T) + skeleton type (T1–T7) + length gate |
| product line | which product or capability the article routes to |
| priority | P0 / P1 / P2 |
| demand evidence | GSC query/page data backing the choice |
| dedup note | how the row is differentiated from prior batches |
| internal links | 2–3 slugs of already-published articles |

The matrix is a decision artifact, not a keyword dump: every row must state why it
earns a slot.

## 2. Data-driven selection (GSC evidence)

- Pull GSC query / page stats (impressions, position, clicks) for the site property
  and record the measurement window in the matrix.
- A keyword earns a slot when it shows observed demand (query exposure) or fills a
  cluster the site already partially ranks for.
- Align the head keyword to the **observed query wording** (e.g. a GSC cluster
  `technical geo …`), not to an invented variant.
- Promote / demote by evidence: queries already at position 5–10 with impressions
  are promotion candidates; zero-impression long tails stay L2/L3.
- Never cite a volume or ranking number you did not observe.

## 3. Deduplication against prior batches (cannibalization control)

- **One page = one head keyword = one intent.** A second article on the same head
  keyword with the same intent is cannibalization: it splits ranking signals.
- Keep a single source of truth mapping head keyword → URL across every published
  and planned batch.
- When a candidate collides with an existing article:
  1. **replace** — drop the new candidate; the existing page owns the term;
  2. **merge** — fold the candidate into the existing page when intent matches;
  3. **differentiate** — keep it only if the intent boundary is genuinely different;
     rewrite title and angle so the two pages do not compete.
- Red lines: no same head keyword + same intent across two articles; no near-duplicate
  titles; a publish-time check must confirm the keyword-to-URL map is collision-free.

## 4. Multi-language release sizing

- Author N articles in the primary language, then translate each into every target
  locale: **N × L language versions total** — never "N articles across L languages".
- All language versions share the slug; each gets its locale URL prefix.
- The matrix is planned once in the primary language; translation rows are derived
  from it (per `translation-standards.md`).

## 5. Product-line balance

- With multiple product lines, distribute article coverage across all of them; no
  single line may monopolize a batch.
- Record the intended share per line in the matrix (e.g. 35/36/29) and verify the
  final counts before registration.

## 6. Volume / KD backfill

Backfill search volume and competition with a free tool before locking the matrix:

- **Google Keyword Planner** (free, no spend required): batch input is capped at
  ~10 terms per query — split the list and submit in batches; download the CSV
  (UTF-16 + tab) and parse it; fix the location / language / currency scope and
  record all three in the matrix.
- **SEMrush free tier** (~10 lookups/day) is an optional KD cross-check; a 100-term
  matrix can be spread over days or limited to the priority clusters.
- Mark "unknown" honestly when a tool shows no volume; do not fabricate ranges.

## 7. Internal-link planning

- Every new article links **2–3 already-published articles** in its Related Reading
  block — no dead links, no links to planned-but-unpublished pages.
- Batch strategy: an early article links only to prior-phase (already live) articles;
  a later article may also link earlier articles of the same phase that are live by
  publishing time.
- URL form is the site's same-language pattern (locale prefix + canonical path); no
  cross-language hops, no bare URLs.
- Anchor text uses a natural keyword phrase of the target article, never "click here".
- **Target by GSC evidence, not only by topic**: when prior-phase pages are live,
  prioritize links toward the pages that actually rank (impressions / position /
  clicks observed), and keep a keyword → single owning page map so the new batch
  never opens a second target page for an already-owned term.

## 8. Taxonomy and labels

- ≤3 tags per article: 1 product / capability tag + 1–2 topic tags, from the site
  registry.
- Reuse existing categories first; new tags go through the site's whitelist flow
  (registry + WP + plan table) before the batch is registered.

## 9. Priority tiers

- **P0**: defends brand terms, or sits in a GSC cluster with evidence at positions
  5–10 (promotion candidates).
- **P1**: solid demand or a cluster gap, standard cadence.
- **P2**: long-tail nurture / future topics.
- Evidence (GSC cluster match) may promote a row at review time; the promotion must
  be recorded in the matrix.
- **Brand-term defense is an explicit responsibility**: each matrix must state who
  owns the brand terms — this batch's new articles, or an earlier phase's published
  pages. A new brand-keyword article is only allowed when no prior page already owns
  the term (cannibalization); otherwise the batch's brand-mention internal links
  should point at the owning page to push it into the top 3.

## 10. Deliverable artifacts — CSV schema & MD report

A matrix ships as **two files with the same base name**: a CSV that drives the
machine pipeline (registration, drafting, publishing, linking) and an MD report that
a human reviews. The CSV is the single source of truth; the MD renders it plus the
decision records.

### 10.1 CSV schema (one row per article, primary-language authored)

| Group | Field | Required | Meaning / values | Consumed by |
|---|---|---|---|---|
| A Identity | ID | yes | phase + sequence (A01…) | traceability, ordering |
| | slug | yes | kebab-case, unique across ALL batches, shared by all languages | article_draft, WP |
| | title | yes | primary-language writing topic (shared by translations) | H1 candidate |
| | head keyword | yes | one primary keyword per article | title / lead |
| | zh-hans gloss | yes | zh-hans rendering of the head keyword, **calibrated against GSC localized queries (per-language dimension)** | translation keyword alignment |
| B Topic | intent | yes | I / C / N / T | skeleton routing |
| | type | yes | T1–T7 | skeleton selection |
| | word count | yes | primary-language length (site language gate) | length gate |
| | batch | yes | 1..N | scheduling |
| | priority | yes | P0 / P1 / P2 | capacity planning |
| C Product & publishing | product line | yes | routed product / capability (site supplement enum) | balance quota, CTA routing |
| | brand-mention points | yes | ≥2 natural mentions (placement convention) | writing execution |
| | category | yes | WP category (reuse existing first) | WP registration |
| | tags | yes | ≤3: 1 product + 1–2 topic (whitelist) | WP registration |
| D Evidence | GSC demand evidence | yes | observed query / impressions / position / clicks + window | selection, promotion audit |
| | monthly volume | recommended | Keyword Planner measured range; "unknown" if none | volume assessment |
| | competition | recommended | Keyword Planner tier; "unknown" if none | KD assessment |
| E Dedup | dedup note | yes | differentiation from prior batches (replaced / merged / differentiated) | cannibalization gate |
| F Internal links | internal link 1–3 | yes | slugs of 3 already-published articles | Related Reading |
| | early-phase internal link | batches 2+ | slug of an already-published same-phase article | Related Reading |

Hard rules: a row with any required field missing is **not registrable**; `slug`
must be globally unique; a head-keyword + intent collision with any prior batch is
a gate error; evidence columns must never be fabricated. The zh-hans gloss must be
verified against GSC query data pulled **per language** — a head keyword whose
translation misses the actually-searched localized term is a coverage gap, not a
word choice.

### 10.2 MD report sections (for human review)

| # | Section | Must contain |
|---|---|---|
| 1 | Overview | phase, total article count, language sizing (N authored × L translations), product-line quotas, batch cadence, GSC data window |
| 2 | Categories & tags | category list, tag whitelist incl. additions for this phase, per-article tag rule |
| 3 | Demand-evidence summary | Top-N GSC hits, how evidence drove selection / promotions |
| 4 | Full matrix | the CSV rendered as a readable table |
| 5 | Dedup notes | replaced / merged / differentiated dispositions + writing red lines |
| 6 | Review & adjustment log | promotions / demotions / keyword swaps with date and basis (audit trail) |
| 7 | Internal-link plan | rules, mapping statistics (machine-generated + human-checked), writing-time actions |
| 8 | Volume / KD backfill | tool, location / language / currency scope, result summary, "unknown" marking |
| 9 | Registration plan | batch scheduling, registration actions, confirmation status |
| 10 | Risks & open items | unresolved decisions, dependencies, open questions |
