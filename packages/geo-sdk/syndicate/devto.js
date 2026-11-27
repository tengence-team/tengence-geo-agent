'use strict';
/**
 * Dev.to publishing (tengence-geo-sdk/syndicate/devto)
 * ============================================================================
 * Sunk down from commands/publish-devto.js on 2026-09-20. The CLI only parses
 * <md path> and --dry-run; everything else (front-matter parsing, Dev.to tag
 * derivation, canonical-URL assembly, payload construction, API calls, progress
 * printing) lives in this file. Input/API errors throw Error; the CLI catches and
 * exits with code 1.
 *
 * Env vars (sites/<site>/.env, injected by t.site.loadSite()):
 *   DEVTO_API_KEY  — Dev.to API key
 *   SITE_DOMAIN    — the official-site domain, used to build canonical_url
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');

const { articleUrl, appendUtm } = require('./utm');

/**
 * Plan tag slug → Dev.to tag (2026-11-24).
 * Dev.to has no category taxonomy and accepts any lowercase tag, so unlike
 * juejin/tencent there is no dictionary to resolve against — only a naming map.
 * Source of truth is `article_plan.tags`; `target_keywords` stays as the fallback
 * (the articles table is empty for 1266/1275 rows, which used to make every
 * Dev.to post ship with the same `seo, ai`).
 */
const PLAN_TAG_TO_DEVTO = {
  'geo-seo': 'seo',
  'technical-seo': 'seo',
  'schema-markup': 'seo',
  'international-seo': 'seo',
  'ai-search': 'ai',
  'agentic-ai': 'ai',
  'entity-authority': 'ai',
  'geo-monitoring': 'ai',
  'ai-content-disclosure': 'ai',
  'ai-transformation': 'ai',
  'tengence-geo': 'ai',
  'rag': 'ai',
  'vector-search': 'ai',
  'data-analytics': 'analytics',
  'user-data': 'analytics',
  'data-growth': 'analytics',
  'funnel-analysis': 'analytics',
  'conversion-optimization': 'growth',
  'search-system': 'search',
  'tengence-search': 'search',
  'technical-solutions': 'api',
  'api-integration': 'api',
  'implementation-guide': 'api',
  'core-web-vitals': 'webdev',
  'recommendation-system': 'machinelearning',
  'ecommerce': 'ecommerce',
  'cross-border': 'international',
  'content-marketing': 'content',
  'brand-strategy': 'marketing',
};

/** Map our plan tag slugs to Dev.to tags (unknown slugs dropped); max 4, de-duped */
function mapPlanTagsToDevto(planTags) {
  const out = [];
  for (const slug of planTags || []) {
    const tag = PLAN_TAG_TO_DEVTO[String(slug || '').trim().toLowerCase()];
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 4);
}


/**
 * Publish a local markdown article to Dev.to (LIVE, not draft)
 * @param {{mdPath:string, dryRun?:boolean, coverImage?:string, tags?:string[]}} opts
 *        coverImage — absolute URL of the article's cover image; dev.to re-hosts
 *        it to its own CDN at publish time (field: main_image).
 *        tags — Dev.to tags already resolved from article_plan.tags by the channel
 *        layer (2026-11-24); when omitted, the `tags:` front matter / keywords are used.
 * @returns {Promise<{dryRun?:boolean, id?:number, url?:string}>}
 * @throws missing file / no front matter / API failure (every error path except dry-run)
 */
/**
 * Classify a non-2xx response from the Dev.to API.
 * 422 “Canonical url has already been taken” is NOT a retryable failure: the
 * article is already live under the same canonical URL, i.e. this run is a
 * duplicate attempt. Treating it as a generic error kept the channel_plan row
 * retryable and made the hourly ticker re-send the same article forever
 * (2026-11-16..11-25, every slot answered 422).
 * @param {number} status HTTP status
 * @param {string} body raw response text
 * @returns {{kind:'already_published'|'api_error', message:string}}
 */
function classifyDevtoError(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body == null ? {} : body);
  if (Number(status) === 422 && /canonical\s*url has already been taken/i.test(text)) {
    return { kind: 'already_published', message: text };
  }
  return { kind: 'api_error', message: text };
}

