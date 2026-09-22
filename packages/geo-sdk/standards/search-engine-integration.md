# Search Engine Integration

> Generic standard shipped with this package. No brand names, no domains, no product
> lines. Anything site-specific — the verified domains, the platform accounts, the API
> credentials — is supplied by the site, never assumed here. See `site-profile.md`.

---

## 1. Core model

### Three discovery paths (how crawlers find you)

```text
(1) sitemap submission  -> the crawler follows the map
(2) inbound links       -> the crawler arrives by following links (main source of
                           authority and trust)
(3) active push / API   -> the publisher tells the crawler directly
                           (most effective for a new site; must be used fully)
```

A new site should saturate path (3) first and build its first high-quality inbound
links as early as possible: links are both a crawler entry point and the core
authority signal.

### The indexing → ranking → citation chain

```text
Indexed by a search engine
   |--→ search ranking   → click traffic       (SEO value)
   └--→ becomes a retrieval candidate → cited by AI answers (GEO value)
           |  engines that lean on one index vs. the open web
           |  assistants tied to a single vendor's ecosystem
           |  assistants that depend on a specific third-party index
           └  assistants with their own retrieval layer
```

**Implication:** each major index is an entry ticket to a different family of AI
assistants. Treat them as separate channels — all of them, not one of them.

### Why indexing is a prerequisite for AI citation

AI retrieval layers run a second pass of retrieval and ranking *on top of* search
indexes. Content that is not indexed cannot enter the candidate set. Submission and
indexing are therefore the foundation under every other GEO action.

### Realistic ramp for a new site

A new domain carries little authority; expect a **1–3 month** ramp before indexing
and ranking stabilise. During that window: (1) push every new URL actively, (2) route
existing authority to new pages with internal links, (3) acquire the first inbound
links, (4) publish steadily.

---

## 2. Measuring the indexing baseline

### Why `site:` queries are unreliable

External `site:domain` queries are routinely answered with a 302, a captcha, or
unrelated results. The count is not trustworthy and must **not** be used as an
indexing metric.

### Correct approach: read the real number in the webmaster backend

Read "pages indexed" from each webmaster console and record it as a time series
(weekly or monthly). Only a series proves growth.

| Platform | Console | Field to read |
|---|---|---|
| Baidu | Baidu Search Resource Platform → Index volume | Total indexed + trend |
| Google | Search Console → Indexed pages | Pages indexed |
| Bing | Bing Webmaster Tools → Sitemaps / URL submission | Submitted URLs indexed |
| Sogou / 360 / Shenma | Respective webmaster consoles | Indexed URL count (record `-` if unverified) |

> A freshly verified site showing 0 is normal; allow 2–3 days for the data to backfill.

---

## 3. China-market search engines

> Priority legend: **P0** must do (largest share, or the index behind a domestic
> assistant) · **P1** important (complementary ecosystem, fast indexing) ·
> **P2** supplementary (specific coverage).

| Priority | Platform | Entry point | Submission | Why it matters |
|---|---|---|---|---|
| P0 | **Baidu** | Baidu Search Resource Platform | sitemap + manual + API + auto JS | Largest domestic share; its index is the retrieval base for several domestic assistants. The foundation of every domestic GEO action. |
| P0 | **ByteDance search** | ByteDance webmaster platform | sitemap + auto-index JS | Retrieval base for the ByteDance-family assistant; also the Douyin/Toutiao traffic entry. Skipping it means absence from that family. |
| P1 | **WeChat Search** | WeChat official-account platform + open platform | sync official-account content | Closed ecosystem; one assistant reads official accounts directly. Content that never enters an official account is invisible to it. |
| P1 | **Sogou** | Sogou webmaster platform | sitemap + manual URL | Inherits Tencent-ecosystem traffic; indexes fast — useful as a probe for crawlability. |
| P1 | **360** | 360 webmaster platform | sitemap + API | Stable desktop share; its AI search reuses the same index. |
| P2 | **Shenma** | Shenma webmaster platform | sitemap | Mobile (UC) traffic; mobile-friendly. |
| P2 | **Quark AI search** | Alibaba family, no separate console | indexing + structured data | Mobile search entry for younger cohorts. |

**Differentiated tactics**

- **Baidu**: beyond submission, build out the surrounding ecosystem (encyclopedia
  entries, the owned content platform, Q&A). Those properties are the strongest
  citation sources for domestic assistants.
- **ByteDance**: inject the auto-index JS site-wide and keep the sitemap current;
  its assistant leans heavily on this index.
- **WeChat Search**: originality certification and content quality of the official
  account directly determine visibility in the corresponding assistant.
- **Sogou**: fast indexing — use it as a crawlability probe for new content.
- **360 / Shenma / Quark**: supplementary; mobile adaptation and a correct sitemap
  are the prerequisites.

> **Common gap.** A new site with persistent "zero effective Baidu crawl" is usually
> not a server problem — it is a missing active-push configuration or an abnormal
> site status on the Baidu side. Investigate separately.

