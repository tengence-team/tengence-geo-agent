'use strict';
/**
 * WeChat Official-Account sync (tengence-geo-sdk/syndicate/wechat)
 * ============================================================================
 * Sunk down from commands/publish-wechat.js on 2026-09-20: the WeChat API client
 * (token cache / image upload / material upload / draft / mass-send), body cleaning
 * (cleanWechatHtml), single-article preparation (prepareArticle — reads the article
 * from the DB + WP cover + image migration) and the main orchestration all moved
 * into this file. The CLI keeps only argument parsing (--slugs= / single slug),
 * article-count validation (≤8) and credential pre-checks.
 *
 * Env vars (sites/<site>/.env, injected by t.site.loadSite()):
 *   WECHAT_APP_ID / WECHAT_APP_SECRET  official-account credentials
 *
 * Printing stays in the SDK (byte-identical to the original CLI output); fatal
 * errors throw Error, the CLI catches, prints "❌ 失败: …" and exits 1.
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const FormData = require('form-data');
const sharp = require('sharp');

const t = require('../index');
const { renderMarkdownToWechat } = require('@rbbtsn0w/wechat-markdown');

// ==================== WeChat API client ====================

let cachedToken = null;
let tokenExpireAt = 0;

function httpsRequest(url, options = {}, body = null, attempt = 0) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = mod.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, json: JSON.parse(data) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, raw: data });
        }
      });
    });
    // Retry only on transient network/socket errors (the egress proxy in this
    // environment occasionally drops rapid sequential TLS connections). HTTP
    // error responses (e.g. 4xx/5xx) are NOT retried — they are real outcomes.
    req.on('error', (err) => {
      const transient = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'Client network socket disconnected before secure TLS connection was established'];
      const isTransient = transient.some((t) => err.message.includes(t) || err.code === t);
      if (isTransient && attempt < 2) {
        setTimeout(() => resolve(httpsRequest(url, options, body, attempt + 1)), 400 * (attempt + 1));
      } else {
        reject(err);
      }
    });
    req.setTimeout(60000, () => {
      req.destroy();
      const err = new Error('Request timeout: ' + url);
      err.code = 'ETIMEDOUT';
      if (attempt < 2) {
        setTimeout(() => resolve(httpsRequest(url, options, body, attempt + 1)), 400 * (attempt + 1));
      } else {
        reject(err);
      }
    });
    if (body) { req.setHeader('Content-Length', Buffer.byteLength(body)); req.write(body); }
    req.end();
  });
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpireAt - 60000) return cachedToken;
  const WECHAT_APP_ID = process.env.WECHAT_APP_ID;
  const WECHAT_APP_SECRET = process.env.WECHAT_APP_SECRET;
  // Use the stable token endpoint (POST). It is idempotent across all callers when
  // force_refresh=false, so independent processes fetching a token never revoke each
  // other's token — unlike the legacy /cgi-bin/token GET, which rotates and invalidates
  // the prior token on every call (observed live: 40001 after a second caller fetched).
  const url = 'https://api.weixin.qq.com/cgi-bin/stable_token';
  const body = JSON.stringify({
    grant_type: 'client_credential',
    appid: WECHAT_APP_ID,
    secret: WECHAT_APP_SECRET,
    force_refresh: false,
  });
  const { json } = await httpsRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, body);
  if (json.errcode && json.errcode !== 0) {
    throw new Error(`access_token fetch failed: ${json.errcode} ${json.errmsg}`);
  }
  cachedToken = json.access_token;
  tokenExpireAt = Date.now() + (json.expires_in || 7200) * 1000;
  console.log(`  ✅ access_token obtained (valid ${json.expires_in || 7200}s)`);
  return cachedToken;
}

/** Force the next getAccessToken() call to refetch (used after an auth error). */
function clearTokenCache() {
  cachedToken = null;
  tokenExpireAt = 0;
}

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? https : http;
    const req = mod.request(
      { hostname: urlObj.hostname, port: urlObj.port || 443, path: urlObj.pathname + urlObj.search, method: 'GET' },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          downloadImage(res.headers.location).then(resolve).catch(reject);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Download timeout: ' + url)); });
    req.end();
  });
}

async function ensureJpeg(buffer) {
  const info = await sharp(buffer).metadata();
  if (info.format === 'jpeg' || info.format === 'jpg') return buffer;
  return sharp(buffer).jpeg({ quality: 90 }).toBuffer();
}

async function uploadContentImage(accessToken, buffer) {
  const form = new FormData();
  form.append('media', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
  const url = `https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=${accessToken}`;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    form.submit({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST', protocol: 'https:' }, (err, res) => {
      if (err) return reject(err);
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.errcode && json.errcode !== 0) return reject(new Error(`uploadimg failed: ${json.errcode} ${json.errmsg}`));
          resolve(json.url);
        } catch (e) {
          reject(new Error('uploadimg response parse failed: ' + data.slice(0, 200)));
        }
      });
    });
  });
}

async function uploadPermanentMaterial(accessToken, buffer) {
  const form = new FormData();
  form.append('media', buffer, { filename: 'cover.jpg', contentType: 'image/jpeg' });
  const url = `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${accessToken}&type=image`;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    form.submit({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST', protocol: 'https:' }, (err, res) => {
      if (err) return reject(err);
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.errcode && json.errcode !== 0) return reject(new Error(`add_material failed: ${json.errcode} ${json.errmsg}`));
          resolve({ mediaId: json.media_id, url: json.url });
        } catch (e) {
          reject(new Error('add_material response parse failed: ' + data.slice(0, 200)));
        }
      });
    });
  });
}

async function createDraft(accessToken, articles) {
  const body = JSON.stringify({ articles });
  const url = `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${accessToken}`;
  const res = await httpsRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, body);
  const json = res.json || {};
  if (json.errcode && json.errcode !== 0) {
    throw new Error(`draft/add failed: ${json.errcode} ${json.errmsg}`);
  }
  if (!json.media_id) {
    throw new Error(`draft/add returned no media_id (HTTP ${res.statusCode}): ${(res.raw || JSON.stringify(json)).slice(0, 300)}`);
  }
  return json.media_id;
}

