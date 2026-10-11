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

function buildSeoGeoMeta(article, config, existingMeta = {}, lang = null) {
  const seo = config && config.seo && Object.keys(config.seo).length ? config.seo : null;
  const geo = config && config.geo && Object.keys(config.geo).length ? config.geo : null;
  const tags = config && Array.isArray(config.tags) ? config.tags : [];
  const content = article.content || '';

  // description & summary: when config lacks them, no longer generate a body-truncated
  // fallback; keep the live value instead
  const desc = seo && seo.meta_description
    ? seo.meta_description.replace(/\n+/g, ' ').slice(0, 175)
    : '';
  const baseTitle = (article.title || '').replace(/\s*\|\s*Tengence\s*$/, '');
  const seoTitle = (seo && seo.title) || `${baseTitle} | Tengence`;
  const aiSummary = (geo && geo.ai_summary) ? String(geo.ai_summary).trim() : '';

  const takeaways = normalizeStringArray(geo && geo.key_takeaways);
  const keywords = normalizeStringArray(seo && seo.keywords);
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
  isBlankMeta,
  normalizeStringArray,
  pickMeta,
  parseFaqFromBody,
  langToOgLocale,
  buildSeoGeoMeta,
  deriveExcerpt,
};
