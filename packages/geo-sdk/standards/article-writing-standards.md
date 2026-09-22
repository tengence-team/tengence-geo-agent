# Article Writing Standards

> The hands-on spec for **every** writing task: what to deliver, the exact body shape,
> the citation and internal-link rules, the quality bar, and the G1–G14 editorial gates.
> Strategy-level questions (which format, keyword matrix, cadence) belong to
> `content-strategy.md`. Site-specific values are **not** here — see `site-profile.md`.

A second, **script-level** gate runs at publish time (`--type` hard word-count check
plus the body checks). The editorial gates below and the script gate cover different
items under the same numbering; **both must pass**.

## 1. Deliverable: one Markdown file

- Deliver **exactly one file**, `<slug>.md`. Metadata lives in **YAML front matter** at
  the top; no separate `.meta.json` is produced.
- Front matter carries **only** meta that the body does not render: the four `seo`
  fields plus `featured_image`.
- **Summary / key takeaways / FAQ / data sources are written into the body** and are
  reverse-parsed back into the content store by the publish chain. Putting them into
  front matter has no effect.
- Where the file lands and how the category is registered: site-defined.

## 2. Body skeleton (follow exactly)

```markdown
---
<front matter: the four seo fields + featured_image — see §3>
---

# Article title (H1)

> **Summary:** one sentence stating the core judgement of the article, 60–90 characters,
> standing on its own as a conclusion (the source of the GEO summary field).

Lead paragraph: industry background / business problem / core metric / the value of this
article. **No** story openings, no characters or scenes, no dialogue, no emotional
language. 150–250 characters.

## Key Takeaways

- Takeaway 1 (one line each, a standalone sentence, unnumbered)
- Takeaway 2
- …
- Takeaway N (**≥5, aim for 6**)

## 1. <numbered section>

Body. Numbered H2 sections run **continuously** — no skipped and no repeated numbers
(Arabic numerals in English, Chinese numerals in Chinese).

…

## FAQ

> **Q: <a complete question, ending in ?>**
>
> A: <answer, 60–180 characters. Never start the answer with "A:">

(**≥5 pairs, aim for 6.** One blank line between pairs.)

## About <Brand>

<one brand paragraph + product link — copy the site's standard wording and links>

## Related Reading

- <a href="<on-site article URL>" target="_blank" rel="noopener noreferrer"><title></a>

(**3–5 items**)

## Data Sources

1. <a href="<specific page URL>" target="_blank" rel="noopener noreferrer"><Institution, Report Name (year)></a>: <which claim in the article this citation supports, in one sentence>

(**≥3 items**, every item must carry a link, and the link must actually resolve)

## Get Started

<the site's fixed CTA link set — not to be added to or trimmed>
```

## 3. Front matter

```yaml
---
seo:
  title: "<H1 title> | <brand suffix>"
  focus_keyword: "<target keyword>"
  keywords: ["<target>", "<related 2>", "<related 3>", "<related 4>", "<related 5>"]
  meta_description: "<90–158 characters, contains the primary keyword, says what the article delivers>"
featured_image: "<final cover image URL; fill in after imaging, otherwise an empty string>"
---
```

Rules:

1. **Front matter carries these five fields only** (`seo.title`, `seo.focus_keyword`,
   `seo.keywords`, `seo.meta_description`, `featured_image`).
2. Summary / takeaways / FAQ / data sources go into the **body**; they are reverse-parsed
   and synced back. Writing them into front matter has no effect.
3. `meta_description` must be **90–158 characters** — the single most common failure;
   count it before you finish.
4. The publish chain treats **front matter as the only source of truth**. `.meta.json` is
   retired and kept only as a fallback for legacy articles.

## 4. Citations (the most common reason an article is rejected)

1. **They must exist.** Verify every URL before using it — only a **200** qualifies:

   ```bash
   curl -s -o /dev/null -w "%{http_code}" -L --max-time 20 -A "Mozilla/5.0" "<candidate URL>"
   ```

