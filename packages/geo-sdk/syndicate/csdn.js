'use strict';
/**
 * CSDN publishing (tengence-geo-sdk/syndicate/csdn)
 * ============================================================================
 * The CSDN channel, shaped to mirror syndicate/juejin.js so that syndicate/channel.js
 * (and therefore channel_publish / channel_plan_next) treats both identically.
 *
 * WHY COOKIE AND NOT AN OFFICIAL API
 *   CSDN exposes no public writing/publishing OpenAPI (openapi.csdn.net → 403;
 *   the legacy MetaWeblog endpoint is dead). The only working path is the same
 *   set of endpoints the CSDN creator console itself calls, which sit behind an
 *   Aliyun API gateway: a login Cookie PLUS four `x-ca-*` signature headers.
 *   The signature is computed locally (AppKey/AppSecret below are the ones the
 *   CSDN web bundle ships), so from the operator's point of view configuring this
 *   channel is still "paste one Cookie" — same operational cost as Juejin.
 *
 * ENDPOINT SOURCE (2026-09-27, reverse-read from the official bundle, then
 * endpoint-existence-verified: a correctly signed request returns 401 请登录后操作,
 * an unknown path returns 404)
 *   https://csdnimg.cn/release/mpfev3/mp_v3/index-C8tjBkJM.js
 *   - 发文        POST https://bizapi.csdn.net/blog-console-api/v1/postedit/saveArticle
 *   - 内容管理    https://bizapi.csdn.net/blog/phoenix/console/v1/…
 *                   article/list (GET)            article/del (POST {articleId, deep})
 *                   article/get-basic-info (GET)  article/get-quality-score (GET)
 *                   category/get-list (GET)       tag/search-recommend-tag (POST)
 *
 * Env vars (sites/<site>/.env, injected by t.site.loadSite()):
 *   CSDN_COOKIE             (required) login cookie
 *   CSDN_USERNAME           (optional) blog username — only used for a sanity check
 *   CSDN_SOURCE             (optional) `source` field, default pc_postedit
 *   CSDN_TAGS               (optional) fallback tags, comma separated
 *   CSDN_CREATION_STATEMENT (optional) 0 无声明 / 1 AI辅助 / 2 网络整合 / 3 个人观点
 *
 * Contract with the rest of the channel stack (mirrors publishJuejin):
 *   - publishCsdn() returns the SAME shape as publishJuejin
 *     ({draftId, articleId, failed, stage, dryRun, …}) so channel.js needs no
 *     CSDN-specific branching in its result handling.
 *   - Idempotency is NOT re-implemented here. It is enforced once, upstream, by
 *     t.plan.channel.filterUnpublished() (slug → channel_plan publish log), exactly
 *     as for juejin. isDuplicate() below is kept as a read-only utility only.
 *   - The publish LOG is written by channel.js/plan.channel.recordPublish against
 *     platform='csdn' — CSDN gets its OWN independent publishing calendar in the
 *     shared channel_plan table; nothing is bulk-imported from the blog plan.
 *
 * ⚠️ CSDN does NOT convert Markdown server-side. `content` must be real HTML or the
 *    public page renders the article as one flat block of text with no code
 *    highlighting. mdToCsdnHtml() handles that (marked → CSDN Prism markup).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const mdmod = require('../content/md');

// ---------------------------------------------------------------------------
// Aliyun API-gateway credentials shipped by the CSDN web bundle.
// If CSDN ever rotates these, re-extract from the console bundle:
//   1. curl https://mp.csdn.net/mp_blog/creation/article  → <script src="…index-*.js">
//   2. grep the bundle for `203803574` (key) and the 28-char secret nearby.
// ---------------------------------------------------------------------------
const APP_KEY = '203803574';
const APP_SECRET = '9znpamsyl2c7cdrr9sas0le9vbc3r6ba';

// CSDN 图床（封面/正文配图）走 resource-api 网关，用的是 web bundle 里另一对
// AppKey/Secret（与发文网关不同）：2026-09-28 从 g.csdnimg.cn/csdn-upload/1.0.9
// + csdn-http/1.0.2 逆向读出，并实测 code:200 通过。签名串里 x-ca-timestamp
// 参与签名（发文网关那套不参与），所以单独实现。
const RES_APP_KEY = '260196572';
const RES_APP_SECRET = 't5PaqxVQpWoHgLGt7XPIvd5ipJcwJTU7';
const BASE_RESOURCE = 'https://bizapi.csdn.net/resource-api';
/** 封面图上传 appName（编辑器封面选择器用的是 direct_blog_coverimage） */
const COVER_APP_NAME = 'direct_blog_coverimage';
/** CSDN 图床支持的扩展名 */
const IMAGE_SUFFIXES = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];

