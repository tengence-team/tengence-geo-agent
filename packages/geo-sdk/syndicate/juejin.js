'use strict';
/**
 * Juejin publishing (tengence-geo-sdk/syndicate/juejin)
 * ============================================================================
 * Sunk down from commands/publish-juejin.js on 2026-09-20: the HTTP helper (native
 * https/http), and the three-step create-draft / write-body / publish orchestration
 * all moved into this file. The CLI only parses <markdown_file> and
 * --title / --draft / --publish, and owns the exit code.
 *
 * Env var: JUEJIN_COOKIE (sites/<site>/.env, injected by t.site.loadSite()).
 *
 * Note: the original script's "❌ 创建失败: ${JSON.stringify(result)}" referenced an
 * undefined variable (should have been createResult); fixed to createResult during
 * the sink-down. All other copy and flow are preserved verbatim.
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// HTTP request helper (ported as-is)
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
      res.on('data', (chunk) => data += chunk);
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

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Create draft (empty)
async function createDraft(cookie, title) {
  const url = 'https://api.juejin.cn/content_api/v1/article_draft/create';
  const headers = {
    'Cookie': cookie,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Referer': 'https://juejin.cn/editor/drafts/new',
    'Content-Type': 'application/json',
  };

  const payload = {
    title: title,
    column_id: '0',
    tags: [],
    category_id: '0',
    cover_image: '',
    is_english: 0,
    user_id: '1430912681125418',
  };

  return await request(url, { method: 'POST', headers }, payload);
}

// Extract brief content from blockquote
function extractBrief(content) {
  const match = content.match(/^> \*\*摘要\*\*：(.+)$/m);
  if (match) return match[1].trim();
  // Fallback: first 100 chars
  return content.replace(/^#.+\n/, '').substring(0, 100).trim();
}

// Update draft with content
async function updateDraft(cookie, draftId, title, content) {
  const url = 'https://api.juejin.cn/content_api/v1/article_draft/update';
  const headers = {
    'Cookie': cookie,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Referer': `https://juejin.cn/editor/drafts/${draftId}`,
    'Content-Type': 'application/json',
  };

  const brief = extractBrief(content);

  const payload = {
    id: draftId,
    title: title,
    mark_content: content,
    brief_content: brief,
    html_content: 'deprecated',
    column_id: '0',
    tags: [],
    category_id: '0',
    cover_image: '',
    is_english: 0,
    is_original: 1,
    edit_type: 10,
    user_id: '1430912681125418',
  };

  return await request(url, { method: 'POST', headers }, payload);
}

// Publish article
async function publishArticle(cookie, draftId) {
  const url = 'https://api.juejin.cn/content_api/v1/article/publish';
  const headers = {
    'Cookie': cookie,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Referer': `https://juejin.cn/editor/drafts/${draftId}`,
    'Content-Type': 'application/json',
  };

  const payload = {
    draft_id: draftId,
  };

  return await request(url, { method: 'POST', headers }, payload);
}

/**
 * Publish markdown to Juejin (creates a draft by default; --publish publishes
 * immediately)
 * Exit semantics identical to pre-sink-down: only a missing cookie throws (CLI exit
 * 1); file-read errors are thrown by readFileSync (caught by the CLI, naturally exits
 * 0); create/write/publish failures only print and return (no throw, process exits 0
 * naturally — matching each failure path's exit code pre-sink-down).
 * @param {{mdFile:string, title?:string|null, publish?:boolean}} opts
 * @returns {Promise<{draftId?:string, articleId?:string, failed?:boolean}>}
 */
async function publishJuejin({ mdFile, title = null, publish = false }) {
  const cookie = process.env.JUEJIN_COOKIE;
  if (!cookie) {
    console.log('❌ JUEJIN_COOKIE not found in .env');
    throw new Error('JUEJIN_COOKIE_MISSING');
  }

  // Read markdown file
  const content = fs.readFileSync(mdFile, 'utf-8');

  // Extract title from first H1 if not provided
  if (!title) {
    const match = content.match(/^# (.+)$/m);
    title = match ? match[1].trim() : path.basename(mdFile, '.md');
  }

  // Strip front matter
  const cleanedContent = content.replace(/^---\n[\s\S]*?\n---\n?/, '');

  console.log(`📝 Title: ${title}`);
  console.log(`📄 File: ${mdFile}`);
  console.log(`📤 Creating the Juejin draft...`);

  // Step 1: Create empty draft
  const createResult = await createDraft(cookie, title);

  if (createResult.err_no !== 0) {
    console.log(`❌ Create failed: ${JSON.stringify(createResult, null, 2)}`);
    return { failed: true };
  }
  const draftId = createResult.data.id;
  const articleId = createResult.data.article_id;
  console.log(`✅ Draft created! Draft ID: ${draftId}`);

  // Step 2: Update draft with content
  console.log(`✏️ Writing the body...`);
  const updateResult = await updateDraft(cookie, draftId, title, cleanedContent);

  if (updateResult.err_no === 0) {
    console.log(`✅ Body written!`);
    console.log(`🔗 Edit link: https://juejin.cn/editor/drafts/${draftId}`);
  } else {
    console.log(`❌ Body write failed: ${JSON.stringify(updateResult, null, 2)}`);
  }

  if (publish) {
    console.log(`📤 Publishing...`);
    const pubResult = await publishArticle(cookie, draftId);
    if (pubResult.err_no === 0) {
      console.log(`✅ Published!`);
      console.log(`🔗 Article link: https://juejin.cn/post/${articleId}`);
    } else {
      console.log(`❌ Publish failed: ${JSON.stringify(pubResult, null, 2)}`);
    }
  }

  return { draftId, articleId };
}

module.exports = { publishJuejin, extractBrief };
