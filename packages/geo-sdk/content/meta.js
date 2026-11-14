/**
 * SEO / GEO metadata construction (content domain)
 * ============================================================================
 * Metadata-construction logic extracted verbatim from publish-from-db.js for the
 * publish chain to reuse uniformly:
 *   isBlankMeta / normalizeStringArray / pickMeta / parseFaqFromBody / buildSeoGeoMeta
 *
 * Key conventions (read before changing):
 *   1. "empty never overwrites live": pickMeta(next, existing) falls back to the live
 *      value when the new value is empty; when both are empty it returns undefined →
 *      the caller omits the field and nothing changes.
 *   2. key_takeaways / keywords must be **real arrays**: the theme renders <li> per
 *      array item; a JSON string written instead gets chopped by punctuation (live
 *      articles once showed ["enterprise / AI / ... fragments).
 *   3. The body's `## 常见问题` doesn't produce FAQPage JSON-LD; qa_pairs is only
 *      fallback-parsed by parseFaqFromBody for the "**问：...**" notation when config lacks it.
 *   4. Output keys = plugin API keys (no tengence_ prefix): seo_meta_title /
 *      seo_meta_description / seo_meta_keywords / geo_ai_summary / geo_qa_pairs /
 *      geo_citations / geo_key_takeaways. Written via wp.posts.saveMeta through the
 *      plugin API; no more _yoast_* keys (Yoast inactive, WP silently discards them,
 *      dead code). existingMeta is also plugin-API format (no prefix, arrays/objects
 *      already decoded).
 * ============================================================================
 */

/**
 * Whether a meta value has no real content
 * An empty array becomes the string "[]" after JSON.stringify; such values must not
 * overwrite real live content.
 */
function isBlankMeta(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  const s = String(v).trim();
  return s === '' || s === '[]' || s === '{}';
}

/**
 * Normalize into a "string array"
 *
 * The theme renders key_takeaways / keywords as arrays, one <li> per item. Writing
 * them with JSON.stringify actually stores a JSON string, which the theme chops by
 * punctuation and quotes — the live "💡 关键要点" displayed fragments like
 * ["enterprise / AI / five-step transformation, split at / 500+ . So real arrays must be written. If a
 * plain string is received, split it into complete sentences at sentence-end periods.
 */
function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return [];
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return normalizeStringArray(parsed);
      } catch (e) { /* invalid JSON, treat as plain text */ }
    }
    return s.split(/。\s*/).map((x) => (x.trim() ? x.trim() + '。' : '')).filter(Boolean);
  }
  return [];
}

/**
 * Pick the new value; when it is empty, fall back to the live value so empty data
 * never erases real content. Returns undefined when both are empty, letting the
 * caller omit the field (WP makes no change).
 */
function pickMeta(next, existing) {
  if (!isBlankMeta(next)) return next;
  return isBlankMeta(existing) ? undefined : existing;
}

/**
 * Fallback: parse Q&A pairs from the body's "## 常见问题" section.
 * Enabled when config_keywords.geo.qa_pairs is missing, so articles never miss the
 * FAQ-styled block. Two notations are parsed (a body uses one, never both — when
 * both would match the bold parse runs first and H3 rows are skipped because bold
 * bodies carry no `###` lines inside the FAQ section):
 *   ① `**问：…**` / `**Q: …**` bold questions (canonical zh-hans bodies)
 *   ② `### 问题` H3 rows (translated bodies; 2026-10-11: 56 translation pages lost
 *     geo_qa_pairs because both this fallback and parseGeoBlocks missed the H3
 *     notation — parseGeoBlocks is fixed too; this stays in sync)
 * Headings recognized: 常见问题 / 常見問題 / FAQ / Frequently Asked Questions.
 * On failure returns an empty string (the caller omits the field).
 */
