# Article Translation Standards

> The hands-on spec for **every** multi-language translation task: target-language
> profiles, the four hard rules (facts / structure / expression / title), the
> GEO-domain glossary (zh-hans ↔ en ↔ zh-hant), the simplified→traditional conversion
> table, the mechanical gate summary (T1–T11), and the per-language block headings.
> Execution lives in the harness (`geo-article-translation` skill); the mechanical
> gate lives in code (`geo-sdk/translate/gate.js`) and is authoritative for T1–T11.
> This file is the single source of truth for **rules and glossaries** — code never
> copies rule text; the harness never copies rule text either (it reads this file at
> runtime via `standards_read`).

## 1. Purpose & scope

- Translate **already gate-passing Chinese articles** (`lang=zh-hans`) into English
  (`en`) and traditional Chinese (`zh-hant`, Hong Kong style), as **separate rows**
  in `tengence_geo_articles` sharing the same `slug` and a common
  `translation_group`.
- The zh-hans article is the **single source of truth**: translations never alter its
  facts, conclusions, numbers, links, or images.
- Out of scope: term/category/tag translation (plugin v1.1), channel rewrites for
  WeChat/CSDN/Juejin (stay zh-hans), audio/video localization.

## 2. Language codes

| Context | Codes |
|---|---|
| geo DB / CLI / MCP (`lang`) | `zh-hans` / `en` / `zh-hant`（articles 表列默认 `en`；站点默认 `zh-hans`） |
| WP plugin taxonomy | `zh-hans`, `en`, `zh-hant`（与内部码直接一致，无映射层） |
| Article URL prefix (plugin) | `/` (zh-hans), `/en/blog/article/{slug}/`, `/zh-hant/blog/article/{slug}/` |
| Google GSC API parameter | `zh-cn`（外部 API 格式，不在统一范围；保持原样） |

All internal codes are **lowercase** — `zh-hans`, `en`, `zh-hant` are the only
canonical values. Never introduce uppercase variants (`zh-Hans`, `en-US`, `zh-Hant`)
or the legacy region codes (`zh-cn` / `en-us` / `zh-hk`) inside geo code, config,
or data. 2026-10-07 migration: internal storage uses `zh-hans` / `zh-hant` / `en`
directly; the former `LANG_MAP` mapping layer was removed and `normalizeLang` is an
identity pass-through. The plugin taxonomy matches internal codes directly.

> **内部语言标识规范（2026-10-07 起生效，SSOT）**：内部体系（DB、CLI/MCP `lang`、
> 站点配置、inbox 目录名、文章内链 URL 前缀）一律直存 `zh-hans` / `zh-hant` / `en`，
> 不设映射层。内链一律保留目标语言的 URL 前缀（同语言互链，禁止裸链、禁止跨语言跳转）。
> 外部接口例外：Google GSC 等第三方 API 参数按其自身格式（如 `zh-cn`）使用，不在统一范围。

## 3. The four hard rules

### 3.1 Facts — never change
- Numbers: years, percentages, versions, amounts, counts, dates stay **exactly as in
  the source** (only thousands-separator / decimal-format differences allowed).
  - **Magnitude wording is normalized, not literal.** A Chinese source magnitude
    (`万` / `亿`) and its English wording (`thousand` / `million` / `billion`) are
    treated as equal by the gate, so you may write either `8 亿` → `800 million` *or*
    `800,000,000`, and `2300 万` → `23 million` *or* `23,000,000`. Do **not** distort
    the target into an unnatural form just to satisfy the gate (e.g. never write
    `9/2022` to satisfy a month check).
  - **Dates with a month:** a Chinese `2022 年 9 月` and an English
    `September 2022` are equivalent — the gate folds the month name to its ordinal
    when a 4-digit year is adjacent, so write the month name naturally.
- Every outbound citation URL and every image URL stays **identical**.
  `featured_image` is copied from the source article unchanged (the three languages
  share one featured image).
- **Internal article links** (`tengence.com/blog/article/<slug>/`): the **slug stays
  identical**, but the **language segment is rewritten to the target language
  prefix** — zh-hans→`/zh-hans/`, en→`/en/`, zh-hant→`/zh-hant/`. A translation's
  internal links must carry the *target* language prefix (same-language internal
  linking — never keep the source language's prefix, never a bare link, never hop
  between languages). T2 compares links with the language segment normalized, so
  prefix rewrites are expected, not drift; T10 enforces the target prefix.