async function publishDevto({ mdPath, dryRun = false, coverImage = null, tags = null }) {
  const API_KEY = process.env.DEVTO_API_KEY;
  if (!API_KEY) {
    console.error('❌ DEVTO_API_KEY not set (in sites/tengence/.env)');
    throw new Error('DEVTO_API_KEY_MISSING');
  }

  const absPath = path.resolve(mdPath);
  if (!fs.existsSync(absPath)) {
    console.error(`❌ File does not exist: ${absPath}`);
    throw new Error('MD_NOT_FOUND');
  }

  const raw = fs.readFileSync(absPath, 'utf-8');

  // ---- parse Front Matter ----
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fmMatch) {
    console.error('❌ Front Matter not found');
    throw new Error('NO_FRONT_MATTER');
  }

  const fm = fmMatch[1];
  const body = raw.slice(fmMatch[0].length);

  // simple YAML front-matter parsing (supports nested seo: blocks)
  function fmValue(key) {
    // look inside the seo: block first
    const re = new RegExp(`^\\s+${key}:\\s*"?(.+?)"?\\s*$`, 'm');
    const m = fm.match(re);
    if (m) return m[1].trim();
    // then the top level
    const reTop = new RegExp(`^${key}:\\s*"?(.+?)"?\\s*$`, 'm');
    const mTop = fm.match(reTop);
    return mTop ? mTop[1].trim() : null;
  }

  // slug derived from the file name
  const slug = path.basename(absPath, '.md');

  const title = fmValue('title');

  // canonical URL = the official-site original (English row: /en/ prefix + UTM)
  const canonicalUrl = appendUtm(
    articleUrl({ domain: process.env.SITE_DOMAIN, slug, lang: 'en' }),
    'devto',
    { slug, lang: 'en' }
  );

  // tags: a `tags:` front matter field (already mapped from article_plan.tags by the
  // channel layer, 2026-11-24) wins; otherwise derive from keywords, then fall back
  const fmTagsLine = fmValue('tags');
  let fmTags = [];
  if (fmTagsLine) {
    // the value is written as a JSON array, but YAML.dump wraps it in single quotes:
    // tags: '["seo","ai"]' — strip the outer quotes before parsing
    const raw = fmTagsLine.trim().replace(/^['"]+/, '').replace(/['"]+$/, '');
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) fmTags = parsed.map((x) => String(x).trim()).filter(Boolean);
    } catch (e) {
      fmTags = raw.split(',').map((x) => x.replace(/[["'\]\s]/g, '')).filter(Boolean);
    }
  }

  // derive Dev.to tags from keywords
  const keywordsLine = fmValue('keywords') || '[]';
  const kwMatch = keywordsLine.match(/\[(.*?)\]/);
  const rawKeywords = kwMatch ? kwMatch[1].split(',').map(t => t.trim().replace(/['"\s\[\]]/g, '')) : [];

  const tagMap = {
    // Chinese keywords
    'EEAT': 'seo', 'AI搜索优化': 'ai', 'GEO': 'seo', '实体权威性': 'seo',
    'AI生成内容': 'ai', '内容合规': 'content', 'Wikidata': 'ai', 'Wikipedia': 'ai',
    'AI搜索': 'ai', 'SEO': 'seo', 'GEO优化': 'seo', 'AIGC': 'ai',
    // English keywords
    'enterprise search API': 'saas', 'managed search service': 'saas',
    'search-as-a-service': 'saas', 'Tengence Search': 'saas', 'AI search': 'ai',
    'seo': 'seo', 'search': 'search', 'api': 'api',
    'saas': 'saas', 'machine learning': 'machinelearning',
  };
  const derivedTags = [];
  for (const kw of rawKeywords) {
    if (tagMap[kw]) derivedTags.push(tagMap[kw]);
  }
  const derivedFinal = [...new Set(derivedTags)].slice(0, 4);
  const explicitTags = Array.isArray(tags) ? tags.map((x) => String(x).trim()).filter(Boolean) : [];
  const devtoTags = explicitTags.length
    ? [...new Set(explicitTags)].slice(0, 4)
    : Array.isArray(fmTags) && fmTags.length
      ? fmTags.slice(0, 4)
      : derivedFinal;
  if (devtoTags.length === 0) devtoTags.push('seo', 'ai');

  // strip the Front Matter and images from the body (Dev.to uses its own image host)
  let cleanBody = body;

  // remove the leading # title (the Dev.to API has a separate title field)
  cleanBody = cleanBody.replace(/^#\s+.+\n/, '');

  // Dev.to allows at most 4 tags
  console.log('📝 Article info:');
  console.log(`   Title: ${title}`);
  console.log(`   Slug: ${slug}`);
  console.log(`   Tags: ${devtoTags.join(', ') || '(none)'}`);
  console.log(`   Canonical: ${canonicalUrl}`);
  console.log(`   Body length: ${cleanBody.length}`);

  if (dryRun) {
    console.log('\n🔍 dry-run mode, not actually publishing');
    return { dryRun: true };
  }

  // ---- call the Dev.to API ----
  const payload = {
    article: {
      title: title,
      body_markdown: cleanBody,
      published: true, // live publish (2026-10-12): no draft-first, publish directly
      canonical_url: canonicalUrl,
      tags: devtoTags.length > 0 ? devtoTags : ['seo', 'marketing'],
      description: fmValue('meta_description') || `Learn about ${title}`,
    }
  };
  if (coverImage) payload.article.main_image = coverImage;

  console.log('\n🚀 Publishing to Dev.to (live)...');

  const res = await fetch('https://dev.to/api/articles', {
    method: 'POST',
    headers: {
      'api-key': API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  // read the raw body once (needed for error classification AND for the payload);
  // stubs/tests may only implement json(), so fall back to that when text() is absent.
  let bodyText = '';
  if (typeof res.text === 'function') {
    bodyText = await res.text();
  } else if (typeof res.json === 'function') {
    bodyText = JSON.stringify(await res.json());
  }
  let data = {};
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch (e) {
    data = { raw: bodyText };
  }
  if (!res.ok) {
    const cls = classifyDevtoError(res.status, bodyText);
    console.error('❌ Publish failed:', res.status, JSON.stringify(data, null, 2));
    if (cls.kind === 'already_published') {
      // the article is already live under this canonical URL — nothing to publish
      console.log('ℹ️  canonical already taken → treated as already published');
      return {
        alreadyPublished: true,
        canonicalUrl,
        status: res.status,
        detail: bodyText.slice(0, 500),
      };
    }
    const err = new Error('DEVTO_API_ERROR');
    // keep the real status + body so channel_plan.error_detail is diagnosable
    // (channel-log used to carry only the string 'DEVTO_API_ERROR')
    err.detail = { status: res.status, body: bodyText.slice(0, 1000) };
    throw err;
  }
  console.log(`✅ Success! Dev.to article ID: ${data.id}`);
  console.log(`   Article link: ${data.url}`);
  console.log(`   Status: published (live)`);
  return { id: data.id, url: data.url };
}

module.exports = { publishDevto, mapPlanTagsToDevto, classifyDevtoError };