async function publishDraft(accessToken, mediaId) {
  const body = JSON.stringify({ media_id: mediaId });
  const url = `https://api.weixin.qq.com/cgi-bin/freepublish/submit?access_token=${accessToken}`;
  const { json } = await httpsRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, body);
  if (json.errcode && json.errcode !== 0) {
    throw new Error(`freepublish/submit failed: ${json.errcode} ${json.errmsg}`);
  }
  return json;
}

/**
 * Publish an existing draft box media_id to the account homepage via
 * freepublish/submit (NO push to followers — the draft is consumed and moves to
 * the published list). dryRun=true prints the payload without calling the API.
 */
async function publishDraftByMediaId(mediaId, { dryRun = false, request = httpsRequest, accessToken: injectedToken } = {}) {
  if (!mediaId) throw new Error('publishDraftByMediaId requires mediaId');
  const body = { media_id: mediaId };
  if (dryRun) {
    console.log(`[dry-run] freepublish/submit payload: ${JSON.stringify(body, null, 2)}`);
    return { dryRun: true, payload: body };
  }
  const accessToken = injectedToken || await getAccessToken();
  const url = `https://api.weixin.qq.com/cgi-bin/freepublish/submit?access_token=${accessToken}`;
  const { json } = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify(body));
  if (json.errcode && json.errcode !== 0) {
    throw new Error(`freepublish/submit failed: ${json.errcode} ${json.errmsg}`);
  }
  return { dryRun: false, publishId: json.publish_id, response: json };
}

// ==================== Article processing ====================

/**
 * NOTE: everything below matches against Chinese WeChat article HTML (tables →
 * cards, "立即行动" CTA removal, "相关阅读" truncation, the "阅读原文" footer copy,
 * etc.). These are functional anchors and reader-facing content of the Chinese
 * official account, and must stay as-is.
 */
function cleanWechatHtml(html) {
  let out = String(html || '');

  // tables → card style (first column bold as the title, later columns on their own lines)
  out = out.replace(/<table[^>]*>[\s\S]*?<\/table>/gi, (table) => {
    const rows = [];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr;
    let isHeader = true;
    while ((tr = trRe.exec(table)) !== null) {
      const cells = [];
      const tdRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
      let td;
      while ((td = tdRe.exec(tr[1])) !== null) {
        cells.push(td[1].trim());
      }
      if (!cells.length) continue;
      if (isHeader) {
        // header row: light-blue background as the title bar
        const headerCells = cells.map((c, i) =>
          `<div style="${i===0 ? 'font-weight:bold;color:#0055FF;' : 'color:#666;'}${i>0?'margin-top:4px;':''}">${c}</div>`
        ).join('');
        rows.push(`<section style="padding:10px 12px;background:#eef3ff;border-radius:6px;margin:12px 0 0;">${headerCells}</section>`);
        isHeader = false;
      } else {
        // data row: first column bold, later columns on their own lines
        const label = cells[0].replace(/<[^>]+>/g, '');
        const bodyCells = cells.slice(1).map((c, i) =>
          `<div style="margin-top:6px;color:#333;">${c}</div>`
        ).join('');
        rows.push(`<section style="padding:12px;background:#f9f9f9;border-radius:6px;margin:0 0 8px;">
          <div style="font-weight:bold;color:#1a1a1a;">${label}</div>
          ${bodyCells}
        </section>`);
      }
    }
    return rows.join('');
  });

  // remove class attributes
  out = out.replace(/\sclass="[^"]*"/gi, '');

  // strip all <a> tags (the WeChat subscription-account API auto-filters external
  // links; keep the text)
  out = out.replace(/<a\s[^>]*>([\s\S]*?)<\/a>/gi, '$1');

  // remove the leading H1 (the WeChat draft already has the title on top)
  out = out.replace(/^<h1[^>]*>[\s\S]*?<\/h1>/i, '');

  // remove the "立即行动" CTA paragraph (CTA can't carry links, useless) — matches
  // <p><strong>立即行动</strong>...</p>
  out = out.replace(/<p[^>]*><strong>立即行动<\/strong>[\s\S]*?<\/p>/i, '');
  // compatibility: also if it's an h2 form
  out = out.replace(/<h2[^>]*>立即行动[\s\S]*$/i, '');

  // h2 → second-level heading (with a blue left bar)
  out = out.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi,
    '<section style="font-size:18px;font-weight:bold;color:#1a1a1a;margin:28px 0 14px;padding-left:12px;border-left:4px solid #0055FF;line-height:1.4;">$1</section>');

  // h3 → third-level heading
  out = out.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi,
    '<section style="font-size:16px;font-weight:bold;color:#333;margin:22px 0 10px;line-height:1.4;">$1</section>');

  // h4-h6 → bold paragraphs
  out = out.replace(/<h[456][^>]*>([\s\S]*?)<\/h[456]>/gi,
    '<section style="font-size:15px;font-weight:bold;color:#333;margin:18px 0 8px;line-height:1.6;">$1</section>');

  // normal paragraphs get line height and spacing
  out = out.replace(/<p>([\s\S]*?)<\/p>/gi,
    '<p style="font-size:15px;color:#333;line-height:1.75;margin:16px 0;letter-spacing:0.5px;">$1</p>');

  // collapse newlines between blockquotes (extra blank lines from FAQ blocks)
  out = out.replace(/(<\/blockquote>)\s*(<blockquote[^>]*>)/gi, '$1$2');

  // quote blocks get a left border and background
  out = out.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
    '<blockquote style="margin:8px 0;padding:12px 16px;border-left:3px solid #0055FF;background:#f5f8ff;color:#555;font-size:14px;line-height:1.7;">$1</blockquote>');

  // list items get line height
  out = out.replace(/<li>/gi, '<li style="margin:4px 0;line-height:1.8;">');

  // collapse newlines inside lists
  out = out.replace(/(<ul[^>]*>)([\s\S]*?)(<\/ul>)/gi, (m, open, inner, close) => {
    return open + inner.replace(/\n\s*/g, '') + close;
  });
  out = out.replace(/(<ol[^>]*>)([\s\S]*?)(<\/ol>)/gi, (m, open, inner, close) => {
    return open + inner.replace(/\n\s*/g, '') + close;
  });

  // code blocks get a gray background
  out = out.replace(/<pre>([\s\S]*?)<\/pre>/gi,
    '<pre style="background:#f6f8fa;padding:12px 16px;border-radius:6px;font-size:13px;line-height:1.6;overflow-x:auto;color:#333;margin:16px 0;">$1</pre>');

  // inline code
  out = out.replace(/<code>([^<]+)<\/code>/gi,
    '<code style="background:#f0f0f0;padding:2px 6px;border-radius:3px;font-size:13px;color:#d63384;">$1</code>');

  // images centered + max width
  out = out.replace(/<img([^>]*)src="([^"]*)"([^>]*)>/gi,
    '<img$1src="$2"$3 style="max-width:100%;height:auto;display:block;margin:16px auto;border-radius:6px;">');

  // dividers
  out = out.replace(/<hr\s*\/>?/gi,
    '<hr style="border:none;border-top:1px solid #e0e0e0;margin:24px 0;">');

  // reader-guide footer (Chinese reader-facing copy, kept as-is)
  out += '<section style="margin-top:32px;padding:16px;background:#f5f8ff;border-radius:8px;text-align:center;color:#666;font-size:14px;">本文完整版及更多案例，请点击下方「阅读原文」访问 Tengence 官网</section>';

  // wrap the whole thing in a section
  out = '<section style="font-size:15px;color:#333;line-height:1.75;">' + out + '</section>';

  return out;
}

