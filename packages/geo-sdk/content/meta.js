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
 * FAQ-styled block. Only the "**问：...**" notation is parsed; on failure returns an
 * empty string (the caller omits the field).
 */
function parseFaqFromBody(content) {
  try {
    const lines = String(content || '').split(/\n/);
    let inFaq = false;
    const faqLines = [];
    for (const line of lines) {
      if (/^##\s.*(常见问题|FAQ|Frequently Asked Questions)/.test(line)) { inFaq = true; continue; }
      if (inFaq && /^##\s/.test(line)) break; // the next H2 ends the FAQ section
      if (inFaq) faqLines.push(line);
    }
    if (!faqLines.length) return '';
    const faqText = faqLines.join('\n');
    const blocks = faqText.split(/\*\*问：|\*\*Q:/).slice(1);
    const pairs = [];
    for (const b of blocks) {
      const m = b.match(/^\s*([^*]+?)\*\*\s*([\s\S]*)$/);
      if (!m) continue;
      const question = m[1].trim().replace(/^问：/, '').replace(/[:：]\s*$/, '').trim();
      const answerRaw = m[2].trim();
      if (!question || !answerRaw) continue;
      const answer = '<p>' + answerRaw.replace(/\n+/g, ' ').trim() + '</p>';
      pairs.push({ question, answer });
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
 */
function buildSeoGeoMeta(article, config, existingMeta = {}) {
  const seo = config && config.seo && Object.keys(config.seo).length ? config.seo : null;
  const geo = config && config.geo && Object.keys(config.geo).length ? config.geo : null;
  const tags = config && Array.isArray(config.tags) ? config.tags : [];
  const content = article.content || '';

  // description & summary: when config lacks them, no longer generate a body-truncated
  // fallback; keep the live value instead
  const desc = seo && seo.meta_description
    ? seo.meta_description.replace(/\n+/g, ' ').slice(0, 160)
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

  const meta = {
    'seo_meta_title': baseTitle
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
    ? String(seo.meta_description).replace(/\n+/g, ' ').slice(0, 160).trim()
    : '';
  return (seoDesc || dbExcerpt || '').trim();
}

module.exports = {
  isBlankMeta,
  normalizeStringArray,
  pickMeta,
  parseFaqFromBody,
  buildSeoGeoMeta,
  deriveExcerpt,
};