/** 封面必须落在 CSDN 自家 CDN，外链一律无效 */
const CSDN_CDN_PATTERNS = [/i-blog\.csdnimg\.cn/, /img-blog\.csdn\.net/, /i-scdn\.csdnimg\.cn/];

/** 按扩展名给出 content-type（图床 PUT/POST 用）。 */
function mimeFor(suffix) {
  return (
    { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' }[
      String(suffix || '').toLowerCase()
    ] || 'application/octet-stream'
  );
}

/**
 * resource-api 网关签名：stringToSign 含 x-ca-timestamp（与发文网关唯一差异）。
 *   METHOD\nAccept\n\nContent-Type\n\nx-ca-key:..\nx-ca-nonce:..\nx-ca-timestamp:..\nPathAndQuery
 */
function signResourceHeaders({ method, pathAndQuery, accept, contentType }) {
  const nonce = crypto.randomUUID();
  const timestamp = String(Date.now());
  const signed = { 'x-ca-key': RES_APP_KEY, 'x-ca-nonce': nonce, 'x-ca-timestamp': timestamp };
  const lines = Object.keys(signed)
    .sort()
    .map((k) => `${k}:${signed[k]}`)
    .join('\n');
  const stringToSign = [method.toUpperCase(), accept, '', contentType, ''].join('\n') + '\n' + lines + '\n' + pathAndQuery;
  const signature = crypto.createHmac('sha256', RES_APP_SECRET).update(stringToSign, 'utf8').digest('base64');
  return {
    ...signed,
    'x-ca-signature': signature,
    'x-ca-signature-headers': Object.keys(signed).sort().join(','),
  };
}

/** 向 resource-api 换取一次直传凭证（OBS 表单直传）。 */
async function getImageUploadSignature({ appName = COVER_APP_NAME, suffix = 'jpg', imageTemplate = '' } = {}) {
  const { cookie } = creds();
  if (!cookie) throw new Error('CSDN_COOKIE_MISSING');
  const accept = 'application/json, text/plain, */*';
  const contentType = 'application/json;charset=UTF-8';
  const pathAndQuery = '/resource-api/v1/image/direct/upload/signature';
  const res = await fetch(`${BASE_RESOURCE}/v1/image/direct/upload/signature`, {
    method: 'POST',
    headers: {
      ...signResourceHeaders({ method: 'POST', pathAndQuery, accept, contentType }),
      accept,
      'content-type': contentType,
      cookie,
      origin: 'https://editor.csdn.net',
      referer: 'https://editor.csdn.net/md/',
      'user-agent': UA,
    },
    body: JSON.stringify({ imageTemplate, appName, imageSuffix: String(suffix).toLowerCase() }),
  });
  const j = await res.json().catch(() => ({ code: res.status, msg: 'non-json response' }));
  if (j.code !== 200 || !j.data) throw new Error(`CSDN 图床签名失败: ${j.msg || j.code}`);
  return j.data;
}

/**
 * 把一张图转存进 CSDN 图床，返回可直接当封面/配图用的 URL。
 * @param {{buffer?:Buffer, filePath?:string, url?:string, suffix?:string, appName?:string}} opts
 */
