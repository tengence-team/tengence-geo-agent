/**
 * diagnose/geo-extra.js — GEO (Generative Engine Optimization) evidence
 * ============================================================================
 * Pure-computation GEO signals on top of an already-fetched page profile
 * (rootParsed / llms / pages). No network requests here: everything is derived
 * from what the classic + deep packs already collected, so adding these checks
 * costs the target site zero extra requests.
 *
 * Signals follow mainstream GEO best practice:
 *   - citeability density (Princeton: >=3 concrete data points per 500 words)
 *   - publication/modified date signals (E-E-A-T / freshness)
 *   - author byline (E-E-A-T)
 *   - authoritative-source citations (external links to gov/academic/standards)
 *   - entity consistency (Organization schema vs visible page identity)
 *   - llms.txt structural compliance (H1 + blockquote + H2 sections + described links)
 *   - key content as static HTML (AI crawlers must read it without JS execution)
 *   - AI-generated content disclosure (GB 45438 / AI-content labeling)
 *   - question/answer blocks (quoteable answer blocks for LLM citation)
 */

const AUTHORITATIVE_RE = /(^|\.)(gov|edu|ac\.|wikipedia\.org|who\.int|un\.org|oecd\.org|worldbank\.org|imf\.org|ieee\.org|acm\.org|springer\.com|elsevier\.com|nature\.com|science\.org|stanford\.edu|mit\.edu|cambridge\.org|oxford\.)/i;

