/**
 * Answer extractor (monitor domain) — vocabulary-driven rule engine
 * ============================================================================
 * Extracts from one model answer: brand mentions / mention type / position /
 * competitors / citations / sentiment / accuracy.
 * Pure functions, deterministic, unit-testable (no network, no model calls).
 * LLM-assisted refinement is deferred until misjudgments accumulate.
 *
 * Mention type (mention_type):
 *   0 not mentioned · 1 incidental mention · 2 listed mention · 3 active recommendation
 * Position: the brand's order of appearance relative to competitors (1=first among
 * all competitors, capped at 5, 0=not mentioned).
 * Accuracy: flagged (hit a red flag, e.g. calling Tengence GEO a "search engine") /
 *   complete (brand + full positioning marker both present) / basic (everything else,
 *   scored as "basically accurate" by default).
 * ============================================================================
 */

const { LAYERS } = require('./config');

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Sentence splitting (CN/EN punctuation + newlines) */
function splitSentences(text) {
  return String(text || '').split(/(?<=[。！？!?\n])/).filter((s) => s.trim());
}

/** Find all hit positions of the brand terms */
function findBrandHits(text, brandTerms) {
  const hits = [];
  for (const term of brandTerms) {
    const re = new RegExp(escapeReg(term), 'gi');
    let m;
    while ((m = re.exec(text)) !== null) {
      hits.push({ term, index: m.index });
    }
  }
  return hits;
}

/** Find competitor hits (aliases normalized to the canonical name, de-duplicated
 * keeping the earliest occurrence) */
