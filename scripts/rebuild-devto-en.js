'use strict';
/**
 * ONE-OFF dev.to English rebuild (2026-10-12) — NOT part of the MCP toolchain.
 * ============================================================================
 * Goal: dev.to is an international channel and must only carry English content.
 *
 * 2026-10-12 verification: dev.to's DELETE /api/articles/:id returns 404 for
 * unpublished drafts (route not exposed), while PUT /api/articles/:id works
 * (HTTP 200). So instead of delete+recreate we OVERWRITE each Chinese draft
 * in place with its English content (title + body + tags + canonical_url).
 * Draft ids stay stable, so channel_plan draft_ids remain valid.
 *
 *  1. PUT-overwrite the 5 Chinese drafts with the articles-table en content.
 *  2. Update channel_plan: refresh notes (English draft) on rows 62/63/66/67
 *     and register a new row for eeat-entity-authority-ai-search (was missing).
 *
 * Idempotent: any draft whose title no longer contains CJK is skipped.
 *
 * Usage: node scripts/rebuild-devto-en.js
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SITE_KEY = 'www_tengence_com';
const SITE_DIR = path.join(__dirname, '..', '..', 'geo-workspace', SITE_KEY);
const DB_PATH = '/Users/tim/.tengence/geo-mcp/geo.sqlite';
const APP_ID = 1;

// ---- load site env (DEVTO_API_KEY, SITE_DOMAIN) ----
const envFile = path.join(SITE_DIR, '.env');
if (!fs.existsSync(envFile)) throw new Error(`missing ${envFile}`);
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
if (!process.env.DEVTO_API_KEY) throw new Error('DEVTO_API_KEY missing after loading .env');
process.env.SITE_DOMAIN = process.env.SITE_DOMAIN || 'www.tengence.com';

// dev.to Chinese draft id -> blog slug -> channel_plan row id
const MAP = [
  { devtoId: 4831947, slug: 'ab-testing-complete-guide', planId: 62 },
  { devtoId: 4831949, slug: 'ab-testing-guide', planId: 63 },
  { devtoId: 4832072, slug: 'ai-era-link-building', planId: 66 },
  { devtoId: 4835316, slug: 'ai-generated-content-disclosure-compliance', planId: 67 },
  { devtoId: 4683114, slug: 'eeat-entity-authority-ai-search', planId: null },
];

const db = new Database(DB_PATH);
const hasCJK = (s) => /[\u4e00-\u9fff]/.test(s || '');

async function devtoGetAll() {
  const res = await fetch(`https://dev.to/api/articles/me/all?per_page=100`, {
    headers: { 'api-key': process.env.DEVTO_API_KEY, 'Accept': 'application/vnd.forem.api-v1+json' },
  });
  if (!res.ok) throw new Error(`dev.to list failed: ${res.status}`);
  return res.json();
}

async function devtoUpdate(id, { title, bodyMarkdown, canonicalUrl, tags }) {
  const res = await fetch(`https://dev.to/api/articles/${id}`, {
    method: 'PUT',
    headers: {
      'api-key': process.env.DEVTO_API_KEY,
      'Accept': 'application/vnd.forem.api-v1+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      article: {
        title,
        body_markdown: bodyMarkdown,
        tags,
        canonical_url: canonicalUrl,
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`dev.to update #${id} failed: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

function stripLeadingTitle(md, title) {
  if (!md) return '';
  const lines = md.split('\n');
  if (lines[0] && lines[0].replace(/^#+\s*/, '').trim() === title.trim()) lines.shift();
  return lines.join('\n');
}

function deriveTags(kws) {
  const tagMap = {
    'EEAT': 'seo', 'AI搜索优化': 'ai', 'GEO': 'seo', '实体权威性': 'seo',
    'AI生成内容': 'ai', '内容合规': 'content', 'Wikidata': 'ai', 'Wikipedia': 'ai',
    'AI搜索': 'ai', 'SEO': 'seo', 'GEO优化': 'seo', 'AIGC': 'ai',
    'enterprise search API': 'saas', 'managed search service': 'saas',
    'search-as-a-service': 'saas', 'Tengence Search': 'saas', 'AI search': 'ai',
    'seo': 'seo', 'search': 'search', 'api': 'api',
    'saas': 'saas', 'machine learning': 'machinelearning',
    'ai': 'ai', 'backlinks': 'seo', 'link building': 'seo', 'content': 'content',
    'ab testing': 'testing', 'a/b testing': 'testing', 'statistics': 'testing',
    'entity authority': 'seo', 'e-e-a-t': 'seo', 'generative ai': 'ai',
  };
  const tags = [...new Set(kws.map((k) => tagMap[k.toLowerCase()]).filter(Boolean))].slice(0, 4);
  return tags.length ? tags : ['seo', 'ai'];
}

