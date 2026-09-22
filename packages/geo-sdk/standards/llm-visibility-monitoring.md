# AI Visibility Monitoring

> Generic standard shipped with this package. No brand names, no domains, no product
> lines. The list of competitors to track, the brand aliases to disambiguate and the
> API keys all come from the site. See `site-profile.md`.

---

## 1. "Monitoring" means four different things

Work on the AI side splits into four layers with different goals and different
levers. They are complementary, not interchangeable.

| Layer | Meaning | Key action | Controllability |
|---|---|---|---|
| **A. Retrieval-index layer** | When an assistant searches the web, candidates come from a search index (Baidu / Bing / Google) | Submit to and get indexed by search engines | **High** |
| **B. Direct-crawl layer** | The vendor's own crawler (GPTBot / PerplexityBot / others) fetches the page directly | Allow in `robots.txt` + sitemap + `llms.txt` | **Medium** |
| **C. Training / corpus layer** | Content enters a training corpus or an authoritative pool (encyclopedia / Q&A / media) | Unify the narrative web-wide + place authoritative sources | **Low** |
| **D. Measurement layer** | Run scheduled queries and audit "mentioned / cited / not at all" | Register provider keys, run the full query set | **High** (technical) |

**Core conclusion.** Layers A and B are the main battlefield and pay off in 3–6 months
at near-zero configuration cost. Layer C is a 6–12 month brand-asset play. Layer D is
the instrument that lets you see the field — it is orthogonal to A/B/C: **without
measurement you cannot evaluate A/B/C at all.**

---

## 2. Allowing AI crawlers

AI retrieval crawlers are the key GEO entry point and must be explicitly allowed in
`robots.txt`. Training crawlers are a separate policy decision, and the two can be
controlled independently. **List each AI user-agent explicitly** rather than relying on
`User-agent: *`, so the policy can be differentiated and reviewed.

### China-market crawlers

| Vendor | User-agent | Type | Recommended action |
|---|---|---|---|
| ByteDance | `Bytespider` | retrieval for search + assistant | allow (critical for citation) |
| Baidu | `Baiduspider` | Baidu index (base for its assistant) | allow |
| Tencent | WeChat / Sogou crawlers | Sogou index | allow |
| 360 | `360Spider` / `HaosouSpider` | 360 index | allow |
| Shenma | `YisouSpider` | Shenma index (mobile) | allow |
| Zhihu | Zhihu crawler | Zhihu content corpus | allow |

### Global crawlers

| Vendor | User-agent | Type | Recommended action |
|---|---|---|---|
| OpenAI | `OAI-SearchBot` | retrieval (ChatGPT search) | allow (GEO core) |
| OpenAI | `ChatGPT-User` | user-triggered fetch | allow |
| OpenAI | `GPTBot` | training crawl | optional (serves training corpora only) |
| Perplexity | `PerplexityBot` / `Perplexity-User` | retrieval / user-triggered | allow |
| Anthropic | `ClaudeBot` / `anthropic-ai` | mixed | allow |
| Google | `Google-Extended` | Gemini training / grounding | optional (training corpora only) |
| Microsoft | `Bingbot` | Bing index (Copilot base) | allow |

> **Trade-off.** `GPTBot` and `Google-Extended` primarily serve *model training*. If
> you do not want content in training corpora you may `Disallow` them — but you must
> keep the retrieval crawlers (`OAI-SearchBot`, `PerplexityBot`, …) allowed. GEO aims
> at being **cited**, and retrieval crawlers are what make that possible.

---

## 3. Assistants to cover (China market)

> **P0** must cover · **P1** important · **P2** supplementary.

