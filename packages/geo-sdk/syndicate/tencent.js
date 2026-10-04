'use strict';
/**
 * Tencent Cloud Developer Community publishing (tengence-geo-sdk/syndicate/tencent)
 * ============================================================================
 * The Tencent Cloud channel, shaped to mirror syndicate/aliyun.js so that
 * syndicate/channel.js treats both the same way.
 *
 * WHY COOKIE AND NOT AN OFFICIAL API
 *   cloud.tencent.com/developer exposes no public writing OpenAPI. The working path
 *   is the same set of endpoints the community editor itself calls. Operationally
 *   this is still "paste one Cookie" — same cost as CSDN / Juejin / Aliyun.
 *
 * ENDPOINT SOURCE (2026-09-27, reverse-read from the official editor bundle, then
 * end-to-end verified with a real Cookie: create → edit → publish → read → delete)
 *   The editor is a Next.js app; its chunks live at
 *     https://qccommunity.qcloudimg.com/community/_next/static/chunks/*.js
 *   and module 45968 holds the article API table, module 33584 the publish payload.
 *
 *   Base: https://cloud.tencent.com/developer   — every call is POST + JSON
 *   - 草稿  POST /api/article/addArticleDraft   → {draftId}
 *          POST /api/article/editArticleDraft   (需带 draftId **且完整载荷**)
 *          POST /api/article/getDraftDetail     {draftId}
 *          POST /api/article/getUserArticleDrafts {page, pageSize}
 *          POST /api/article/deleteUserArticleDrafts {draftId}   ← 单数，不是 draftIds
 *   - 文章  POST /api/article/addArticle        → {articleId, status}
 *          POST /api/article/editArticle        (带 articleId)
 *   - 字典  POST /api/column/get-classify-list-by-scene {scene:1} → 24 个分类
 *          POST /api/tag/search {keyword, limit} → [{tagId, tagName}]
 *          POST /api/column/getColumnsByUser {uid, needReadNum:1} → 我的专栏
 *          POST /api/common/check-article-classify-manager → {hasUpdateArticlePrivilege}
 *          POST /api/creator/getRecentArticles {page, pageSize}
 *   - 图片(当前不需要) POST /api/common/cos/upload-info {scene,extension}
 *                     POST /api/common/cos/tmp-secret {objectKey}
 *
 * AUTH
 *   Cookie header + Origin + Referer only. **No CSRF** (unlike Aliyun, which needs
 *   c_csrf + p_csrf + X-XSRF-TOKEN) — verified 2026-09-27.
 *
 * Env vars (sites/<site>/.env, injected by t.site.loadSite()):
 *   TENCENT_COOKIE        (required) login cookie
 *   TENCENT_CLASSIFY_IDS  (optional) comma-separated 分类 id，如 "16"（16=架构设计）
 *   TENCENT_TAG_IDS       (optional) comma-separated 标签 id 兜底（平台要求标签 ≥1）
 *   TENCENT_COLUMN_IDS    (optional) comma-separated 专栏 id；未建专栏时留空即可
 *   TENCENT_SOURCE_TYPE   (optional) 1 原创(default) / 2 转载 / 3 翻译
 *
 * ✅ PUBLISH IS NOT HUMAN-GATED (2026-09-27, verified with a real article)
 *   `article/addArticle` succeeds server-side — no captcha, no slider, no token:
 *     → {"articleId": 2751864, "status": 0}
 *   BUT the article then enters the platform's REVIEW queue: the article page renders
 *   「审核中」. Status enum (from the bundle): PENDING_APPROVAL 0 / NORMAL 1 /
 *   REJECT 2 / BANNED 3 / TO_BE_ADOPTED 4.
 *   => publishTencent() defaults to `publish:false` (draft box) to match the Aliyun
 *      contract, but `publish:true` WILL go live into review. `publishGated:false`.
 *
 * 🖼️ MAIN IMAGE (cover) — verified 2026-09-27, and much simpler than Aliyun
 *   The `pic` field accepts an ARBITRARY EXTERNAL URL and persists it verbatim —
 *   verified with both a foreign CDN jpg and this site's own **.webp**, read back
 *   identically from getDraftDetail, and rendered on the published article page.
 *   => NO upload step at all (Aliyun/CSDN both force a re-upload to their own CDN).
 *   The COS upload path (upload-info → tmp-secret → COS PUT) is kept in the notes
 *   below as a fallback should the platform ever tighten this.
 *
 * ⚠️ PAYLOAD GOTCHA (this is where third-party write-ups are wrong)
 *   The body field is NOT `markdownContent`. It is:
 *     content = "<!--markdown-->\n" + markdown + "\n<!--/markdown-->"
 *   plus `plain` (markdown with ALL whitespace stripped, sliced to 50000) and
 *   `summary`. And the publish switches are `banComment` (= openComment ? 0 : 1)
 *   and `closeArticleTextLink` — NOT `openComment` / `closeTextLink`.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const HOST = 'cloud.tencent.com';
const BASE = `https://${HOST}/developer`;
const EDITOR_URL = `${BASE}/article/write-new`;
const ARTICLE_URL = `${BASE}/article`;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Conservative default — the platform publishes no documented title limit. */
const TENCENT_TITLE_MAX = 100;
/** Enforced by the editor textarea (maxLength=200). */
const TENCENT_ABSTRACT_MAX = 200;
/** Enforced by the editor: 「文章内容不能少于 140 字」/「不能大于 50000 字」 */
const TENCENT_BODY_MIN = 140;
const TENCENT_BODY_MAX = 50000;
/** Editor drawer limits: 分类 ≤3、标签 ≤5、长尾标签 ≤5 */
const TENCENT_MAX_CLASSIFY = 3;
const TENCENT_MAX_TAGS = 5;
const TENCENT_MAX_LONGTAIL = 5;