async function prepareArticle(conn, slug, siteDomain, overrides = {}) {
  const APP_ID = process.env.APP_ID || '1';

  console.log(`\n📄 Processing article: ${slug}`);

  const detail = await t.db.articles.getDetail(conn, APP_ID, slug);
  if (!detail) throw new Error(`Article not found: ${slug}`);

  const articleId = detail.id;
  const title = overrides.titleOverride || detail.title;
  let mdContent = overrides.contentMdOverride != null ? overrides.contentMdOverride : (detail.content_longtext || detail.content || '');

  // Since 2026-09-20: the DB is the single source of truth (local md moved to data/
  // and no longer participates); the body is guaranteed non-empty
  if (!mdContent.trim()) {
    throw new Error(`Article ${slug} has an empty DB body (not ingested? run article-ingest first)`);
  }

  // parse front matter
  const { data: fm, content: mdBodyRaw } = t.content.md.parseFrontMatter(mdContent);
  let mdBody = mdBodyRaw;

  // cover image: prefer the WP media library
  const config = await t.db.config.getFull(conn, articleId, APP_ID);
  let featuredImage = null;
  if (detail.wp_post_id) {
    try {
      const wpPost = await t.wp.posts.get(detail.wp_post_id);
      if (wpPost.featured_media) {
        const mediaRes = await t.wp.api(`/media/${wpPost.featured_media}?_fields=source_url`);
        if (mediaRes && mediaRes.source_url) {
          featuredImage = mediaRes.source_url;
          console.log(`  Cover source: WP media library`);
        }
      }
    } catch (e) {
      console.warn(`  ⚠️ Cover lookup from WP failed: ${e.message}`);
    }
  }
  if (!featuredImage) {
    featuredImage = (fm && fm.featured_image) || config.featured_image || null;
  }

  // replace Unsplash image URLs in the markdown with tengence.com CDN URLs
  // (CN-accessible); use the WP featured_image as the body's leading image (it's
  // already on the tengence.com CDN)
  if (detail.featured_image) {
    mdBody = mdBody.replace(/(!\[[^\]]*\]\()https:\/\/images\.unsplash\.com\/[^)]+\)/g,
      `$1${detail.featured_image})`);
  }

  // extract all image URLs from the body
  const images = t.content.md.extractAnyImageUrls(mdBody);
  console.log(`  Body images: ${images.length}`);

  const accessToken = await getAccessToken();

  // upload all body images to the WeChat CDN first, building a URL map
  const imageMap = {};
  for (const img of images) {
    try {
      console.log(`  Uploading image: ${img.originalUrl.slice(0, 80)}...`);
      const buf = await downloadImage(img.originalUrl);
      const jpegBuf = await ensureJpeg(buf);
      const wxUrl = await uploadContentImage(accessToken, jpegBuf);
      imageMap[img.originalUrl] = wxUrl;
      if (img.originalUrl.includes('?')) {
        const baseUrl = img.originalUrl.split('?')[0];
        imageMap[baseUrl] = wxUrl;
      }
    } catch (e) {
      console.warn(`  ⚠️ Image upload failed (original link kept): ${img.originalUrl.slice(0, 80)} — ${e.message}`);
    }
  }

  // Markdown → HTML (uses the project's marked, then WeChat adaptation)
  let html = t.content.md.markdownToHtml(mdBody);

  // replace image srcs in the HTML with the WeChat CDN URLs
  for (const [origUrl, wxUrl] of Object.entries(imageMap)) {
    html = html.split(origUrl).join(wxUrl);
  }

  // post-processing: remove the leading H1 (the WeChat draft already has the title)
  html = html.replace(/^<h1[^>]*>[\s\S]*?<\/h1>/i, '');

  // post-processing: remove all class attributes
  html = html.replace(/\sclass="[^"]*"/gi, '');

  // post-processing: strip all <a> tags, keep the text (the WeChat subscription-account
  // API strips them anyway)
  html = html.replace(/<a\s[^>]*>([\s\S]*?)<\/a>/gi, '$1');

  // post-processing: collapse newlines inside lists (WeChat renders newlines between
  // li as empty list items)
  html = html.replace(/(<ul[^>]*>)[\s\S]*?(<\/ul>)/gi, (m, open, close) => {
    const inner = m.replace(open, '').replace(close, '');
    return open + inner.replace(/\n/g, '') + close;
  });
  html = html.replace(/(<ol[^>]*>)[\s\S]*?(<\/ol>)/gi, (m, open, close) => {
    const inner = m.replace(open, '').replace(close, '');
    return open + inner.replace(/\n/g, '') + close;
  });

  // post-processing: remove the "立即行动" section (truncate from its block-level
  // tag to the end)
  {
    const ctaIdx = html.indexOf('立即行动');
    if (ctaIdx !== -1) {
      // find both <h2 and <p, take the one closer to "立即行动"
      const h2Start = html.lastIndexOf('<h2', ctaIdx);
      const pStart = html.lastIndexOf('<p', ctaIdx);
      const start = Math.max(h2Start, pStart);
      if (start !== -1 && start < ctaIdx) {
        html = html.substring(0, start);
      }
    }
  }

  // post-processing: remove "相关阅读" and everything after (keeps "关于Tengence";
  // supports both h2 and p forms)
  {
    const relIdx = html.indexOf('相关阅读');
    if (relIdx !== -1) {
      const h2Start = html.lastIndexOf('<h2', relIdx);
      const pStart = html.lastIndexOf('<p', relIdx);
      const start = Math.max(h2Start, pStart);
      if (start !== -1 && start < relIdx) {
        html = html.substring(0, start);
      }
    }
  }

  // post-processing: compact inline styles
  html = html.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi,
    '<p style="margin:0 0 12px;font-size:15px;line-height:1.75;color:#333;">$1</p>');
  html = html.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi,
    '<section style="font-size:18px;font-weight:bold;color:#1a1a1a;margin:24px 0 12px;padding-left:10px;border-left:3px solid #0055FF;line-height:1.4;">$1</section>');
  html = html.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi,
    '<section style="font-size:16px;font-weight:bold;color:#333;margin:18px 0 8px;line-height:1.4;">$1</section>');
  html = html.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
    '<section style="margin:12px 0;padding:10px 14px;border-left:3px solid #0055FF;background:#f5f8ff;color:#555;font-size:14px;line-height:1.7;">$1</section>');
  html = html.replace(/<ul[^>]*>/gi, '<ul style="margin:8px 0;padding-left:20px;">');
  html = html.replace(/<ol[^>]*>/gi, '<ol style="margin:8px 0;padding-left:20px;">');
  html = html.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi,
    '<li style="margin:4px 0;line-height:1.7;color:#333;">$1</li>');
  // tables: remove thead/tbody tags (WeChat renders thead with blank lines); the
  // header row goes straight into tbody
  html = html.replace(/<thead>/gi, '').replace(/<\/thead>/gi, '');
  html = html.replace(/<tbody>/gi, '').replace(/<\/tbody>/gi, '');
  // tables: keep horizontal tables, add borders and inline styles
  html = html.replace(/<table[^>]*>/gi, '<table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:14px;">');
  html = html.replace(/<th[^>]*>([\s\S]*?)<\/th>/gi,
    '<th style="border:1px solid #ddd;padding:6px 10px;background:#f5f8ff;text-align:left;font-weight:bold;">$1</th>');
  html = html.replace(/<td[^>]*>([\s\S]*?)<\/td>/gi,
    '<td style="border:1px solid #ddd;padding:6px 10px;">$1</td>');
  // images centered with rounded corners
  html = html.replace(/<img([^>]*)>/gi, '<img$1 style="max-width:100%;border-radius:6px;margin:8px auto;display:block;">');

  // move the first body image to the top of the article
  {
    const imgMatch = html.match(/<p[^>]*><img[^>]*><\/p>/i);
    if (imgMatch) {
      const imgBlock = imgMatch[0];
      html = html.replace(imgBlock, '');
      const firstH2 = html.search(/<section[^>]*font-size:18px/i);
      if (firstH2 !== -1) {
        html = html.substring(0, firstH2) + imgBlock + html.substring(firstH2);
      } else {
        html = imgBlock + html;
      }
    }
  }

  // outer wrapper
  html = '<section style="font-size:15px;color:#333;line-height:1.75;">' + html + '</section>';

  // reader-guide footer (Chinese reader-facing copy, kept as-is)
  html += '<section style="margin-top:24px;padding:12px;background:#f5f8ff;border-radius:6px;text-align:center;color:#888;font-size:13px;">本文完整版请点击「阅读原文」访问 Tengence 官网</section>';

  // upload the cover
  let thumbMediaId = '';
  if (featuredImage) {
    console.log(`  Uploading cover: ${featuredImage.slice(0, 80)}...`);
    try {
      const coverBuf = await downloadImage(featuredImage);
      const coverJpeg = await ensureJpeg(coverBuf);
      const cover = await uploadPermanentMaterial(accessToken, coverJpeg);
      thumbMediaId = cover.mediaId;
    } catch (e) {
      console.warn(`  ⚠️ Cover upload failed: ${e.message}`);
    }
  }
  if (!thumbMediaId) {
    throw new Error(`Article ${slug} has no featured image; cannot create a draft`);
  }

  // digest
  let digest = '';
  if (detail.excerpt) {
    digest = detail.excerpt;
  } else if (fm && fm.seo && fm.seo.meta_description) {
    digest = fm.seo.meta_description;
  } else {
    digest = t.content.md.makeDescription(mdBody, 120);
  }
  digest = digest.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);

  const sourceUrl = `https://${siteDomain}/blog/article/${slug}/`;

  return {
    title: title,
    author: 'Tengence',
    digest: digest,
    content: html,
    content_source_url: sourceUrl,
    thumb_media_id: thumbMediaId,
    show_cover_pic: 1,
    need_open_comment: 0,
    only_fans_can_comment: 0,
  };
}

