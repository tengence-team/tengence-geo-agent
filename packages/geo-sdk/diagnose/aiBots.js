/**
 * diagnose/aiBots.js — crawler reachability (SEO vs GEO, separate), llms.txt,
 *                      language-version probe, and robots block detection
 * ============================================================================
 * The GEO/SEO halves of the diagnosis need to know, deterministically:
 *   - do SEARCH-ENGINE crawlers (Googlebot / Bingbot / Baiduspider) get a 200
 *     with *complete* content, a 200 shell, or a block?        → SEO group
 *   - do GENERATIVE-ENGINE crawlers (GPTBot / ClaudeBot / PerplexityBot /
 *     Bytespider) get the same?                                 → GEO group
 *     (SEO and GEO crawlers are probed and judged separately.)
 *   - is /llms.txt (or variants) present for generative engines to consume?
 *   - does robots.txt block any crawler by name (per group)?
 *   - does an independent language version (/en/, /fr/, …) exist, and does the
 *     homepage declare hreflang?
 * Everything fails softly and is bounded.
 */

const { UA } = require('./fetch');
const { parseRobots } = require('./robots');

/**
 * Crawler groups. `geo` = generative-engine (AI) crawlers; `seo` = search-engine
 * crawlers. They are probed and judged separately so a report can distinguish
 * "Google can read us but AI engines can't" (and vice versa).
 */
const GEO_BOTS = [
  { id: 'GPTBot', ua: 'GPTBot/1.0 (+https://openai.com/gptbot)', group: 'geo' },
  {
    id: 'ClaudeBot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +claudebot-crawler@anthropic.com',
    group: 'geo',
  },
  { id: 'PerplexityBot', ua: 'PerplexityBot/1.0 (+https://perplexity.ai/perplexitybot)', group: 'geo' },
  { id: 'Bytespider', ua: 'Mozilla/5.0 (compatible; Bytespider; +https://bytedance.com)', group: 'geo' },
];

