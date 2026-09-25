'use strict';
/**
 * Juejin publishing (tengence-geo-sdk/syndicate/juejin)
 * ============================================================================
 * Sunk down from commands/publish-juejin.js on 2026-09-20: the HTTP helper (native
 * https/http), and the three-step create-draft / write-body / publish orchestration
 * all moved into this file. The CLI only parses <markdown_file> and
 * --title / --draft / --publish, and owns the exit code.
 *
 * Env vars (sites/<site>/.env, injected by t.site.loadSite()):
 *   JUEJIN_COOKIE  (required) session cookie
 *   JUEJIN_UID     (required) account user_id — used in create/update/list payloads
 *   JUEJIN_AID     (optional) API aid, default 2608
 *
 * Additions 2026-09-25 (掘金渠道完整化):
 *   - 查: listDrafts / listPublished / getDraft (read-back of drafts & published)
 *   - 删: deleteDraft / deleteArticle  (IRREVERSIBLE — caller must confirm)
 *   - 定时: publishArticle accepts optional publish_time (server-side schedule;
 *           the MCP server itself never schedules — an external harness triggers it)
 *   - 幂等: isDuplicate(title) checks juejin drafts+published before publishing
 *   - 去硬编码: user_id / aid read from env, no longer hard-coded
 *   - 标签: best-effort tag_ids resolution from article target_keywords
 *
 * Additions 2026-09-26 (平台词表 + 显式覆盖):
 *   - listCategories / listAllTags: fetch the platform's OWN category (~8) and tag
 *     (~725, offset-paginated) dictionaries, cached into channel_taxonomy so every
 *     site resolves names → ids without its own config file.
 *   - createDraft / updateDraft / publishJuejin accept an explicit categoryId and
 *     tagIds override, which take priority over the env defaults.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const JUEJIN_AID_DEFAULT = '2608';

/** Read juejin credentials from injected env. */
function creds() {
  return {
    cookie: process.env.JUEJIN_COOKIE || '',
    uid: process.env.JUEJIN_UID || '',
    aid: process.env.JUEJIN_AID || JUEJIN_AID_DEFAULT,
    // Required at publish time — Juejin rejects an article with category_id '0'
    // (err_no 1002 "至少添加一个分类"). Default to 人工智能 (AI) for this tech blog;
    // override per-site via JUEJIN_CATEGORY_ID.
    categoryId: process.env.JUEJIN_CATEGORY_ID || '6809637773935378440',
    // Fallback tag when the article carries no target_keywords (or none resolve to a
    // Juejin tag). Juejin requires ≥1 tag at publish (err_no 1003). Default 人工智能.
    defaultTagId: process.env.JUEJIN_TAG_ID || '6809640642101116936',
  };
}

// HTTP request helper (native, mirrors the original script)
function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = mod.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ raw: data, statusCode: res.statusCode });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Build default headers (Cookie injected from env). */
function jHeaders(referer, extra = {}) {
  const { cookie, aid } = creds();
  return {
    Cookie: cookie,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    Referer: referer || 'https://juejin.cn/',
    'content-type': 'application/json',
    aid,
    ...extra,
  };
}

// Create draft (empty). categoryId overrides the env default (resolved taxonomy).
async function createDraft(title, tagIds = [], categoryId = null) {
  const { uid, categoryId: envCategoryId } = creds();
  const url = 'https://api.juejin.cn/content_api/v1/article_draft/create';
  const payload = {
    title,
    column_id: '0',
    tags: [],
    tag_ids: tagIds || [],
    category_id: categoryId || envCategoryId,
    cover_image: '',
    is_english: 0,
    user_id: uid,
  };
  return request(url, { method: 'POST', headers: jHeaders('https://juejin.cn/editor/drafts/new') }, payload);
}