// ==================== Logging ====================

function appendLog(entry, LOG_DIR, LOG_FILE) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
}

// ==================== Main flow ====================

/**
 * Sync articles to the WeChat official-account draft box (--publish mass-sends
 * directly)
 * @param {{slugs:string[], dryRun?:boolean, shouldPublish?:boolean, siteKey?:string, keepOrder?:boolean}} opts
 *   keepOrder=true keeps the given slug order (the 1st article becomes the
 *   headline of a multi-article message) instead of sorting by publish time;
 *   default false keeps the historical newest→oldest behavior.
 * @returns {Promise<{mediaId?:string, action:'draft'|'publish'}>}
 * @throws article not found / no featured image / WeChat API error (the CLI catches
 *         and exits 1)
 */
async function syncWechat({ slugs, dryRun = false, shouldPublish = false, siteKey, keepOrder = false }) {
  const SITE = t.site.loadSite(siteKey);
  const SITE_DOMAIN = (process.env.SITE_DOMAIN || (SITE.site && SITE.site.site && SITE.site.site.domain) || 'www.tengence.com').replace(/^https?:\/\//, '').replace(/^www\./, 'www.');
  const LOG_DIR = path.join(SITE.siteDir, 'data');
  const LOG_FILE = path.join(LOG_DIR, 'wechat-log.jsonl');

  console.log('='.repeat(60));
  console.log(`WeChat Official-Account sync (${slugs.length} articles)`);
  console.log('='.repeat(60));

  let mediaId = null;
  let action = 'draft';

  await t.db.withConn(async (conn) => {
    // sort by publish time descending unless keepOrder is set (1st slug = headline)
    const articlesMeta = [];
    for (const slug of slugs) {
      const detail = await t.db.articles.getDetail(conn, process.env.APP_ID || '1', slug);
      if (!detail) throw new Error(`Article not found: ${slug}`);
      articlesMeta.push({ slug, publishedAt: detail.published_at || detail.lastmod || 0 });
    }
    if (!keepOrder) {
      articlesMeta.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    }
    const sortedSlugs = keepOrder ? slugs.slice() : articlesMeta.map((a) => a.slug);

    console.log(`\nSend order (${keepOrder ? 'as given, 1st is headline' : 'newest → oldest'}): ${sortedSlugs.join(' → ')}`);

    if (dryRun) {
      for (const slug of sortedSlugs) {
        const detail = await t.db.articles.getDetail(conn, process.env.APP_ID || '1', slug);
        console.log(`  - ${slug} | ${detail.title}`);
      }
      console.log('\n[dry-run] done');
      return;
    }

    const articles = [];
    for (const slug of sortedSlugs) {
      const article = await prepareArticle(conn, slug, SITE_DOMAIN);
      article._slug = slug;
      articles.push(article);
    }

    console.log('\n📝 Creating the WeChat draft box entry...');
    const accessToken = await getAccessToken();
    const draftArticles = articles.map(({ _slug, ...rest }) => rest);
    mediaId = await createDraft(accessToken, draftArticles);

    console.log(`\n✅ Draft created! media_id: ${mediaId}`);
    console.log(`   Draft box: https://mp.weixin.qq.com/ → 草稿箱`);
    console.log(`   Preview the layout in the dashboard and mass-send manually, or add --publish to publish directly.`);

    if (shouldPublish) {
      console.log('\n🚀 Publishing directly (mass send)...');
      const result = await publishDraft(accessToken, mediaId);
      console.log(`✅ Publish submitted: ${JSON.stringify(result)}`);
      appendLog({ time: new Date().toISOString(), action: 'publish', slugs: sortedSlugs, mediaId, result }, LOG_DIR, LOG_FILE);
      action = 'publish';
    } else {
      appendLog({ time: new Date().toISOString(), action: 'draft', slugs: sortedSlugs, mediaId }, LOG_DIR, LOG_FILE);
    }

    console.log(`\n📋 Log written: ${LOG_FILE}`);
  });

  return { mediaId, action };
}

// ==================== Read-back / progress reconciliation ====================

/**
 * List the draft box (draft/batchget): every draft's media_id + article titles.
 * Paginated (offset/count=20) until total_count is reached.
 * @returns {Promise<Array<{media_id:string, update_time:number, titles:string[]}>>}
 */
async function listDrafts() {
  const accessToken = await getAccessToken();
  const items = [];
  const count = 20;
  let offset = 0;
  for (;;) {
    const body = JSON.stringify({ offset, count, no_content: 1 });
    const url = `https://api.weixin.qq.com/cgi-bin/draft/batchget?access_token=${accessToken}`;
    const { json } = await httpsRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, body);
    if (json.errcode && json.errcode !== 0) {
      throw new Error(`draft/batchget failed: ${json.errcode} ${json.errmsg}`);
    }
    for (const it of json.item || []) {
      items.push({
        media_id: it.media_id,
        update_time: it.update_time,
        titles: ((it.content || {}).news_item || []).map((n) => n.title),
      });
    }
    if (items.length >= json.total_count || !json.item || json.item.length === 0) break;
    offset += count;
  }
  return items;
}

