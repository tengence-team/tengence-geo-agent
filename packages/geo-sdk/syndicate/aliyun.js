'use strict';
/**
 * Aliyun Developer Community publishing (tengence-geo-sdk/syndicate/aliyun)
 * ============================================================================
 * The Aliyun channel, shaped to mirror syndicate/csdn.js so that syndicate/channel.js
 * treats both the same way.
 *
 * WHY COOKIE AND NOT AN OFFICIAL API
 *   developer.aliyun.com exposes no public writing OpenAPI. The working path is the
 *   same set of endpoints the community editor itself calls. Operationally this is
 *   still "paste one Cookie" — same cost as CSDN / Juejin.
 *
 * ENDPOINT SOURCE (2026-09-27, reverse-read from the official editor bundle, then
 * endpoint-existence-verified: an existing path answers 405 on the wrong method,
 * an unknown path answers 404 HTML)
 *   https://g.alicdn.com/aliyun/developer-aliyun-com-fe/2.8.59/scripts/publishArticle.js
 *   - 草稿  POST /developer/api/articleDraft/putDraft   (带 aid 即更新)
 *          GET  /developer/api/articleDraft/listDraft
 *          GET  /developer/api/articleDraft/draftDetail?aid=
 *          POST /developer/api/articleDraft/deleteDraft?aid=
 *   - 文章  POST /developer/api/article/publishArticle?...&groupCode=
 *          POST /developer/api/article/updateArticle   (带 articleId 时前端走它)
 *          POST /developer/api/article/deleteArticle?articleId=
 *          GET  /developer/api/article/getDetail
 *   - 工具  POST /developer/api/article/markdownToHtml
 *          POST /developer/api/image/getImageUploadUrl
 *          POST /developer/api/captcha2/encryptedSceneId
 *          GET  /developer/api/my/user/getUser
 *
 * AUTH (three pieces, all required)
 *   1. Cookie header                — the login cookie
 *   2. `?p_csrf=<value>`            — query param on every write call
 *   3. `X-XSRF-TOKEN: <value>`      — HTTP header (the editor's fetch wrapper adds it)
 *   Plus `Origin` and `Referer: https://developer.aliyun.com/article/new`.
 *   The CSRF value is ISSUED BY THE SERVER via `Set-Cookie: c_csrf=<uuid>` on any
 *   page request — it is NOT part of the pasted cookie, so harvestCsrf() fetches it.
 *
 * Env vars (sites/<site>/.env, injected by t.site.loadSite()):
 *   ALIYUN_COOKIE        (required) login cookie
 *   ALIYUN_ARTICLE_TYPE  (optional) '1' 原创 (default) / '2' 翻译 / '3' 转载
 *
 * ⚠️ PUBLISH IS HUMAN-GATED (2026-09-27, verified)
 *   `article/publishArticle` exists and its payload is fully reverse-engineered, but
 *   every publish attempt returns `{"code":"50002","message":"内部错误"}` — including
 *   a trivial control article, which proves it is NOT content related. The editor page
 *   ships `GLOBAL_CONFIG.skipSlider: null` (falsy), so the publish button always runs
 *   an Aliyun Captcha first; the token cannot be produced without a human.
 *   => This channel automates DRAFTS and leaves the final publish to a human, exactly
 *      like the WeChat channel (draft only, human triggers the mass send).
 *      publishAliyun() therefore defaults to `publish:false` and returns a clear,
 *      actionable error when a publish is attempted.
 *
 * Unlike CSDN, Aliyun accepts Markdown directly as the article body (the draft we
 * created comes back with `format: 2`), so there is no md→HTML step here.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const HOST = 'developer.aliyun.com';
const BASE = `https://${HOST}/developer/api`;
const EDITOR_URL = `https://${HOST}/article/new`;
/** CSRF is issued as a cookie by any page hit; /my is cheap and always 200. */
const CSRF_SEED_URL = `https://${HOST}/my`;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Conservative default — Aliyun does not publish a documented title limit and the
 * editor only validates the abstract length (300). Truncating at 100 matches the
 * other CN channels and is well clear of anything the UI exercised.
 */
const ALIYUN_TITLE_MAX = 100;
/** Enforced by the editor: 「请修改摘要，字数控制在300字以内」 */
const ALIYUN_ABSTRACT_MAX = 300;

/** 文章类型（发布表单必填，required: true） */
const ARTICLE_TYPE = { original: '1', translation: '2', reprint: '3' };

/**
 * Returned by publishArticle when the platform's risk control blocks the call.
 * See the file header: publish needs a human to solve the Aliyun Captcha.
 */
