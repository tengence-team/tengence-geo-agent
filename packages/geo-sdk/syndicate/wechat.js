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

function httpsRequest(url, options = {}, body = null) {
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
    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Request timeout: ' + url));
    });
    if (body) { req.setHeader('Content-Length', Buffer.byteLength(body)); req.write(body); }
    req.end();
  });
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpireAt - 60000) return cachedToken;
  const WECHAT_APP_ID = process.env.WECHAT_APP_ID;
  const WECHAT_APP_SECRET = process.env.WECHAT_APP_SECRET;
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WECHAT_APP_ID}&secret=${WECHAT_APP_SECRET}`;
  const { json } = await httpsRequest(url);
  if (json.errcode && json.errcode !== 0) {
    throw new Error(`access_token fetch failed: ${json.errcode} ${json.errmsg}`);
  }
  cachedToken = json.access_token;
  tokenExpireAt = Date.now() + json.expires_in * 1000;
  console.log(`  ✅ access_token obtained (valid ${json.expires_in}s)`);
  return cachedToken;
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

async function prepareArticle(conn, slug, siteDomain) {
  const APP_ID = process.env.APP_ID || '1';

  console.log(`\n📄 Processing article: ${slug}`);

  const detail = await t.db.articles.getDetail(conn, APP_ID, slug);
  if (!detail) throw new Error(`Article not found: ${slug}`);

  const articleId = detail.id;
  const title = detail.title;
  let mdContent = detail.content_longtext || detail.content || '';

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

module.exports = { syncWechat, cleanWechatHtml, prepareArticle };