2. **They must be the specific page that states the claim.** ❌ a homepage, ❌ a level-1
   channel page (`example.com/blog/`), ❌ a guessed URL.
3. **Preferred sources**: arXiv papers, official documentation, listed-company filings
   and investor-relations pages, official engineering blogs, and the **specific report
   page** of a research firm.
4. **≥3 citations, and the body must actually use them** — each citation carries one
   concrete claim. Do not pad the list.
5. In the data-sources block, state for each item **which claim it supports**.
6. **If you cannot find the specific source for a claim, delete the claim.** Do not
   weaken it into a vague number and do not substitute a homepage URL.

## 5. Internal links

1. On-site links use the URL format the site defines.
2. In the body, on-site links are **Markdown** `[title](url)`. In the related-reading
   block they are **HTML** `<a … target="_blank" rel="noopener noreferrer">`.
3. Links may point **only** to ① articles already published, or ② articles queued ahead
   of this one. Anything unpublished is skipped automatically — as good as not written.
4. **≥3 in-body on-site links**, woven into the argument naturally, plus 3–5 in
   related reading.
5. Off-site links (citations) use HTML `<a>` with
   `target="_blank" rel="noopener noreferrer"`.

## 6. Quality bar (this decides whether AI will cite the article)

- **Fact density**: at least one verifiable statement per 150–200 words (data,
  literature, an official position). This is the core of GEO.
- **Do not write**:
  - ❌ universal openings ("In today's digital era…", "With the development of X…")
  - ❌ empty parallelism, emotional exclamations, stacked rhetorical questions
  - ❌ sections that are nothing but two or three sentences under a heading
  - ❌ invented precise figures
- **Do write**:
  - ✅ ≥300 characters per H2 section, with real substance (table / list / steps /
    comparison dimensions)
  - ✅ at least one Markdown table (comparison, metrics, or checklist)
  - ✅ executable methods, decision rules, rollout steps — not generalities
  - ✅ figures with a source; when it cannot be verified, use a qualitative statement
- **Cases**: never name a real company, brand or person. Use natural generic
  descriptors, and never invent a case — with no real data, write no case section.

## 7. Delivery report

Report: ① file path ② length ③ the gate result verbatim (last three lines) ④ which
citations were used and what each one carries. **If any gate fails, fix it until all
pass before reporting** — never hand back a failing draft.

## 8. Editorial gates G1–G14

All 14 must pass before publishing; any failure sends the article back.

| ID | Gate | Criterion |
|---|---|---|
| G1 | Title carries the target term | naturally, without stuffing |
| G2 | Answer-first opening | every H2 opens with a self-contained 40–60 character answer |
| G3 | Key-takeaways block | 4–8 items, after the lead and before the first H2 |
| G4 | FAQ block | 4–8 pairs in the Q/A notation |
| G5 | Entity byline | real author name + Organization |
| G6 | Verifiable citations | sourced links with dates; no homepage or level-1 channel pages |
| G7 | Anonymized data | no real companies or people; use generic descriptors |
| G8 | No fabrication | no invented cases or figures |
| G9 | Internal links | ≥2 pointing at the hub, no dead links |
| G10 | No bare URLs | citations are text hyperlinks |
| G11 | Geographic framing | global first; single-market data labelled with its country |
| G12 | No Markdown residue | no stray `###` or markers in the rendered body |
| G13 | Compliant images | no third-party logos; every image carries real content |
| G14 | Correct CTA | routed by product line, no broken links |

## 9. Site-specific items

The following are **not** defined here; the site must supply them as a supplement
(`site-profile.md`): delivery path and category registry, the `About <Brand>` standard
paragraph, the fixed `Get Started` CTA link set, front-matter site values (title suffix
and similar), internal-link URL format and link pool, brand voice and banned words, and
the type→length gate table.
