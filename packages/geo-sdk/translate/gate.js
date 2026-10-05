'use strict';
/**
 * Mechanical translation gate — T1–T8 (geo-sdk/translate/gate)
 * ============================================================================
 * Pure code: no LLM, no network. The harness runs `check_translation` before
 * ingest; `errors` must be empty to proceed. Rules are codified in
 * standards/translation-standards.md §8 — this file is the authoritative
 * implementation and the document is the readable summary (SSOT lives here).
 *
 * Merge order for forbidden terms: global standards/translation-glossary.yaml
 * (base) ← site config/translation-glossary.yaml (wins).
 * ============================================================================
 */
const md = require('../content/md');
const { loadForbidden } = require('./glossary');

/** Target-language block heading patterns (§9 of translation-standards.md). */
const HEADINGS = {
  // zh-cn articles may use Chinese OR English block headings (block-conventions §3).
  // All patterns are multiline: headings can appear anywhere in the body.
  'zh-cn': {
    summary: /^>\s*\*\*(摘要|Summary)\*\*[：:]/im,
    takeaways: /^##\s*(关键要点|核心要点|要点速览|Key Takeaways|Key Points)/im,
    faq: /^##\s*(常见问题|FAQ)/im,
    data_sources: /^##\s*(数据来源|引用来源|Data Sources|Sources|References)/im,
    related: /^##\s*(相关阅读|Related Reading)/im,
    get_started: /^##\s*(立即行动|Get Started)/im,
    about: /^##\s*(关于|About\s)/im,
  },
  'en-us': {
    summary: /^>\s*\*\*Summary:?\*\*/im,
    takeaways: /^##\s*(Key Takeaways|Key Points)/im,
    faq: /^##\s*FAQ/im,
    data_sources: /^##\s*(Data Sources|Sources|References)/im,
    related: /^##\s*Related Reading/im,
    get_started: /^##\s*Get Started/im,
    about: /^##\s*About\s/im,
  },
  'zh-hk': {
    summary: /^>\s*\*\*摘要\*\*[：:]/im,
    takeaways: /^##\s*(關鍵要點|核心要點)/im,
    faq: /^##\s*(常見問題|FAQ)/im,
    data_sources: /^##\s*(資料來源|引用來源)/im,
    related: /^##\s*相關閱讀/im,
    get_started: /^##\s*立即行動/im,
    about: /^##\s*關於/im,
  },
};

/** meta_description length bounds per target language (§3.4). */
const META_DESC_LEN = { 'en-us': [150, 160], 'zh-hk': [60, 80] };
/** Per-section length floor relative to the source section (§3.3, §8 T7). */
const SECTION_RATIO = { 'en-us': 0.5, 'zh-hk': 0.6 };