async function uploadImage({ buffer = null, filePath = null, url = null, suffix = null, appName = COVER_APP_NAME } = {}) {
  let buf = buffer;
  let ext = String(suffix || '').toLowerCase().replace(/^\./, '');
  if (!buf && filePath) {
    buf = fs.readFileSync(filePath);
    ext = ext || path.extname(filePath).slice(1).toLowerCase();
  }
  if (!buf && url) {
    const r = await fetch(url, { headers: { 'user-agent': UA, referer: new URL(url).origin + '/' } });
    if (!r.ok) throw new Error(`下载图片失败: HTTP ${r.status} ${url}`);
    buf = Buffer.from(await r.arrayBuffer());
    const ctype = r.headers.get('content-type') || '';
    ext = ext || (ctype.split('/')[1] || '').split(';')[0].toLowerCase() || 'jpg';
    if (ext === 'jpeg') ext = 'jpg';
  }
  if (!buf) throw new Error('uploadImage 需要 buffer / filePath / url 之一');
  if (!IMAGE_SUFFIXES.includes(ext)) ext = 'jpg';

  const sig = await getImageUploadSignature({ appName, suffix: ext });
  const fd = new FormData();
  fd.append('key', sig.filePath);
  fd.append('policy', sig.policy);
  fd.append('signature', sig.signature);
  fd.append('callbackBody', sig.callbackBody);
  fd.append('callbackBodyType', sig.callbackBodyType);
  if (sig.provider === 'obs') {
    fd.append('callbackUrl', sig.callbackUrl);
    fd.append('AccessKeyId', sig.accessId);
  } else {
    fd.append('callback', sig.callbackUrl);
    fd.append('OSSAccessKeyId', sig.accessId);
  }
  for (const [k, v] of Object.entries(sig.customParam || {})) fd.append(`x:${k}`, String(v));
  fd.append('file', new Blob([buf], { type: mimeFor(ext) }), `image.${ext}`);

  const up = await fetch(sig.host, { method: 'POST', body: fd });
  const body = await up.text().catch(() => '');
  let parsed = null;
  try { parsed = JSON.parse(body); } catch (e) { /* 直传成功但响应非 JSON */ }
  const imageUrl = parsed && parsed.data && parsed.data.imageUrl;
  if (!imageUrl) {
    if (up.status >= 200 && up.status < 300) {
      return { imageUrl: `${String(sig.host).replace(/\/$/, '')}/${sig.filePath}`, raw: parsed || body };
    }
    throw new Error(`CSDN 图床上传失败: HTTP ${up.status} ${String(body).slice(0, 200)}`);
  }
  return { imageUrl, raw: parsed };
}

/** 已经是 CSDN CDN 的图无需再转存。 */
function isCsdnCdn(url) {
  return !!url && CSDN_CDN_PATTERNS.some((re) => re.test(url));
}

/** 发文 base */
const BASE_EDITOR = 'https://bizapi.csdn.net/blog-console-api';
/** 内容管理 base */
const BASE_PHOENIX = 'https://bizapi.csdn.net/blog/phoenix/console/v1';

/** CSDN 标题上限（channel.js 在调用前也会按此截断） */
const CSDN_TITLE_MAX = 100;
/** CSDN 强制 1~5 个标签；发布时缺标签直接 400「请设置文章标签」 */
const CSDN_TAGS_MAX = 5;

/** article/list 的 status 枚举（取自官方 bundle 的导航分类定义） */
const LIST_STATUS = {
  all: 'all_v3',        // 全部
  published: 'all_v2',  // 已发布
  audit: 'audit',       // 审核中/未通过
  deleted: 'deleted',   // 回收站
  draft: 'draft',       // 草稿箱
};

const DEFAULT_ACCEPT = 'application/json, text/plain, */*';
const DEFAULT_CONTENT_TYPE = 'application/json;';