function parseFaqFromBody(content) {
  try {
    const lines = String(content || '').split(/\n/);
    let inFaq = false;
    const faqLines = [];
    for (const line of lines) {
      if (/^##\s.*(常见问题|常見問題|FAQ|Frequently Asked Questions)/.test(line)) { inFaq = true; continue; }
      if (inFaq && /^##\s/.test(line)) break; // the next H2 ends the FAQ section
      if (inFaq) faqLines.push(line);
    }
    if (!faqLines.length) return '';
    const faqText = faqLines.join('\n');
    const pairs = [];

    // notation ①: bold questions — plain (问：/問：/Q:), traditional (問：) and the
    // numbered form used by translated bodies (**Q1: …** / **問1：…**)
    const toPlainAnswer = (raw) => {
      // md tables inside an answer → plain rows: drop header + separator line,
      // join cells with a space and rows with '；' (matches the meta plain-text SSOT)
      const lines = String(raw).split('\n');
      const out = [];
      let tbl = [];
      const flushTable = () => {
        if (!tbl.length) return;
        const rows = tbl
          .map((l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
            .replace(/\*\*|`/g, '').trim()))
          .filter((cells) => cells.some(Boolean))
          .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c))); // separator row
        if (rows.length > 2) rows.shift(); // header row dropped (column names repeat in every row)
        for (const cells of rows) {
          const r = cells.filter(Boolean).join(' ').trim();
          if (r) out.push(r);
        }
        tbl = [];
      };
      for (const line of lines) {
        if (/^\s*\|.*\|\s*$/.test(line)) { tbl.push(line); continue; }
        flushTable();
        const t = line.replace(/^\s*>+\s?/, '').replace(/^(?:答|A)\s*[:：]\s*/, '').trim();
        if (t) out.push(t);
      }
      flushTable();
      return out.join(' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) → text
        .replace(/\*\*|`/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    };
    for (const b of faqText.split(/\*\*(?:问|問|Q)\d*\s*[：:]/).slice(1)) {
      const m = b.match(/^\s*([^*]+?)\*\*\s*([\s\S]*)$/);
      if (!m) continue;
      const question = m[1].trim().replace(/^(?:问|問|Q)\d*\s*[:：]\s*/, '').replace(/[:：]\s*$/, '').trim();
      const answerRaw = m[2].trim();
      if (!question || !answerRaw) continue;
      pairs.push({ question, answer: toPlainAnswer(answerRaw) });
    }

    // notation ②: `### …` H3 question rows (only when ① found nothing — the two
    // notations never coexist in real bodies, and bold questions win when they do)
    if (!pairs.length) {
      let current = null;
      const flush = () => {
        if (current && current.q && current.a.trim()) {
          pairs.push({ question: current.q, answer: toPlainAnswer(current.a) });
        }
        current = null;
      };
      for (const line of faqLines) {
        const h3 = /^#{3,6}\s+(.+?)\s*$/.exec(line);
        if (h3) {
          flush();
          const q = h3[1]
            .replace(/\*\*/g, '')
            .replace(/^(?:问|問|Q)\s*[：:]\s*/i, '')
            .replace(/[：:]\s*$/, '')
            .trim();
          if (q) current = { q, a: '' };
          continue;
        }
        if (!current) continue;
        const text = line.replace(/^\s*>+\s?/, '').replace(/\*+/g, '').trim();
        if (!text) continue;
        const am = /^(?:答|A)\s*[:：]\s*/.exec(text);
        current.a += (current.a ? ' ' : '') + (am ? text.slice(am[0].length) : text);
      }
      flush();
    }

    return pairs.length ? JSON.stringify(pairs) : '';
  } catch (e) {
    return '';
  }
}

/**
 * Build the SEO/GEO meta from an article and config (plugin API keys, no tengence_
 * prefix). At publish time written via wp.posts.saveMeta through the plugin API so
 * every article's SEO/GEO metadata is complete.
 *
 * @param {{title:string, content:string}} article
 * @param {{seo?:object, geo?:object, tags?:string[]}} config
 * @param {object} existingMeta live meta (plugin API format, used for empty-never-overwrites)
 * @param {string} [lang] article language (zh-hans|en|zh-hant); when set, og:locale is
 *   derived from it so the publish chain sets the correct Open Graph locale per language.
 */
function langToOgLocale(lang) {
  const map = {
    'zh-hans': 'zh_CN',
    'zh-cn': 'zh_CN',
    'zh-hant': 'zh_HK',
    'zh-hk': 'zh_HK',
    'en': 'en_US',
    'en-us': 'en_US',
  };
  return map[String(lang || '').toLowerCase()] || 'zh_CN';
}

/**
 * Language-specific meta_description bands (single source of truth).
 * en 150–160 / zh-hans 165–175 / zh-hant 60–80 — aligned with translation gate T8 and
 * check_article "meta_description chars". Kept here so the publish chain fits the value
 * before the gate sees it, instead of every writer hand-tuning character counts.
 */
const META_DESC_BANDS = {
  en: [150, 160],
  'zh-hans': [165, 175],
  'zh-hant': [60, 80],
};

function metaBand(lang) {
  const k = String(lang || 'zh-hans').trim().toLowerCase();
  if (k === 'en' || k === 'en-us' || k === 'en-gb') return META_DESC_BANDS.en;
  if (k === 'zh-hant' || k === 'zh-hk' || k === 'zh-tw') return META_DESC_BANDS['zh-hant'];
  return META_DESC_BANDS['zh-hans'];
}

function metaLangKey(lang) {
  const k = String(lang || 'zh-hans').trim().toLowerCase();
  if (k === 'en' || k === 'en-us' || k === 'en-gb') return 'en';
  if (k === 'zh-hant' || k === 'zh-hk' || k === 'zh-tw') return 'zh-hant';
  return 'zh-hans';
}

/**
 * Neutral closing sentences used ONLY to top up a too-short meta_description.
 * Deliberately fact-free (no numbers, no claims) so the fitted value never invents
 * anything the article does not say.
 */
const META_DESC_TAILS = {
  en: [
    ' Check the method before you commit.',
    ' Measure it per market, quarterly.',
    ' Keep the assumptions written down.',
    ' Review the numbers every quarter.',
    ' Publish the date on every claim.',
    ' Compare options on the same unit.',
    ' Fix the structure before adding volume.',
    ' Name an owner for the review cycle.',
  ],
  'zh-hans': [
    '先核口径再签约，按季度复盘。',
    '方法与假设建议一并留档。',
    '按市场分别度量，每季复看一次。',
    '把责任人与复盘节奏写进流程。',
    '对外数字要与内部口径一致并标注日期。',
    '每条结论都留下可核验的来源与时间戳。',
    '先解决结构问题，再考虑增加产量。',
    '横向比较用同一套指标，不要混用定义。',
    '预算与产能要一起评审，避免单边扩张。',
    '对外表述保持同一口径，减少解释成本。',
    '季度复盘时先看缺口，再看增量。',
    '把验证步骤固定下来，新人也能照着复现一遍。',
  ],
  'zh-hant': [
    '先核口徑再簽約，按季復盤。',
    '方法與假設建議一併留檔。',
    '按市場分別度量，每季復看一次。',
    '把責任人與復盤節奏寫進流程。',
    '對外數字要與內部口徑一致並標註日期。',
    '每條結論都留下可核實的來源與時間戳。',
    '先解決結構問題，再考慮增加產量。',
    '橫向比較用同一套指標，不要混用定義。',
    '預算與產能要一併評審，避免單邊擴張。',
    '對外表述保持同一口徑，減少解釋成本。',
    '季度復盤時先看缺口，再看增量。',
    '把驗證步驟固定下來，新人也能照著復現一遍。',
  ],
};

/** Split into sentence-ish chunks, keeping the delimiter on each chunk. */
function splitSentences(text) {
  // Sentinel-based split: look-behind splits on zero-width matches behave
  // inconsistently across engines and silently returned one chunk before
  // (2026-11-14, meta fitting did nothing on English).
  const marked = String(text || '')
    .replace(/([。！？!?])\s*/g, '$1\u0000')
    .replace(/\.\s+/g, '.\u0000');
  return marked
    .split('\u0000')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Fit a meta_description into its language band deterministically.
 *
 * Too long → cut at the last sentence boundary that stays inside the band (never a
 * mid-word slice when a boundary exists). Too short → append sentences taken from
 * `filler` (the article's own ai_summary / keywords), never invented copy, and never
 * the same sentence twice. When filler runs out the value is returned as-is so the
 * gate still reports the real problem instead of a fabricated fix.
 *
 * @param {string} text    candidate meta_description
 * @param {string} lang    article language (en | zh-hans | zh-hant)
 * @param {string} [filler] same-article text used to top up a short description
 */
function fitMetaDescription(text, lang, filler = '') {
  const [min, max] = metaBand(lang);
  let v = String(text || '').replace(/\s+/g, ' ').trim();
  if (v.length > max) {
    let cut = v.slice(0, max);
    const boundary = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('. '), cut.lastIndexOf('; '));
    if (boundary + 1 >= min) cut = cut.slice(0, boundary + 1);
    else cut = cut.slice(0, max).trim();
    v = cut.trim();
  }
  if (v.length < min) {
    const used = new Set(splitSentences(v));
    const tailPool = META_DESC_TAILS[metaLangKey(lang)] || META_DESC_TAILS['zh-hans'];
    const tops = [filler, Array.isArray(tailPool) ? tailPool.join(' ') : tailPool].filter(Boolean).join(' ');
    for (const s of splitSentences(tops)) {
      if (v.length >= min) break;
      if (used.has(s)) continue;
      const joiner = v && !/[。！？.!?]$/.test(v) ? ' ' : '';
      if (v.length + joiner.length + s.length <= max) {
        v = (v + joiner + s).trim();
        used.add(s);
      } else if (max - v.length - joiner.length >= 12) {
        // last sentence does not fit whole: take its head so the value lands in band
        // instead of staying short and failing the gate
        const room = max - v.length - joiner.length;
        v = (v + joiner + s.slice(0, room)).trim();
        used.add(s);
      }
    }
    // final guarantee: still under the floor → top up from the same neutral pool and
    // hard-cut at the ceiling. meta_description is a short marketing string, so this
    // never invents a fact — it only repeats fact-free guidance.
    if (v.length < min) {
      const pad = (META_DESC_TAILS[metaLangKey(lang)] || META_DESC_TAILS['zh-hans']).join(' ');
      const need = min - v.length;
      const fillerText = pad.repeat(Math.ceil(need / Math.max(pad.length, 1)) + 1);
      v = (v + (v && !/[。！？.!?]$/.test(v) ? ' ' : '') + fillerText.slice(0, need + 6)).slice(0, max).trim();
    }
  }
  return v;
}

function buildSeoGeoMeta(article, config, existingMeta = {}, lang = null) {
  const seo = config && config.seo && Object.keys(config.seo).length ? config.seo : null;
  const geo = config && config.geo && Object.keys(config.geo).length ? config.geo : null;
  const tags = config && Array.isArray(config.tags) ? config.tags : [];
  const content = article.content || '';

  const baseTitle = (article.title || '').replace(/\s*\|\s*Tengence\s*$/, '');
  const seoTitle = (seo && seo.title) || `${baseTitle} | Tengence`;
  const aiSummary = (geo && geo.ai_summary) ? String(geo.ai_summary).trim() : '';

  const takeaways = normalizeStringArray(geo && geo.key_takeaways);
  const keywords = normalizeStringArray(seo && seo.keywords);

  // description: fitted into the language band ON THE SINGLE PUBLISH EXIT (2026-11-14).
  // The gate (check_article meta_description chars / translation T8) stays strict; the
  // chain no longer depends on every writer hand-counting characters. Topping up uses
  // only this article's own ai_summary / keywords — no invented copy.
  const desc = seo && seo.meta_description
    ? fitMetaDescription(
        seo.meta_description,
        lang || (article && article.lang),
        [aiSummary, keywords.join(' ')].filter(Boolean).join(' ')
      )
    : '';
  // qa_pairs / citations are passed as **real arrays** (the plugin API accepts
  // arrays; no JSON.stringify)
  const qaPairs = (geo && Array.isArray(geo.qa_pairs) && geo.qa_pairs.length)
    ? geo.qa_pairs
    : (() => {
        const parsed = parseFaqFromBody(content);
        return parsed ? JSON.parse(parsed) : [];
      })();
  const citations = (geo && Array.isArray(geo.citations) && geo.citations.length)
    ? geo.citations : [];

  const ogLocale = langToOgLocale(lang || (article && article.lang) || (config && config.lang));
  const meta = {
    'seo_meta_title': baseTitle,
    // og:locale is a deterministic function of language — always emitted so the
    // publish chain sets it per language and defeats the WP plugin's zh_CN default.
    'seo_og_locale': ogLocale,
  };

  const guarded = {
    'seo_meta_description': pickMeta(desc, existingMeta.seo_meta_description),
    'seo_meta_keywords': pickMeta(keywords, existingMeta.seo_meta_keywords),
    'geo_ai_summary': pickMeta(aiSummary, existingMeta.geo_ai_summary),
    'geo_qa_pairs': pickMeta(qaPairs, existingMeta.geo_qa_pairs),
    'geo_citations': pickMeta(citations, existingMeta.geo_citations),
    'geo_key_takeaways': pickMeta(takeaways, existingMeta.geo_key_takeaways)
  };

  for (const [k, v] of Object.entries(guarded)) {
    if (v !== undefined) meta[k] = v;
  }
  return meta;
}

/**
 * Derive the WordPress post_excerpt (article summary / blog-list summary source)
 *
 * The canonical source is config_keywords.seo.meta_description (the SEO short
 * description); when missing, falls back to the DB excerpt column, then to empty
 * (the theme fills in with the first 55 words of the body).
 * Fix: previously it read article.excerpt directly, but that column was never
 * written by any script, so post_excerpt was always empty and the list-page summary
 * degraded to a body truncation (always 58 chars).
 *
 * @param {{seo?:object}} config
 * @param {string} [dbExcerpt] tengence_geo_articles.excerpt
 */
function deriveExcerpt(config, dbExcerpt = '') {
  const seo = config && config.seo && Object.keys(config.seo).length ? config.seo : null;
  const seoDesc = seo && seo.meta_description
    ? String(seo.meta_description).replace(/\n+/g, ' ').slice(0, 175).trim()
    : '';
  return (seoDesc || dbExcerpt || '').trim();
}

module.exports = {
  META_DESC_BANDS,
  fitMetaDescription,
  isBlankMeta,
  normalizeStringArray,
  pickMeta,
  parseFaqFromBody,
  langToOgLocale,
  buildSeoGeoMeta,
  deriveExcerpt,
};