| Priority | Assistant | Vendor | Source dependency | What earns citation |
|---|---|---|---|---|
| P0 | Wenxin (Ernie Bot) | Baidu | Baidu index + encyclopedia + owned content platform + Q&A | Baidu indexing + encyclopedia entry + content-platform sync + structured FAQ |
| P0 | Doubao | ByteDance | Toutiao search + Douyin + open web | submit in ByteDance webmaster + allow `Bytespider` + structured data |
| P0 | Yuanbao | Tencent | official accounts + Sogou / Tencent ecosystem + open web | sync official accounts + Sogou indexing + consistent narrative |
| P1 | Kimi | Moonshot | open-web retrieval; long-context and structure friendly | long-form + clean heading hierarchy + tabular data |
| P1 | Qwen | Alibaba | open-web retrieval; prefers high data density | data density (≥1 verifiable claim per 150–200 words) |
| P1 | DeepSeek | DeepSeek | technical / academic friendly | technical articles + code + parameters |
| P1 | Metaso AI search | Metaso | open-web retrieval (academic / professional) | structure + citation labels + being indexed |
| P1 | GLM | Zhipu | academic / paper friendly | academic citations + structure |
| P1 | 360 AI search | 360 | 360 index + open web | 360 indexing + structure |
| P1 | Quark AI | Alibaba | open-web retrieval (mobile-leaning) | indexing + structure |
| P1 | SkyWork AI | Kunlun | open-web retrieval | indexing + structure |
| P1 | Zhihu direct-answer | Zhihu | Zhihu content corpus | sync the organisation account (directly determines visibility) |
| P1 | Agent platforms (Coze-like) | ByteDance family | structured data + tools / docs | `llms.txt` + open API docs + structured FAQ |
| P2 | Spark | iFlytek | Chinese + voice | indexing + voice-scenario content |
| P2 | Hunyuan | Tencent | official-account ecosystem | sync official accounts |
| P2 | MiniMax | MiniMax | multimodal | indexing + image / audio / video assets |
| P2 | Baichuan | Baichuan | general + open source | indexing |
| P2 | StepFun | StepFun | general | indexing |

---

## 4. Assistants to cover (global)

> Same priority legend. Global models generally require **network reachability and a
> compliance review** (see §6), so schedule them after the directly reachable group.

| Priority | Assistant | Vendor | Source dependency | What earns citation |
|---|---|---|---|---|
| P0 | ChatGPT | OpenAI | own retrieval + Bing | GSC indexing + Bing/IndexNow + allow `OAI-SearchBot` |
| P0 | Perplexity | Perplexity | Bing index + own crawler | IndexNow push + allow `PerplexityBot` + GSC |
| P0 | Claude | Anthropic | web retrieval + own crawler | allow `ClaudeBot` + general web visibility |
| P1 | Gemini | Google | Google index | GSC indexing + allow `Google-Extended` |
| P1 | Microsoft Copilot | Microsoft | Bing index | Bing WMT indexing + IndexNow |
| P1 | Grok | xAI | real-time X data | X presence + open web |
| P1 | Mistral | Mistral AI | open web | indexing + structure |
| P1 | You.com | You.com | open-web retrieval | indexing + structure |
| P2 | Llama / Meta | Meta | self-hosted | private deployment + indexing |
| P2 | Meta AI | Meta | Meta ecosystem | Meta content ecosystem |
| P2 | Cohere Command | Cohere | enterprise RAG | indexing + enterprise knowledge |
| P2 | Pi / Inflection | Inflection | open web | indexing |

---

## 5. AI search engines: the core GEO battlefield

AI search engines answer *with citations*, which makes them the highest-value
monitoring targets.

### China market

| Platform | Type | Online | Notes |
|---|---|---|---|
| Metaso AI search | AI search | yes | academic / professional; ships citation labels; reachable — monitor first |
| 360 AI search | AI search | yes | covers the PC installed base |
| Quark AI | AI search (Alibaba) | yes | mobile search entry |
| SkyWork AI | AI search | yes | supplementary |

### Global

| Platform | Type | Online | Notes |
|---|---|---|---|
| Perplexity | AI search | yes | the GEO reference implementation — strongly recommended |
| Bing Copilot | AI search | yes | Bing-backed |
| You.com | AI search | yes | reachable |

> Most AI search engines are closed web services and may not expose an
> OpenAI-compatible API. Monitoring may have to fall back to "simulate the retrieval,
> then feed the result to a general model for evaluation" — assess case by case.

---

## 6. Model-specific behaviour, metrics and constraints

### Reasoning models

- They "think" for thousands of tokens before answering, and **thinking tokens are
  billed as output**; time-to-first-token is high.
- Impact on the monitoring script: ① `maxTokens` caps only the visible answer —
  thinking tokens do not consume the cap but **raise cost**; ② relax timeouts; ③ each
  call is slower, so a full sweep takes longer.
- Mitigation: set `maxTokens` / `timeout` per model for reasoning models; bill with
  the real unit price (reasoning tokens at output price).

### Web-search models

- They retrieve live pages, which **directly determines whether your brand can be
  cited** — the core battlefield for GEO monitoring.
- Their citation rate is naturally higher than a pure text model's; reports must
  distinguish **"brand mentioned"** from **"brand cited with a link"**.

### Multimodal

- Determines whether visual assets (logo, product imagery) are recognised. Include
  image-oriented questions in the query set.