---

## 4. Global search engines

> Same priority legend. Global engines do not depend on domestic filing and are the
> key to overseas visibility and overseas AI citation.

| Priority | Platform | Entry point | Submission | Why it matters |
|---|---|---|---|---|
| P0 | **Google** | Google Search Console | sitemap + URL inspection | Entry ticket for the Google-ecosystem assistants; sets the mobile-first indexing standard. |
| P0 | **Bing** | Bing Webmaster Tools | sitemap + URL Submission API | Retrieval base for several North-American assistants. |
| P0 | **IndexNow** | indexnow.org | JSON API, real-time | The closest thing to "submit directly to AI retrieval": publish-and-notify, very high return for the effort. |
| P1 | **DuckDuckGo** | reuses the Bing index | covered automatically via Bing | Privacy-focused entry; no separate work needed. |
| P1 | **Yandex** | Yandex Webmaster | sitemap | Russian-market coverage. |
| P2 | **Naver** | Naver Search Advisor | sitemap | Korea-specific entry. |
| P2 | **Seznam** | Seznam Webmaster | sitemap | Czech-market entry. |

### Implementing IndexNow

1. Generate a 32–128 character hex key (`openssl rand -hex 16`).
2. Write the key to a file whose *name* is the key (`{key}.txt`); its content is the
   key on a single line.
3. Upload it to the site root so `https://domain/{key}.txt` is reachable — HTTP 200,
   `content-type: text/plain`, no stray whitespace or newline.
4. Push URL lists (max 10,000 per batch):

```json
{
  "host": "www.example.com",
  "key": "YOUR_KEY",
  "keyLocation": "https://www.example.com/YOUR_KEY.txt",
  "urlList": [
    "https://www.example.com/page-a",
    "https://www.example.com/page-b"
  ]
}
```

> `keyLocation` must be an absolute https URL on the same host as `host`.
> 200/202 = accepted; 400 = malformed JSON; 403 = the key file is not reachable.

### Why Bing matters beyond Bing

Bing is the retrieval backbone for several assistant products, so **Bing indexing +
IndexNow** indirectly opens the overseas AI citation channel at very low cost.

---

## 5. Automated push channels (push on publish)

### Recommended architecture

```text
Article published
   |--→ Baidu active-push API
   |--→ IndexNow real-time push
   |--→ Bing indexing (normally carried by IndexNow; no separate API)
   |--→ Google Search Console service account (sitemap submit + URL inspection sampling)
   └--→ log the result (URL / channel / timestamp / response / quota remaining)
```

Wire this into the CMS publish hook so "published" implies "submitted everywhere".
Manual submission is a guaranteed source of omissions.

### Mechanism, quota and cadence

| Channel | Mechanism | Quota | Cadence |
|---|---|---|---|
| Baidu active push | tell the crawler directly | typically 3,000–5,000/day for a new site | push on every publish; scheduled incremental re-push |
| IndexNow | JSON API, real-time | up to 10,000 URLs per batch | push on every publish |
| Bing (via IndexNow) | triggered by IndexNow | usually sufficient | push on every publish |
| Google URL inspection | request indexing | ~50/day | request indexing for unindexed pages daily |

### Re-push schedule (T+3 / T+7 / T+14)

- **T+0** — push to every channel on publish.
- **T+3** — check indexing; if not indexed, request indexing in GSC and re-submit
  manually.
- **T+7** — still not indexed: check `noindex`, `canonical` and `robots`; add
  internal and external links.
- **T+14** — still not indexed: treat it as a quality problem — expand by ~30%, add
  data, then re-push.

---

## 6. Indexing quality

### sitemap best practice

- Include only important, stable, canonical URLs. Exclude pagination, filters and
  parameter-duplicated pages.
- Ping / re-submit the sitemap after content updates.
- For large sites, split into a sitemap index plus child sitemaps so crawlers can
  traverse efficiently.

### robots.txt

- **List AI crawler user-agents explicitly** (for example `OAI-SearchBot`,
  `PerplexityBot`, `Bytespider`, `Baiduspider`) rather than relying on
  `User-agent: *`. Only an explicit list lets you differentiate retrieval crawlers
  from training crawlers, and only then can the policy be reviewed.
- Declare the sitemap location with a `Sitemap:` directive.
- Re-run a fetch-diagnostics check in the webmaster console after every change.
- **Re-audit the AI user-agent list quarterly** — vendors rename and merge agents
  frequently.

### URL canonicalisation

- Pick one preferred host (www or bare) and 301 everything else to it. **Allow exactly
  one 301 hop**: 302s and multi-hop chains pass little authority and get mangled by
  CDN caching.
- Mark canonical pages with `canonical` so tracking parameters do not spawn duplicates
  that dilute authority. **Trailing-slash must be consistent** — `/article/` and
  `/article` are two different canonicals and their signals fight.
- Force HTTP → HTTPS with a 301.

### Mobile and mobile-first indexing