/** Count concrete data points (numbers/percentages/amounts/dates) in body text. */
function dataPointDensity(bodyText) {
  const text = String(bodyText || '');
  if (!text.trim()) return { points: 0, per500: 0, wordCount: 0 };
  // CJK chars + latin words ≈ word count used elsewhere in the engine
  const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const latin = (text.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[a-zA-Z0-9]+(?:['-][a-zA-Z0-9]+)*/g) || []).length;
  const wordCount = cjk + latin;
  // concrete numbers: standalone digits (>=1 digit), percentages, currency, big year-range dates
  const points =
    (text.match(/\b\d{2,}\b(?:\.\d+)?%?/g) || []).length +       // 10, 99, 12.5%, 2025
    (text.match(/(?:¥|￥|$|€|£)\s?\d[\d,.]*/g) || []).length +   // amounts
    (text.match(/\d{4}[-/年]\d{1,2}(?:[-/月]\d{1,2})?/g) || []).length; // dates
  const per500 = wordCount ? Math.round((points / wordCount) * 500) : 0;
  return { points, per500, wordCount };
}

/** Publication & modification date signals from JSON-LD + meta. */
function dateSignals(parsed) {
  const meta = (parsed && parsed.meta) || {};
  const out = { published: null, modified: null, gapDays: null, source: 'none' };
  const jl = (parsed && parsed.jsonld && parsed.jsonld.samples) || [];
  for (const doc of jl) {
    const d = doc && doc['@graph'] ? (Array.isArray(doc['@graph']) ? doc['@graph'] : []) : [doc];
    for (const node of d) {
      if (!node) continue;
      const t = String(node['@type'] || '').toLowerCase();
      if (t.includes('article') || t.includes('blogposting') || t.includes('webpage') || t.includes('newsarticle')) {
        out.published = out.published || node.datePublished || null;
        out.modified = out.modified || node.dateModified || null;
        if (out.published) out.source = 'jsonld';
      }
    }
  }
  out.published = out.published || meta['article:published_time'] || null;
  out.modified = out.modified || meta['article:modified_time'] || meta['article:published_time'] || null;
  if (out.published && out.source === 'none') out.source = 'meta';
  if (out.published && out.modified) {
    const a = Date.parse(out.published);
    const b = Date.parse(out.modified);
    if (a && b) out.gapDays = Math.max(0, Math.round((b - a) / 86400000));
  }
  return out;
}

/** Author byline: JSON-LD author, meta author, or visible byline. */
function authorByline(parsed) {
  const meta = (parsed && parsed.meta) || {};
  const jl = (parsed && parsed.jsonld && parsed.jsonld.samples) || [];
  let ldAuthor = null;
  for (const doc of jl) {
    const d = doc && doc['@graph'] ? (Array.isArray(doc['@graph']) ? doc['@graph'] : []) : [doc];
    for (const node of d) {
      const author = node && (node.author || node.creator);
      if (author && typeof author === 'object' && author.name) ldAuthor = author.name;
      else if (author && typeof author === 'string') ldAuthor = author;
      if (ldAuthor) break;
    }
    if (ldAuthor) break;
  }
  return { author: ldAuthor || meta.author || (parsed && parsed.byline) || null, source: ldAuthor ? 'jsonld' : meta.author ? 'meta' : parsed && parsed.byline ? 'page' : 'none' };
}

/** Authoritative-source citations via outbound link hosts. */
function authoritativeCitations(externalHosts) {
  const hosts = (externalHosts || []).filter(Boolean);
  const auth = hosts.filter((h) => AUTHORITATIVE_RE.test(h));
  return { total: hosts.length, authoritative: auth.length, hosts: hosts.slice(0, 15), authoritativeHosts: auth.slice(0, 5) };
}

/** Organization entity consistency: schema name/logo vs visible title/logo. */
function entityConsistency(parsed) {
  const jl = (parsed && parsed.jsonld && parsed.jsonld.samples) || [];
  let org = null;
  for (const doc of jl) {
    const d = doc && doc['@graph'] ? (Array.isArray(doc['@graph']) ? doc['@graph'] : []) : [doc];
    for (const node of d) {
      if (node && String(node['@type'] || '').toLowerCase() === 'organization') { org = node; break; }
    }
    if (org) break;
  }
  if (!org) return { declared: false, name: null, logo: null, title: null, logoOnPage: false, nameConsistent: null };
  const title = (parsed && parsed.title) || '';
  const name = org.name || org.legalName || null;
  const logo = org.logo && (typeof org.logo === 'object' ? org.logo.url || null : org.logo) || null;
  const logoOnPage = !!(logo && parsed && parsed.images && parsed.images.srcs && parsed.images.srcs.some((s) => logo && String(s).toLowerCase().includes(String(logo).split('/').pop().toLowerCase())));
  const nameConsistent = name && title ? title.toLowerCase().includes(String(name).toLowerCase().slice(0, 20)) : null;
  return { declared: true, name, logo, title, logoOnPage, nameConsistent };
}

/** llms.txt structural compliance per the llms.txt spec.
 *  `extraContents` maps absolute llms.txt URLs to their (truncated) bodies,
 *  so per-locale variants (/zh-hans/llms.txt etc.) are checked too.
 */
function llmsStructure(content, extraContents) {
  const text = String(content || '');
  const lines = text.split('\n');
  const h1 = lines.find((l) => /^#\s+\S/.test(l.trim())) || null;
  const blockquote = lines.find((l) => /^>\s*\S/.test(l.trim())) || null;
  const h2s = lines.filter((l) => /^##\s+\S/.test(l.trim()));
  const linkLines = lines.filter((l) => /^\s*-\s*\[[^\]]+\]\(https?:\/\/[^)]+\)\s*:?\s*\S+/i.test(l.trim()) || /^\s*-\s*\[[^\]]+\]\(https?:\/\/[^)]+\)/i.test(l.trim()));
  const links = linkLines.length;
  const described = linkLines.filter((l) => /:\s*\S+/.test(l.split(')')[1] || '') || /\S+\s*—\s*\S+/.test(l)).length;
  const specCompliant = !!(h1 && blockquote && h2s.length >= 1 && links >= 3 && (described / Math.max(1, links)) >= 0.5);
  // Per-locale llms.txt variants: any 200 text bodies besides the root file.
  const variantBodies = Object.entries(extraContents || {})
    .filter(([u]) => !/\/llms\.txt$/.test(new URL(u).pathname) || new URL(u).pathname !== '/llms.txt')
    .map(([, b]) => b);
  const langVersions = variantBodies.filter((b) => {
    const t = String(b || '');
    return /^#\s+\S/m.test(t) && /^##\s+\S/m.test(t) && /-\s*\[[^\]]+\]\(https?:\/\//.test(t);
  }).length;
  // Multilingual root index: root file links to per-locale files (llms.txt best practice).
  const langIndex = !!['zh-hans/llms.txt', 'zh-hant/llms.txt', 'en/llms.txt'].some((p) => text.includes(p));
  return { specCompliant, h1: h1 ? h1.trim() : null, blockquote: blockquote ? blockquote.trim().slice(0, 120) : null, sections: h2s.length, links, described, textLen: text.length, langVersions, langIndex };
}

/** Key content served as static HTML (AI crawler readability without JS). */
function staticHtmlContent(parsed) {
  const textLength = (parsed && parsed.textLength) || 0;
  const h1s = (parsed && parsed.headings && parsed.headings.h1 && parsed.headings.h1.count) || 0;
  return { textLength, h1s, staticOk: textLength >= 800 && h1s >= 1 };
}

/** AI-generated content disclosure (AIGC labeling, GB 45438 spirit). */
function aigcDisclosure(parsed) {
  const text = ((parsed && parsed.bodyText) || '') + ' ' + JSON.stringify((parsed && parsed.meta) || {});
  const re = /(ai[- ]?generated|generated by ai|由\s*ai\s*(智能)?\s*生成|ai\s*(生成|撰写|创作)|人工智能生成|生成式\s*ai|aigc)/i;
  const m = re.exec(text);
  return { declared: !!m, match: m ? m[0].slice(0, 40) : null };
}

/** Question/answer answer-block presence (LLM-quoteable structure). */
function qaBlocks(parsed) {
  const q = (parsed && parsed.qaSignals) || {};
  const total = (q.questionHeadings || 0) + (q.details || 0) + (q.faqText ? 1 : 0);
  return { count: total, questionHeadings: q.questionHeadings || 0, details: q.details || 0, faqText: !!q.faqText, samples: (q.samples || []).slice(0, 4) };
}

module.exports = {
  dataPointDensity,
  dateSignals,
  authorByline,
  authoritativeCitations,
  entityConsistency,
  llmsStructure,
  staticHtmlContent,
  aigcDisclosure,
  qaBlocks,
  AUTHORITATIVE_RE,
};