const PUBLISH_GATED_CODE = '50002';

/** Read Aliyun credentials from injected env. */
function creds() {
  return {
    cookie: process.env.ALIYUN_COOKIE || '',
    type: String(process.env.ALIYUN_ARTICLE_TYPE || ARTICLE_TYPE.original),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * One raw call. Resolves {statusCode, headers, body, json}.
 * @param {string} fullUrl
 * @param {{method?:string, body?:object|null, csrf?:string|null}} opts
 */
function rawRequest(fullUrl, { method = 'GET', body = null, csrf = null } = {}) {
  const { cookie } = creds();
  if (!cookie) throw new Error('ALIYUN_COOKIE_MISSING');

  // The harvested CSRF must travel THREE ways or the server rejects the call with
  // 403 「Could not verify the provided CSRF token because your session was not found」:
  // the c_csrf COOKIE, the ?p_csrf= query param and the X-XSRF-TOKEN header.
  const cookieHeader = csrf ? `${cookie}; c_csrf=${csrf}` : cookie;
  const headers = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'user-agent': UA,
    cookie: cookieHeader,
    origin: `https://${HOST}`,
    referer: EDITOR_URL,
  };
  if (csrf) headers['x-xsrf-token'] = csrf;
  let payload = null;
  if (body != null) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(fullUrl, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (_) {
          json = null; // HTML error page (e.g. 404) — caller inspects statusCode
        }
        resolve({ statusCode: res.statusCode || 0, headers: res.headers || {}, body: text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let cachedCsrf = null;

/**
 * Fetch a server-issued CSRF token (`Set-Cookie: c_csrf=<uuid>`).
 * Cached for the process; pass force:true after an auth failure.
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<string>}
 */
async function harvestCsrf({ force = false } = {}) {
  if (cachedCsrf && !force) return cachedCsrf;
  const res = await rawRequest(CSRF_SEED_URL, { method: 'GET' });
  const setCookie = res.headers['set-cookie'] || [];
  const hit = setCookie.map((s) => String(s)).find((s) => s.startsWith('c_csrf='));
  if (!hit) throw new Error('ALIYUN_CSRF_MISSING');
  cachedCsrf = hit.split(';')[0].slice('c_csrf='.length);
  return cachedCsrf;
}

/**
 * Call one Aliyun community endpoint (CSRF appended automatically).
 * @param {string} apiPath e.g. '/articleDraft/putDraft'
 */
async function request(apiPath, { method = 'GET', body = null, retryAuth = true } = {}) {
  let csrf = await harvestCsrf();
  const sep = apiPath.includes('?') ? '&' : '?';
  let res = await rawRequest(`${BASE}${apiPath}${sep}p_csrf=${encodeURIComponent(csrf)}`, {
    method,
    body,
    csrf,
  });
  // A stale CSRF shows up as a failure envelope; refresh once and retry.
  if (retryAuth && res.json && res.json.success === false && res.json.code === '40001') {
    csrf = await harvestCsrf({ force: true });
    res = await rawRequest(`${BASE}${apiPath}${sep}p_csrf=${encodeURIComponent(csrf)}`, {
      method,
      body,
      csrf,
    });
  }
  return res;
}

/**
 * Normalise an Aliyun envelope into {ok, code, msg, data}.
 * Aliyun returns HTTP 200 even for failures, so success must be read from the body.
 */
function unwrap(res) {
  const j = res && res.json ? res.json : null;
  if (!j) {
    return { ok: false, code: String(res ? res.statusCode : 0), msg: 'non-JSON response', data: null };
  }
  if (j.success === true) return { ok: true, code: j.code || '200', msg: j.message || '', data: j.data };
  return { ok: false, code: String(j.code || res.statusCode), msg: j.message || 'request failed', data: j.data };
}

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

/**
 * Drop one or more leading `# Title` lines. The platform renders the title in its
 * own slot, so it must not be repeated at the top of the body.
 */
function stripLeadingTitleHeading(md) {
  if (!md) return md;
  return md.replace(/^(?:#\s+[^\n]*\r?\n)+/, '');
}

/**
 * Best-effort abstract (≤300 chars) from the markdown, used when the caller
 * does not supply one. Prefers a `> **摘要**：…` callout.
 */
function deriveAbstract(md) {
  if (!md) return '';
  const brief = md.match(/^>\s*\*\*摘要\*\*[：:](.+)$/m);
  const raw = brief ? brief[1].trim() : md.replace(/^#\s+.+$/m, '').replace(/[#>*`\-[\]()!]/g, ' ').replace(/\s+/g, ' ').trim();
  return raw.slice(0, ALIYUN_ABSTRACT_MAX);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Current login identity (also the cheapest cookie validity check). */
async function getUser() {
  const res = await request('/my/user/getUser', { method: 'GET' });
  const u = unwrap(res);
  if (!u.ok) throw new Error(`Aliyun getUser failed: ${u.code} ${u.msg}`);
  return u.data;
}

/** Draft box listing. */
async function listDrafts() {
  const res = await request('/articleDraft/listDraft', { method: 'GET' });
  const u = unwrap(res);
  if (!u.ok) throw new Error(`Aliyun listDraft failed: ${u.code} ${u.msg}`);
  return u.data || [];
}

/** One draft, including the stored markdown body. */
async function draftDetail(aid) {
  const res = await request(`/articleDraft/draftDetail?aid=${encodeURIComponent(aid)}`, { method: 'GET' });
  const u = unwrap(res);
  if (!u.ok) throw new Error(`Aliyun draftDetail failed: ${u.code} ${u.msg}`);
  return u.data;
}

/** Published article detail. */
async function getArticle(articleId) {
  const res = await request(`/article/getDetail?articleId=${encodeURIComponent(articleId)}`, { method: 'GET' });
  const u = unwrap(res);
  if (!u.ok) throw new Error(`Aliyun getDetail failed: ${u.code} ${u.msg}`);
  return u.data;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Create or update a draft.
 * NOTE: only these fields survive validation — adding `format` / `ext` / `coverUrl` /
 * `isNoComment` makes the endpoint answer 40000 「请求参数有误」.
 * @returns {Promise<object>} the raw envelope data (contains `aid`)
 */
async function putDraft({ title, content, abstractContent = '', aid = null } = {}) {
  const body = {
    title,
    content,
    abstractContent: String(abstractContent || '').slice(0, ALIYUN_ABSTRACT_MAX),
    contentRender: '',
    productTags: [],
    freeTierVOS: [],
  };
  if (aid) body.aid = aid;
  const res = await request('/articleDraft/putDraft', { method: 'POST', body });
  const u = unwrap(res);
  if (!u.ok) throw new Error(`Aliyun putDraft failed: ${u.code} ${u.msg}`);
  return u.data || {};
}

/**
 * Publish (draft → live), or update an already published article.
 *
 * ⚠️ In practice this is blocked by the platform's risk control: the editor always
 * shows an Aliyun Captcha before publishing (GLOBAL_CONFIG.skipSlider is falsy), so a
 * token-less server call answers 50002 内部错误. Callers should treat a non-ok result
 * with code 50002 as "human action required" and keep the draft.
 */
async function publishArticle({ title, content, abstractContent = '', draftId = null, articleId = null, type = null } = {}) {
  const { type: envType } = creds();
  const body = {
    title,
    abstractContent: String(abstractContent || '').slice(0, ALIYUN_ABSTRACT_MAX),
    content,
    contentRender: '',
    type: String(type || envType || ARTICLE_TYPE.original),
  };
  if (draftId) body.draftId = draftId;
  if (articleId) body.articleId = articleId;
  const res = await request('/article/publishArticle?groupCode=notPublishSpecialGroup', {
    method: 'POST',
    body,
  });
  return unwrap(res);
}

/** Delete a draft. */
async function deleteDraft(aid) {
  const res = await request(`/articleDraft/deleteDraft?aid=${encodeURIComponent(aid)}`, { method: 'POST' });
  const u = unwrap(res);
  if (!u.ok) throw new Error(`Aliyun deleteDraft failed: ${u.code} ${u.msg}`);
  return u.data;
}

/** Delete a published article. */
async function deleteArticle(articleId) {
  const res = await request(`/article/deleteArticle?articleId=${encodeURIComponent(articleId)}`, { method: 'POST' });
  const u = unwrap(res);
  if (!u.ok) throw new Error(`Aliyun deleteArticle failed: ${u.code} ${u.msg}`);
  return u.data;
}

// ---------------------------------------------------------------------------
// Publish entry point (mirrors publishCsdn's contract)
// ---------------------------------------------------------------------------

/**
 * Save an article to the Aliyun draft box (and optionally attempt to publish).
 *
 * Returns the SAME shape as publishCsdn ({draftId, articleId, url, published, title,
 * titleTrimmed, failed, stage, dryRun}) so channel.js needs no Aliyun-specific
 * branching in its result handling.
 *
 * Idempotency is NOT re-implemented here — it is enforced once, upstream, by
 * t.plan.channel.filterUnpublished() (slug → channel_plan publish log), as for csdn.
 *
 * @param {object} opts
 * @param {string} [opts.mdFile]      source markdown file
 * @param {string} [opts.contentMd]   or inline markdown
 * @param {string} [opts.title]       override title (else taken from the leading H1)
 * @param {boolean} [opts.publish]    attempt a live publish (blocked by captcha)
 * @param {boolean} [opts.dryRun]     validate without calling the API
 * @param {string} [opts.abstract]    override abstract
 * @param {string|null} [opts.draftId] update an existing draft
 */
async function publishAliyun({
  mdFile = null,
  contentMd = null,
  title = null,
  publish = false,
  dryRun = false,
  abstract = '',
  draftId = null,
} = {}) {
  const { cookie } = creds();
  if (!cookie) {
    console.log('❌ ALIYUN_COOKIE not found in .env');
    throw new Error('ALIYUN_COOKIE_MISSING');
  }
  if (contentMd == null && !mdFile) {
    throw new Error('publishAliyun requires either mdFile or contentMd');
  }

  const raw = contentMd != null ? contentMd : fs.readFileSync(mdFile, 'utf-8');
  const cleanedMd = raw.replace(/^---\n[\s\S]*?\n---\n?/, ''); // strip front matter
  const bodyMd = stripLeadingTitleHeading(cleanedMd).trim();

  if (!title) {
    const m = cleanedMd.match(/^#\s+(.+)$/m);
    title = m ? m[1].trim() : path.basename(mdFile || 'article', '.md');
  }
  let titleTrimmed = false;
  if (title.length > ALIYUN_TITLE_MAX) {
    title = title.slice(0, ALIYUN_TITLE_MAX);
    titleTrimmed = true;
  }

  const resolvedAbstract = abstract || deriveAbstract(bodyMd);

  console.log(`📝 Title: ${title}${titleTrimmed ? ' (trimmed)' : ''}`);
  console.log(`📄 Abstract: ${resolvedAbstract.slice(0, 60)}…`);

  if (dryRun) {
    console.log(`🔍 [dryRun] would save to Aliyun draft box: ${title}`);
    return { dryRun: true, title, titleTrimmed, skipped: false };
  }

  console.log(`📤 ${draftId ? 'Updating' : 'Creating'} draft on Aliyun…`);
  const data = await putDraft({
    title,
    content: bodyMd,
    abstractContent: resolvedAbstract,
    aid: draftId,
  });
  const aid = String(data.aid || draftId || '');
  console.log(`✅ Aliyun draft saved! Draft ID: ${aid}`);
  console.log(`🔗 ${EDITOR_URL}?edit=${aid}`);

  const result = {
    draftId: aid,
    articleId: null,
    url: `${EDITOR_URL}?edit=${aid}`,
    published: false,
    title,
    titleTrimmed,
    abstract: resolvedAbstract,
  };

  if (!publish) return result;

  // Publish attempt. Expected to be refused by risk control unless the platform
  // has skipSlider enabled for this account — see the file header.
  console.log('📤 Attempting live publish on Aliyun…');
  const pub = await publishArticle({
    title,
    content: bodyMd,
    abstractContent: resolvedAbstract,
    draftId: aid,
  });
  if (!pub.ok) {
    const gated = pub.code === PUBLISH_GATED_CODE;
    console.log(`❌ Aliyun publish refused: ${pub.code} ${pub.msg}`);
    if (gated) {
      console.log('   → 该平台发布前需人工通过验证码（skipSlider 未开启），草稿已保留，请在编辑器手动发布。');
    }
    return {
      ...result,
      failed: true,
      stage: 'publish',
      error: pub.msg,
      code: pub.code,
      publishGated: gated,
    };
  }
  const articleId = String((pub.data && (pub.data.articleId || pub.data)) || '');
  console.log(`✅ Aliyun published! Article ID: ${articleId}`);
  return { ...result, articleId, published: true, url: `https://${HOST}/article/${articleId}` };
}

module.exports = {
  // env / plumbing
  creds,
  harvestCsrf,
  request,
  rawRequest,
  unwrap,
  stripLeadingTitleHeading,
  deriveAbstract,
  // read
  getUser,
  listDrafts,
  draftDetail,
  getArticle,
  // write
  putDraft,
  publishArticle,
  deleteDraft,
  deleteArticle,
  // orchestration
  publishAliyun,
  // constants (consumed by channel.js / MCP tools)
  ALIYUN_TITLE_MAX,
  ALIYUN_ABSTRACT_MAX,
  ARTICLE_TYPE,
  PUBLISH_GATED_CODE,
};