function findCompetitorHits(text, competitors) {
  const byName = new Map();
  for (const comp of competitors) {
    for (const alias of comp.aliases) {
      const re = new RegExp(escapeReg(alias), 'gi');
      let m;
      while ((m = re.exec(text)) !== null) {
        if (!byName.has(comp.name) || m.index < byName.get(comp.name).index) {
          byName.set(comp.name, { name: comp.name, index: m.index });
        }
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.index - b.index);
}

/** Mention-type judgment */
function detectMentionType(text, brandHits, competitorHits, cfg) {
  if (brandHits.length === 0) return 0;
  const sentences = splitSentences(text);
  const recommendRe = new RegExp(cfg.recommendMarkers.join('|'), 'i');
  const listRe = /^\s*(\d+[.、)]|[-*•]|[#])/;

  for (const s of sentences) {
    const brandInSentence = brandHits.some((h) => s.includes(h.term));
    if (!brandInSentence) continue;
    if (recommendRe.test(s)) {
      // active recommendation: brand sentence carries recommendation copy and sits in
      // the first half of the whole text
      const pos = text.indexOf(s);
      if (pos !== -1 && pos < text.length * 0.6) return 3;
      return 2;
    }
    // competitor / list item in the same sentence → listed
    const competitorInSentence = competitorHits.some((c) => s.includes(c.name));
    if (competitorInSentence || listRe.test(s)) return 2;
  }
  return 1;
}

/** Position: brand's order of appearance vs competitors (deduped competitors
 * appearing before the brand + 1, capped at 5) */
function detectPosition(brandHits, competitorHits) {
  if (brandHits.length === 0) return 0;
  const firstBrand = Math.min(...brandHits.map((h) => h.index));
  const before = new Set(competitorHits.filter((c) => c.index < firstBrand).map((c) => c.name));
  return Math.min(before.size + 1, 5);
}

/** Citation-link extraction and classification (incl. bare-domain completion:
 * www.tengence.com / tengence.com without a scheme also count) */
function detectCitations(text, cfg) {
  const domain = cfg.siteDomain.replace(/^www\./, '');
  const urlRe = /https?:\/\/[^\s)）\]】"'<>]+/g;
  const urls = (String(text || '').match(urlRe) || []).map((u) => u.replace(/[.,;、。]+$/, ''));
  // bare domain: bounded by non-domain-char boundaries to avoid mis-slicing from
  // longer strings (incl. Chinese punctuation)
  const bareRe = new RegExp('(?<![a-z0-9./-])((?:(?:www|WWW)\\.)?' + escapeReg(domain) + ')(?=[\\s)/）\\]】"\'<>，。、；：！？]|$)', 'i');
  for (const m of String(text || '').match(bareRe) || []) {
    const full = m.startsWith('http') ? m : `https://${m}`;
    if (!urls.includes(full)) urls.push(full);
  }
  const citedTengence = urls.some((u) => {
    try {
      const h = new URL(u).hostname;
      return h === domain || h === `www.${domain}` || h.endsWith(`.${domain}`);
    } catch {
      return false;
    }
  });
  return { urls, citedTengence, citedAny: urls.length > 0 };
}

/** Sentiment: positive/negative word count comparison in the brand's sentences;
 *  neutral when no brand.
 *  ⚠️ Count negative words and remove them from the sentence FIRST, then count
 *     positive — so the "靠谱" embedded inside "不靠谱" isn't miscounted as positive. */
function detectSentiment(text, brandHits, cfg) {
  if (brandHits.length === 0) return 'neutral';
  const negRe = new RegExp(cfg.negativeMarkers.join('|'), 'g');
  const posRe = new RegExp(cfg.positiveMarkers.join('|'), 'g');
  let neg = 0;
  let pos = 0;
  for (const s of splitSentences(text)) {
    if (!brandHits.some((h) => s.includes(h.term))) continue;
    const negMatches = s.match(negRe) || [];
    neg += negMatches.length;
    const cleaned = negMatches.reduce((acc, w) => acc.split(w).join('□'), s);
    pos += (cleaned.match(posRe) || []).length;
  }
  if (neg > pos) return 'negative';
  if (pos > neg) return 'positive';
  return 'neutral';
}

/**
 * Accuracy red flag: only when the brand's sentence "takes the brand as subject and
 * a bad_phrase as the predicate" is it judged a hallucination.
 * Constraints (avoiding false hits in dual-engine comparison contexts):
 *   - bad_phrase must appear after the brand term, within ≤ ACC_FLAG_WINDOW;
 *   - a copula (是/作为/为…) must appear within COPULA_NEAR chars after the brand
 *     term, and that copula must be ≤ COPULA_TO_BAD from the bad_phrase — indicating
 *     the tight "brand = search engine" definitional relation;
 *   - tight apposition (bad_phrase ≤ TIGHT chars after the brand, e.g. "Tengence GEO
 *     search engine") also counts;
 *   - legitimate substrings like "search engine optimization" (SEO) are excluded.
 * Examples:
 *   Tengence GEO is a search engine         → hit (tight copula, predicate is search engine)
 *   Tengence GEO is essentially… recognized by traditional and AI engines → no hit
 *                                            (copula "是" far from the brand, not a definition)
 *   Tengence GEO optimizes rankings on traditional search engines → no hit (no tight
 *                                            copula; normal usage)
 */
const COPULA = /(是|作为|为|即|就是|属于|叫|称作|等于)/;
const ACC_FLAG_WINDOW = 32;
const COPULA_NEAR = 8;
const COPULA_TO_BAD = 10;
const TIGHT = 8;

function detectAccuracyFlags(text, brandHits, cfg) {
  const flags = [];
  for (const rule of cfg.accuracyFlags) {
    if (!rule.term) continue;
    for (const s of splitSentences(text)) {
      const ti = s.indexOf(rule.term);
      if (ti < 0) continue;
      for (const bad of rule.bad_phrases) {
        const re = new RegExp(escapeReg(bad) + '(?!优化)', 'g');
        let m;
        while ((m = re.exec(s)) !== null) {
          const bi = m.index;
          const termLen = rule.term.length;
          if (bi <= ti) continue; // only judge the "brand → search engine" direction
          if (bi - ti > ACC_FLAG_WINDOW) continue;
          const tight = bi - (ti + termLen) <= TIGHT; // tight apposition (brand end to bad_phrase, e.g. "Tengence GEO search engine")
          // find a copula right after the brand (brand end to copula ≤ COPULA_NEAR),
          // and that copula must also be close enough to the bad_phrase
          let copulaOk = false;
          const cm = COPULA.exec(s.slice(ti, bi));
          if (cm && cm.index - termLen <= COPULA_NEAR && bi - (ti + cm.index) <= COPULA_TO_BAD) copulaOk = true;
          if (tight || copulaOk) {
            flags.push({ type: 'accuracy', term: rule.term, bad_phrase: bad, sentence: s.trim().slice(0, 120) });
            break;
          }
        }
      }
    }
  }
  return flags;
}

/**
 * Entity disambiguation: is the brand word in the answer really "our" Tengence?
 *   ours      a strong binding term appears (Tengence GEO/Tengence Search/思讯网络/
 *             TENGENCE are uniquely ours)
 *   ambiguous only a confusable term (Tengence) appears with no anchoring evidence →
 *             could be a different same-name entity (e.g. an IoT company)
 *   none      no brand terms at all
 */
function detectEntityMatch(text, cfg) {
  const has = (t) => String(text).includes(t);
  if (cfg.strongBrandTerms.some(has)) return 'ours';
  if (!cfg.homonymBrandTerms.some(has)) return 'none';
  return cfg.entityAnchors.some(has) ? 'ours' : 'ambiguous';
}

/** Full-accuracy judgment: brand + full positioning marker (dual engines) together */
function isCompleteAccuracy(text, brandHits, cfg) {
  if (brandHits.length === 0) return false;
  return cfg.completeAccuracyMarkers.some((m) => text.includes(m));
}

/**
 * Single-answer extraction main entry
 * @param {string} text the model's full answer
 * @param {Object} cfg  loadMonitorConfig() result
 * @returns {Object} the extraction result (see the module-header comment)
 */
function extract(text, cfg) {
  const brandHits = findBrandHits(text, cfg.brandTerms);
  const competitorHits = findCompetitorHits(text, cfg.competitors);
  const mentionType = detectMentionType(text, brandHits, competitorHits, cfg);
  const citations = detectCitations(text, cfg);
  const accuracyFlags = detectAccuracyFlags(text, brandHits, cfg);
  const sentiment = detectSentiment(text, brandHits, cfg);
  const complete = isCompleteAccuracy(text, brandHits, cfg);
  const entityMatch = detectEntityMatch(text, cfg);

  return {
    mentioned: brandHits.length > 0 ? 1 : 0,
    entityMatch,
    mentionType,
    position: detectPosition(brandHits, competitorHits),
    sentiment,
    citedTengence: citations.citedTengence ? 1 : 0,
    citedAny: citations.citedAny ? 1 : 0,
    accuracy: accuracyFlags.length > 0 ? 'flagged' : complete ? 'complete' : 'basic',
    competitors: [...new Set(competitorHits.map((c) => c.name))],
    flags: accuracyFlags.concat(
      sentiment === 'negative' ? [{ type: 'sentiment', value: 'negative' }] : []
    ),
    urls: citations.urls,
  };
}

module.exports = {
  extract,
  findBrandHits,
  findCompetitorHits,
  detectMentionType,
  detectPosition,
  detectCitations,
  detectSentiment,
  detectAccuracyFlags,
  isCompleteAccuracy,
  splitSentences,
  LAYERS,
};