/** 文章来源（编辑器下拉）；原创时 sourceDetail 传 undefined */
const SOURCE_TYPE = { original: 1, reproduced: 2, translated: 3, other: 99 };

/**
 * Article status, read off `articleInfo.status` (bundle enum, chunk c32.js):
 *   { PENDING_APPROVAL:0 → 审核中, NORMAL:2 → 正常, REJECTED:3 → 未通过, DELETED:5 → 已删除 }
 *
 * ⚠️ CORRECTED 2026-09-27: an earlier version used a DIFFERENT enum found in
 * c33.js ({TO_BE_AUDIT:0, NORMAL:1, REJECT:2, BANNED:3, TO_BE_ADOPTED:4}), which
 * reads status 3 as 被封禁. That is wrong for articles — verified against
 * `POST /api/creator/articleListNum` → {reject:1, pass:0, pending:0} while
 * articleInfo.status was 3, and an anonymous fetch of the article page returned
 * HTTP 404 「不存在」. So 3 = REJECTED (未通过), and 已发布 is 2 (not 1).
 * Several enums coexist in the bundle; this one is the article-level one.
 */
const ARTICLE_STATUS = {
  PENDING_APPROVAL: 0,
  NORMAL: 2,
  REJECTED: 3,
  DELETED: 5,
};

/** Read Tencent credentials from injected env. */
function creds() {
  return {
    cookie: process.env.TENCENT_COOKIE || '',
    classifyIds: ids(process.env.TENCENT_CLASSIFY_IDS),
    tagIds: ids(process.env.TENCENT_TAG_IDS),
    columnIds: ids(process.env.TENCENT_COLUMN_IDS),
    sourceType: Number(process.env.TENCENT_SOURCE_TYPE || SOURCE_TYPE.original),
  };
}

