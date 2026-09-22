# Content Platform Integration

> Generic standard shipped with this package. No brand names, no domains, no product
> lines — every platform account, entity URL and credential is supplied by the site.
> See `site-profile.md`.

---

## 1. Why

- **Feed AI citation sources (the GEO main line).** Get mainstream assistants to cite
  the site first when they answer brand- or category-related questions. Choose
  platforms by one criterion: *is this platform indexed by the assistant you care
  about*.
- **Reach technical practitioners and technical decision makers.** The core audience is
  practitioners (developers, SRE, architects) and decision makers (CTO, engineering
  directors, architects, technical procurement). Technical blogs and communities are
  the primary distribution surface.
- **Hard cross-platform rule.** Every syndicated copy must carry a `canonical_url` (or
  an explicit source link) pointing back to the original on the primary site. Where the
  platform supports the field, configure it; where it does not, state the backlink in
  the body or in the submission metadata. Otherwise search engines treat the platform
  copy as the original and it cannibalises the primary site's authority.

---

## 2. Entity-claim platforms (the AI citation anchor; highest leverage, not a publishing channel)

### 2.1 Entity-signal methodology

- **Stable `@id`**: use one fixed Organization `@id` site-wide, e.g.
  `{site-root}/#organization`.
- **`sameAs` set**: claim each profile and backfill its official URL, producing a
  cross-verifiable entity graph. Domestic and international platforms matter equally;
  both belong in the set.
- **Consistent authorship**: do not scatter `Person` authors in a way that conflicts
  with the organisation entity — point authorship at the Organization `@id`, or use
  `publisher` to carry the Organization.
- Rationale: guidance on generative-AI optimisation treats "a clear, third-party
  verifiable entity" as core to GEO. Entity SEO requires an Organization with **both**
  a stable `@id` **and** a `sameAs` set; only then can AI anchor the brand stably to an
  organisation entity.

### 2.2 Organization JSON-LD template (placeholders)

```json
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": "{site-root}/#organization",
  "name": "{brand name}",
  "alternateName": "{Latin-script brand name}",
  "url": "{site-root}",
  "logo": "{site-root}/assets/images/logo.png",
  "description": "{one-line positioning}",
  "sameAs": [
    "{site-root}",
    "{Wikidata entity URL}",
    "{Google Business Profile URL}",
    "{business-registry lookup URL}",
    "{encyclopedia entry URL}",
    "{GitHub organisation URL}",
    "{LinkedIn company page URL}",
    "{X/Twitter brand account URL}",
    "{microblog URL}",
    "{official messaging / video account URL}",
    "{Q&A organisation account URL}",
    "{short-video / feed platform URL}",
    "{Crunchbase organisation URL}"
  ]
}
```

### 2.3 Entity-claim platform list

#### China market

| Platform | Entity role | How to claim |
|---|---|---|
| Business registries (Tianyancha / Qichacha / Aiqiicha) | corporate registration verification | claim the company page, backfill into `sameAs`; one of the strongest domestic verification signals |
| Baidu Baike | authoritative endorsement | submit the entry for review, backfill into `sameAs` |
| WeChat official account / video account | brand home base | claim the official account, backfill into `sameAs` |
| Zhihu organisation account | professional / brand entity | claim the account, backfill into `sameAs` |
| Weibo | brand account | register / claim, backfill into `sameAs` |
| Douyin / Toutiao (ByteDance family) | brand home base | claim the official account, backfill into `sameAs` |

#### Global

| Platform | Entity role | How to claim |
|---|---|---|
| **Wikidata** | AI entity skeleton (Q-ID) | submit an organisation item, backfill the Q-ID into `sameAs`; cross-model and the strongest single entity signal |
| **Google Business Profile** | anchors the Google / Gemini entity | create the local business entity page, backfill the `cid` into `sameAs` |
| **GitHub** | technical entity | create the organisation and public repositories, backfill into `sameAs` |
| **LinkedIn** | company entity | create the company page, backfill into `sameAs` |
| **X / Twitter** | brand account | register / claim, backfill into `sameAs` |
| **Crunchbase** | commercial / funding signal | claim the organisation page, backfill into `sameAs`; not a GEO requirement — can be deferred |
| **Reddit** | community listening, potential AI source | only if you intend to capture Reddit signals: register a Data API app to stay compliant; not a publishing channel |

