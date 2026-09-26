'use strict';
/**
 * Unified cross-platform publish channel (tengence-geo-sdk/syndicate/channel)
 * ============================================================================
 * One entry point for every platform in registry.js. Two input modes:
 *
 *   Mode A — original slugs (原文直发):
 *     publishToChannel({ platform, slugs }) reads the articles from the DB and
 *     runs the platform's existing pipeline (wechat drafts box, juejin draft,
 *     devto publish). Only implemented for api platforms; for api:none platforms
 *     it errors and asks for Mode B.
 *
 *   Mode B — pre-written articles (改写稿接收):
 *     publishToChannel({ platform, articles }) exports each article as a publish
 *     package under <site>/data/channel-export/<platform>/<slug>.md with a full
 *     front matter, and logs to <site>/data/channel-log.jsonl. This is how the
 *     harness (MCP client) lands a rewritten draft for manual publishing on any
 *     platform — the MCP server itself never rewrites content.
 *
 * Soft-failure convention (same as baidu/wechat): one failing platform/article is
 * logged, not fatal to the rest.
 *
 * Juejin taxonomy (2026-09-26): before publishing, the platform dictionary cached in
 * channel_taxonomy is used to map our article_plan category/tags onto the platform's
 * own category_id/tag_ids (module: syndicate/juejin-taxonomy). Fallbacks guarantee a
 * category + at least one tag on every publish. Platform-scoped, so no per-site config.
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const t = require('../index');
const registry = require('./registry');
const planRepo = require('../db/plan');
const channelPlanRepo = require('../db/channel-plan');
const { syncWechat, publishRewrittenToWechat } = require('./wechat');
const juejin = require('./juejin');
const juejinTaxonomy = require('./juejin-taxonomy');
const { publishDevto } = require('./devto');

const DEFAULT_APP_ID = () => Number(process.env.APP_ID || 1);

/** Export root: <siteDir>/data/channel-export/<platform>/<slug>.md */
function exportDir(siteDir, platform) {
  return path.join(siteDir, 'data', 'channel-export', platform);
}

/** Channel activity log: <siteDir>/data/channel-log.jsonl */
function logFile(siteDir) {
  return path.join(siteDir, 'data', 'channel-log.jsonl');
}