/**
 * List mass-sent articles (freepublish/batchget): article_id + titles.
 * @returns {Promise<Array<{article_id:string, update_time:number, titles:string[]}>>}
 */
async function listPublished() {
  const accessToken = await getAccessToken();
  const items = [];
  const count = 20;
  let offset = 0;
  for (;;) {
    const body = JSON.stringify({ offset, count, no_content: 1 });
    const url = `https://api.weixin.qq.com/cgi-bin/freepublish/batchget?access_token=${accessToken}`;
    const { json } = await httpsRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, body);
    if (json.errcode && json.errcode !== 0) {
      throw new Error(`freepublish/batchget failed: ${json.errcode} ${json.errmsg}`);
    }
    for (const it of json.item || []) {
      items.push({
        article_id: it.article_id,
        update_time: it.update_time,
        titles: ((it.content || {}).news_item || []).map((n) => n.title),
      });
    }
    if (items.length >= json.total_count || !json.item || json.item.length === 0) break;
    offset += count;
  }
  return items;
}

/**
 * Reconcile the channel_plan calendar with the real WeChat backend:
 *   - draft rows whose media_id IS in the draft box → keep draft;
 *   - draft rows whose titles appear in freepublish → upgrade to published;
 *   - draft rows whose media_id is missing AND not found in freepublish →
 *     UNCERTAIN (no auto-write): WeChat provides no API for mass-sent
 *     (push-notification) records, so a missing draft may mean "already
 *     mass-sent manually" as well as "never created". Rollback to todo would
 *     re-queue a published issue and risk a duplicate mass-send, so these rows
 *     are reported for manual confirmation instead.
 *   - published rows are never downgraded (title match only confirms them).
 * `fetchers` is an injection seam for tests ({listDrafts, listPublished}).
 * @returns {Promise<{ok:boolean, dryRun:boolean, report:Object}>}
 */