- Google has been **mobile-first** since 2020: the primary crawler sees the mobile
  rendering. The mobile site must expose every article link; a mobile homepage with
  no article links makes the blog nearly invisible in the mobile index.
- If you run an m-dot setup: (1) annotate both directions (`alternate media` +
  `canonical`), (2) keep canonicals consistent, (3) avoid UA-based redirects that
  poison the CDN cache — send `Vary: User-Agent` or move to responsive single-URL.

### Internal and external links

- **Internal**: clear heading hierarchy plus contextual links, routing authority from
  the homepage and hub pages to new articles. Shallow internal linking leaves new
  articles with no authority and excessive crawl depth.
- **External**: the first high-quality inbound links are what break the "zero links"
  deadlock — prioritise industry media, product directories, technical communities and
  partner cross-links. Never buy links or use bulk blasting tools; both trigger
  algorithmic penalties.

### Structured data / Schema

- Deploy `Article`, `BreadcrumbList`, `FAQPage`, `Product` JSON-LD to cut parsing
  cost for both search engines and AI, raising the odds of inclusion and citation.
- Pair it with an `llms.txt` at the site root to further reduce AI parsing cost.

### CDN, caching and crawl budget

- Cache HTML (lower TTFB, less origin load) and give static assets long cache
  lifetimes — excessive origin fetches waste **crawl budget** and raise latency.
- Crawl budget is finite: every request consumed by scanners or vulnerability probes
  is a request the real crawler cannot spend. Rate-limit or block obviously abusive
  agents at the edge and reserve the budget for search and AI crawlers.
- Observed in practice: **AI crawlers are usually already hitting the site heavily**
  (hundreds to thousands of hits per month per vendor). "Can they crawl us" is
  generally already true — the work shifts to whether the crawled content is worth
  citing, i.e. GEO content quality.

### Dead links and content refresh

- Submit dead-link lists (404 / retired pages) periodically.
- Refresh older articles (expand, add data, update time-sensitive claims) instead of
  deleting in bulk. Any URL change must be a 301.

---

## 7. Entity and authoritative sources (stable brand anchoring)

> GEO is not only "be indexed" — it is making AI anchor the brand stably as *one
> organisation entity*. See `content-platform-integration.md`.

- **`sameAs` entity graph**: claim and backfill each profile — official site,
  LinkedIn, X/Twitter, GitHub, Wikidata (strongest cross-model entity signal, the
  Q-ID), Google Business Profile, Crunchbase — and wire them into the Organization
  JSON-LD `sameAs` set. A cross-verifiable graph is what lets AI anchor the brand to
  an organisation entity.
- **Stable site-wide `@id`**: use a fixed Organization `@id`, e.g.
  `{site-root}/#organization`.
- **Consistent authorship**: an article `author` must not conflict with the
  organisation entity — point it at the Organization `@id` or use `publisher`.
- **Ecosystem coupling**: each content platform feeds its own assistant. Reputation
  and presence on those platforms directly determine visibility in the corresponding
  assistant.

---

## 8. Cautions and troubleshooting

### Cautions

1. **Never buy links, never use bulk blasting tools** — mainstream algorithms penalise
   both, and it destroys GEO credibility.
2. **Push ≠ indexed.** Pushing only notifies; indexing depends on content quality and
   site trust. Budget 1–3 months for a new site.
3. **Search indexing is a prerequisite for AI citation.** Once compliance, robots,
   sitemap and `llms.txt` are correct, what remains is content quality and links.
4. **Console entry points change.** Re-audit webmaster console URLs and AI crawler
   user-agents quarterly.
5. **Keep push credentials secret**: API keys and service-account secrets belong in a
   gitignored credentials file, never in version control.

### Troubleshooting

| Symptom | Likely cause | Checks |
|---|---|---|
| Completely unindexed by a domestic engine | site unverified / robots blocked / low-quality content / no active push configured | ① verification status ② `curl` robots.txt ③ fetch diagnostics ④ active-push config ⑤ preferred-domain and duplicate 301s |
| Indexed, then dropped | low quality / unstable server / scraped copies | ① coverage report ② uptime log ③ originality check |
| Crawled but "not indexed" | quality / duplication / low authority | ① add inbound links ② add internal links ③ expand + add data |
| Push API returns quota 0 | daily quota exhausted | re-push next day; throttle push frequency |
| IndexNow 403 / 400 | key location mismatch or malformed body | ① `domain/<key>.txt` reachable and content equals key ② JSON complete |
| Never cited by AI | not indexed / crawler blocked / content not extractable | ① robots ② index status ③ `llms.txt` + Schema |
| Cited but mis-stated | a third-party aggregator carries wrong data | ① fix the official site ② align every platform ③ re-push |
| Never cited by one vendor's assistant | its crawler blocked / never submitted to its webmaster console | ① robots ② submit in that console |
| Poor mobile indexing | mobile-first sees the mobile rendering, but it hides article links or canonicals disagree | ① article links on mobile homepage ② canonical trailing slash ③ bidirectional `alternate` |
