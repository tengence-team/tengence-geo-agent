<!-- T7 Product-guides
     Use for: API references, console walkthroughs, integration, configuration,
     billing notes.
     Length: per the site's template selection table gate range.
     H2 style: numbered + code blocks; usually no CTA.
     Tone: less GEO marketing, more accuracy and operability — steps must be
     copy-pasteable and parameters must be checkable against a table.
     Red lines and the full conventions: article-writing-standards.md. -->
---
seo:
  title: "{SEO title (≤60 characters)}"
  keywords: ["{primary keyword}", "{secondary keyword}", "{long-tail keyword}"]
  focus_keyword: "{focus keyword}"
  meta_description: "{165–175 characters, conclusion first}"
featured_image: "https://www.<site-domain>/blog/static/images/{category}/{slug}/cover.webp"
---

# {Article title: feature + action}

> **Summary:** {Conclusion first, 40–60 characters — the feature + what it achieves +
> time or prerequisites.}

{Lead paragraph (80–120 characters): what this feature solves and who it is for.}

## Key Takeaways

- {Point one}
- {Point two}
- {Point three}
- {Point four}
- {Point five}

## 1. Feature Overview

{What this feature solves, its inputs and outputs; answer-first opening sentence.}

## 2. Prerequisites

{Account / permissions / data preparation; use a list.}

## 3. Steps / API Call

{Step-by-step; include a code block and a parameter table.}

```bash
# Example: call the diagnostic endpoint
curl -X POST https://api.<site-domain>/v1/diagnose \
  -H "Authorization: Bearer {TOKEN}" \
  -d '{ "domain": "https://www.example.com" }'
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| domain | string | yes | {site domain to diagnose} |
| token | string | yes | {app token} |

## 4. FAQ

> **Q: {question one}?**
>
> A: {answer}

> **Q: {question two}?**
>
> A: {answer}

## About <Brand>

{The site's standard "About" paragraph, including the topic-binding sentence.}

## Related Reading

- [{verified article title}](https://www.<site-domain>/blog/article/{verified-slug}/)

## Data Sources

1. **[{source name}](the specific page carrying the claim)**: {the conclusion or figure
   stated on that page}.