### Same-name entity disambiguation

- Same-name collision is the single largest source of noise, especially for short
  brand names.
- Mitigation: disambiguate at the extraction layer — a strong co-binding term confirms
  "it is us", a bare occurrence counts as "ambiguous". Report on *confirmed ours*,
  not on raw string hits.

### What to measure (GEO visibility dimensions)

For every **question × model** pair, quantify these and weight them into a visibility
score:

- **Mention** (absent / incidental / listed / actively recommended) — the base level.
- **Citation source** (none / a competitor / our own domain) — the direct GEO lever;
  being cited is being anchored.
- **Descriptive accuracy** (hallucinated or wrong vs. complete and correct) — a wrong
  description is worse than no mention; track it in a separate ledger.
- **Position** (outside top 5 / top 5 / top 3 / first) — decides who gets the traffic.
- **Sentiment** (negative / neutral / positive) — negative mentions need root-cause
  work fast.
- **Share of voice** — our mentions ÷ (ours + competitors'). A single comparable
  competitive number; keep it out of the composite score.

### Network reachability

- **Directly reachable group**: several domestic vendors expose OpenAI-compatible
  endpoints reachable without egress work — monitor these first.
- **Egress group**: OpenAI / Anthropic / Gemini / Perplexity need an egress solution
  (SSH dynamic tunnel or overseas host) plus a cross-border compliance review. Use
  official APIs, low-frequency plain text, for your own brand monitoring only; avoid
  opaque relays.

### API vs. web-surface divergence

- The API answer differs from the web answer (which has live search and
  personalisation). **Manually sample ~10% of questions on the web surface** as a
  calibration set, and state the data source (API / web) in the report.
- The same question can yield different answers on the same day → run each question
  multiple times and take the majority, pin a low temperature, rotate question
  phrasings, and flag high-variance questions.

---

## 7. Content engineering that makes AI want to cite you

| Action | How | Effect on AI behaviour |
|---|---|---|
| **Conclusion first** | Open with a standalone answer sentence (40–60 characters in Chinese; one sentence in English) | AI lifts it as the first line of its answer |
| **Definition paragraphs** | "X is …" as its own paragraph | gets cited for "What is X" |
| **FAQ block** | 3–5 pairs, real phrasings, answer-first | matches long-tail question queries |
| **Data density** | ≥1 verifiable claim per 150–200 words | AI prefers citing content with numbers |
| **Tabular comparison** | real HTML tables, not images | structured comparisons are easy to extract |
| **Source labelling** | attribute external data with source + year | materially raises perceived credibility |
| **Schema + `llms.txt`** | FAQPage / Article + root `llms.txt` | lowers AI parsing cost |
| **Consistent narrative** | brand name, positioning, product naming, core figures and legal entity identical everywhere | AI cross-validates before trusting |
| **Authorship and freshness** | publish date + updated date + author | enables recency judgement |

### Narrative consistency — the invisible GEO gate

AI cross-validates across sources; an inconsistent narrative reads as untrustworthy.
Fields to unify and keep unified: brand name, positioning statement, product-line
naming, core figures, founding date / legal entity. Coverage should include the
official site, encyclopedia entries, the Q&A and content platforms, code hosting,
industry media, product directories and AI directories. **Product-line naming matters
most**: only use product names that actually exist and are actually promoted — remove
any description of products that do not exist or are no longer pushed.

---

## 8. Monitoring cautions

1. **There is no "paid AI inclusion".** If a vendor claims to buy AI recommendations,
   verify whether it is actually an ad product or a grey-market scheme. Budget belongs
   in original content, authoritative sources and links.
2. **Domestic AI has no unified submission endpoint.** Entry happens indirectly through
   search-engine indexing plus ecosystem content (encyclopedia, content platforms,
   Q&A). "Submitting to search engines" *is* the actual domestic AI-inclusion action —
   the two are one thing. The exception is IndexNow, which is a direct channel into
   overseas AI retrieval; configure it.
3. **Keep monitoring API keys secret**: vendor keys go into environment variables and a
   gitignored credentials file, never into version control.
4. **Non-standard APIs cost more to adapt.** Schedule them after the
   compatible-endpoint group.
5. **Global models need egress plus a compliance review.** Cross-border payment carries
   risk; do not force monitoring before both are solved.
6. **"Never cited" ≠ "not measured".** First check whether the page is indexed at all,
   whether crawlers are blocked, and whether `llms.txt` / Schema are in place.