const SEO_BOTS = [
  { id: 'Googlebot', ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', group: 'seo' },
  {
    id: 'Bingbot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    group: 'seo',
  },
  { id: 'Baiduspider', ua: 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)', group: 'seo' },
];

const ALL_BOTS = [...GEO_BOTS, ...SEO_BOTS];

/** robots rules that target generative-engine (GEO) crawlers by name. */
const GEO_NAMES = ['gptbot', 'claudebot', 'perplexitybot', 'ccbot', 'anthropic', 'openai', 'google-extended', 'bytespider', 'cohere', 'amazonbot', 'meta-externalagent'];
/** robots rules that target search-engine (SEO) crawlers by name. */
const SEO_NAMES = ['googlebot', 'bingbot', 'baiduspider', 'yandexbot', 'sogou', '360spider', 'duckduckbot'];

/** Count words (CJK chars + latin words) in a text body. */
function countWords(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const latin = (s.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[a-zA-Z0-9]+(?:['-][a-zA-Z0-9]+)*/g) || []).length;
  return cjk + latin;
}

/**
 * Probe the homepage as each crawler (SEO group + GEO group). `baselineWords`
 * is the word count seen by a normal browser UA; a crawl is judged "full" only
 * when it receives a 200 **on the same host** with at least 60% of the baseline
 * words. A redirect to a foreign host (WAF verification page, challenge domain,
 * …) means the bot was intercepted — GEO/SEO-fatal even if HTTP says 200.
 *
 * @param {string} baseUrl
 * @param {{timeoutMs?:number, baselineWords?:number}} [opts]
 * @returns {Promise<Array<{bot:string, group:'geo'|'seo', status:number, finalUrl:string,
 *          hostSame:boolean, bodyLength:number, wordCount:number, full:boolean, error?:string}>>}
 */
async function aiReachability(baseUrl, { timeoutMs = 10000, baselineWords = 0 } = {}) {
  const baseHost = (() => {
    try {
      return new URL(baseUrl).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  const out = [];
  for (const b of ALL_BOTS) {
    try {
      const res = await fetch(baseUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': b.ua, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      });
      const finalUrl = res.url || baseUrl;
      let hostSame = true;
      try {
        hostSame = new URL(finalUrl).hostname.toLowerCase() === baseHost;
      } catch {
        hostSame = false;
      }
      const body = await res.text().catch(() => '');
      const wordCount = countWords(body);
      const full =
        res.status === 200 &&
        hostSame &&
        (baselineWords > 0 ? wordCount >= Math.max(20, baselineWords * 0.6) : wordCount >= 100);
      out.push({ bot: b.id, group: b.group, status: res.status, finalUrl, hostSame, bodyLength: Buffer.byteLength(body), wordCount, full, error: null });
    } catch (e) {
      out.push({ bot: b.id, group: b.group, status: 0, finalUrl: '', hostSame: false, bodyLength: 0, wordCount: 0, full: false, error: e.message });
    }
  }
  return out;
}

const LLMS_PATHS = ['/llms.txt', '/llms-full.txt', '/.well-known/llms.txt'];

/**
 * Probe standard llms.txt locations.
 * @param {string} baseUrl
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{found:boolean, probes:Array<{url:string,status:number}>, content:string}>}
 */
async function probeLlms(baseUrl, { timeoutMs = 8000 } = {}) {
  const probes = [];
  let found = false;
  let content = '';
  for (const p of LLMS_PATHS) {
    const u = new URL(p, baseUrl).href;
    try {
      const res = await fetch(u, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': UA, accept: 'text/plain,*/*;q=0.8' },
      });
      const body = await res.text().catch(() => '');
      probes.push({ url: u, status: res.status });
      // a WAF challenge page is HTML even when HTTP says 200 — never count it as llms.txt
      const looksLikeText = !/^\s*(<!DOCTYPE html|<html)/i.test(body.trim());
      if (res.status === 200 && looksLikeText && body.trim().length) {
        found = true;
        content = body.slice(0, 500);
      }
    } catch (e) {
      probes.push({ url: u, status: 0 });
    }
  }
  return { found, probes, content };
}

const LANG_PATHS = ['/en/', '/en', '/fr/', '/fr', '/es/', '/es', '/de/', '/de', '/ja/', '/ja'];

/**
 * Probe common independent language-version paths (a "real" i18n site has them
 * as separate URLs; a `?l=en` query-param site does not).
 * @param {string} baseUrl
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{probes:Array<{lang:string,url:string,status:number,is200:boolean}>}>}
 */
async function probeLanguages(baseUrl, { timeoutMs = 7000 } = {}) {
  const probes = [];
  for (const p of LANG_PATHS) {
    const u = new URL(p, baseUrl).href;
    try {
      const res = await fetch(u, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.8' },
      });
      probes.push({ lang: p.replace(/[\/]/g, '') || 'en', url: u, status: res.status, is200: res.status === 200 });
    } catch {
      probes.push({ lang: p.replace(/[\/]/g, '') || 'en', url: u, status: 0, is200: false });
    }
  }
  return { probes };
}

/**
 * Do the robots groups block any named crawler of a given group? A
 * `User-agent: * / Disallow: /admin/` is NOT a block (bots can still crawl
 * everything else); only a root-level Disallow on a wildcard group, or any
 * Disallow on a crawler-named group, genuinely excludes that group.
 *
 * @param {object} robots parsed robots (parseRobots output) or robots raw text
 * @param {'geo'|'seo'} [group] which crawler group to check (default 'geo')
 * @returns {{blocked:Array<{ua:string,rule:string}>, count:number}}
 */
function robotsAiBlocks(robots, group = 'geo') {
  const names = group === 'seo' ? SEO_NAMES : GEO_NAMES;
  const groups = robots && Array.isArray(robots.groups) ? robots.groups : [];
  const blocked = [];
  for (const g of groups) {
    const agents = (g.userAgents || []).map((x) => x.toLowerCase().trim());
    const targetsGroup = agents.some((a) => a === '*' || names.includes(a));
    if (!targetsGroup) continue;
    const dis = (g.disallow || []).map((d) => d.trim()).filter((d) => d !== '');
    if (!dis.length) continue;
    const isWildcard = agents.includes('*');
    if (isWildcard) {
      if (dis.includes('/') || dis.includes('/*')) {
        blocked.push({ ua: '*', rule: 'Disallow: /（根级，全站屏蔽）' });
      }
      continue; // non-root wildcard disallows do not hide the site from crawlers
    }
    for (const d of dis) blocked.push({ ua: agents.join(','), rule: `Disallow: ${d}` });
  }
  return { blocked, count: blocked.length };
}

module.exports = { GEO_BOTS, SEO_BOTS, ALL_BOTS, GEO_NAMES, SEO_NAMES, countWords, aiReachability, probeLlms, probeLanguages, robotsAiBlocks };