async function syncProgressFromWechat({ siteKey, dryRun = false, fetchers } = {}) {
  const SITE = t.site.loadSite(siteKey);
  const f = fetchers || { listDrafts, listPublished };
  const drafts = await f.listDrafts();
  const published = await f.listPublished();
  const draftIds = new Set(drafts.map((d) => d.media_id));
  const publishedTitles = new Set(published.flatMap((p) => p.titles));

  const rows = await t.plan.channel.list({ platform: 'wechat' });
  const report = { site: SITE.siteKey, drafts: drafts.length, published: published.length, changes: [], unchanged: [], uncertain: [] };

  await t.db.withConn(async (conn) => {
    for (const row of rows) {
      const titles = [];
      for (const slug of row.article_slugs) {
        try {
          const detail = await t.db.articles.getDetail(conn, process.env.APP_ID || '1', slug);
          if (detail && detail.title) titles.push(detail.title);
        } catch (_) { /* article missing → skip */ }
      }
      const matchedDraft = row.draft_ids.some((id) => draftIds.has(id));
      const matchedPublished = titles.some((title) => publishedTitles.has(title));

      if (row.status === 'draft') {
        if (matchedDraft) {
          report.unchanged.push({ id: row.id, period: row.period, status: 'draft', reason: 'draft media_id exists in the draft box' });
        } else if (matchedPublished) {
          if (!dryRun) await t.plan.channel.markStatus(row.id, 'published', row.draft_ids);
          report.changes.push({ id: row.id, period: row.period, from: 'draft', to: 'published', reason: 'already mass-sent (title matched in freepublish list)' });
        } else {
          report.uncertain.push({
            id: row.id,
            period: row.period,
            status: 'draft',
            reason:
              'draft media_id missing from the draft box and no freepublish record — ' +
              'WeChat exposes no API for mass-sent (push) records, so the issue may have been ' +
              'mass-sent manually. NOT auto-modified; confirm with the mp.weixin.qq.com 发表记录.',
          });
        }
      } else if (row.status === 'published') {
        report.unchanged.push({
          id: row.id,
          period: row.period,
          status: 'published',
          reason: matchedPublished ? 'confirmed in the publish list' : 'kept (published rows are never downgraded)',
        });
      } else {
        report.unchanged.push({ id: row.id, period: row.period, status: row.status, reason: 'no change' });
      }
    }
  });

  return { ok: true, dryRun, report };
}

// ==================== Mass-send / preview / delete (push capabilities) ====================

/**
 * Mass-send (push) a draft to followers.
 * Routes: all followers or one tag → message/mass/sendall; specific openids →
 * message/mass/send. The mpnews media_id is the DRAFT media_id (draft/add) —
 * after a successful send the draft is consumed (auto-deleted from the draft box).
 * Subscription accounts get 1 mass-send per day; if "风险操作保护" is enabled in the
 * backend, the admin must confirm the send before it really goes out.
 * dryRun=true only builds & prints the payload (nothing is sent).
 * `request` is an injection seam for tests.
 * @returns {Promise<{dryRun:boolean, msgId?:string, payload?:Object, response?:Object}>}
 */
async function massSend(mediaId, { tagId, toUsers, clientMsgId, dryRun = false, request = httpsRequest, accessToken: injectedToken } = {}) {
  if (!mediaId) throw new Error('massSend requires mediaId (a draft box media_id)');
  const base = { mpnews: { media_id: mediaId }, msgtype: 'mpnews', send_ignore_reprint: 1 };
  if (clientMsgId) base.clientmsgid = clientMsgId;
  let url;
  let body;
  if (toUsers && toUsers.length) {
    url = `https://api.weixin.qq.com/cgi-bin/message/mass/send?access_token=TOKEN`;
    body = { ...base, touser: toUsers };
  } else if (tagId) {
    url = `https://api.weixin.qq.com/cgi-bin/message/mass/sendall?access_token=TOKEN`;
    body = { ...base, filter: { is_to_all: false, tag_id: Number(tagId) } };
  } else {
    url = `https://api.weixin.qq.com/cgi-bin/message/mass/sendall?access_token=TOKEN`;
    body = { ...base, filter: { is_to_all: true } };
  }
  if (dryRun) {
    console.log(`[dry-run] massSend payload: ${JSON.stringify(body, null, 2)}`);
    return { dryRun: true, payload: body };
  }
  const accessToken = injectedToken || await getAccessToken();
  url = url.replace('TOKEN', accessToken);
  const { json } = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify(body));
  if (json.errcode && json.errcode !== 0) {
    throw new Error(`message/mass/send failed: ${json.errcode} ${json.errmsg}`);
  }
  return { dryRun: false, msgId: json.msg_id, msgDataId: json.msg_data_id, response: json };
}

/**
 * Preview a draft by sending it to one user (message/mass/preview — verified
 * accounts). touser (openid) or wxname; wxname requires the user to have
 * interacted with the account.
 * @returns {Promise<{msgId?:string, response?:Object}>}
 */
async function massPreview(mediaId, { openid, wxname, dryRun = false, request = httpsRequest, accessToken: injectedToken } = {}) {
  if (!mediaId) throw new Error('massPreview requires mediaId');
  if (!openid && !wxname) throw new Error('massPreview requires openid or wxname');
  const body = {
    ...(openid ? { touser: openid } : { towxname: wxname }),
    mpnews: { media_id: mediaId },
    msgtype: 'mpnews',
  };
  if (dryRun) {
    console.log(`[dry-run] massPreview payload: ${JSON.stringify(body, null, 2)}`);
    return { dryRun: true, payload: body };
  }
  const accessToken = injectedToken || await getAccessToken();
  const url = `https://api.weixin.qq.com/cgi-bin/message/mass/preview?access_token=${accessToken}`;
  const { json } = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify(body));
  if (json.errcode && json.errcode !== 0) {
    throw new Error(`message/mass/preview failed: ${json.errcode} ${json.errmsg}`);
  }
  return { dryRun: false, msgId: json.msg_id, response: json };
}

/**
 * Query a mass-send task status (message/mass/get).
 * @returns {Promise<{status?:string, counts?:Object, response?:Object}>}
 */
async function massStatus(msgId, { request = httpsRequest, accessToken: injectedToken } = {}) {
  if (!msgId) throw new Error('massStatus requires msgId');
  const accessToken = injectedToken || await getAccessToken();
  const url = `https://api.weixin.qq.com/cgi-bin/message/mass/get?access_token=${accessToken}`;
  const { json } = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify({ msg_id: msgId }));
  if (json.errcode && json.errcode !== 0) {
    throw new Error(`message/mass/get failed: ${json.errcode} ${json.errmsg}`);
  }
  return {
    msgId,
    status: json.msg_status,
    counts: { total: json.total_count, filter: json.filter_count, sent: json.sent_count, error: json.error_count },
    response: json,
  };
}

/**
 * Delete a mass-send record/task (message/mass/delete).
 * @returns {Promise<{response?:Object}>}
 */