// ---- character / structure detectors ------------------------------------

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const CN_PUNCT_RE = /[，。：；！？「」『』（）【】《》]/;
const H1_RE = /^#\s+(.+)$/gm;
const H2_RE = /^##\s+(.+)$/gm;
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+["“][^"”]*["”])?\)/g;
const NUM_RE = /\d[\d,.]*\d|\d+/g;
const MARKDOWN_RESIDUE_RE = /\*\*[ \t]*\*\*|\(\s*\)|\[\s*\]/;

/** Numbered-H2 line: `## 1. …` (en, dot+space) or `## 一、…` (zh, 顿号直接跟标题). */
const NUM_H2_RE = /^##\s+([0-9]+)[.、．]\s+/;
const CN_NUM_H2_RE = /^##\s+([一二三四五六七八九十]+)[、．]/;
/** Roman-numeral H2 (`## I.`, `## IV.`): the English rendering of 一、二、… . Without
 *  this the en-us target counted 0 numbered sections and T7 reported a false
 *  section-count mismatch against the Chinese source. */
const ROMAN_H2_RE = /^##\s+([IVXLCDM]+)[.、．]\s+/i;
const CN_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const ROMAN_VALUES = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

/** Parse a Roman numeral (I … MMMDCCCLXXXVIII). Returns null when invalid. */
function parseRoman(s) {
  if (!s) return null;
  const up = s.toUpperCase();
  let total = 0;
  for (let i = 0; i < up.length; i++) {
    const v = ROMAN_VALUES[up[i]];
    if (v === undefined) return null;
    // subtractive pair (IV / IX / XL …): smaller before larger means subtract
    const next = ROMAN_VALUES[up[i + 1]];
    total += (next !== undefined && next > v) ? -v : v;
  }
  return total;
}

/**
 * Parse a Chinese numeral up to 99 (一 … 九十九). Articles number far beyond 十, and
 * the old fixed 一–十 lookup returned null for 十一/十二/二十, which made the
 * numbering check report a false break. Returns null for anything unparseable.
 */
function parseCnNumber(s) {
  if (!s) return null;
  // pure digit form without 十 (一二三四五六七八九)
  if (s.length === 1) return CN_DIGITS[s] !== undefined ? CN_DIGITS[s] : (s === '十' ? 10 : null);
  const tenIdx = s.indexOf('十');
  if (tenIdx === -1) {
    // e.g. 二十 handled below; a multi-char run with no 十 is not a valid numeral here
    let n = 0;
    for (const ch of s) {
      if (CN_DIGITS[ch] === undefined) return null;
      n = n * 10 + CN_DIGITS[ch];
    }
    return n;
  }
  const head = s.slice(0, tenIdx);
  const tail = s.slice(tenIdx + 1);
  const tens = head === '' ? 1 : CN_DIGITS[head];
  const ones = tail === '' ? 0 : CN_DIGITS[tail];
  if (tens === undefined || ones === undefined) return null;
  return tens * 10 + ones;
}

// ---- glossary loading (shared with the MCP `translation_glossary_get` tool;
// merge order: global standards/translation-glossary.yaml ← site config wins) ----
// loadForbidden imported from ./glossary

// ---- extractors -----------------------------------------------------------

function stripFm(content) {
  return md.stripFrontMatter(content || '');
}

/** Remove fenced code blocks (```...```) so that `#` comments, `()` call signatures,
 *  example URLs, and numeric literals inside code are NOT mistaken for Markdown
 *  structure / residue. Fixes T1 (H1) and T5 (`()`) false positives. */
function stripFencedCode(mdText) {
  return (mdText || '').replace(/```[\s\S]*?```/g, '');
}

function extractHrefs(mdText) {
  const out = new Set();
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(mdText)) !== null) out.add(m[1]);
  return out;
}

/** Chinese/English magnitude suffixes applied when a number token is followed by one. */
const MAGNITUDE = {
  万: 1e4, 萬: 1e4, 亿: 1e8, 億: 1e8,
  K: 1e3, k: 1e3, M: 1e6, m: 1e6, B: 1e9, b: 1e9,
};

/**
 * Extract numeric tokens, skipping heading lines (H2 numbering must not count).
 * Chinese magnitude words (万/億/亿) and English suffixes (K/M/B) are normalized to
 * their scaled value so that "85万" == "850,000" == "850K" (only thousand-separator /
 * decimal / magnitude-wording differences are allowed per standards §3.1). A range
 * like "3-5万" scales both endpoints ("3" → 30000, "5万" → 50000). When a magnitude
 * is present the bare number is not added separately (otherwise the source's "85万"
 * would demand a literal "85" in the target).
 */
