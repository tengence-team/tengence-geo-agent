'use strict';
/**
 * Deterministic platform sanitizer (tengence-geo-sdk/syndicate/sanitize)
 * ============================================================================
 * The REWRITE half that makes an unattended publish path safe: it takes the
 * article body and strips exactly what the platform's audit rules forbid, using
 * the SAME styles/*.yaml rules that styleCheck validates against. One source of
 * truth — sanitize removes what check() would reject, so the pair cannot drift.
 *
 * Why this exists (2026-11-11): channel_publish_due (Mode A) sends the raw DB
 * body (only UTM rewrite). The raw body carries the brand block (关于通智云),
 * the CTA block (立即行动) and conversion links (console/login, /contact-us,
 * product pages). Once styleCheck became a HARD pre-send gate (2026-10-24 /
 * 2026-10-27 / 2026-11-04), every unattended send was rejected before reaching
 * the platform: juejin 3/80 candidates passed, csdn 2/88. The 改写 step only
 * existed in Mode B (harness), which the scheduler never runs. This module is
 * the missing deterministic step.
 *
 * What it does (driven by rewrite.* of the platform style file):
 *   1. removeBlocks      → drop the whole section whose heading matches, or the
 *                          sentence that mentions the block inline
 *   2. forbiddenPhrases  → drop the sentences that contain a banned phrase
 *   3. externalLinks     → mode:none ⇒ unwrap/remove ALL links (images kept);
 *                          otherwise brand URLs keep only pattern-allowed ones
 *                          (e.g. /blog/article/), everything else degrades to
 *                          plain text; third-party citations are untouched
 *   4. body.maxChars     → drop trailing sections, then hard-trim at a line
 *                          boundary (platforms reject over-length bodies)
 *   5. body.noEmoji      → strip emoji/pictographs
 *
 * Invariants: source库 and the WP body are NEVER touched — this only runs on the
 * channel exit; the hard gate (styleCheck) stays in place AFTER it, and anything
 * the sanitizer cannot fix is still blocked, never silently published.
 */

const registry = require('./registry');

/** Platforms the sanitizer is wired into (Mode A exits that hit the hard gate). */
const SANITIZE_PLATFORMS = ['juejin', 'csdn', 'aliyun', 'tencent'];