async function massDelete(msgId, { dryRun = false, request = httpsRequest, accessToken: injectedToken } = {}) {
  if (!msgId) throw new Error('massDelete requires msgId');
  const body = { msg_id: msgId };
  if (dryRun) {
    console.log(`[dry-run] massDelete payload: ${JSON.stringify(body, null, 2)}`);
    return { dryRun: true, payload: body };
  }
  const accessToken = injectedToken || await getAccessToken();
  const url = `https://api.weixin.qq.com/cgi-bin/message/mass/delete?access_token=${accessToken}`;
  const { json } = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify(body));
  if (json.errcode && json.errcode !== 0) {
    throw new Error(`message/mass/delete failed: ${json.errcode} ${json.errmsg}`);
  }
  return { dryRun: false, response: json };
}

/**
 * Delete a published article (freepublish/delete) — IRREVERSIBLE.
 * article_id comes from freepublish/batchget; index (1-based) deletes a single
 * article of a multi-article message (omit to delete the whole message).
 * @returns {Promise<{response?:Object}>}
 */
async function deletePublished(articleId, { index, dryRun = false, request = httpsRequest, accessToken: injectedToken } = {}) {
  if (!articleId) throw new Error('deletePublished requires articleId');
  const body = { article_id: articleId };
  if (index) body.index = Number(index);
  if (dryRun) {
    console.log(`[dry-run] deletePublished payload: ${JSON.stringify(body, null, 2)}`);
    return { dryRun: true, payload: body };
  }
  const accessToken = injectedToken || await getAccessToken();
  const url = `https://api.weixin.qq.com/cgi-bin/freepublish/delete?access_token=${accessToken}`;
  const { json } = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify(body));
  if (json.errcode && json.errcode !== 0) {
    throw new Error(`freepublish/delete failed: ${json.errcode} ${json.errmsg}`);
  }
  return { dryRun: false, response: json };
}

// ==================== 数据统计 (datacube) ====================
/**
 * Official-account statistics (cgi-bin/datacube/*), read-only.
 *
 * Constraints enforced by WeChat (verified against the official docs):
 *   - every endpoint is POST with { begin_date, end_date } in the JSON body;
 *   - the span between begin_date and end_date must be <= 7 days;
 *   - data is T+1: the latest usable end_date is yesterday (Beijing time),
 *     so the default window is the 7 days ending yesterday;
 *   - requires 用户分析 / 图文分析 permissions (认证公众号). An unauthorised
 *     account returns errcode 48001 (api unauthorized) — surfaced verbatim.
 *
 * Raw rows are returned untouched (field names differ per endpoint); only the
 * resolved window and endpoint are added as metadata.
 */
// WeChat's datacube family is served at api.weixin.qq.com/datacube/* WITHOUT the
// /cgi-bin/ prefix. The /cgi-bin/datacube/* variant is rejected (HTTP 404, empty
// body) by the egress proxy in this environment, so getStats deliberately omits
// it. The legacy article/user-read/share endpoints (getarticletotal / getuserread
// / getusershare) now return errcode 47009 "api offline" — replaced below by the
// new "发表内容" APIs (getbizsummary / getarticleread / getarticleshare /
// getarticletotaldetail). Verified live on 2026-09-25.
const STATS_ENDPOINTS = {
  user_summary: 'datacube/getusersummary',
  user_cumulate: 'datacube/getusercumulate',
  upstream_msg: 'datacube/getupstreammsg',
  interface_summary: 'datacube/getinterfacesummary',
  biz_summary: 'datacube/getbizsummary',
  article_read: 'datacube/getarticleread',
  article_share: 'datacube/getarticleshare',
  article_detail: 'datacube/getarticletotaldetail',
};
/** Per-action query constraints (verified against WeChat docs + live probes):
 *  - maxSpan: max allowed (end - begin + 1) days;
 *  - singleDay: if true, begin_date must equal end_date (the new per-article
 *    "发表内容" APIs accept only a single day per call). */
const STATS_CONSTRAINTS = {
  user_summary: { maxSpan: 7 },
  user_cumulate: { maxSpan: 7 },
  upstream_msg: { maxSpan: 7 },
  interface_summary: { maxSpan: 30 },
  biz_summary: { maxSpan: 30 },
  article_read: { maxSpan: 1, singleDay: true },
  article_share: { maxSpan: 1, singleDay: true },
  article_detail: { maxSpan: 1, singleDay: true },
};
/** Max allowed span between begin_date and end_date (WeChat limit, fallback). */
const STATS_MAX_SPAN_DAYS = 7;