function extractNumbers(mdText) {
  const lines = mdText.split('\n');
  const nums = new Set();
  for (const line of lines) {
    if (/^\s*#/.test(line)) continue;
    let m;
    NUM_RE.lastIndex = 0;
    while ((m = NUM_RE.exec(line)) !== null) {
      const raw = m[0].replace(/,/g, '');
      // peek at the character right after the match for a magnitude suffix
      const rest = line.slice(m.index + m[0].length);
      // Chinese magnitude words (万/億/亿) need no word boundary; English suffixes
      // (K/M/B) do, so "12 months" is not read as 12M. A bare number directly
      // followed by "-<digits><magnitude>" (range left endpoint, "3-5万") is skipped
      // here and added in scaled form by the right endpoint's range handling below.
      const magMatch = /^\s*(万|萬|亿|億)/.exec(rest) || /^\s*([KkMmBb])\b/.exec(rest);
      if (magMatch) {
        const mult = MAGNITUDE[magMatch[1]];
        const scaled = String(Math.round(parseFloat(raw) * mult));
        nums.add(scaled);
        // range left endpoint: "3-5万" — the token before the suffix also scales
        const before = line.slice(0, m.index).trimEnd();
        const rangeMatch = /[-\u2013\u2014]\s*$/.exec(before);
        if (rangeMatch) {
          const leftMatch = /(\d[\d,.]*\d|\d+)\s*$/.exec(before.slice(0, before.length - rangeMatch[0].length));
          if (leftMatch) nums.add(String(Math.round(parseFloat(leftMatch[0].replace(/,/g, '')) * mult)));
        }
      } else if (!/^\s*[-–—]\s*\d[\d,.]*\d\s*(万|萬|亿|億|[KkMmBb])\b/.test(rest)) {
        nums.add(raw);
      }
    }
  }
  return nums;
}

function extractImages(mdText, frontMatter) {
  const urls = new Set();
  for (const img of md.extractAnyImageUrls(mdText)) urls.add(img.originalUrl);
  // featured_image from front matter (shared across languages)
  const fm = md.parseFrontMatter(frontMatter || '');
  const data = fm && fm.data;
  const fi = data && data.featured_image;
  if (fi && typeof fi === 'string' && fi.trim()) urls.add(fi.trim());
  return urls;
}

function extractFrontMatterMap(content) {
  const fm = md.parseFrontMatter(content || '');
  if (!fm || typeof fm.data !== 'object' || fm.data === null) return {};
  return fm.data;
}

/** True when a `##` heading carries a section number in any supported notation:
 *  arabic (`## 1.`), Chinese (`## 一、`) or Roman (`## I.`). */
function isNumberedHeading(heading) {
  return /^##\s+(?:[0-9]+[.、．]|[一二三四五六七八九十]+[、．]|[IVXLCDM]+[.、．]\s)/i.test(heading);
}

/** Split md into numbered-H2 sections. Any `##` heading ends the current section;
 *  only numbered sections (T1-conformant `## 1.` / `## 一、` / `## I.`) are
 *  collected, so GEO block headings (Key Takeaways, FAQ, …) never inflate a
 *  section's length. */
function splitNumberedSections(mdText) {
  const lines = mdText.split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (current && isNumberedHeading(current.heading)) sections.push(current);
      current = { heading: line, body: '' };
    } else if (current) {
      current.body += line + '\n';
    }
  }
  if (current && isNumberedHeading(current.heading)) sections.push(current);
  return sections;
}

function hasBlock(mdText, lang, role) {
  const patterns = HEADINGS[lang] || HEADINGS['en-us'];
  const re = patterns[role];
  if (!re) return true; // role not defined for this lang: treat as present
  return re.test(mdText);
}

function checkNumbering(mdText, targetLang) {
  const lines = mdText.split('\n');
  const nums = [];
  for (const line of lines) {
    let m = line.match(NUM_H2_RE);
    if (m) { nums.push(parseInt(m[1], 10)); continue; }
    m = line.match(CN_NUM_H2_RE);
    if (m) {
      const v = parseCnNumber(m[1]);
      if (v !== null) nums.push(v);
      continue;
    }
    m = line.match(ROMAN_H2_RE);
    if (m) {
      const v = parseRoman(m[1]);
      if (v !== null) nums.push(v);
    }
  }
  if (nums.length === 0) return { ok: true, nums: [] };
  let expected = 1;
  for (const n of nums) {
    if (n !== expected) return { ok: false, expected, found: n, nums };
    expected += 1;
  }
  return { ok: true, nums };
}

// ---- the gate --------------------------------------------------------------

/**
 * Run the T1–T8 mechanical gate on a translation.
 * @param {object} opts
 * @param {string} opts.sourceMd   source (zh-cn) markdown (may include front matter)
 * @param {string} opts.targetMd   translated markdown (may include front matter)
 * @param {string} opts.targetLang 'en-us' | 'zh-hk'
 * @param {string} [opts.sourceLang='zh-cn']
 * @param {string} [opts.siteKey]  site key (for site-level glossary)
 * @returns {{ok:boolean, errors:Array<{id:string,message:string}>, checks:object}}
 */