- No new cases, claims, or conclusions; no deleted ones. No "improving" the source.

### 3.2 Structure — preserve the GEO skeleton
- Keep the H1, the full H2 hierarchy, tables, ordered/unordered lists, bold text,
  blockquotes, and the GEO blocks — Summary / Key Takeaways / FAQ / Data Sources /
  Related Reading / Get Started (when present in the source).
- Block headings use the **target-language canonical forms** (§9). Numbered H2
  sections: English uses Arabic numerals (`## 1. …`), Chinese (both variants) uses
  Chinese numerals (`## 一、…`); numbering runs continuously.
- Every H2 opens with a **self-contained answer-first sentence** (25–40 words in
  English; 40–60 characters in Chinese).
- No Markdown residue in the final body; no bare URLs.

### 3.3 Expression — idiomatic, not literal
- English: en, neutral tone, native-speaker prose. Reorganize sentences to sound
  natural; do not translate word-for-word. Use the GEO-domain vocabulary of §6.
- Traditional Chinese: Hong Kong style on a common-traditional base (see §5). Never
  produce OpenCC-style glyph-only conversion (简→繁 glyph swap without term
  localization is a hard failure).
- The result must read as **written in the target language**, not translated.

### 3.4 Titles — localize, keep the keyword
- The H1 and H2 headings may be **re-created** for the target language's search
  habits, provided: the core keyword(s) of the source title survive, and the
  conclusion stays identical.
- `meta_title` / `meta_description` are re-created per target-language length
  standards (English meta_description 150–160 chars; zh-hant ≈ 60–80 chars).
- No mixed-language titles (brand names excepted).

## 4. English target profile (en)

- Spelling: American English (optimize, organization, center, behavior).
- Tone: neutral, professional B2B/SaaS style; no hype, no filler, no exclamation
  marks, no emoji.