/** "1,2,3" → [1,2,3] (tolerant; empty → []) */
function ids(v) {
  return String(v || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * One raw call. Resolves {statusCode, headers, body, json}.
 * @param {string} apiPath e.g. '/api/article/addArticleDraft'
 * @param {{body?:object|null}} [opts]
 */
function request(apiPath, { body = null } = {}) {
  const { cookie } = creds();
  if (!cookie) throw new Error('TENCENT_COOKIE_MISSING');

  const headers = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-cn,zh;q=0.9',
    'user-agent': UA,
    cookie,
    origin: `https://${HOST}`,
    referer: EDITOR_URL,
    'content-type': 'application/json',
  };
  const payload = JSON.stringify(body == null ? {} : body);
  headers['content-length'] = Buffer.byteLength(payload);

  return new Promise((resolve, reject) => {
    const req = https.request(`${BASE}${apiPath}`, { method: 'POST', headers }, (res) => {
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
    req.setTimeout(40000, () => req.destroy(new Error('TENCENT_REQUEST_TIMEOUT')));
    req.write(payload);
    req.end();
  });
}

/**
 * Normalise a Tencent response into {ok, code, msg, data}.
 * The platform answers HTTP 200 even for failures — success must be read from the
 * BODY. Successful bodies carry no `code` at all ({} / {draftId} / {articleId,status}),
 * failures carry `code` (400 「参数错误」, 51 「参数有误」 …) alongside `msg`.
 */
function unwrap(res) {
  const j = res && res.json ? res.json : null;
  if (!j) {
    return { ok: false, code: String(res ? res.statusCode : 0), msg: 'non-JSON response', data: null };
  }
  const code = j.code === undefined || j.code === null ? null : String(j.code);
  if (code !== null && Number(code) !== 0) {
    return { ok: false, code, msg: j.msg || 'request failed', data: null };
  }
  return { ok: true, code: '0', msg: j.msg || '', data: j };
}

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

/** Drop one or more leading `# Title` lines (the platform renders the title itself). */
function stripLeadingTitleHeading(md) {
  if (!md) return md;
  return md.replace(/^(?:#\s+[^\n]*\r?\n)+/, '');
}

/** Best-effort abstract (≤200 chars); prefers a `> **摘要**：…` callout. */
function deriveAbstract(md) {
  if (!md) return '';
  const brief = md.match(/^>\s*\*\*摘要\*\*[：:](.+)$/m);
  const raw = brief
    ? brief[1].trim()
    : md.replace(/^#\s+.+$/m, '').replace(/[#>*`\-[\]()!]/g, ' ').replace(/\s+/g, ' ').trim();
  return raw.slice(0, TENCENT_ABSTRACT_MAX);
}

/** The platform's `plain` field: markdown with ALL whitespace removed. */
function toPlain(md) {
  return String(md || '').replace(/\s+/g, '').slice(0, TENCENT_BODY_MAX);
}

/** The platform's `content` field: markdown wrapped in its own markers. */
function toContent(md) {
  return `<!--markdown-->\n${md}\n<!--/markdown-->`;
}

// ---------------------------------------------------------------------------
// Read / dictionaries
// ---------------------------------------------------------------------------

/** 分类字典（scene 1 = 文章）→ [{id, name, …}] */
async function listClassify() {
  const r = unwrap(await request('/api/column/get-classify-list-by-scene', { body: { scene: 1 } }));
  return (r.data && r.data.list) || [];
}

/** 标签搜索 → [{tagId, tagName}] */
async function searchTags(keyword, limit = 10) {
  const r = await request('/api/tag/search', { body: { keyword, limit } });
  return Array.isArray(r.json) ? r.json : [];
}

/**
 * Resolve free-text tags to platform tag ids via tag/search.
 * Unmatched keywords are dropped silently (the platform needs ≥1, caller guards).
 * @param {string[]} keywords
 * @returns {Promise<number[]>}
 */
async function resolveTagIds(keywords) {
  const out = [];
  for (const kw of keywords || []) {
    if (!kw) continue;
    const hit = await searchTags(kw, 5);
    const exact = hit.find((x) => x.tagName === kw) || hit[0];
    if (exact && exact.tagId && !out.includes(Number(exact.tagId))) out.push(Number(exact.tagId));
    if (out.length >= TENCENT_MAX_TAGS) break;
  }
  return out;
}

/** 我的专栏 → [{columnId, …}]；未建专栏时为空数组 */
async function listColumns(uid) {
  if (!uid) return [];
  const r = await request('/api/column/getColumnsByUser', { body: { uid, needReadNum: 1 } });
  return (r.json && r.json.list) || [];
}

/** 是否分类管理员 —— 为 true 时 classifyIds 才是必填 */
async function isClassifyManager() {
  const r = await request('/api/common/check-article-classify-manager', { body: {} });
  return !!(r.json && r.json.hasUpdateArticlePrivilege);
}

/** 草稿列表 → {list, total} */
async function listDrafts({ page = 1, pageSize = 20 } = {}) {
  const r = unwrap(await request('/api/article/getUserArticleDrafts', { body: { page, pageSize } }));
  if (!r.ok) throw new Error(`TENCENT_LIST_FAILED ${r.code} ${r.msg}`);
  return { list: (r.data && r.data.list) || [], total: Number((r.data && r.data.total) || 0) };
}

/** 草稿详情 */
async function draftDetail(draftId) {
  const r = unwrap(await request('/api/article/getDraftDetail', { body: { draftId: Number(draftId) } }));
  if (!r.ok) throw new Error(`TENCENT_DRAFT_DETAIL_FAILED ${r.code} ${r.msg}`);
  return r.data || {};
}

/** 已发布文章（近期） */
async function listRecentArticles({ page = 1, pageSize = 20 } = {}) {
  const r = unwrap(await request('/api/creator/getRecentArticles', { body: { page, pageSize } }));
  if (!r.ok) throw new Error(`TENCENT_RECENT_FAILED ${r.code} ${r.msg}`);
  return { list: (r.data && r.data.list) || [], total: Number((r.data && r.data.total) || 0) };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Build the platform payload. Shared by draft (add/edit) and publish so the two
 * can never drift apart.
 *
 * NOTE: editArticleDraft rejects PARTIAL payloads with 400 「参数错误」 — always
 * send every field, which is why this helper exists.
 *
 * ⚠️ THE COMMENT SWITCHES ARE NAMED DIFFERENTLY PER MODE (verified 2026-09-27):
 *      draft   → openComment / closeTextLink
 *      publish → banComment  / closeArticleTextLink
 *    Sending the publish names on a draft call is rejected with 400 「参数错误」.
 *
 * @param {'draft'|'publish'} [opts.mode]
 */
function buildPayload({
  title,
  contentMd,
  plain,
  abstract,
  coverUrl = null,
  classifyIds = [],
  tagIds = [],
  longtailTag = [],
  columnIds = [],
  sourceType = null,
  openComment = true,
  closeTextLink = false,
  mode = 'draft',
} = {}) {
  const { classifyIds: envClassify, tagIds: envTags, columnIds: envColumns, sourceType: envType } = creds();
  const forPublish = mode === 'publish';
  const body = {
    title,
    content: toContent(contentMd),
    plain: plain != null ? plain : toPlain(contentMd),
    columnIds: (columnIds.length ? columnIds : envColumns).slice(0, 9),
    classifyIds: (classifyIds.length ? classifyIds : envClassify).slice(0, TENCENT_MAX_CLASSIFY),
    sourceType: Number(sourceType || envType || SOURCE_TYPE.original),
    tagIds: (tagIds.length ? tagIds : envTags).slice(0, TENCENT_MAX_TAGS),
    longtailTag: (longtailTag || []).slice(0, TENCENT_MAX_LONGTAIL),
    // 原创时服务端不接受 sourceDetail；转载/翻译才需要 {link, author}
    sourceDetail: undefined,
    pic: coverUrl || '',
    userSummary: abstract,
    zoneName: '',
    vlogIds: [],
    summary: abstract,
  };
  if (forPublish) {
    body.banComment = openComment ? 0 : 1;
    body.closeArticleTextLink = closeTextLink ? 1 : 0;
  } else {
    body.openComment = openComment ? 1 : 0;
    body.closeTextLink = closeTextLink ? 1 : 0;
  }
  return body;
}

/**
 * Create a draft.
 * @returns {Promise<number>} draftId
 */
async function putDraft(payload) {
  const r = unwrap(await request('/api/article/addArticleDraft', { body: { ...payload, articleId: 0 } }));
  if (!r.ok) throw new Error(`TENCENT_DRAFT_FAILED ${r.code} ${r.msg}`);
  return Number(r.data && r.data.draftId);
}

/**
 * Update an existing draft. MUST receive the complete payload — partial updates
 * are rejected with 400 「参数错误」 (verified 2026-09-27).
 */
async function editDraft(draftId, payload) {
  const r = unwrap(await request('/api/article/editArticleDraft', {
    body: { ...payload, draftId: Number(draftId) },
  }));
  if (!r.ok) throw new Error(`TENCENT_DRAFT_EDIT_FAILED ${r.code} ${r.msg}`);
  return Number(draftId);
}

/**
 * Publish (draft → live, then into the review queue).
 * @returns {Promise<{articleId:number, status:number, raw:object}>}
 */
async function publishArticle(draftId, payload) {
  const r = unwrap(await request('/api/article/addArticle', {
    body: { ...payload, draftId: Number(draftId) || 0 },
  }));
  if (!r.ok) throw new Error(`TENCENT_PUBLISH_FAILED ${r.code} ${r.msg}`);
  const data = r.data || {};
  return { articleId: Number(data.articleId || 0), status: Number(data.status), raw: data };
}

/** Update an already published article (needs its articleId). */
async function updateArticle(articleId, payload) {
  const r = unwrap(await request('/api/article/editArticle', {
    body: { ...payload, articleId: Number(articleId) },
  }));
  if (!r.ok) throw new Error(`TENCENT_ARTICLE_EDIT_FAILED ${r.code} ${r.msg}`);
  return Number(articleId);
}

/** Delete a draft. NOTE: the parameter is the SINGULAR `draftId`. */
async function deleteDraft(draftId) {
  const r = unwrap(await request('/api/article/deleteUserArticleDrafts', { body: { draftId: Number(draftId) } }));
  if (!r.ok) throw new Error(`TENCENT_DRAFT_DELETE_FAILED ${r.code} ${r.msg}`);
  return true;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Publish one article to Tencent Cloud Developer Community.
 *
 * Return shape is identical to publishAliyun / publishCsdn so that
 * syndicate/channel.js needs no platform-specific branch on the result.
 *
 * @param {string}  [opts.mdFile]         source markdown file
 * @param {string}  [opts.contentMd]      markdown string (alternative to mdFile)
 * @param {string}  [opts.title]          override title
 * @param {boolean} [opts.publish]        false → draft box only (default)
 * @param {boolean} [opts.dryRun]         validate without calling the API
 * @param {string}  [opts.abstract]       override abstract
 * @param {number}  [opts.draftId]        update an existing draft
 * @param {string}  [opts.coverUrl]       main image — ANY external url works (verified)
 * @param {string[]}[opts.tags]           free-text tags, resolved via tag/search
 * @param {number[]}[opts.tagIds]         explicit platform tag ids (skip resolution)
 * @param {number[]}[opts.classifyIds]    explicit 分类 ids
 * @param {string[]}[opts.longtailTag]    free-text 长尾标签
 */
async function publishTencent({
  mdFile = null,
  contentMd = null,
  title = null,
  publish = false,
  dryRun = false,
  abstract = '',
  draftId = null,
  coverUrl = null,
  tags = null,
  tagIds = null,
  classifyIds = null,
  longtailTag = null,
} = {}) {
  const { cookie } = creds();
  if (!cookie) {
    console.log('❌ TENCENT_COOKIE not found in .env');
    throw new Error('TENCENT_COOKIE_MISSING');
  }
  if (contentMd == null && !mdFile) {
    throw new Error('publishTencent requires either mdFile or contentMd');
  }

  const raw = contentMd != null ? contentMd : fs.readFileSync(mdFile, 'utf-8');
  const cleanedMd = raw.replace(/^---\n[\s\S]*?\n---\n?/, ''); // strip front matter
  const bodyMd = stripLeadingTitleHeading(cleanedMd).trim();

  if (!title) {
    const m = cleanedMd.match(/^#\s+(.+)$/m);
    title = m ? m[1].trim() : path.basename(mdFile || 'article', '.md');
  }
  let titleTrimmed = false;
  if (title.length > TENCENT_TITLE_MAX) {
    title = title.slice(0, TENCENT_TITLE_MAX);
    titleTrimmed = true;
  }

  const resolvedAbstract = String(abstract || deriveAbstract(bodyMd)).slice(0, TENCENT_ABSTRACT_MAX);
  const plain = toPlain(bodyMd);

  console.log(`📝 Title: ${title}${titleTrimmed ? ' (trimmed)' : ''}`);
  console.log(`📄 Abstract: ${resolvedAbstract.slice(0, 60)}…`);

  // ---- platform-side validation, mirrored from the editor so failures are local ----
  const problems = [];
  if (plain.length < TENCENT_BODY_MIN) problems.push(`正文少于 ${TENCENT_BODY_MIN} 字（当前 ${plain.length}）`);
  if (plain.length > TENCENT_BODY_MAX) problems.push(`正文超过 ${TENCENT_BODY_MAX} 字（当前 ${plain.length}）`);
  if (!resolvedAbstract.trim()) problems.push('摘要为空');

  let resolvedTagIds = (tagIds || []).map(Number).filter(Boolean);
  if (!resolvedTagIds.length && tags && tags.length) {
    try {
      resolvedTagIds = await resolveTagIds(tags);
    } catch (e) {
      console.log(`⚠️  标签解析失败（不影响投稿，将回退到环境变量）：${e.message}`);
    }
  }
  if (!resolvedTagIds.length) resolvedTagIds = creds().tagIds;
  if (!resolvedTagIds.length) problems.push('平台要求至少 1 个标签（传 tags，或配置 TENCENT_TAG_IDS）');

  if (problems.length) {
    console.log(`❌ 腾讯云投稿前校验未通过：\n   - ${problems.join('\n   - ')}`);
    return { failed: true, stage: 'validate', error: problems.join('; '), title, titleTrimmed };
  }

  if (dryRun) {
    console.log(`🔍 [dryRun] would save to Tencent Cloud draft box: ${title}`);
    return { dryRun: true, title, titleTrimmed, skipped: false };
  }

  const payloadCommon = {
    title,
    contentMd: bodyMd,
    plain,
    abstract: resolvedAbstract,
    coverUrl,
    classifyIds: classifyIds || [],
    tagIds: resolvedTagIds,
    longtailTag: longtailTag || [],
  };
  const draftPayload = buildPayload({ ...payloadCommon, mode: 'draft' });
  const publishPayload = buildPayload({ ...payloadCommon, mode: 'publish' });

  // ---- draft ----
  let aid = draftId ? Number(draftId) : null;
  if (aid) {
    console.log(`📤 Updating Tencent Cloud draft ${aid}…`);
    await editDraft(aid, draftPayload);
  } else {
    console.log('📤 Creating Tencent Cloud draft…');
    aid = await putDraft(draftPayload);
  }
  console.log(`✅ Tencent Cloud draft saved! Draft ID: ${aid}`);
  console.log(`🔗 ${EDITOR_URL}?draftId=${aid}`);

  const result = {
    draftId: aid,
    articleId: null,
    url: `${EDITOR_URL}?draftId=${aid}`,
    published: false,
    title,
    titleTrimmed,
    abstract: resolvedAbstract,
    coverUrl: coverUrl || null,
    tags: resolvedTagIds,
  };

  if (!publish) return result;

  // ---- publish ----
  // Not human-gated (verified): no captcha, no slider. The article lands in the
  // platform's review queue with status PENDING_APPROVAL(0).
  console.log('📤 Publishing on Tencent Cloud…');
  try {
    const pub = await publishArticle(aid, publishPayload);
    const url = `${ARTICLE_URL}/${pub.articleId}`;
    console.log(`✅ Tencent Cloud published! Article ID: ${pub.articleId}`);
    console.log(`🔗 ${url}`);
    if (pub.status === ARTICLE_STATUS.PENDING_APPROVAL) {
      console.log('   → 已进入平台审核队列（status=0 审核中），过审后自动公开，无需人工点发布。');
    }
    return {
      ...result,
      articleId: pub.articleId,
      published: true,
      url,
      status: pub.status,
      underReview: pub.status === ARTICLE_STATUS.PENDING_APPROVAL,
    };
  } catch (e) {
    console.log(`❌ Tencent Cloud publish failed: ${e.message}`);
    return { ...result, failed: true, stage: 'publish', error: e.message };
  }
}

module.exports = {
  // env / plumbing
  creds,
  request,
  unwrap,
  stripLeadingTitleHeading,
  deriveAbstract,
  toPlain,
  toContent,
  // dictionaries
  listClassify,
  searchTags,
  resolveTagIds,
  listColumns,
  isClassifyManager,
  // read
  listDrafts,
  draftDetail,
  listRecentArticles,
  // write
  buildPayload,
  putDraft,
  editDraft,
  publishArticle,
  updateArticle,
  deleteDraft,
  // orchestration
  publishTencent,
  // constants (consumed by channel.js / MCP tools)
  TENCENT_TITLE_MAX,
  TENCENT_ABSTRACT_MAX,
  TENCENT_BODY_MIN,
  TENCENT_BODY_MAX,
  SOURCE_TYPE,
  ARTICLE_STATUS,
  EDITOR_URL,
  ARTICLE_URL,
};