function checkTranslation({ sourceMd, targetMd, targetLang, sourceLang = 'zh-cn', siteKey, targetSeo } = {}) {
  const errors = [];
  const checks = {};
  if (!targetMd || typeof targetMd !== 'string') {
    return { ok: false, errors: [{ id: 'T1', message: 'targetMd is empty' }], checks: {} };
  }
  const targetLangNorm = targetLang || 'en-us';
  const sourceBody = stripFm(sourceMd || '');
  const targetBody = stripFm(targetMd || '');
  // Structural / link / image / number / residue analysis runs on the code-stripped
  // body: `#` comments, `()` calls, example URLs and numeric literals inside fenced
  // code are content, not Markdown structure (fixes T1 H1 and T5 `()` false positives).
  const sourceClean = stripFencedCode(sourceBody);
  const targetClean = stripFencedCode(targetBody);
  const targetFm = extractFrontMatterMap(targetMd || '');
  const forbidden = loadForbidden(siteKey);

  // ---- T1 structure -------------------------------------------------------
  const t1 = [];
  const h1s = targetClean.match(H1_RE) || [];
  if (h1s.length !== 1) t1.push(`H1 must appear exactly once (found ${h1s.length})`);
  for (const role of ['summary', 'takeaways', 'faq', 'data_sources', 'related', 'get_started', 'about']) {
    const srcHas = hasBlock(sourceClean, sourceLang, role);
    const tgtHas = hasBlock(targetClean, targetLangNorm, role);
    if (srcHas && !tgtHas) t1.push(`block "${role}" missing in the target (source has it)`);
  }
  const numbering = checkNumbering(targetBody, targetLangNorm);
  if (!numbering.ok) t1.push(`numbered H2 sequence broken: expected ${numbering.expected}, found ${numbering.found} (${numbering.nums.join(', ')})`);
  checks.T1 = { ok: t1.length === 0, issues: t1 };
  if (t1.length) errors.push(...t1.map((message) => ({ id: 'T1', message })));

  // ---- T2 link fidelity ----------------------------------------------------
  const srcLinks = extractHrefs(sourceClean);
  const tgtLinks = extractHrefs(targetClean);
  const t2 = [];
  for (const u of srcLinks) if (!tgtLinks.has(u)) t2.push(`source link missing in target: ${u}`);
  for (const u of tgtLinks) if (!srcLinks.has(u)) t2.push(`target link not in source: ${u}`);
  checks.T2 = { ok: t2.length === 0, sourceCount: srcLinks.size, targetCount: tgtLinks.size, issues: t2 };
  if (t2.length) errors.push(...t2.map((message) => ({ id: 'T2', message })));

  // ---- T3 image fidelity ---------------------------------------------------
  const srcImages = extractImages(sourceClean, sourceMd || '');
  const tgtImages = extractImages(targetClean, targetMd || '');
  const t3 = [];
  for (const u of srcImages) if (!tgtImages.has(u)) t3.push(`source image missing in target: ${u}`);
  for (const u of tgtImages) if (!srcImages.has(u)) t3.push(`target image not in source: ${u}`);
  checks.T3 = { ok: t3.length === 0, sourceCount: srcImages.size, targetCount: tgtImages.size, issues: t3 };
  if (t3.length) errors.push(...t3.map((message) => ({ id: 'T3', message })));

  // ---- T4 number fidelity --------------------------------------------------
  const srcNums = extractNumbers(sourceClean);
  const tgtNums = extractNumbers(targetClean);
  const t4 = [];
  for (const n of srcNums) if (!tgtNums.has(n)) t4.push(`source number missing in target: ${n}`);
  for (const n of tgtNums) if (!srcNums.has(n)) t4.push(`target number not in source: ${n}`);
  checks.T4 = { ok: t4.length === 0, sourceCount: srcNums.size, targetCount: tgtNums.size, issues: t4 };
  if (t4.length) errors.push(...t4.map((message) => ({ id: 'T4', message })));

  // ---- T5 residue ----------------------------------------------------------
  /**
 * zh-hk forbidden-term search with CJK word boundaries. The forbidden list holds
 * simplified-only words (e.g. 算法), but a legitimate HK word may contain the
 * simplified form as a substring (演算法 ⊃ 算法); match only as a standalone word
 * (neither side a CJK character) so 演算法 is allowed while a bare 算法 is not.
 */
function findForbiddenZh(body, w) {
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return body.search(new RegExp(`(?<![\\u4e00-\\u9fff])${esc}(?![\\u4e00-\\u9fff])`));
}

const t5 = [];
  if (targetLangNorm === 'en-us') {
    const cjk = targetClean.match(CJK_RE);
    if (cjk) t5.push(`CJK characters present in en-us body (near: …${targetClean.slice(Math.max(0, cjk.index - 20), cjk.index + 20)}…)`);
    const cp = targetClean.match(CN_PUNCT_RE);
    if (cp) t5.push(`Chinese punctuation present in en-us body (near: …${targetClean.slice(Math.max(0, cp.index - 20), cp.index + 20)}…)`);
  } else if (targetLangNorm === 'zh-hk') {
    const fb = forbidden['zh-hk'] || [];
    for (const w of fb) {
      const idx = findForbiddenZh(targetClean, w);
      if (idx >= 0) t5.push(`simplified term "${w}" present in zh-hk body (near: …${targetClean.slice(Math.max(0, idx - 15), idx + 15)}…)`);
    }
  }
  const residue = targetClean.match(MARKDOWN_RESIDUE_RE);
  if (residue) t5.push(`Markdown residue: ${JSON.stringify(residue[0].trim())}`);
  checks.T5 = { ok: t5.length === 0, issues: t5 };
  if (t5.length) errors.push(...t5.map((message) => ({ id: 'T5', message })));

  // ---- T6 term compliance --------------------------------------------------
  const t6 = [];
  const fbTarget = (forbidden[targetLangNorm] || []).filter((w) => {
    // en-us list is case-insensitive
    return targetLangNorm === 'en-us' ? true : true;
  });
  const bodyLower = targetClean.toLowerCase();
  for (const w of fbTarget) {
    const haystack = targetLangNorm === 'en-us' ? bodyLower : targetClean;
    const needle = targetLangNorm === 'en-us' ? w.toLowerCase() : w;
    const idx = targetLangNorm === 'zh-hk' ? findForbiddenZh(targetClean, w) : haystack.indexOf(needle);
    if (idx >= 0) {
      const start = Math.max(0, idx - 15);
      t6.push(`forbidden term "${w}" present in ${targetLangNorm} body (near: …${targetClean.slice(start, start + 40)}…)`);
    }
  }
  checks.T6 = { ok: t6.length === 0, issues: t6 };
  if (t6.length) errors.push(...t6.map((message) => ({ id: 'T6', message })));

  // ---- T7 section length floor ---------------------------------------------
  const t7 = [];
  const srcSections = splitNumberedSections(sourceClean);
  const tgtSections = splitNumberedSections(targetClean);
  const ratio = SECTION_RATIO[targetLangNorm] || 0.5;
  if (srcSections.length !== tgtSections.length) {
    t7.push(`numbered-section count differs (source ${srcSections.length} vs target ${tgtSections.length})`);
  } else {
    for (let i = 0; i < srcSections.length; i++) {
      const srcLen = srcSections[i].body.replace(/\s/g, '').length;
      const tgtLen = tgtSections[i].body.replace(/\s/g, '').length;
      if (srcLen > 0 && tgtLen < srcLen * ratio) {
        t7.push(`section ${i + 1} ("${tgtSections[i].heading.trim()}") too short: ${tgtLen} chars vs source ${srcLen} (floor ${Math.round(srcLen * ratio)})`);
      }
    }
  }
  checks.T7 = { ok: t7.length === 0, issues: t7 };
  if (t7.length) errors.push(...t7.map((message) => ({ id: 'T7', message })));

  // ---- T8 title spec -------------------------------------------------------
  const t8 = [];
  const h1 = h1s.length ? h1s[0].replace(/^#\s+/, '').trim() : '';
  if (targetLangNorm === 'en-us' && CJK_RE.test(h1)) t8.push('H1 contains CJK characters');
  if (targetLangNorm === 'zh-hk') {
    const fb = forbidden['zh-hk'] || [];
    for (const w of fb) if (h1.includes(w)) t8.push(`H1 contains simplified term "${w}"`);
  }
  // meta_description lives in the `articles.seo` column (front matter is stripped at
  // ingest — article-save.js), so `targetSeo` is authoritative. The target .md front
  // matter is only a fallback for the pre-ingest (md_path) workflow.
  const metaDesc = (targetSeo && targetSeo.meta_description) ||
    (targetFm && targetFm.seo && targetFm.seo.meta_description) || null;
  const bounds = META_DESC_LEN[targetLangNorm];
  if (bounds) {
    if (!metaDesc || typeof metaDesc !== 'string') {
      t8.push(`seo.meta_description missing (${targetLangNorm} needs ${bounds[0]}–${bounds[1]} chars)`);
    } else if (metaDesc.length < bounds[0] || metaDesc.length > bounds[1]) {
      t8.push(`seo.meta_description length ${metaDesc.length} outside ${bounds[0]}–${bounds[1]} (${targetLangNorm})`);
    }
  }
  checks.T8 = { ok: t8.length === 0, h1, metaDescriptionLength: metaDesc ? metaDesc.length : 0, issues: t8 };
  if (t8.length) errors.push(...t8.map((message) => ({ id: 'T8', message })));

  return { ok: errors.length === 0, errors, checks };
}

module.exports = { checkTranslation };