/** Read CSDN credentials from injected env. */
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function creds() {
  return {
    cookie: process.env.CSDN_COOKIE || '',
    username: process.env.CSDN_USERNAME || '',
    source: process.env.CSDN_SOURCE || 'pc_postedit',
    defaultTags: (process.env.CSDN_TAGS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    creationStatement: Number(process.env.CSDN_CREATION_STATEMENT || 0),
  };
}

// ---------------------------------------------------------------------------
// Signature (Aliyun API gateway, HMAC-SHA256)
// ---------------------------------------------------------------------------

/**
 * Build the `x-ca-*` signature headers.
 *   StringToSign = METHOD \n Accept \n Content-MD5 \n Content-Type \n Date \n
 *                  x-ca-key:{key}\nx-ca-nonce:{nonce} \n PathAndParameters
 * (Content-MD5 and Date are not sent, so they stay blank; the newline layout is
 * what the gateway expects — verified: a wrong signature yields
 * {"message":"HMAC signature does not match"}, a correct one gets past the gateway.)
 */
function signHeaders({ method, pathAndQuery, accept = DEFAULT_ACCEPT, contentType = DEFAULT_CONTENT_TYPE }) {
  const nonce = crypto.randomUUID();
  const headersPart = `x-ca-key:${APP_KEY}\nx-ca-nonce:${nonce}`;
  const stringToSign = [method.toUpperCase(), accept, '', contentType, '', headersPart, pathAndQuery].join('\n');
  const signature = crypto.createHmac('sha256', APP_SECRET).update(stringToSign, 'utf8').digest('base64');
  return {
    'x-ca-key': APP_KEY,
    'x-ca-nonce': nonce,
    'x-ca-signature-headers': 'x-ca-key,x-ca-nonce',
    'x-ca-signature': signature,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * One signed call to the CSDN gateway.
 * NOTE: the SIGNED path must include the query string (GET), hence pathAndQuery.
 * @returns {Promise<object>} parsed JSON, or {raw, statusCode} when not JSON
 */
function request(fullUrl, { method = 'GET', body = null, referer } = {}) {
  const { cookie } = creds();
  if (!cookie) throw new Error('CSDN_COOKIE_MISSING');

  const urlObj = new URL(fullUrl);
  const pathAndQuery = urlObj.pathname + urlObj.search;
  const contentType = DEFAULT_CONTENT_TYPE;
  const signed = signHeaders({ method, pathAndQuery, contentType });

  const payload = body == null ? null : JSON.stringify(body);
  const headers = {
    ...signed,
    accept: DEFAULT_ACCEPT,
    'content-type': contentType,
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    origin: 'https://mp.csdn.net',
    referer: referer || 'https://mp.csdn.net/mp_blog/creation/editor',
    cookie,
  };
  if (payload) headers['content-length'] = Buffer.byteLength(payload);

  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: urlObj.hostname, port: 443, path: pathAndQuery, method, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            // Surface an expired login state as an explicit, greppable signal instead
            // of a silent empty list.
            if (parsed && (parsed.code === 401 || /请登录|登录已失效|未登录/.test(parsed.message || ''))) {
              parsed.csdnCookieExpired = true;
            }
            resolve(parsed);
          } catch (e) {
            resolve({ raw: data, statusCode: res.statusCode });
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('CSDN request timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Normalize the {code, message, data} envelope every CSDN endpoint returns. */
function unwrap(resp) {
  const ok = !!resp && (resp.code === 200 || resp.code === '200');
  return {
    ok,
    code: resp ? resp.code : null,
    msg: resp ? resp.message || resp.msg || null : null,
    data: resp ? resp.data : null,
    cookieExpired: !!(resp && resp.csdnCookieExpired),
  };
}

// ---------------------------------------------------------------------------
// Markdown → CSDN HTML
// ---------------------------------------------------------------------------

/**
 * CSDN's article page renders `content` as plain HTML and CSDN does NOT run a
 * server-side Markdown conversion. Feeding raw Markdown in produces a single flat
 * text block with no code highlighting.
 *
 * Reuses the project's own Markdown→HTML chain (t.content.md.markdownToHtml — the
 * same one the WordPress/WeChat pipelines use), then rewrites marked's
 * `<pre><code class="language-x">` into CSDN's Prism markup.
 */
function mdToCsdnHtml(md) {
  const html = mdmod.markdownToHtml(md || '');
  return html
    .replace(/<pre><code class="language-([\w+#.-]+)">/g, '<pre class="prettyprint"><code class="prism language-$1">')
    .replace(/<pre><code>/g, '<pre class="prettyprint"><code class="prism language-text">');
}

/**
 * Drop the leading "# Title" H1 from a body markdown.
 * CSDN renders the article title in its own slot (the `title` field), so the body
 * must NOT repeat it — otherwise the title shows up twice (once as the heading bar,
 * once as the first line of the article body). This is applied uniformly with Juejin.
 * @param {string} md
 * @returns {string} body with the first ATX H1 removed
 */
function stripLeadingTitleHeading(md) {
  if (!md) return md;
  // Drop ONE OR MORE leading ATX H1 lines. Some export pipelines duplicate the
  // title as two consecutive `# Title` lines; CSDN renders the title in its own
  // slot, so none of them belong in the body.
  return md.replace(/^(?:#\s+[^\n]*\r?\n)+/, '');
}

// ---------------------------------------------------------------------------
// 增 / 改：saveArticle (one-step create-or-update)
// ---------------------------------------------------------------------------

/**
 * Create / update / publish / draft an article in ONE call.
 * CSDN has no Juejin-style three-step (create → update → publish) dance:
 *   - `status` 2 = draft, 1 = submit for review, 0 = publish live
 *   - `is_new` 1 = create, 0 = update (then `article_id` is required)
 * @param {{title:string, contentHtml:string, contentMd:string, tags?:string[],
 *          description?:string, publish?:boolean, articleId?:string|null,
 *          categories?:string, type?:string, readType?:string}} opts
 */
async function saveArticle({
  title,
  contentHtml,
  contentMd,
  tags = [],
  description = '',
  publish = false,
  articleId = null,
  categories = '',
  type = 'original',
  readType = 'public',
  coverImages = [],
  coverType = 1,
} = {}) {
  const { source, creationStatement } = creds();
  const isNew = articleId ? 0 : 1;
  const payload = {
    article_id: articleId || '',
    title,
    content: contentHtml,
    markdowncontent: contentMd,
    description: (description || '').slice(0, 256),
    tags: (tags || []).slice(0, CSDN_TAGS_MAX).join(','),
    categories: categories || '',
    type: type || 'original',
    status: publish ? 0 : 2,
    pubStatus: publish ? 'publish' : 'draft',
    readType: readType || 'public',
    creation_statement: creationStatement,
    source,
    is_new: isNew,
    not_auto_saved: 1,
    authorized_status: false,
    check_original: false,
    cover_type: coverType,
    cover_images: Array.isArray(coverImages) ? coverImages : [],
    vote_id: 0,
    resource_id: '',
    scheduled_time: 0,
    reason: '',
    original_link: '',
  };
  return request(`${BASE_EDITOR}/v1/postedit/saveArticle`, {
    method: 'POST',
    body: payload,
    referer: articleId
      ? `https://editor.csdn.net/md/?articleId=${articleId}`
      : 'https://editor.csdn.net/md/',
  });
}

// ---------------------------------------------------------------------------
// 查
// ---------------------------------------------------------------------------

/**
 * List the account's articles.
 * @param {number} page 1-based
 * @param {number} pageSize default 20 (the console's own default)
 * @param {'all'|'published'|'draft'|'audit'|'deleted'} status
 * @returns {Promise<{ok, code, msg, data, cookieExpired, items:Array, counts:object}>}
 */
async function listArticles(page = 1, pageSize = 20, status = 'all') {
  const qs = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    status: LIST_STATUS[status] || LIST_STATUS.all,
  });
  const resp = await request(`${BASE_PHOENIX}/article/list?${qs.toString()}`, { method: 'GET' });
  const u = unwrap(resp);
  const data = u.data || {};
  const items = Array.isArray(data.list) ? data.list : [];
  return {
    ...u,
    items: items.map((it) => ({
      id: it.articleId != null ? String(it.articleId) : it.id != null ? String(it.id) : null,
      title: it.title || '',
      status: it.status != null ? it.status : null,
      url: it.url || (it.articleId ? `https://blog.csdn.net/${creds().username}/article/details/${it.articleId}` : ''),
      postTime: it.postTime || it.createTime || null,
      viewCount: it.viewCount != null ? it.viewCount : null,
      raw: it,
    })),
    counts: data.count || {},
  };
}

/** Published articles — the CSDN counterpart of juejin.listPublished(). */
async function listPublished(page = 1, pageSize = 20) {
  return listArticles(page, pageSize, 'published');
}

/** Draft box — the CSDN counterpart of juejin.listDrafts(). */
async function listDrafts(page = 1, pageSize = 20) {
  return listArticles(page, pageSize, 'draft');
}

/** One article's basic info (phoenix/console/v1/article/get-basic-info). */
async function getArticleBasicInfo(articleId) {
  const qs = new URLSearchParams({ articleId: String(articleId) });
  const resp = await request(`${BASE_PHOENIX}/article/get-basic-info?${qs.toString()}`, { method: 'GET' });
  return unwrap(resp);
}

/** Quality score of one article (0-100) — a CSDN-only signal, no Juejin equivalent. */
async function getQualityScore(articleId) {
  const qs = new URLSearchParams({ articleId: String(articleId) });
  const resp = await request(`${BASE_PHOENIX}/article/get-quality-score?${qs.toString()}`, { method: 'GET' });
  return unwrap(resp);
}

/** The platform's category dictionary (no per-site mapping file needed). */
async function listCategories() {
  const resp = await request(`${BASE_PHOENIX}/category/get-list`, { method: 'GET' });
  const u = unwrap(resp);
  const arr = Array.isArray(u.data) ? u.data : u.data && Array.isArray(u.data.list) ? u.data.list : [];
  return { ...u, categories: arr };
}

/** Tag recommendation for a keyword — CSDN tags are free text, so this is advisory. */
async function recommendTags(keyword) {
  const resp = await request(`${BASE_PHOENIX}/tag/search-recommend-tag`, {
    method: 'POST',
    body: { keyword },
  });
  return unwrap(resp);
}

// ---------------------------------------------------------------------------
// 删
// ---------------------------------------------------------------------------

/** Delete one article. IRREVERSIBLE. `deep=true` also purges it from the recycle bin. */
async function deleteArticle(articleId, deep = false) {
  return request(`${BASE_PHOENIX}/article/del`, {
    method: 'POST',
    body: { articleId: String(articleId), deep: !!deep },
  });
}

// ---------------------------------------------------------------------------
// 幂等 utility (NOT used by the publish pipeline — see the file header)
// ---------------------------------------------------------------------------

/**
 * True when a CSDN article already carries this (normalized) title.
 * Kept as a read-only utility, mirroring juejin.isDuplicate(). The publish pipeline
 * no longer relies on title matching: it de-duplicates by slug against the local
 * channel_plan log (t.plan.channel.filterUnpublished), which survives title edits
 * and truncation.
 */
async function isDuplicate(title) {
  const norm = (s) => (s || '').trim().toLowerCase();
  const target = norm(title);
  if (!target) return false;
  try {
    const res = await listArticles(1, 50, 'all');
    if (res.cookieExpired) return false;
    return (res.items || []).some((it) => norm(it.title) === target);
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 主发布流程
// ---------------------------------------------------------------------------

/**
 * Publish markdown to CSDN.
 *
 * @param {{mdFile?:string, contentMd?:string, title?:string|null, publish?:boolean,
 *          dryRun?:boolean, tags?:string[], articleId?:string|null,
 *          description?:string, categories?:string}} opts
 *   mdFile     path of a markdown file (Mode A)
 *   contentMd  the body as a string (Mode B — harness-rewritten draft)
 *   tags       article keywords (strings); CSDN keeps 1~5, free text
 *   articleId  when set, UPDATES that article instead of creating a new one
 * @returns {Promise<{draftId?:string, articleId?:string, url?:string, failed?:boolean,
 *                    stage?:string, dryRun?:boolean, skipped?:boolean, tags?:string[]}>}
 *   NOTE: CSDN has no separate draft/publish entities, so `draftId` and `articleId`
 *   carry the SAME CSDN article id — the shape is kept identical to publishJuejin so
 *   channel.js and the channel_plan log need no CSDN-specific handling.
 */
async function publishCsdn({
  mdFile = null,
  contentMd = null,
  title = null,
  publish = false,
  dryRun = false,
  tags = [],
  articleId = null,
  description = '',
  categories = '',
  coverImages = [],
  coverType = 1,
  coverUrl = null,
  coverSuffix = null,
} = {}) {
  const { cookie, defaultTags } = creds();
  if (!cookie) {
    console.log('❌ CSDN_COOKIE not found in .env');
    throw new Error('CSDN_COOKIE_MISSING');
  }
  if (contentMd == null && !mdFile) {
    throw new Error('publishCsdn requires either mdFile or contentMd');
  }

  const raw = contentMd != null ? contentMd : fs.readFileSync(mdFile, 'utf-8');
  const cleanedMd = raw.replace(/^---\n[\s\S]*?\n---\n?/, ''); // strip front matter
  // The article title is rendered by CSDN in its own slot (the `title` field above),
  // so drop the leading "# Title" H1 from the body to avoid showing it twice.
  const bodyMd = stripLeadingTitleHeading(cleanedMd);
  if (!title) {
    const match = cleanedMd.match(/^# (.+)$/m);
    title = match ? match[1].trim() : path.basename(mdFile || 'article', '.md');
  }
  let titleTrimmed = false;
  if (title.length > CSDN_TITLE_MAX) {
    title = title.slice(0, CSDN_TITLE_MAX);
    titleTrimmed = true;
  }

  // CSDN requires ≥1 tag when publishing (400 「请设置文章标签」) and allows 5.
  let resolvedTags = (Array.isArray(tags) ? tags : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .slice(0, CSDN_TAGS_MAX);
  if (!resolvedTags.length) resolvedTags = defaultTags.slice(0, CSDN_TAGS_MAX);

  if (!description) {
    const brief = cleanedMd.match(/^> \*\*摘要\*\*：(.+)$/m);
    description = brief ? brief[1].trim() : cleanedMd.replace(/^#.+\n/, '').substring(0, 200).trim();
  }

  console.log(`📝 Title: ${title}${titleTrimmed ? ' (trimmed)' : ''}`);
  console.log(`🏷️  Tags: ${resolvedTags.join(', ') || '(none)'}`);

  if (dryRun) {
    console.log(`🔍 [dryRun] would ${publish ? 'publish' : 'save as draft'} on CSDN: ${title}`);
    return { dryRun: true, title, titleTrimmed, tags: resolvedTags, skipped: false };
  }

  if (publish && !resolvedTags.length) {
    console.log('❌ CSDN requires at least 1 tag to publish (400 请设置文章标签)');
    return { failed: true, stage: 'tags', title };
  }

  // 封面：CSDN 只认自家图床，外链（博客特色图）必须先转存；已经是 CDN 的直接用。
  let resolvedCovers = Array.isArray(coverImages) ? coverImages.filter(Boolean) : [];
  let coverSource = resolvedCovers.length ? 'direct' : null;
  if (!resolvedCovers.length && coverUrl) {
    if (isCsdnCdn(coverUrl)) {
      resolvedCovers = [coverUrl];
      coverSource = 'already-cdn';
    } else {
      try {
        const up = await uploadImage({ url: coverUrl, suffix: coverSuffix });
        resolvedCovers = [up.imageUrl];
        coverSource = 'uploaded';
        console.log(`🖼  封面已转存 CSDN 图床: ${up.imageUrl}`);
      } catch (e) {
        console.log(`⚠️  封面转存失败，按无封面继续: ${e.message}`);
      }
    }
  }

  const contentHtml = mdToCsdnHtml(bodyMd);
  console.log(`📤 ${articleId ? 'Updating' : 'Creating'} on CSDN (${publish ? 'publish' : 'draft'})...`);

  const resp = await saveArticle({
    title,
    contentHtml,
    contentMd: bodyMd,
    tags: resolvedTags,
    description,
    publish,
    articleId,
    categories,
    coverImages: resolvedCovers,
    coverType: resolvedCovers.length ? coverType : 0,
  });
  const u = unwrap(resp);
  if (!u.ok) {
    console.log(`❌ CSDN save failed: ${JSON.stringify(resp, null, 2)}`);
    return { failed: true, stage: 'save', title, error: u.msg, cookieExpired: u.cookieExpired };
  }

  const data = u.data || {};
  const id = String(data.article_id || data.id || articleId || '');
  const url = data.url || (id ? `https://blog.csdn.net/${creds().username}/article/details/${id}` : '');
  console.log(`✅ CSDN ${publish ? 'published' : 'draft saved'}! Article ID: ${id}`);
  if (url) console.log(`🔗 ${url}`);

  return {
    draftId: id,
    articleId: id,
    url,
    published: !!publish,
    coverImages: resolvedCovers,
    coverSource,
    title,
    titleTrimmed,
    tags: resolvedTags,
  };
}

module.exports = {
  // env / plumbing
  creds,
  signHeaders,
  request,
  unwrap,
  mdToCsdnHtml,
  // write
  saveArticle,
  publishCsdn,
  // image hosting（封面/正文配图必须落在 CSDN 图床）
  uploadImage,
  getImageUploadSignature,
  isCsdnCdn,
  // read
  listArticles,
  listPublished,
  listDrafts,
  getArticleBasicInfo,
  getQualityScore,
  listCategories,
  recommendTags,
  // delete
  deleteArticle,
  // utility
  isDuplicate,
  // constants (consumed by channel.js / MCP tools)
  CSDN_TITLE_MAX,
  CSDN_TAGS_MAX,
  COVER_APP_NAME,
  LIST_STATUS,
};