### 2.4 Where to deploy

Emit the JSON-LD as `<script type="application/ld+json">` on **every page** of the
site (in `<head>` or the footer; output exactly once site-wide):

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": "https://www.example.com/#organization",
  "name": "{brand name}",
  "alternateName": "{Latin-script brand name}",
  "url": "https://www.example.com",
  "logo": "https://www.example.com/assets/images/logo.png",
  "description": "{one-line positioning}",
  "sameAs": [
    "https://www.example.com",
    "https://www.wikidata.org/wiki/{Q-ID}",
    "https://www.google.com/maps/place/{cid}",
    "{business-registry lookup URL}",
    "{encyclopedia entry URL}",
    "https://github.com/{org}",
    "https://www.linkedin.com/company/{slug}",
    "https://x.com/{handle}",
    "{microblog URL}",
    "{Q&A organisation account URL}",
    "{official messaging / video account URL}",
    "https://www.crunchbase.com/organization/{slug}"
  ]
}
</script>
```

> `www.example.com` is a placeholder. Replace every value with the site's own facts —
> never publish a template with placeholders left in, and never copy another site's
> entity block.

---

## 3. General content platforms

### 3.1 China market

| Platform | Characteristics | Audience | API support | Feeds which assistant |
|---|---|---|---|---|
| WeChat official account (verified subscription) | strong daily cadence (1 push/day, ≤8 items); search ranking treats service and subscription accounts equally — what actually weights is *verification + originality + topical focus* | broad followers + active searchers | ✅ official API: create draft → publish; requires business verification, AppID/AppSecret and an IP allowlist; body HTML, images uploaded as permanent media first | the Tencent-family assistant |
| Baijiahao | Baidu-family platform; high search weight, fast indexing | Baidu searchers + industry readers | ✅ official content API: OAuth2.0 → publish endpoint, rich text + source link | the Baidu-family assistant |
| Zhihu organisation account | educated audience; indexes well; the direct-answer product can be cited | educated / professional readers | ❌ no public write API; the open platform is read-only and writing is prohibited by its terms | the Zhihu answer product |
| Toutiao | strong recommendation algorithm, large reach | general news readers | ⚠️ non-standard: backend endpoints + cookie / MCP automation, no clean open API | the ByteDance-family assistant |
| WeChat official account (service) | 4 pushes/month; lands in the chat list, high exposure but fast unfollow | product / transactional users | ✅ official API (as above) | the Tencent-family assistant |
| Baidu Baike | authoritative endorsement, strong search display | searchers | ❌ manual review: no API, submit the entry for approval | the Baidu-family assistant |
| Xiaohongshu | young, discovery-oriented | consumer audience | ❌ allowlisted commercial API only | — |

### 3.2 Global

| Platform | Characteristics | Audience | API support |
|---|---|---|---|
| WordPress.com | complete REST API | general | ✅ REST API |
| Medium | large reach, authoritative | overseas general / technical readers | ❌ official API deprecated: "Import a story" by URL (carries canonical automatically), or unofficial session-cookie automation |
| LinkedIn (company page posts) | company-page posts and long-form; B2B / professional decision makers | B2B / professional | ⚠️ no clean long-form publish API; company pages can post updates |
| Substack | subscription long-form | overseas subscribers | ❌ no official API for long-form (unreliable) |

---

## 4. Technical content platforms (the main battlefield for technical audiences)

### 4.1 China market

| Platform | Authority | Audience | API support |
|---|---|---|---|
| ★ InfoQ | very high | architects / engineering managers / CTO | ❌ submission / invitation |
| ★ Alibaba Cloud developer community | very high (vendor backing) | cloud / AI / data / architecture | ❌ creator console |
| ★ Tencent Cloud developer community | very high | same as above | ❌ creator console |
| ★ Huawei Cloud developer community | high | same as above | ❌ creator console |
| ★ 51CTO | high (decision-maker oriented) | ops / network / security / architecture | ❌ creator console (Word import supported) |
| ★ Juejin | high | developers (frontend origin, expanded to AI/backend) | ❌ creator console |
| Zhihu column | high (indexes well in Baidu / Sogou) | general but technically dense | ❌ no API (long-form column) |
| CSDN | high (one of the largest developer communities; uneven quality) | developers | ❌ no official API (reverse-engineering carries compliance risk) |
| cnblogs | medium-high (SEO friendly) | established, high-quality developers | ❌ creator console |
| SegmentFault | medium | developers (Q&A + blog) | ❌ creator console |
| OSChina | medium | developers | ❌ creator console |
| GitChat | medium | technical | ❌ creator console |

### 4.2 Global

| Platform | Characteristics | Audience | API support |
|---|---|---|---|
| **Dev.to** | developer-oriented, cleanest automation, SEO friendly | overseas developers | ✅ official REST API: API key + `POST /api/articles`, `canonical_url` supported |
| **Hashnode** | technical blogging, GraphQL, mature canonical handling | overseas developers / technical bloggers | ✅ GraphQL API: PAT + publicationId, draft → publish in two steps |
| **GitHub** | developer-oriented; GitHub Pages can host a technical blog or docs; repository READMEs and wikis *are* content and are widely indexed by AI and search (also carries the entity claim, see §2.3) | overseas developers | ✅ repositories / Pages: public READMEs and wikis become content directly; Pages hosts a site via git commits — no article-publish API |
| **Ghost** | full Admin API lifecycle | self-hosted blogs | ✅ Admin API (usually redundant if you already run a self-hosted CMS) |

---

## 5. Encyclopedia and authoritative-endorsement platforms

| Platform | Role | How | Feeds which assistant |
|---|---|---|---|
| Baidu Baike | authoritative endorsement, strong search display | ❌ manual review, no API; submit the entry for approval | the Baidu-family assistant |
| Wikidata | cross-model, the strongest entity signal; also the AI entity skeleton | submit an organisation item, backfill the Q-ID | all assistants |

---

## 6. Integration methods (methodology)

### 6.1 Four integration modes

| Mode | Platforms | Notes |
|---|---|---|
| **API automation** | verified subscription accounts, Baijiahao, Dev.to, Hashnode | wire into the post-publish pipeline via the official API; carries canonical automatically. Highest priority. |
| **Creator console + canonical backlink** | domestic technical communities, Zhihu columns, Toutiao (semi-automatic) | manual or semi-automatic distribution; the source backlink is mandatory |
| **Web automation (non-standard authorisation)** | Toutiao, CSDN (reverse-engineered / MCP) | non-standard; schedule after the API path and never promise it |
| **Purely manual** | Zhihu organisation account, Baidu Baike, Xiaohongshu (not planned) | one piece submitted to several places, or encyclopedia entries; no engineering investment |

### 6.2 Selection and differentiation rules

- Every syndicated copy **must carry the source backlink** (canonical or in-body) to
  protect the primary site's authority.
- Each cross-platform copy must differ from the original by **≥30%** (rewrite the
  lede, the structure, the case framing) so it is not judged duplicate content.
- Prioritise high-value pieces: developer-oriented, GEO-technical,
  architecture-decision content.

---

## 7. Distribution and reuse SOP

> Pairs with §6 (selection and differentiation rules).

### 7.1 One piece, many placements

- Take one core piece, rewrite it per platform, then distribute. Never copy verbatim.
- The three standard body blocks (summary · takeaways · FAQ) are materialised with the
  Markdown, so they travel with the copy automatically.

### 7.2 Platform adaptation

| Platform | Rewrite emphasis |
|---|---|
| Official account | narrative opening, strong CTA |
| Zhihu | professional depth, cited sources |
| Toutiao / Baijiahao | timely headline, short paragraphs |
| Video account | spoken script, cut into highlight slices |

### 7.3 Reuse boundaries

- The GEO/SEO body is the **master**; distributed copies are **children** and must
  state their source and their differences.
- Never sacrifice a GEO element of the master for the sake of distribution.
