/**
 * diagnose/i18n.js — multilingual (i18n) evidence
 * ============================================================================
 * Answers questions the language-path probe alone cannot:
 *   - does EVERY declared language homepage carry the full hreflang group
 *     (self + siblings + x-default)? Asymmetric hreflang = weak i18n signal.
 *   - is the 404 page localized consistently (lang attribute vs title)?
 *   - do the sitemap articles cover every language (coverage completeness)?
 * All network calls are bounded, HEAD/GET only, soft-fail.
 */

const { fetchPage } = require('./fetch');
const { parsePage } = require('./parse');

/** Normalize a BCP-47-ish tag for case-insensitive comparison (zh-hans == zh-Hans). */
function normLang(tag) {
  return String(tag || '').trim().toLowerCase();
}

/**
 * Probe every language homepage referenced by the root page's hreflang group
 * (plus the root's own path) and re-parse its hreflang set.
 * @param {string} baseUrl root (already redirected) URL
 * @param {Array<{hreflang:string, href:string}>} rootHreflang hreflang group from the root page
 * @param {{timeoutMs?:number, maxLangs?:number}} [opts]
 * @returns {Promise<{probes:Array<{lang:string,url:string,status:number,hreflangCount:number,
 *            hasSelf:boolean,hasXDefault:boolean,error?:string}>}>}
 */
async function probeLangHomepages(baseUrl, rootHreflang = [], { timeoutMs = 10000, maxLangs = 6 } = {}) {
  const seen = new Set();
  const targets = [];
  for (const r of rootHreflang || []) {
    if (!r || !r.href) continue;
    const u = (() => {
      try {
        return new URL(r.href, baseUrl).href;
      } catch {
        return null;
      }
    })();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    targets.push({ lang: r.hreflang, url: u });
  }
  // fallback: common independent language paths if the root declares none
  if (!targets.length) {
    for (const p of ['/en', '/zh-hans', '/zh-hant']) {
      const u = new URL(p, baseUrl).href;
      if (!seen.has(u)) {
        seen.add(u);
        targets.push({ lang: p.replace(/^\//, ''), url: u });
      }
    }
  }
  targets.splice(maxLangs);

  const probes = [];
  for (const t of targets) {
    try {
      const res = await fetchPage(t.url, { timeoutMs });
      if (res.error || res.status !== 200) {
        probes.push({ lang: t.lang, url: t.url, status: res.status || 0, hreflangCount: 0, hasSelf: false, hasXDefault: false, error: res.error || null });
        continue;
      }
      const parsed = parsePage(res.body, res.finalUrl);
      const group = parsed.hreflang || [];
      const normGroup = group.map((g) => normLang(g.hreflang));
      const selfTag = normLang(parsed.lang);
      probes.push({
        lang: t.lang,
        url: t.url,
        status: res.status,
        hreflangCount: group.length,
        hasSelf: group.some((g) => normLang(g.hreflang) === selfTag),
        hasXDefault: normGroup.includes('x-default'),
        tags: group.map((g) => g.hreflang),
      });
    } catch (e) {
      probes.push({ lang: t.lang, url: t.url, status: 0, hreflangCount: 0, hasSelf: false, hasXDefault: false, error: e.message });
    }
  }
  return { probes };
}

/**
 * 404-page localization check: does the lang attribute match the title's language?
 * Pure computation over an already-fetched 404 page (no extra network call).
 * @param {object|null} parsed404 parsePage output of the 404 body
 * @returns {{consistent:boolean|null, lang:string|null, title:string|null, note:string}}
 */
function check404Localization(parsed404) {
  if (!parsed404 || !parsed404.title) {
    return { consistent: null, lang: parsed404 ? parsed404.lang : null, title: null, note: '404 页无解析数据' };
  }
  const lang = parsed404.lang || '';
  const title = parsed404.title;
  const hasCJK = /[\u3400-\u9fff]/g.test(title);
  const langIsCjk = /^zh/i.test(lang);
  const consistent = hasCJK === langIsCjk;
  return {
    consistent,
    lang,
    title: title.slice(0, 60),
    note: consistent
      ? `lang=${lang || '无'} 与标题语言一致`
      : `lang=${lang || '无'} 但标题包含${hasCJK ? '中文' : '非中文'}（本地化不一致）`,
  };
}

/**
 * Article coverage across languages, computed from the sitemap URL inventory.
 * @param {string[]} sitemapUrls full sitemap URL list
 * @param {string[]} langPrefixes declared language prefixes
 * @returns {{total:number, covered:number, gapPct:number, gaps:Array<{slug:string, present:string[]}>}}
 */
function i18nCoverage(sitemapUrls, langPrefixes = []) {
  const bySlug = new Map();
  for (const u of sitemapUrls || []) {
    let slug = '';
    try {
      const pathname = new URL(u).pathname.replace(/\/+$/, '');
      // strip the leading language prefix (if any) to get the content slug
      slug = pathname.replace(new RegExp('^/(' + langPrefixes.map(escapeRe).join('|') + ')(/|$)'), '');
    } catch {
      slug = '';
    }
    if (!slug) continue;
    let lang = 'none';
    for (const p of langPrefixes) {
      const pathname = (() => {
        try {
          return new URL(u).pathname;
        } catch {
          return '';
        }
      })();
      if (pathname === '/' + p || pathname.startsWith('/' + p + '/')) {
        lang = p;
        break;
      }
    }
    if (!bySlug.has(slug)) bySlug.set(slug, new Set());
    bySlug.get(slug).add(lang);
  }
  const entries = [...bySlug.entries()];
  const full = entries.filter(([, langs]) => langs.size >= langPrefixes.length);
  const gaps = entries
    .filter(([, langs]) => langs.size < langPrefixes.length)
    .map(([slug, langs]) => ({ slug, present: [...langs] }));
  return {
    total: entries.length,
    covered: full.length,
    gapPct: entries.length ? Math.round((gaps.length / entries.length) * 100) : 0,
    gaps: gaps.slice(0, 10),
  };
}

function escapeRe(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { probeLangHomepages, check404Localization, i18nCoverage, normLang };