/** Beijing-time (UTC+8) calendar day of an ISO timestamp, as YYYY-MM-DD. */
function beijingDay(iso) {
  return new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Calendar-day difference b - a, both YYYY-MM-DD (pure date math, no ICU). */
function dayDiff(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** Shift a YYYY-MM-DD by n days (n negative = backwards). */
function shiftDay(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

/**
 * Resolve the query window: defaults to the 7 days ending yesterday (Beijing),
 * because datacube data is T+1 and never includes today. Honors per-action
 * constraints (maxSpan / singleDay) from STATS_CONSTRAINTS.
 * @param {string} [beginDate]
 * @param {string} [endDate]
 * @param {{maxSpan?:number, singleDay?:boolean}} [constraint]
 * @returns {{begin_date:string, end_date:string}}
 */
function resolveStatsRange(beginDate, endDate, constraint = {}) {
  const maxSpan = constraint.maxSpan || STATS_MAX_SPAN_DAYS;
  const singleDay = !!constraint.singleDay;
  const end = endDate || shiftDay(beijingDay(new Date().toISOString()), -1);
  let begin = beginDate || shiftDay(end, -(maxSpan - 1));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(begin) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error('Invalid date format: begin_date / end_date must be YYYY-MM-DD');
  }
  if (dayDiff(begin, end) < 0) {
    throw new Error(`begin_date (${begin}) must not be later than end_date (${end})`);
  }
  if (singleDay) {
    // New per-article APIs accept only begin_date === end_date.
    begin = end;
  } else if (dayDiff(begin, end) + 1 > maxSpan) {
    throw new Error(`Date span must be <= ${maxSpan} days (got ${dayDiff(begin, end) + 1}: ${begin} → ${end})`);
  }
  return { begin_date: begin, end_date: end };
}

/**
 * Read one statistics report from the official-account backend.
 * @param {string} action one of STATS_ENDPOINTS keys
 * @param {{beginDate?:string, endDate?:string}} [range]
 * @returns {Promise<{action:string, endpoint:string, begin_date:string, end_date:string, list:Array, is_delay?:boolean}>}
 */
async function getStats(action, { beginDate, endDate } = {}) {
  const endpoint = STATS_ENDPOINTS[action];
  if (!endpoint) {
    throw new Error(`Unknown stats action: ${action}. Available: ${Object.keys(STATS_ENDPOINTS).join(', ')}`);
  }
  const constraint = STATS_CONSTRAINTS[action] || {};
  const { begin_date, end_date } = resolveStatsRange(beginDate, endDate, constraint);
  const accessToken = await getAccessToken();
  // datacube is served at api.weixin.qq.com/<endpoint> (NO /cgi-bin/ prefix —
  // the /cgi-bin/datacube/* variant is blocked by the egress proxy here).
  const url = `https://api.weixin.qq.com/${endpoint}?access_token=${accessToken}`;
  const body = JSON.stringify({ begin_date, end_date });
  const res = await httpsRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, body);
  if (res.statusCode !== 200) {
    const hint = res.raw ? `: ${String(res.raw).slice(0, 200)}` : ' (empty response body — likely blocked by the egress proxy; use the non-/cgi-bin/ datacube path)';
    throw new Error(`${endpoint} HTTP ${res.statusCode}${hint}`);
  }
  const json = res.json || {};
  // 40001/42001 = token invalid/expired. Clear the cache and retry exactly once,
  // in case a concurrent caller rotated the token (defense-in-depth on top of stable_token).
  if (json.errcode === 40001 || json.errcode === 42001) {
    clearTokenCache();
    const token2 = await getAccessToken();
    const res2 = await httpsRequest(url.replace(accessToken, token2), { method: 'POST', headers: { 'Content-Type': 'application/json' } }, body);
    const json2 = res2.json || {};
    if (json2.errcode && json2.errcode !== 0) {
      throw new Error(`${endpoint} failed: ${json2.errcode} ${json2.errmsg}`);
    }
    return { action, endpoint, begin_date, end_date, list: json2.list || [], is_delay: json2.is_delay, retried: true };
  }
  if (json.errcode && json.errcode !== 0) {
    throw new Error(`${endpoint} failed: ${json.errcode} ${json.errmsg}`);
  }
  return { action, endpoint, begin_date, end_date, list: json.list || [], is_delay: json.is_delay };
}

/**
 * Overview bundle: user growth + cumulative users + account biz summary +
 * message stats for one 7-day window (4 datacube calls). Individual failures are
 * collected per key instead of aborting, so a partially-permissioned account
 * still returns data.
 * @returns {Promise<{begin_date:string, end_date:string, data:Object, errors:Object}>}
 */
async function getStatsOverview({ beginDate, endDate } = {}) {
  const { begin_date, end_date } = resolveStatsRange(beginDate, endDate);
  const wanted = ['user_summary', 'user_cumulate', 'biz_summary', 'upstream_msg'];
  const data = {};
  const errors = {};
  for (const action of wanted) {
    try {
      data[action] = (await getStats(action, { beginDate: begin_date, endDate: end_date })).list;
    } catch (e) {
      errors[action] = e.message;
    }
  }
  return { begin_date, end_date, data, errors };
}

/**
 * Push harness-rewritten articles to the WeChat draft box (Mode B publish path).
 * ---------------------------------------------------------------------------
 * Unlike syncWechat (Mode A — reads the DB ORIGINAL and publishes it verbatim),
 * this takes the ALREADY-REWRITTEN title/body from the caller (the Skill / harness
 * did the semantic rewrite per styles/*.yaml) and pushes them as ONE multi-article
 * draft. The server never rewrites content; it only adapts (md→WeChat HTML),
 * uploads images, and calls draft/add.
 *
 * @param {{articles:Array<{slug:string,title:string,contentMd:string}>, siteKey?:string, dryRun?:boolean}} opts
 * @returns {Promise<{mediaId?:string, action:'draft'|'dry-run'}>}
 */
async function publishRewrittenToWechat({ articles, siteKey, dryRun = false }) {
  const SITE = t.site.loadSite(siteKey);
  const SITE_DOMAIN = (process.env.SITE_DOMAIN || (SITE.site && SITE.site.site && SITE.site.site.domain) || 'www.tengence.com')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, 'www.');
  const LOG_DIR = path.join(SITE.siteDir, 'data');
  const LOG_FILE = path.join(LOG_DIR, 'wechat-log.jsonl');

  const slugs = articles.map((a) => a.slug);
  console.log('='.repeat(60));
  console.log(`WeChat draft (rewritten) sync (${articles.length} articles)`);
  console.log('='.repeat(60));

  if (dryRun) {
    for (const a of articles) console.log(`  - ${a.slug} | ${a.title}`);
    console.log('\n[dry-run] done');
    return { mediaId: null, action: 'dry-run' };
  }

  let mediaId = null;
  await t.db.withConn(async (conn) => {
    const draftArticles = [];
    for (const a of articles) {
      // reuse the full md→HTML + image-upload + cover pipeline, but feed the
      // harness-rewritten title/body instead of the DB original
      const article = await prepareArticle(conn, a.slug, SITE_DOMAIN, {
        titleOverride: a.title,
        contentMdOverride: a.contentMd,
      });
      article._slug = a.slug;
      draftArticles.push(article);
    }
    const accessToken = await getAccessToken();
    const cleanArticles = draftArticles.map(({ _slug, ...rest }) => rest);
    mediaId = await createDraft(accessToken, cleanArticles);
    console.log(`\n✅ Draft created! media_id: ${mediaId}`);
    appendLog(
      { time: new Date().toISOString(), action: 'draft', slugs, mediaId, rewritten: true },
      LOG_DIR,
      LOG_FILE
    );
  });

  return { mediaId, action: 'draft' };
}

module.exports = {
  syncWechat,
  publishRewrittenToWechat,
  cleanWechatHtml,
  prepareArticle,
  listDrafts,
  listPublished,
  syncProgressFromWechat,
  massSend,
  massPreview,
  massStatus,
  massDelete,
  deletePublished,
  publishDraftByMediaId,
  getStats,
  getStatsOverview,
  STATS_ENDPOINTS,
  resolveStatsRange,
  clearTokenCache,
};