- GEO-domain idiom: use the standard English terms of §6 ("Generative Engine
  Optimization", "AI visibility", "answer-first", "entity signals", "citation
  density") exactly as listed; never gloss them into invented phrases.
- Sentence style: shorter sentences, concrete subjects, active voice preferred;
  "you/your" allowed for reader guidance; keep numbers and units in US format
  (e.g. `1,200`).
- Avoid translationese: no "As a…, we…" openers copied from Chinese syntax; no
  "the so-called"; no overuse of passive voice.

## 5. Traditional Chinese target profile (Hong Kong style)

- Character set: traditional glyphs, **Hong Kong variants** where they differ
  (e.g. 軟件, 網絡, 電郵, 上載, 伺服器, 檔案; see §7).
- Term usage: common-traditional base (terms shared by HK/TW readers) plus Hong
  Kong preferences. Never mix simplified glyphs or simplified-only terms into the
  body.
- Tone: professional, concise; 的/地/得 normal usage; prefer 透過/通過 carefully
  (透過 is the common HK form), 以及/並 connectors.
- Punctuation: full-width Chinese punctuation（，。；：？！「」——）, but numbers and
  Latin terms keep half-width.
- Keywords keep their English form where the industry does (GEO, AI, SEO, API,
  WordPress, SaaS) — no forced Chinese gloss for established acronyms.

## 6. GEO-domain glossary (zh-hans ↔ en ↔ zh-hant)

| zh-hans (source) | en | zh-hant (Hong Kong style) |
|---|---|---|
| GEO / 生成式引擎优化 | Generative Engine Optimization (GEO) | GEO / 生成式引擎優化 |
| AI 可见性 | AI visibility | AI 可見性 |
| 双引擎（GEO+SEO） | dual-engine (GEO+SEO) strategy | 雙引擎（GEO+SEO） |
| 实体认领 | entity claiming / entity signals | 實體認領 |
| 回答优先 | answer-first | 答案優先 |
| 引用密度 | citation density | 引用密度 |
| 关键要点 | Key Takeaways | 關鍵要點 |
| 常见问题 | FAQ | 常見問題 |
| 数据来源 | Data Sources | 資料來源 |
| 相关阅读 | Related Reading | 相關閱讀 |
| 立即行动 | Get Started | 立即行動 |
| 搜索引擎 | search engine | 搜尋引擎 |
| 收录 / 索引 | indexing | 收錄 / 索引 |
| 关键词 / 长尾关键词 | keyword / long-tail keyword | 關鍵字 / 長尾關鍵字 |
| 搜索意图 | search intent | 搜尋意圖 |
| 元数据 | metadata | 中繼資料 |
| 结构化数据 | structured data | 結構化資料 |
| 大语言模型 | large language model (LLM) | 大型語言模型 |
| 生成式 AI | generative AI | 生成式 AI |
| 自然语言处理 | natural language processing | 自然語言處理 |
| 语义 | semantics | 語義 |
| 实体 | entity | 實體 |
| 权威性 / 相关性 | authority / relevance | 權威性 / 相關性 |
| 反向链接 | backlink | 反向連結 |
| 外链 / 内链 | outbound link / internal link | 外部連結 / 內部連結 |
| 锚文本 | anchor text | 連結文字 |
| 网站地图 | sitemap | 網站地圖 |
| 爬虫 / 蜘蛛 | crawler / bot | 爬蟲 / 機械人 |
| 点击率 | click-through rate (CTR) | 點擊率 |
| 跳出率 | bounce rate | 跳出率 |
| 品牌提及 | brand mention | 品牌提及 |
| 引用来源 | citation source | 引用來源 |
| 快照 | snapshot / cache | 快照 |
| 排名 | ranking | 排名 |
| 权重 | authority weight / domain strength | 權重 |
| 内容策略 | content strategy | 內容策略 |
| 选题 | topic planning | 選題 |
| 研究简报 | research brief | 研究簡報 |
| 发布日历 | content calendar / publishing plan | 發布日曆 |
| 草稿 / 发布 | draft / publish | 草稿 / 發布 |
| 站点配置 | site configuration | 站點配置 |
| 媒体库 | media library | 媒體庫 |
| 特色图片 | featured image | 特色圖片 |
| 正文 | article body | 正文 |
| 结构化输出 | structured output | 結構化輸出 |
| 提示词 | prompt | 提示詞 |
| 模型 | model | 模型 |
| 幻觉 | hallucination | 幻覺 / 錯覺 |
| 训练数据 | training data | 訓練數據 |
| 知识库 | knowledge base | 知識庫 |
| 语义搜索 | semantic search | 語義搜尋 |
| 自然语言查询 | natural-language query | 自然語言查詢 |
| 引用快照 | cited snapshot | 引用快照 |

## 7. Simplified → Traditional high-frequency conversion table

> Applied to zh-hant output. Never glyph-swap without checking this table; glyph-only
> conversion of the words below is a T6/T5 failure.

| zh-hans | zh-hant (use) | avoid (TW-only or simplified) |
|---|---|---|
| 软件 | 軟件 | 軟體 |
| 信息 | 資訊 | — |
| 网络 | 網絡 | 網路 |
| 视频 | 影片 | 視頻（口語可，正式用影片） |
| 优化 | 優化 | 最佳化 |
| 用户 | 用戶 | 使用者 |
| 数据 | 數據 | 資料（同義但與"資料來源"混用需一致） |
| 文件 | 檔案 | — |
| 邮箱 | 電郵 | 電子郵箱 |
| 上传 / 下载 | 上載 / 下載 | 上傳 |
| 服务器 | 伺服器 | — |
| 支持 | 支援 | — |
| 默认 | 預設 | — |
| 兼容 | 相容 | — |
| 算法 | 演算法 | — |
| 登录 / 注册 | 登入 / 註冊 | — |
| 账号 | 帳戶 | 帳號（台灣） |
| 菜单 | 選單 | 菜單（簡體） |
| 文件夹 | 資料夾 | — |
| 链接 | 連結 | 鏈接（簡體） |
| 插件 | 外掛程式 | — |
| 浏览器 | 瀏覽器 | — |
| 应用 | 應用程式 | 應用 |
| 界面 | 介面 | 界面（簡體） |
| 开源 | 開放原始碼 | 開源 |
| 云计算 | 雲端運算 | 雲計算 |
| 数据库 | 資料庫 | — |
| 更新 | 更新 | — |
| 显示 | 顯示 | — |
| 设置 | 設定 | 設置（簡體/台灣） |
| 视频会议 | 視像會議 | 視頻會議（簡體） |
| 演示 | 示範 | — |
| 教程 | 教學 | 教程 |
| 社区 | 社群 | 社區 |
| 套餐 | 套餐 | — |
| 充电 | 充電 | — |
| 干货 | 乾貨 | — |

## 8. Mechanical gate summary (T1–T11)

> Authoritative implementation: `geo-sdk/translate/gate.js`. The harness runs
> `check_translation` before ingest; errors must be zero to proceed.
> T10/T11 are new since 2026-10-06 (internal-link language prefix / CTA layout).

| ID | Check | Rule (summary) |
|---|---|---|
| T1 | Structure | H1 ×1; Summary / Key Takeaways / FAQ / Data Sources / Related Reading / Get Started present per source; headings use §9 forms; H2 numbering continuous |
| T2 | Link fidelity | Outbound citation URL set identical to source; internal-link URL set identical **after normalizing the language segment** (zh-hans/zh-hant/en prefixes are stripped, so a language-prefix rewrite in the target is expected, not drift) |
| T3 | Image fidelity | Image URL set identical (incl. `featured_image`); alt may be translated but non-empty |
| T4 | Number fidelity | Numeric set (years/percent/versions/amounts) matches source modulo thousand-separator/decimal format |
| T5 | No residue | en: no CJK outside whitelist (brand/proper nouns), no Chinese punctuation; zh-hant: no simplified terms (§7) and no simplified glyphs; both: no Markdown residue |
| T6 | Term compliance | Target-language glossary hits: en has no direct-translation of glossary terms; zh-hant has no zh-hans-only terms |
| T7 | Length floor | Each H2 maps 1:1 to source structure; no truncated section; en H2 ≥ ~50% of source length |
| T8 | Title spec | H1 keeps core keyword; no mixed-language title; meta_description length per target profile |
| T9 | Mermaid label syntax | bare `( )` inside a mermaid node / edge / subgraph label is a lexing error; quote the whole label (`A["text (x)"]`) |
| T10 | Internal-link language prefix | every on-site article link in the target carries the **target** language prefix (/zh-hans/ zh-hans, /en/ en, /zh-hant/ zh-hant); bare links or another language's prefix fail |
| T11 | CTA layout | the Get Started / 立即行动 block lists each link on its own line; links joined by `|` on one line fail |

## 9. Block headings per target language

> The zh-hans forms are the legacy canonical (unchanged). Additions for en / zh-hant
> are new recognition points for the parser (`content/md.js`, `check/index.js`,
> `publish/index.js`) — add, never replace (block-conventions §3 rule).

| Role | zh-hans (legacy) | en | zh-hant (new) |
|---|---|---|---|
| Opening summary | `> **摘要**：…` | `> **Summary:** …` | `> **摘要**：…` |
| Key takeaways | `## 关键要点` | `## Key Takeaways` | `## 關鍵要點` |
| FAQ | `## 常见问题` | `## FAQ` | `## 常見問題` |
| Data sources | `## 数据来源` | `## Data Sources` | `## 資料來源` |
| Related reading | `## 相关阅读` | `## Related Reading` | `## 相關閱讀` |
| Call to action | `## 立即行动` | `## Get Started` | `## 立即行動` |
| Brand blurb | `## 关于<品牌>` | `## About <Brand>` | `## 關於<品牌>` |

FAQ pairs in zh-hant: `> **問：{問題}？**` / `> 答：{答案}`.

## 10. Deliverable format

- One file per language: `<site>/data/inbox/<lang>/<slug>.md` (ingested via
  `article_ingest --lang <lang>`).
- YAML front matter: the four `seo` fields (`seo.meta_title`,
  `seo.meta_description`, `seo.slug`, `seo.og_image` — og_image may point at the
  shared featured image) plus `featured_image` (copied from source, unchanged).
- GEO blocks live **in the body** (reverse-parsed at publish), never in front matter.
- A translation may ship with its own research brief only when it adds
  target-language citations; otherwise it inherits the source brief path and passes
  the gate on the source's research file (gate reads `<lang>` inbox path).