function appendLog(siteDir, entry) {
  const file = logFile(siteDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

/** Build the publish-package markdown (front matter + body). */
function renderPublishPackage(platform, article) {
  const fm = {
    platform,
    slug: article.slug,
    title: article.title,
    summary: article.summary || '',
    tags: Array.isArray(article.tags) ? article.tags : [],
    source_url: article.sourceUrl || '',
    cover: article.cover || '',
    exported_at: new Date().toISOString(),
    rewrite: article.rewrite || 'harness',
    mode: article.mode || 'harness',
  };
  const fmText = yaml.dump(fm, { lineWidth: -1 });
  const body = article.contentMd || '';
  return `---\n${fmText}---\n\n${body.trim()}\n`;
}

/**
 * Read an article from the DB into the {slug,title,contentMd,target_keywords} shape,
 * plus our own plan taxonomy (article_plan.category / article_plan.tags) which the
 * juejin resolver maps onto the platform's category_id / tag_ids.
 */
async function articleFromDb(conn, appId, slug, siteDomain) {
  const detail = await t.db.articles.getDetail(conn, appId, slug);
  if (!detail) throw new Error(`Article not found: ${slug}`);
  let planRow = null;
  try {
    planRow = await planRepo.getBySlug(conn, appId, slug);
  } catch (e) {
    // a missing/unreadable plan row must not block publishing
    planRow = null;
  }
  return {
    slug,
    title: detail.title,
    contentMd: detail.content_longtext || '',
    targetKeywords: detail.target_keywords || '',
    featuredImage: detail.featured_image || '',
    publishedAt: detail.published_at || detail.lastmod || '',
    planCategory: planRow ? planRow.category || null : null,
    planTags: planRow && Array.isArray(planRow.tags) ? planRow.tags : [],
  };
}

/**
 * Mode A: publish original DB articles through the platform's own pipeline.
 */
async function publishFromSlugs({ platform, slugs, asDraft, keepOrder, dryRun, siteKey }) {
  const plat = registry.getPlatform(platform);
  const site = t.site.loadSite(siteKey);
  const SITE_DOMAIN = (process.env.SITE_DOMAIN || (site.site && site.site.site && site.site.site.domain) || 'www.tengence.com')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, 'www.');

  // ---- wechat: reuse the existing drafts-box pipeline (multi-article merge) ----
  if (platform === 'wechat') {
    const { mediaId, action } = await syncWechat({ slugs, dryRun, shouldPublish: !asDraft, siteKey, keepOrder });
    appendLog(site.siteDir, { action: dryRun ? 'dry-run' : action, platform, slugs, ok: true, detail: { mediaId } });
    return {
      ok: true,
      platform,
      action: dryRun ? 'dry-run' : action,
      refs: { mediaId },
      logPath: logFile(site.siteDir),
    };
  }

  // ---- baijiahao: pending credentials ----
  if (platform === 'baijiahao') {
    throw new Error(
      'baijiahao publish is pending: the official API needs enterprise-verified app_id/app_token ' +
        '(get them in the baijiahao dashboard → 开发). Stage 1 only exports rewrite packages (Mode B).'
    );
  }

  // ---- api:none platforms ----
  if (plat.api === 'none') {
    throw new Error(
      `"${platform}" has no publish API (api: none). Use Mode B: pass pre-written articles[] ` +
        'to export a publish package for manual posting.'
    );
  }

  // ---- juejin / devto: export a DB-derived markdown, then run the platform pipeline ----
  const appId = DEFAULT_APP_ID();

  // juejin taxonomy: preload the platform dictionary (channel_taxonomy) ONCE for the
  // whole batch. The dictionary is platform-scoped, so no site needs its own mapping
  // file. Auto-syncs when empty, EXCEPT on dryRun (which must make no external calls) —
  // a dry-run instead reports dictEmpty so the operator knows to sync first. A failed
  // sync is never fatal: resolution then falls back to the env ids.
  let taxoCtx = null;
  if (platform === 'juejin') {
    taxoCtx = await juejinTaxonomy.prepareJuejinTaxonomy({ siteDir: site.siteDir, autoSync: !dryRun });
  }

  const results = [];
  let failed = 0;
  await t.db.withConn(async (conn) => {
    for (const slug of slugs) {
      try {
        const article = await articleFromDb(conn, appId, slug, SITE_DOMAIN);
        const dir = exportDir(site.siteDir, platform);
        fs.mkdirSync(dir, { recursive: true });
        const mdPath = path.join(dir, `${slug}.md`);

        if (platform === 'juejin') {
          // juejin title hard limit (the editor rejects > ~40 chars)
          const TITLE_MAX = 40;
          let title = article.title || '';
          let titleTrimmed = false;
          if (title.length > TITLE_MAX) {
            title = title.slice(0, TITLE_MAX);
            titleTrimmed = true;
          }

          // ---- dedup layer 1: OUR publish log, keyed by SLUG (no external call) ----
          // channel_plan is a publish log: one row per slug recording the real outcome
          // (published / failed). A slug already recorded as published is NEVER
          // re-published — even if its title changed or got trimmed since. This runs
          // before anything is written, and it also covers dryRun (it is a local read).
          let priorRow = null;
          try {
            priorRow = await channelPlanRepo.findBySlug(conn, appId, platform, slug);
          } catch (e) {
            // a read failure must not block publishing
            priorRow = null;
          }
          if (priorRow && priorRow.status === 'published') {
            appendLog(site.siteDir, {
              action: 'skip-published',
              platform,
              slug,
              ok: true,
              detail: { title, reason: 'already published per channel_plan publish log', rowId: priorRow.id },
            });
            results.push({
              slug,
              ok: true,
              skipped: true,
              reason: 'already published (channel_plan)',
              rowId: priorRow.id,
              title,
            });
            continue;
          }

          fs.writeFileSync(mdPath, `# ${title}\n\n${article.contentMd.trim()}\n`, 'utf8');

          const tagKws = (article.targetKeywords || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);

          // map OUR plan taxonomy (category/tags) onto the platform's own ids via the
          // cached dictionary; never fails — always yields a category_id + ≥1 tag_id
          const taxo = taxoCtx
            ? juejinTaxonomy.resolveFromContext(taxoCtx, {
                category: article.planCategory,
                tags: article.planTags,
                keywords: tagKws,
              })
            : null;
          const taxoSummary = taxo
            ? {
                category: taxo.categoryName || taxo.categoryId,
                categoryOrigin: taxo.categoryOrigin,
                tags: taxo.tagNames.length ? taxo.tagNames : taxo.tagIds,
                tagOrigins: taxo.origins,
                dictEmpty: taxo.dictEmpty,
              }
            : null;

          // dryRun: no external calls — just preview the plan (incl. resolved taxonomy)
          if (dryRun) {
            appendLog(site.siteDir, {
              action: 'dry-run',
              platform,
              slug,
              ok: true,
              detail: { title, trimmed: titleTrimmed, tags: tagKws, taxonomy: taxoSummary },
            });
            results.push({ slug, ok: true, dryRun: true, title, trimmed: titleTrimmed, taxonomy: taxoSummary });
            continue;
          }

          const res = await juejin.publishJuejin({
            mdFile: mdPath,
            title,
            publish: !asDraft,
            tags: tagKws,
            categoryId: taxo ? taxo.categoryId : null,
            tagIds: taxo ? taxo.tagIds : null,
          });
          appendLog(site.siteDir, {
            action: asDraft ? 'draft' : 'publish',
            platform,
            slug,
            ok: !res.failed,
            detail: { ...res, taxonomy: taxoSummary },
          });
          if (res.failed) {
            failed += 1;
            results.push({ slug, ok: false, stage: res.stage, detail: res, title });
          } else {
            // expose articleId so the caller can record it in channel_plan.draft_ids.
            // `published` distinguishes a LIVE article from a mere draft — the publish
            // log must only ever mark "published" when it actually went out, otherwise
            // the slug-based dedup below would permanently skip an article that is
            // still sitting in the draft box.
            results.push({
              slug,
              ok: true,
              published: !asDraft,
              draftId: res.draftId,
              articleId: res.articleId,
              title,
              trimmed: titleTrimmed,
              taxonomy: taxoSummary,
            });
          }
        } else if (platform === 'devto') {
          const fm = {
            title: article.title,
            keywords: `[${(article.targetKeywords || '').split(',').map((k) => k.trim()).filter(Boolean).slice(0, 8).join(', ')}]`,
          };
          fs.writeFileSync(mdPath, `---\n${yaml.dump(fm, { lineWidth: -1 }).trim()}\n---\n\n${article.contentMd.trim()}\n`, 'utf8');
          const res = await publishDevto({ mdPath, dryRun });
          appendLog(site.siteDir, { action: dryRun ? 'dry-run' : 'publish', platform, slug, ok: true, detail: res });
          results.push({ slug, ok: true, detail: res });
        } else {
          throw new Error(`channel mode A not implemented for platform "${platform}"`);
        }
    } catch (e) {
      failed += 1;
      results.push({ slug, ok: false, error: e.message, title: typeof article !== 'undefined' ? article.title : undefined });
      appendLog(site.siteDir, { action: 'error', platform, slug, ok: false, detail: { error: e.message } });
    }
    }
  });

  return {
    ok: failed === 0,
    platform,
    action: asDraft ? 'draft' : 'publish',
    refs: { mdDir: exportDir(site.siteDir, platform) },
    results,
    logPath: logFile(site.siteDir),
  };
}

/**
 * Mode B: export pre-written (harness-rewritten) articles as publish packages.
 * Works for every platform — api:none platforms publish manually from these files.
 */
async function exportArticles({ platform, articles, dryRun, siteKey, asDraft = true }) {
  const site = t.site.loadSite(siteKey);
  const dir = exportDir(site.siteDir, platform);
  fs.mkdirSync(dir, { recursive: true });

  const exported = [];
  let failed = 0;
  for (const article of articles) {
    if (!article.slug || !article.title || !article.contentMd) {
      failed += 1;
      exported.push({ slug: article.slug || '(no slug)', ok: false, error: 'slug/title/contentMd are required' });
      continue;
    }
    try {
      const mdPath = path.join(dir, `${article.slug}.md`);
      fs.writeFileSync(mdPath, renderPublishPackage(platform, article), 'utf8');
      exported.push({ slug: article.slug, ok: true, path: mdPath });
      appendLog(site.siteDir, {
        action: 'export',
        platform,
        slug: article.slug,
        ok: true,
        detail: { path: mdPath, rewrite: article.rewrite || 'harness' },
      });
    } catch (e) {
      failed += 1;
      exported.push({ slug: article.slug, ok: false, error: e.message });
      appendLog(site.siteDir, { action: 'export', platform, slug: article.slug, ok: false, detail: { error: e.message } });
    }
  }

  // ---- api:official platforms (wechat) actually push the rewritten draft ----
  // Mode B's contract: the harness already rewrote the article; here we land it in
  // the platform draft box (createDraft) instead of only exporting a local package.
  let pushResult = null;
  const plat = registry.getPlatform(platform);
  if (plat && plat.api === 'official' && platform === 'wechat' && !dryRun) {
    try {
      pushResult = await publishRewrittenToWechat({ articles, siteKey });
    } catch (e) {
      failed += 1;
      appendLog(site.siteDir, { action: 'push-error', platform, ok: false, detail: { error: e.message } });
    }
  }

  // ---- juejin: Mode B ALSO pushes the rewritten draft through the real pipeline ----
  // Without this the platform-adapted draft only ever lands on disk, and the only
  // way onto Juejin was Mode A (the untouched DB original) — which carries the
  // brand/CTA blocks Juejin's own rules forbid. Same rationale as wechat above.
  const juejinResults = [];
  if (platform === 'juejin' && !dryRun) {
    const taxoCtx = await juejinTaxonomy.prepareJuejinTaxonomy({ siteDir: site.siteDir, autoSync: true });
    const TITLE_MAX = 40;
    for (const article of articles) {
      if (!article.slug || !article.title || !article.contentMd) continue;
      try {
        let title = String(article.title || '');
        const trimmed = title.length > TITLE_MAX;
        if (trimmed) title = title.slice(0, TITLE_MAX);

        // taxonomy: prefer the DB plan row (single source of truth, as in Mode A);
        // fall back to whatever tags the harness passed in.
        let category = null;
        let tags = Array.isArray(article.tags) && article.tags.length ? article.tags : [];
        try {
          await t.db.withConn(async (conn) => {
            const row = await planRepo.getBySlug(conn, DEFAULT_APP_ID(), article.slug);
            if (!row) return;
            category = row.category || category;
            if (Array.isArray(row.tags) && row.tags.length) tags = row.tags;
          });
        } catch (e) {
          // a missing plan row must not block publishing
        }

        const taxo = taxoCtx
          ? juejinTaxonomy.resolveFromContext(taxoCtx, { category, tags, keywords: tags })
          : null;
        const taxoSummary = taxo
          ? {
              category: taxo.categoryName || taxo.categoryId,
              categoryOrigin: taxo.categoryOrigin,
              tags: taxo.tagNames.length ? taxo.tagNames : taxo.tagIds,
              tagOrigins: taxo.origins,
              dictEmpty: taxo.dictEmpty,
            }
          : null;

        const res = await juejin.publishJuejin({
          contentMd: `# ${title}\n\n${article.contentMd.trim()}\n`,
          title,
          publish: !asDraft,
          tags,
          categoryId: taxo ? taxo.categoryId : null,
          tagIds: taxo ? taxo.tagIds : null,
        });

        appendLog(site.siteDir, {
          action: asDraft ? 'draft' : 'publish',
          platform,
          slug: article.slug,
          ok: !res.failed,
          detail: { ...res, taxonomy: taxoSummary, rewrite: article.rewrite || 'harness' },
        });

        if (res.failed) {
          failed += 1;
          juejinResults.push({ slug: article.slug, ok: false, stage: res.stage, detail: res, title });
        } else {
          juejinResults.push({
            slug: article.slug,
            ok: true,
            published: !asDraft,
            draftId: res.draftId,
            articleId: res.articleId,
            title,
            trimmed,
            taxonomy: taxoSummary,
          });
        }
      } catch (e) {
        failed += 1;
        juejinResults.push({ slug: article.slug, ok: false, error: e.message, title: article.title });
        appendLog(site.siteDir, { action: 'error', platform, slug: article.slug, ok: false, detail: { error: e.message } });
      }
    }
  }

  return {
    ok: failed === 0,
    platform,
    action: juejinResults.length ? (asDraft ? 'draft' : 'publish') : pushResult ? 'draft' : 'manual',
    refs: { mdDir: dir, mediaId: pushResult && pushResult.mediaId },
    exported,
    // mirror Mode A's shape so the MCP publish log (channel_plan) can record it
    results: juejinResults.length ? juejinResults : undefined,
    logPath: logFile(site.siteDir),
  };
}

/**
 * Unified channel publish.
 * @param {object} opts
 * @param {string} opts.platform platform key (registry)
 * @param {string[]} [opts.slugs] Mode A: DB slugs to publish through the platform pipeline
 * @param {Array<object>} [opts.articles] Mode B: pre-written articles
 *        [{slug,title,contentMd,summary,tags,sourceUrl,cover,rewrite,mode}]
 * @param {boolean} [opts.asDraft=true] draft instead of direct publish (wechat/juejin)
 * @param {boolean} [opts.keepOrder=false] wechat: keep slugs order (1st = headline)
 * @param {boolean} [opts.dryRun=false] no external calls, print the plan
 * @param {string} [opts.siteKey] site key (default from site.readSiteArg())
 * @throws unknown platform / nothing to do / api:none with slugs (Mode A)
 */
async function publishToChannel({ platform, slugs = [], articles = [], asDraft = true, keepOrder = false, dryRun = false, siteKey }) {
  const plat = registry.getPlatform(platform);
  if (!plat) {
    throw new Error(
      `Unknown platform "${platform}". Known: ${registry.PLATFORM_KEYS.join(', ')} (see channel_list)`
    );
  }

  const hasSlugs = Array.isArray(slugs) && slugs.length > 0;
  const hasArticles = Array.isArray(articles) && articles.length > 0;
  if (!hasSlugs && !hasArticles) {
    throw new Error('channel_publish requires slugs[] (Mode A: 原文直发) or articles[] (Mode B: 改写稿)');
  }
  if (hasSlugs && hasArticles) {
    throw new Error('channel_publish accepts either slugs[] (Mode A) or articles[] (Mode B), not both');
  }

  if (!siteKey) siteKey = t.site.readSiteArg();

  if (hasSlugs) {
    return publishFromSlugs({ platform, slugs, asDraft, keepOrder, dryRun, siteKey });
  }
  return exportArticles({ platform, articles, dryRun, siteKey, asDraft });
}

module.exports = {
  publishToChannel,
  exportDir,
  logFile,
  renderPublishPackage,
};