// Extract brief content from blockquote
function extractBrief(content) {
  const match = content.match(/^> \*\*摘要\*\*：(.+)$/m);
  if (match) return match[1].trim();
  return content.replace(/^#.+\n/, '').substring(0, 100).trim();
}

// Update draft with content. categoryId overrides the env default.
async function updateDraft(draftId, title, content, tagIds = [], categoryId = null) {
  const { uid, categoryId: envCategoryId } = creds();
  const url = 'https://api.juejin.cn/content_api/v1/article_draft/update';
  const payload = {
    id: draftId,
    title,
    mark_content: content,
    brief_content: extractBrief(content),
    html_content: 'deprecated',
    column_id: '0',
    tags: [],
    tag_ids: tagIds || [],
    category_id: categoryId || envCategoryId,
    cover_image: '',
    is_english: 0,
    is_original: 1,
    edit_type: 10,
    user_id: uid,
  };
  return request(url, { method: 'POST', headers: jHeaders(`https://juejin.cn/editor/drafts/${draftId}`) }, payload);
}

// Publish a draft (optionally scheduled via publish_time)
async function publishArticle(draftId, publishTime = null, tagIds = []) {
  const url = 'https://api.juejin.cn/content_api/v1/article/publish';
  const payload = { draft_id: draftId, tag_ids: tagIds || [] };
  if (publishTime) payload.publish_time = publishTime;
  return request(url, { method: 'POST', headers: jHeaders(`https://juejin.cn/editor/drafts/${draftId}`) }, payload);
}

// ----------------------------- 查 (read-back) -----------------------------

/** List drafts (paginated). Returns the raw API response (err_no / data[]). */
async function listDrafts(page = 0, pageSize = 20) {
  const { uid } = creds();
  const payload = { user_id: uid, page_size: pageSize, page_no: page, sort_type: 0 };
  return request(
    'https://api.juejin.cn/content_api/v1/article_draft/list_by_user',
    { method: 'POST', headers: jHeaders() },
    payload
  );
}

/** List published articles (paginated). Returns the raw API response. */
async function listPublished(page = 0, pageSize = 20) {
  const { uid } = creds();
  const payload = { user_id: uid, page_size: pageSize, page_no: page, sort_type: 0 };
  return request(
    'https://api.juejin.cn/content_api/v1/article/list_by_user',
    { method: 'POST', headers: jHeaders() },
    payload
  );
}

/** Fetch one draft's detail. */
async function getDraft(draftId) {
  return request(
    'https://api.juejin.cn/content_api/v1/article_draft/get',
    { method: 'POST', headers: jHeaders() },
    { id: draftId }
  );
}

// ----------------------------- 删 (delete) -----------------------------

/** Delete a draft. IRREVERSIBLE. */
async function deleteDraft(draftId) {
  return request(
    'https://api.juejin.cn/content_api/v1/article_draft/delete',
    { method: 'POST', headers: jHeaders() },
    { draft_id: draftId }
  );
}

/** Delete a published article. IRREVERSIBLE. */
async function deleteArticle(articleId) {
  return request(
    'https://api.juejin.cn/content_api/v1/article/delete',
    { method: 'POST', headers: jHeaders() },
    { article_id: articleId }
  );
}

// ----------------------------- 幂等 / 标签 -----------------------------

/** True if a juejin draft or published article already carries this (normalized) title. */
async function isDuplicate(title) {
  const norm = (s) => (s || '').trim().toLowerCase();
  const target = norm(title);
  if (!target) return false;
  const matchItems = (resp) => {
    const data = resp && resp.data;
    const items = Array.isArray(data) ? data : data && Array.isArray(data.data) ? data.data : [];
    return items.some(
      (it) => norm(it.title) === target || norm(it.article_info && it.article_info.title) === target
    );
  };
  try {
    if (matchItems(await listDrafts(0, 50))) return true;
    if (matchItems(await listPublished(0, 50))) return true;
  } catch (e) {
    // network/parse error → assume not duplicate, let the publish attempt proceed
  }
  return false;
}

/** Best-effort: map keyword strings → juejin tag_ids (empty on any failure). */
async function resolveTagIds(keywords) {
  const { defaultTagId } = creds();
  if (!keywords || !keywords.length) return [defaultTagId];
  try {
    const { uid, aid } = creds();
    const url = `https://api.juejin.cn/tag_api/v1/query_tag_list?aid=${aid}&uuid=${uid}&spider=0`;
    const resp = await request(url, { method: 'GET', headers: jHeaders() });
    const tags = (resp && resp.data) || [];
    const ids = [];
    for (const kw of keywords) {
      const k = (kw || '').trim().toLowerCase();
      if (!k) continue;
      const hit = tags.find((t) => {
        const n = (t.name || '').toLowerCase();
        return n && (n.includes(k) || k.includes(n));
      });
      if (hit && hit.tag_id) ids.push(hit.tag_id);
    }
    // Juejin requires ≥1 tag; fall back to the configured default when nothing resolved.
    return ids.length ? ids.slice(0, 5) : [defaultTagId];
  } catch (e) {
    return [defaultTagId];
  }
}

// ----------------------------- 词表 (taxonomy dictionary) -----------------------------

/**
 * Fetch the platform's category list (POST tag_api/v1/query_category_list).
 * Juejin has 8 fixed categories (后端/前端/Android/iOS/人工智能/开发工具/代码人生/阅读).
 * @returns {Promise<Array<{external_id:string, name:string}>>}
 */
async function listCategories() {
  const resp = await request(
    'https://api.juejin.cn/tag_api/v1/query_category_list',
    { method: 'POST', headers: jHeaders() },
    {}
  );
  const data = (resp && resp.data) || [];
  return data
    .map((c) => ({
      external_id: String(c.category_id || (c.category && c.category.category_id) || ''),
      name: (c.category && c.category.category_name) || c.category_name || '',
      extra: c.category && c.category.ctime ? { ctime: c.category.ctime } : null,
    }))
    .filter((c) => c.external_id && c.name);
}

/**
 * Fetch the FULL tag dictionary, offset-paginated (~725 tags).
 * NOTE: the vendor API ignores a `keyword` filter, so the dictionary is the only
 * way to resolve a tag name → tag_id; the caller caches it (channel_taxonomy).
 * @returns {Promise<Array<{external_id:string, name:string, extra:object}>>}
 */
async function listAllTags() {
  const { uid, aid } = creds();
  const out = [];
  const seen = new Set();
  let cursor = 0;
  for (let guard = 0; guard < 100; guard += 1) {
    const resp = await request(
      'https://api.juejin.cn/tag_api/v1/query_tag_list',
      { method: 'POST', headers: jHeaders() },
      { aid: Number(aid), uuid: uid, spider: 0, cursor: String(cursor), limit: 100 }
    );
    const arr = (resp && resp.data) || [];
    if (!arr.length) break;
    for (const it of arr) {
      const tag = it.tag || it;
      const id = tag.tag_id || tag.id;
      const name = tag.tag_name || tag.name;
      if (!id || !name || seen.has(String(id))) continue;
      seen.add(String(id));
      out.push({
        external_id: String(id),
        name,
        parent_id: tag.category_id != null ? String(tag.category_id) : null,
        extra: tag.post_article_count != null ? { post_article_count: tag.post_article_count } : null,
      });
    }
    if (!resp.has_more) break;
    cursor += 100;
  }
  return out;
}

// ----------------------------- 主发布流程 -----------------------------

/**
 * Publish markdown to Juejin (creates a draft by default; --publish publishes).
 *
 * Taxonomy resolution order (first non-empty wins — see syndicate/juejin-taxonomy.js):
 *   1. explicit opts.tagIds / opts.categoryId (article-level override)
 *   2. opts.tags (keyword strings) → resolveTagIds best-effort
 *   3. the env defaults from creds() (JUEJIN_CATEGORY_ID / JUEJIN_TAG_ID)
 * Category and tag are BOTH required by Juejin (err_no 1002 / 1003), so this
 * function always sends at least the env default for each — it can never publish
 * an article without them.
 *
 * @param {{mdFile:string, title?:string|null, publish?:boolean, dryRun?:boolean,
 *          tags?:string[], tagIds?:string[], categoryId?:string|null}} opts
 *   tags    = article target_keywords (strings); resolved to tag_ids best-effort.
 *   tagIds  = already-resolved juejin tag_ids (bypasses resolution; takes priority).
 *   categoryId = already-resolved juejin category_id (overrides the env default).
 * @returns {Promise<{draftId?:string, articleId?:string, failed?:boolean, stage?:string, dryRun?:boolean, skipped?:boolean, taxonomy?:object}>}
 */
async function publishJuejin({ mdFile, title = null, publish = false, dryRun = false, tags = [], tagIds = null, categoryId = null }) {
  const { cookie, categoryId: envCategoryId, defaultTagId } = creds();
  if (!cookie) {
    console.log('❌ JUEJIN_COOKIE not found in .env');
    throw new Error('JUEJIN_COOKIE_MISSING');
  }

  const content = fs.readFileSync(mdFile, 'utf-8');
  if (!title) {
    const match = content.match(/^# (.+)$/m);
    title = match ? match[1].trim() : path.basename(mdFile, '.md');
  }
  const cleanedContent = content.replace(/^---\n[\s\S]*?\n---\n?/, '');

  // ---- taxonomy: explicit override → resolved ids → keyword resolution → env ----
  const resolvedCategoryId = categoryId || envCategoryId;
  let resolvedTagIds;
  if (Array.isArray(tagIds) && tagIds.length) {
    resolvedTagIds = tagIds;
  } else {
    resolvedTagIds = await resolveTagIds(tags);
  }
  const taxonomy = { categoryId: resolvedCategoryId, tagIds: resolvedTagIds, source: categoryId ? 'override' : 'env/resolved' };

  console.log(`📝 Title: ${title}`);
  console.log(`🏷️  Taxonomy: category_id=${resolvedCategoryId}, tag_ids=[${resolvedTagIds.join(', ')}]`);

  if (dryRun) {
    console.log(`🔍 [dryRun] would create draft then ${publish ? 'publish' : 'save as draft'} on Juejin: ${title}`);
    return { dryRun: true, title, skipped: false, taxonomy };
  }

  console.log(`📤 Creating the Juejin draft...`);
  const createResult = await createDraft(title, resolvedTagIds, resolvedCategoryId);
  if (createResult.err_no !== 0) {
    console.log(`❌ Create failed: ${JSON.stringify(createResult, null, 2)}`);
    return { failed: true, stage: 'create' };
  }
  const draftId = createResult.data.id;
  const articleId = createResult.data.article_id;
  console.log(`✅ Draft created! Draft ID: ${draftId}`);

  console.log(`✏️ Writing the body...`);
  const updateResult = await updateDraft(draftId, title, cleanedContent, resolvedTagIds, resolvedCategoryId);
  if (updateResult.err_no !== 0) {
    // fix: do NOT publish a draft whose body failed to save
    console.log(`❌ Body write failed: ${JSON.stringify(updateResult, null, 2)}`);
    return { failed: true, stage: 'update', draftId, articleId };
  }
  console.log(`✅ Body written!`);
  console.log(`🔗 Edit link: https://juejin.cn/editor/drafts/${draftId}`);

  let publishedArticleId = articleId;
  if (publish) {
    console.log(`📤 Publishing...`);
    const pubResult = await publishArticle(draftId, null, resolvedTagIds);
    if (pubResult.err_no === 0) {
      console.log(`✅ Published!`);
      if (pubResult.data && pubResult.data.article_id) publishedArticleId = pubResult.data.article_id;
      console.log(`🔗 Article link: https://juejin.cn/post/${publishedArticleId}`);
    } else {
      console.log(`❌ Publish failed: ${JSON.stringify(pubResult, null, 2)}`);
      return { failed: true, stage: 'publish', draftId, articleId };
    }
  }

  return { draftId, articleId: publishedArticleId, taxonomy };
}

module.exports = {
  publishJuejin,
  extractBrief,
  createDraft,
  updateDraft,
  publishArticle,
  listDrafts,
  listPublished,
  getDraft,
  deleteDraft,
  deleteArticle,
  isDuplicate,
  resolveTagIds,
  listCategories,
  listAllTags,
};
