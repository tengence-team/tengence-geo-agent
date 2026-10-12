'use strict';
/**
 * UTM injection for cross-platform channel links (tengence-geo-sdk/syndicate/utm)
 * ============================================================================
 * Every outbound channel link that points back at the official blog
 * (www.<domain>/blog/article/<slug>/) carries UTM parameters so blog-side
 * analytics can attribute traffic to the source channel and article:
 *
 *   ?utm_source=<channel>&utm_content=<slug>
 *
 * Decisions (confirmed 2026-10-12):
 *   - Only utm_source + utm_content. utm_medium / utm_campaign carry no
 *     distinguishing signal here (one source per channel; steady-state content
 *     distribution) and are intentionally omitted. The helpers accept an
 *     optional `extra` map should a campaign dimension ever be needed.
 *   - utm_source naming: WeChat Official Account → 'wechat_oa' (NOT 'wechat',
 *     which is the app, not the public-account platform); Tencent Cloud →
 *     'tencent_cloud' (NOT 'tencent').
 *   - Outbound links always carry the www host and the channel language prefix:
 *     dev.to → /en/, every CN channel → /zh-hans/. The site's own WP publish
 *     path (publish/index.js) is untouched — on-site links stay clean.
 *   - Idempotent: a URL that already carries a utm_source parameter is left
 *     alone (no double injection on re-publish / re-rewrite).
 *   - Only the site's own domain is rewritten; third-party citations
 *     (elastic.co, nngroup.com, …) pass through untouched.
 * ============================================================================
 */

/** Channel key → utm_source value. */
const UTM_SOURCE = {
  wechat: 'wechat_oa', // WeChat Official Accounts Platform（公众号），不是微信 App
  juejin: 'juejin',
  csdn: 'csdn',
  tencent: 'tencent_cloud', // 腾讯云 Tencent Cloud，不是厂商名 Tencent
  aliyun: 'aliyun',
  devto: 'devto',
  zhihu: 'zhihu',
  xiaohongshu: 'xiaohongshu',
  toutiao: 'toutiao',
  baijiahao: 'baijiahao',
  blog: 'blog',
};

/** Channel key → article-language prefix. Every CN channel defaults to zh-hans. */
const CHANNEL_LANG = {
  devto: 'en',
};

/** The site's own domain, bare (no scheme, no www). Lazy — env may change per site. */
function bareDomain() {
  return (process.env.SITE_DOMAIN || 'www.tengence.com')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '');
}

/** utm_source value for a channel key (fallback: the key itself). */
function utmSourceFor(platform) {
  return UTM_SOURCE[platform] || String(platform || '');
}

/** Language prefix for a channel (caller may override with an explicit lang). */
function langFor(platform, lang) {
  return lang || CHANNEL_LANG[platform] || 'zh-hans';
}

/**
 * Build the canonical article URL on the official blog:
 *   https://www.<domain>/<lang>/blog/article/<slug>/
 * @param {{domain?:string, slug?:string, lang?:string}} opts domain may carry
 *        scheme / www; it is normalized here. lang default zh-hans.
 * @returns {string} '' when slug is missing
 */
function articleUrl({ domain = null, slug = null, lang = 'zh-hans' } = {}) {
  if (!slug) return '';
  const dom = (domain || bareDomain()).replace(/^https?:\/\//, '').replace(/^www\./, '');
  return `https://www.${dom}/${lang}/blog/article/${slug}/`;
}

/** Pull the article slug out of an own-site article path ('' when not an article page). */
function slugInPath(u) {
  const m =
    u.pathname.match(/^\/?(?:zh-hans|zh-hant|en)\/blog\/article\/([^/]+)\/?$/) ||
    u.pathname.match(/^\/?blog\/article\/([^/]+)\/?$/);
  return m ? m[1] : '';
}

/**
 * Append UTM params to one own-site URL and normalize it:
 *   - host → www.<domain>
 *   - article paths → channel language prefix (devto → en, else zh-hans)
 *   - ?utm_source=<channel>&utm_content=<slug|target-slug>
 * Idempotent (existing utm_source → untouched). Third-party / unparseable URLs
 * are returned unchanged.
 * @param {string} url
 * @param {string} platform channel key (syndicate registry)
 * @param {{slug?:string, lang?:string, extra?:Object}} [opts] slug = the CURRENT
 *        article (used as utm_content for non-article paths, or as an explicit
 *        override); article paths default utm_content to the TARGET slug found
 *        in the URL. extra = additional query params (reserved, not used today).
 * @returns {string}
 */
function appendUtm(url, platform, { slug = null, lang = null, extra = null } = {}) {
  if (!url) return '';
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return url;
  }
  // Only rewrite links that point at our own site.
  if (u.hostname.replace(/^www\./, '') !== bareDomain()) return url;
  // Idempotent: already carries a utm_source param → leave alone.
  if (u.searchParams.has('utm_source')) return url;
  // Normalize host to www.
  u.hostname = `www.${bareDomain()}`;
  const target = slugInPath(u);
  const content = slug || target;
  const source = utmSourceFor(platform);
  if (target) {
    // Article path: apply the channel language prefix.
    u.pathname = `/${langFor(platform, lang)}/blog/article/${target}/`;
  }
  u.searchParams.set('utm_source', source);
  if (content) u.searchParams.set('utm_content', content);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v != null && v !== '') u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

const MD_LINK_RE = /(\[[^\]]*\]\()(https?:\/\/[^\s)]+)(\))/g;
const HTML_LINK_RE = /(<a\s+[^>]*?href=")(https?:\/\/[^"]+)(")/gi;

/**
 * Rewrite every own-site link inside a markdown body: normalize host + language
 * prefix + append UTM (see appendUtm). Third-party citations stay untouched.
 * Handles both markdown links `[text](url)` and inline `<a href="...">`.
 * @param {string} md markdown body
 * @param {{platform:string, lang?:string, slug?:string, extra?:Object}} opts
 * @returns {string}
 */
function rewriteMarkdownUtm(md, { platform, lang = null, slug = null, extra = null } = {}) {
  if (!md) return md;
  const opts = { lang, slug, extra };
  let out = md.replace(MD_LINK_RE, (whole, open, url, close) => {
    const rewritten = appendUtm(url, platform, opts);
    return rewritten === url ? whole : `${open}${rewritten}${close}`;
  });
  out = out.replace(HTML_LINK_RE, (whole, pre, url, post) => {
    const rewritten = appendUtm(url, platform, opts);
    return rewritten === url ? whole : `${pre}${rewritten}${post}`;
  });
  return out;
}

module.exports = {
  UTM_SOURCE,
  CHANNEL_LANG,
  utmSourceFor,
  langFor,
  articleUrl,
  slugInPath,
  appendUtm,
  rewriteMarkdownUtm,
};
