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

/**
 * Publish a local markdown article to Dev.to as a draft
 * @param {{mdPath:string, dryRun?:boolean}} opts
 * @returns {Promise<{dryRun?:boolean, id?:number, url?:string}>}
 * @throws missing file / no front matter / API failure (every error path except dry-run)
 */
async function publishDevto({ mdPath, dryRun = false }) {
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

  // canonical URL = the official-site original
  let siteDomain = process.env.SITE_DOMAIN || 'www.tengence.com';
  if (!siteDomain.startsWith('http')) siteDomain = `https://www.${siteDomain.replace(/^www\./, '')}`;
  const canonicalUrl = `${siteDomain}/blog/article/${slug}/`;

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
  const devtoTags = [...new Set(derivedTags)].slice(0, 4);
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
      published: false, // draft first; publish after manual review in the dashboard
      canonical_url: canonicalUrl,
      tags: devtoTags.length > 0 ? devtoTags : ['seo', 'marketing'],
      description: fmValue('meta_description') || `Learn about ${title}`,
    }
  };

  console.log('\n🚀 Publishing to Dev.to (draft)...');

  const res = await fetch('https://dev.to/api/articles', {
    method: 'POST',
    headers: {
      'api-key': API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('❌ Publish failed:', res.status, JSON.stringify(data, null, 2));
    throw new Error('DEVTO_API_ERROR');
  }
  console.log(`✅ Success! Dev.to article ID: ${data.id}`);
  console.log(`   Draft link: ${data.url}/edit`);
  console.log(`   Status: draft (log into the Dev.to dashboard, review the content, then click Publish)`);
  return { id: data.id, url: data.url };
}

module.exports = { publishDevto };