const FENCE_RE = /^\s*(```+|~~~+)/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{2049}\u{203C}\u{FE0F}\u{200D}\u{20E3}]/gu;

/** Count characters with full Unicode (CJK) awareness (same as styleCheck). */
function charLen(s) {
  return [...String(s)].length;
}

/** Headings whose text matches a removeBlock ⇒ drop the whole section. */
function removeSections(lines, phrases, actions) {
  const out = [];
  let skipLevel = 0;
  let inFence = false;

  for (const line of lines) {
    const fence = FENCE_RE.test(line);
    if (fence) inFence = !inFence;

    if (skipLevel > 0) {
      // inside a dropped section: keep going until a heading at the same or a
      // higher level reopens normal processing (that heading may itself be a hit)
      const h = inFence ? null : HEADING_RE.exec(line);
      if (!h || h[1].length > skipLevel) continue;
      skipLevel = 0;
    }

    if (!inFence) {
      const h = HEADING_RE.exec(line);
      if (h) {
        const text = h[2].trim();
        const hit = phrases.find((p) => p && text.includes(p));
        if (hit) {
          skipLevel = h[1].length;
          actions.push({ type: 'remove-section', rule: hit, heading: text });
          continue;
        }
      }
    }
    out.push(line);
  }
  return out;
}

/** Drop the sentences that mention a banned phrase (inline CTA / brand mentions). */
function cleanSentences(line, phrases, actions) {
  if (!line.trim()) return line;
  // keep the terminating punctuation attached to each fragment
  const parts = line.split(/(?<=[。！？!?；;])/u);
  const kept = [];
  let removed = 0;
  for (const p of parts) {
    const hit = phrases.find((ph) => ph && p.includes(ph));
    if (hit) {
      removed += 1;
      actions.push({ type: 'remove-sentence', rule: hit, text: p.trim().slice(0, 60) });
      continue;
    }
    kept.push(p);
  }
  if (!removed) return line;
  const joined = kept.join('').replace(/\s{2,}/g, ' ').trim();
  // a list item / paragraph that was nothing but the removed sentence disappears
  if (!joined || /^[-*>|\s]*$/.test(joined)) return '';
  return joined;
}

/**
 * Last-resort sweep: the gate matches substrings anywhere, so a banned phrase
 * surviving inside a table cell or a code fence (e.g. a directory tree line
 * `├── 关于我们`) still blocks the send even though sentence-level removal
 * skipped that line. Strip the phrase text itself and tidy the punctuation
 * left behind — a table row keeps its shape, a tree line keeps its indent.
 */
function sweepResidual(lines, banned, actions) {
  let hitCount = 0;
  const out = [];
  for (const line of lines) {
    let s = line;
    for (const ph of banned) {
      if (!ph || !s.includes(ph)) continue;
      hitCount += 1;
      s = s.split(ph).join('');
    }
    if (s !== line) {
      // tidy artifacts: dangling separators / empty bold / empty parens
      s = s
        .replace(/\*\*\s*\*\*/g, '')
        .replace(/（\s*）/g, '')
        .replace(/\(\s*\)/g, '')
        .replace(/[，、,]\s*[，、,]/g, '，')
        .replace(/\|\s*\|/g, '|')
        .replace(/[，、,]\s*\|/g, ' |')
        .replace(/\|\s*[，、,]/g, '| ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      // a cell / line that became pure punctuation disappears
      if (/^[|\-*#>：:，、,\s]*$/.test(s) && !/^\s*\|/.test(line)) continue;
      if (/^\s*\|/.test(s) && /^[|\-\s]*$/.test(s)) continue;
      actions.push({ type: 'sweep-phrase', text: line.trim().slice(0, 50) });
    }
    out.push(s);
  }
  if (hitCount) actions.push({ type: 'sweep-total', count: hitCount });
  return out;
}

/**
 * Link policy from externalLinks.
 *  mode: none      → no hyperlink survives (images exempt)
 *  maxBrandLinks…  → brand URLs survive only if they match an allowed pattern and
 *                    no denied pattern; third-party citations are untouched.
 */
function makeLinkKeeper(el) {
  const modeNone = !!(el && (el.mode === 'none' || el.removeAllLinks === true));
  const allowed = (el && el.brandLinkAllowedPatterns) || [];
  const denied = (el && el.brandLinkDeniedPatterns) || [];
  const brand = (el && el.brandDomainPatterns) || [];
  const isBrand = (u) => brand.some((d) => d && u.includes(d));
  return (url) => {
    const u = String(url || '');
    if (modeNone) return false;
    if (!isBrand(u)) return true;
    if (denied.some((p) => p && u.includes(p))) return false;
    if (allowed.length && !allowed.some((p) => p && u.includes(p))) return false;
    return true;
  };
}

/** Unwrap / drop links per policy. Images (![]() and <img>) are always preserved. */
function cleanLinks(body, el, actions) {
  const keep = makeLinkKeeper(el);
  const stripped = [];

  // protect images so the passes below never eat them
  const imgs = [];
  let s = String(body)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, (m) => {
      imgs.push(m);
      return `\u0000IMG${imgs.length - 1}\u0000`;
    })
    .replace(/<img\b[^>]*>/gi, (m) => {
      imgs.push(m);
      return `\u0000IMG${imgs.length - 1}\u0000`;
    });

  // HTML anchors → inner text when the href is not allowed
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (m, attrs, inner) => {
    const href = (/href\s*=\s*["']([^"']+)["']/i.exec(attrs) || [])[1] || '';
    if (keep(href)) return m;
    stripped.push(href);
    return String(inner);
  });

  // markdown hyperlinks → visible text when not allowed
  s = s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (m, label, url) => {
    const u = String(url).split(/\s+/)[0];
    if (keep(u)) return m;
    stripped.push(u);
    return label;
  });

  // bare URLs
  s = s.replace(/https?:\/\/[^\s)"'<>\u0000]+/g, (u) => {
    if (keep(u)) return u;
    stripped.push(u);
    return '';
  });

  s = s.replace(/\u0000IMG(\d+)\u0000/g, (_, i) => imgs[Number(i)]);
  if (stripped.length) {
    actions.push({ type: 'strip-links', count: stripped.length, sample: inspected(stripped) });
  }
  return s;
}

function inspected(urls) {
  const seen = [...new Set(urls)].filter(Boolean);
  return seen.slice(0, 3).join(' | ') + (seen.length > 3 ? ` (+${seen.length - 3})` : '');
}

/** Drop trailing sections until the body fits; then hard-trim at a line boundary. */
function trimToMax(body, max, actions) {
  if (!max || charLen(body) <= max) return body;
  let src = body;
  const before = charLen(src);
  for (let guard = 0; guard < 50; guard += 1) {
    if (charLen(src) <= max) break;
    const lines = src.split('\n');
    // last heading (any level) whose section we can drop, keeping ≥ 1 section
    let cut = -1;
    let inFence = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (FENCE_RE.test(lines[i])) inFence = !inFence;
      if (inFence) continue;
      if (HEADING_RE.test(lines[i]) && i > 0) cut = i;
    }
    if (cut < 0) break;
    actions.push({ type: 'trim-section', chars: charLen(src) - charLen(lines.slice(0, cut).join('\n')) });
    src = lines.slice(0, cut).join('\n');
  }
  if (charLen(src) > max) {
    const lines = src.split('\n');
    let acc = '';
    for (const line of lines) {
      if (charLen(acc + line) > max) break;
      acc += `${line}\n`;
    }
    src = acc || [...src].slice(0, max).join('');
    actions.push({ type: 'trim-hard', chars: charLen(src) });
  }
  actions.push({ type: 'trim-total', from: before, to: charLen(src), max });
  return src.trim() + '\n';
}

/** Collapse the blank-line runs left behind by removals. */
function tidy(body) {
  return String(body)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[\s]*[-*]\s*\n/gm, '') // empty bullets
    .trim();
}

/**
 * Sanitize a channel body for one platform.
 *
 * @param {object} args
 *   platform  the channel key (must exist in the syndicate registry)
 *   body      the outgoing markdown (already UTM-rewritten)
 * @returns {{body:string, changed:boolean, actions:object[], platform:string}}
 */
function sanitizeBody({ platform, body }) {
  const p = registry.getPlatform(platform);
  if (!p) throw new Error(`Unknown platform: "${platform}" (not in syndicate registry)`);
  const rw = p.rewrite || {};
  const src = String(body == null ? '' : body);
  const actions = [];

  const removeBlocks = Array.isArray(rw.removeBlocks) ? rw.removeBlocks.filter(Boolean) : [];
  const phrases = Array.isArray(rw.forbiddenPhrases) ? rw.forbiddenPhrases.filter(Boolean) : [];
  // forbiddenPhrases are a subset of what audit rejects; both are removed the same way
  const banned = [...new Set([...removeBlocks, ...phrases])];

  // 1) whole sections named by a removeBlock
  let lines = src.replace(/\r\n/g, '\n').split('\n');
  if (removeBlocks.length) lines = removeSections(lines, removeBlocks, actions);

  // 2) inline mentions / banned marketing phrases (code fences untouched)
  if (banned.length) {
    let inFence = false;
    lines = lines.map((line) => {
      if (FENCE_RE.test(line)) inFence = !inFence;
      if (inFence) return line;
      if (/^\s*\|/.test(line)) return line; // table rows: never splice sentences
      return cleanSentences(line, banned, actions);
    });
  }
  // 2b) residual sweep — table cells / code-fence lines / bold CTA lines
  if (banned.length) lines = sweepResidual(lines, banned, actions);

  let out = lines.join('\n');

  // 3) emoji ban
  if (rw.body && rw.body.noEmoji && EMOJI_RE.test(out)) {
    const hits = out.match(EMOJI_RE) || [];
    out = out.replace(EMOJI_RE, '');
    actions.push({ type: 'strip-emoji', count: hits.length });
  }

  // 4) links
  if (rw.externalLinks) out = cleanLinks(out, rw.externalLinks, actions);

  // 4b) unwrapping a link can CREATE a banned phrase (e.g. `了解[通智 GEO](url)`
  //     → `了解通智 GEO`), so sweep again on the post-link text.
  if (banned.length) {
    const swept = sweepResidual(out.split('\n'), banned, actions);
    out = swept.join('\n');
  }

  // 5) length
  if (rw.body && rw.body.maxChars) out = trimToMax(out, rw.body.maxChars, actions);

  const body2 = tidy(out);
  return {
    body: body2,
    changed: body2 !== src.replace(/\r\n/g, '\n').trim(),
    actions,
    platform,
  };
}

module.exports = { sanitizeBody, SANITIZE_PLATFORMS, charLen };
