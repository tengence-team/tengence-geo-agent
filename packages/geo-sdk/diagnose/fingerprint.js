/**
 * diagnose/fingerprint.js — CMS / framework / platform / CDN / server detection
 * ============================================================================
 * Deterministic heuristics over response headers + HTML body. Returns a labeled
 * fingerprint; unknown values stay null (absence of evidence ≠ evidence).
 */

function fingerprint(headers = {}, html = '') {
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = String(v);
  const body = String(html || '').toLowerCase();

  const out = {
    server: h['server'] || null,
    poweredBy: h['x-powered-by'] || null,
    cms: null,
    framework: null,
    platform: null,
    cdn: null,
    generator: null,
    signals: [],
  };

  // ---------- server ----------
  const srv = (out.server || '').toLowerCase();
  if (srv.includes('cloudflare')) out.signals.push('server header: Cloudflare');
  if (srv.includes('openresty')) out.signals.push('server header: OpenResty');
  if (srv.includes('nginx')) out.signals.push('server header: nginx');
  if (srv.includes('apache')) out.signals.push('server header: Apache');
  if (srv.includes('microsoft-iis')) out.signals.push('server header: IIS');
  if (srv.includes('gws')) out.signals.push('server header: Google Web Server (GWS)');

  // ---------- CDN / hosting platform (header signals) ----------
  if (h['cf-ray'] || h['cf-cache-status'] || srv.includes('cloudflare')) {
    out.cdn = 'Cloudflare';
  } else if (h['x-amz-cf-id'] || h['x-amz-cf-pop']) {
    out.cdn = 'AWS CloudFront';
  } else if (h['x-nf-request-id'] || h['x-nf-request-id'] !== undefined) {
    out.cdn = 'Netlify';
  } else if (h['x-vercel-id'] || h['x-vercel-cache'] || h['x-vercel-request-id']) {
    out.cdn = 'Vercel';
  } else if ((h['via'] || '').toLowerCase().includes('fastly')) {
    out.cdn = 'Fastly';
  } else if ((h['x-cache'] || '').toLowerCase().includes('hit')) {
    out.cdn = 'CDN (x-cache HIT)';
  } else if (srv.includes('cloudflare')) {
    out.cdn = 'Cloudflare';
  }
  if (h['x-cache-hits']) out.signals.push('CDN-style cache header present (x-cache-hits)');
  if (h['x-cdn'] && !out.cdn) out.cdn = h['x-cdn'];
  if (h['x-sucuri-id']) out.cdn = 'Sucuri';
  if (h['x-qc-cdn'] || srv.includes('qcloud') || srv.includes('tencent')) {
    out.cdn = out.cdn || 'Tencent Cloud CDN';
  }
  if (h['ali-swift-global-savetime'] || h['x-cache'] && srv.includes('tengine')) {
    out.cdn = out.cdn || 'Alibaba Cloud CDN';
  }
  if (h['x-github-request-id'] || /github\.io/.test(body)) {
    out.platform = 'GitHub Pages';
    out.cdn = out.cdn || null;
  }
  if (h['x-served-by'] && /netlify/i.test(h['x-served-by'])) out.platform = 'Netlify';

  // ---------- CMS ----------
  if (/wp-content\/|wp-includes\/|wp-json\/|\/wp-admin\/|wordpress\.com/.test(body)) {
    out.cms = 'WordPress';
    out.signals.push('wp-content/wp-json/wp-includes markers');
  } else if (/wixstatic\.com|wix\.com\/\w+\/v1/.test(body) || /<meta[^>]+name=["']generator["'][^>]*content=["'][^"']*wix/i.test(body)) {
    out.cms = 'Wix';
  } else if (/cdn\.shopify\.com|shopify\.theme|Shopify\.theme/.test(body)) {
    out.cms = 'Shopify';
    out.platform = 'Shopify';
  } else if (/static1\.squarespace\.com|squarespace/i.test(body)) {
    out.cms = 'Squarespace';
    out.platform = 'Squarespace';
  } else if (/joomla/i.test(body)) {
    out.cms = 'Joomla';
  } else if (/drupal/i.test(body)) {
    out.cms = 'Drupal';
  } else if (/ghost\.io|ghost-url/.test(body)) {
    out.cms = 'Ghost';
  }

  // ---------- framework ----------
  if (/_next\/static|__next_data__|next\.js/.test(body)) {
    out.framework = 'Next.js';
  } else if (/__nuxt__|_nuxt\//.test(body)) {
    out.framework = 'Nuxt';
  } else if (/__gatsby|gatsby-/.test(body)) {
    out.framework = 'Gatsby';
  } else if (/data-reactroot|__react|react\.production/i.test(body)) {
    out.framework = 'React';
  } else if (/__vue__|vue\.js|vue\.runtime/i.test(body)) {
    out.framework = 'Vue';
  } else if (/svelte-/.test(body)) {
    out.framework = 'Svelte';
  } else if (/astro-|__astro/i.test(body)) {
    out.framework = 'Astro';
  } else if (/hugo/i.test(body)) {
    out.framework = 'Hugo (static)';
  } else if (/jekyll|jekyll-/.test(body)) {
    out.framework = 'Jekyll (static)';
  } else if (/hexo/i.test(body)) {
    out.framework = 'Hexo (static)';
  }

  // ---------- generator meta ----------
  const gm = /<meta[^>]+name=["']generator["'][^>]*content=["']([^"']+)/i.exec(html || '');
  if (gm) out.generator = gm[1];

  // ---------- compression / transport hints ----------
  out.compression = h['content-encoding'] || null;
  out.cacheControl = h['cache-control'] || null;

  return out;
}

module.exports = { fingerprint };