(async () => {
  console.log(`[1/3] dev.to 当前文章列表...`);
  const all = await devtoGetAll();
  const byId = new Map(all.map((a) => [String(a.id), a]));
  for (const m of MAP) {
    const a = byId.get(String(m.devtoId));
    console.log(`  #${m.devtoId} ${a ? (hasCJK(a.title) ? '中文' : '英文') + ' | ' + a.title.slice(0, 55) : '(列表不存在)'}`);
  }

  // [2/3] overwrite Chinese drafts in place with English content
  console.log(`\n[2/3] 用英文内容覆盖中文草稿 (PUT)...`);
  for (const m of MAP) {
    const a = byId.get(String(m.devtoId));
    if (!a) { console.log(`  #${m.devtoId} 不在列表中，跳过`); continue; }
    if (!hasCJK(a.title)) { console.log(`  #${m.devtoId} 已是英文(${a.title.slice(0, 40)})，跳过`); continue; }

    const row = db
      .prepare('SELECT * FROM tengence_geo_articles WHERE app_id=? AND slug=? AND lang=?')
      .get(APP_ID, m.slug, 'en');
    if (!row) { console.log(`  ${m.slug} (en) 在 articles 表不存在，跳过`); continue; }

    const title = row.title;
    const body = stripLeadingTitle(row.content_longtext || row.content_md || '', title).trim();
    const kws = (row.target_keywords || '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 8);
    const siteDomain = process.env.SITE_DOMAIN.startsWith('http')
      ? process.env.SITE_DOMAIN
      : `https://www.${process.env.SITE_DOMAIN.replace(/^www\./, '')}`;
    const canonical = `${siteDomain}/blog/article/${m.slug}/`;

    const d = await devtoUpdate(m.devtoId, {
      title,
      bodyMarkdown: body,
      canonicalUrl: canonical,
      tags: deriveTags(kws),
    });
    console.log(`  #${m.devtoId} ${m.slug} -> 已覆盖为英文 "${(d.title || title).slice(0, 50)}"`);
    await new Promise((res) => setTimeout(res, 800)); // dev.to rate limit
  }

  // [3/3] update channel_plan notes + register eeat row
  console.log(`\n[3/3] 更新 channel_plan...`);
  const upd = db.prepare('UPDATE tengence_geo_channel_plan SET notes=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?');
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  for (const m of MAP) {
    const a = byId.get(String(m.devtoId));
    const note = `dev.to 英文草稿（draft-first，无审核；待人工在 dashboard 发布）: #${m.devtoId}`;
    if (m.planId) {
      upd.run(note, m.planId);
      console.log(`  plan#${m.planId} ${m.slug} -> notes 已标注英文草稿 #${m.devtoId}`);
    } else {
      const exists = db.prepare('SELECT id FROM tengence_geo_channel_plan WHERE app_id=? AND platform=? AND slug=? AND lang=?').get(APP_ID, 'devto', m.slug, 'en');
      if (exists) {
        upd.run(note, exists.id);
        console.log(`  plan#${exists.id} ${m.slug}(eeat 补登记) -> notes 已标注英文草稿 #${m.devtoId}`);
      } else {
        const r = db
          .prepare(
            `INSERT INTO tengence_geo_channel_plan
             (app_id, platform, slug, lang, status, draft_ids, notes, created_at, updated_at)
             VALUES (?, 'devto', ?, 'en', 'draft', ?, ?, ?, ?)`
          )
          .run(APP_ID, m.slug, JSON.stringify([m.devtoId]), note, now, now);
        console.log(`  plan#${r.lastInsertRowid} ${m.slug}(新登记) -> draft_ids=[${m.devtoId}]`);
      }
    }
  }

  console.log(`\n完成。dev.to 应只含英文草稿 + 已发布英文文章。`);
  db.close();
})().catch((e) => { console.error('脚本失败:', e.message); process.exit(1); });
