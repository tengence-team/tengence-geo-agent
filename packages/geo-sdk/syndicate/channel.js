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
const { syncWechat, publishRewrittenToWechat } = require('./wechat');
const juejin = require('./juejin');
const juejinTaxonomy = require('./juejin-taxonomy');
const csdn = require('./csdn');
const aliyun = require('./aliyun');
const tencent = require('./tencent');
const tencentTaxonomy = require('./tencent-taxonomy');
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

/**
 * Strip a single leading level-1 heading (`# Title`) from a markdown body.
 *
 * Every channel carries the title in a dedicated field (front matter in Mode B,
 * the platform's `title` argument in Mode A / API). Embedding `# Title` at the
 * top of the body is therefore redundant and, on some renderers, produces a
 * duplicated visible heading. We remove ONLY the very first H1 line; any other
 * shape is returned unchanged (trimmed). Trailing blank lines are collapsed.
 *
 * @param {string} md markdown body
 * @returns {string} body with the leading H1 removed
 */
function stripLeadingTitle(md, title) {
  if (!md) return '';
  const text = md.replace(/^\s+/, '');
  const m = text.match(/^#\s+(.+?)\s*(?:\n|$)/);
  if (!m) return text.replace(/\s+$/, '');
  // Only drop the leading H1 when it actually duplicates the article title — a
  // differing H1 is a genuine content heading and must be preserved.
  if (title != null && m[1].trim() === String(title).trim()) {
    return text.slice(m[0].length).replace(/^\s+/, '').replace(/\s+$/, '');
  }
  return text.replace(/\s+$/, '');
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
  // title lives in the front matter above — drop a leading "# Title" from the body
  // ONLY when it duplicates the article title, so the exported package never shows the
  // title twice while genuine content headings are preserved.
  const body = stripLeadingTitle(article.contentMd || '', article.title);
  return `---\n${fmText}---\n\n${body.trim()}\n`;
}

/**
 * Read an article from the DB into the {slug,title,contentMd,target_keywords} shape,
 * plus our own plan taxonomy (article_plan.category / article_plan.tags) which the
 * juejin resolver maps onto the platform's category_id / tag_ids.
 */
async function articleFromDb(conn, appId, slug, siteDomain, lang = 'zh-hans') {
  // channel rewrite is language-scoped: zh-hans channels take the zh-hans row; the
  // dev.to English flow passes lang='en' explicitly (task #5)
  const detail = await t.db.articles.getDetail(conn, appId, slug, lang);
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
 * CSDN tags for one article. The DB plan row wins (single source of truth, same
 * policy as the juejin branch); otherwise fall back to the article's target_keywords.
 * CSDN tags are free text, so no platform dictionary is involved — publishCsdn caps
 * them at the platform maximum and applies the CSDN_TAGS env fallback when empty.
 */
/**
 * Free-text tags for an article, used by the channels whose tags are free text
 * (csdn / tencent). DB plan tags win; target_keywords is the fallback.
 */
function articleTagsFor(article) {
  const fromPlan = Array.isArray(article.planTags) ? article.planTags : [];
  if (fromPlan.length) return fromPlan.map((s) => String(s || '').trim()).filter(Boolean);
  return (article.targetKeywords || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The article's main image — read straight from the articles table
 * (articles.featured_image). This is the SINGLE SOURCE OF TRUTH for a channel
 * cover; no front matter is involved. Never throws: an article without a featured
 * image simply publishes without one.
 * @param {string} slug
 * @param {string|null} [inherited] value already resolved by the caller (wins)
 */
async function featuredImageFor(slug, inherited = null) {
  if (inherited) return inherited;
  if (!slug) return null;
  try {
    let url = null;
    await t.db.withConn(async (conn) => {
      const detail = await t.db.articles.getDetail(conn, DEFAULT_APP_ID(), slug, 'zh-hans');
      if (detail && detail.featured_image) url = detail.featured_image;
    });
    return url;
  } catch (e) {
    // a missing/unreadable article row must not block publishing
    return null;
  }
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

  // ---- channel-agnostic dedup: skip slugs already published on THIS platform ----
  // Single source of truth = the local channel_plan publish log, keyed by slug.
  // No external calls, no title matching. EVERY platform (wechat/juejin/devto/…)
  // goes through this exactly once here — it is NOT re-implemented per platform,
  // and it also covers the CLI (publish-wechat.js now routes through here too).
  const { toPublish, skipped } = await t.plan.channel.filterUnpublished(platform, slugs);
  if (skipped.length) {
    appendLog(site.siteDir, {
      action: 'skip-published',
      platform,
      slugs: skipped,
      ok: true,
      detail: { reason: 'already published on this platform (channel_plan publish log)' },
    });
  }
  // Nothing left to publish → report and return (no draft / no external call).
  if (toPublish.length === 0) {
    appendLog(site.siteDir, {
      action: 'skip-empty',
      platform,
      slugs,
      ok: true,
      detail: { reason: 'all slugs already published on this platform' },
    });
    return {
      ok: true,
      platform,
      action: 'skip-empty',
      skipped,
      refs: {},
      results: skipped.map((s) => ({ slug: s, ok: true, skipped: true, reason: 'already published' })),
      logPath: logFile(site.siteDir),
    };
  }

  // ---- wechat: reuse the existing drafts-box pipeline (multi-article merge) ----
  if (platform === 'wechat') {
    // WeChat caps a single send at 8 image-text articles; apply the cap to the
    // post-dedup list so published slugs never waste a slot.
    const WECHAT_MAX = 8;
    let wechatSlugs = toPublish;
    if (wechatSlugs.length > WECHAT_MAX) {
      console.warn(
        `⚠️  WeChat allows at most ${WECHAT_MAX} articles per send; sending the first ${WECHAT_MAX} of ${wechatSlugs.length} (after dedup).`
      );
      wechatSlugs = wechatSlugs.slice(0, WECHAT_MAX);
    }
    const { mediaId, action } = await syncWechat({ slugs: wechatSlugs, dryRun, shouldPublish: !asDraft, siteKey, keepOrder });
    appendLog(site.siteDir, { action: dryRun ? 'dry-run' : action, platform, slugs: wechatSlugs, ok: true, detail: { mediaId } });
    return {
      ok: true,
      platform,
      action: dryRun ? 'dry-run' : action,
      refs: { mediaId },
      // the group actually merged into this ONE message — the caller (MCP) persists
      // it as one 第N期 row so "which articles went into this message" is never lost
      slugs: wechatSlugs,
      skipped: skipped.length ? skipped : undefined,
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

  // Tencent Cloud: same platform-scoped dictionary approach, but CATEGORY ONLY —
  // the platform publishes no full tag word list (tag/search is a keyword search),
  // so tags keep being resolved live per publish by syndicate/tencent.js.
  let tencentTaxoCtx = null;
  if (platform === 'tencent') {
    tencentTaxoCtx = await tencentTaxonomy.prepareTencentTaxonomy({ siteDir: site.siteDir, autoSync: !dryRun });
  }

  const results = [];
  let failed = 0;
  await t.db.withConn(async (conn) => {
    for (const slug of toPublish) {
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

          // NOTE: the channel-agnostic slug dedup (filterUnpublished) already ran
          // once at the top of publishFromSlugs, so every slug here is guaranteed
          // NOT yet published on this platform. No per-slug lookup needed.

          // title is passed separately to publishJuejin; never embed it in the
          // body — drop any leading "# Title" so the exported file stays clean.
          fs.writeFileSync(mdPath, `${stripLeadingTitle(article.contentMd, article.title).trim()}\n`, 'utf8');

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
            // 封面：博客特色图（articles.featured_image）；publishJuejin 内部会
            // 把它转存到掘金图床（外链封面在掘金无效，与 CSDN 分支同理）。
            coverUrl: await featuredImageFor(slug, article.featuredImage),
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
          // title is in the front matter above; drop any leading "# Title" from
          // the body so the exported file never shows the title twice.
          fs.writeFileSync(mdPath, `---\n${yaml.dump(fm, { lineWidth: -1 }).trim()}\n---\n\n${stripLeadingTitle(article.contentMd, article.title).trim()}\n`, 'utf8');
          const res = await publishDevto({ mdPath, dryRun });
          appendLog(site.siteDir, { action: dryRun ? 'dry-run' : 'publish', platform, slug, ok: true, detail: res });
          results.push({ slug, ok: true, detail: res });
        } else if (platform === 'csdn') {
          // Reuses the SAME upstream dedup as every other platform (filterUnpublished,
          // run once at the top of publishFromSlugs) — no platform-local re-check.
          // CSDN tags are free text: prefer the DB plan tags, fall back to the article
          // target_keywords (publishCsdn trims to the platform maximum of 5 and applies
          // the env fallback when there is none).
          // title is passed separately to the platform pipeline; drop any leading
          // "# Title" so the exported .md body stays clean.
          fs.writeFileSync(mdPath, `${stripLeadingTitle(article.contentMd, article.title).trim()}\n`, 'utf8');
          const tags = articleTagsFor(article);

          if (dryRun) {
            appendLog(site.siteDir, {
              action: 'dry-run', platform, slug, ok: true,
              detail: { title: article.title, tags },
            });
            results.push({ slug, ok: true, dryRun: true, title: article.title, tags });
            continue;
          }

          const res = await csdn.publishCsdn({
            mdFile: mdPath,
            title: article.title,
            publish: !asDraft,
            tags,
            // 封面：博客特色图（articles.featured_image）；publishCsdn 内部会
            // 把它转存到 CSDN 图床（外链封面在 CSDN 无效）。
            coverUrl: await featuredImageFor(slug, article.featuredImage),
          });
          appendLog(site.siteDir, {
            action: asDraft ? 'draft' : 'publish', platform, slug, ok: !res.failed, detail: res,
          });
          if (res.failed) {
            failed += 1;
            results.push({ slug, ok: false, stage: res.stage, detail: res, title: article.title });
          } else {
            // identical shape to the juejin branch so channel_plan logging is uniform
            results.push({
              slug,
              ok: true,
              published: !asDraft,
              draftId: res.draftId,
              articleId: res.articleId,
              url: res.url,
              title: article.title,
              tags: res.tags,
            });
          }
        } else if (platform === 'aliyun') {
          // Reuses the SAME upstream dedup as every other platform (filterUnpublished,
          // run once at the top of publishFromSlugs) — no platform-local re-check.
          // ⚠️ Aliyun publishing is human-gated: the editor always shows an Aliyun
          // Captcha before publishing, so a token-less server call is refused with
          // 50002 (see syndicate/aliyun.js header). The pipeline can therefore only
          // reach the DRAFT box — `published` stays false and the slug remains
          // eligible in the publish log until a human publishes it, which is exactly
          // the WeChat channel's "draft box + human send" contract.
          // title is passed separately to the platform pipeline; drop any leading
          // "# Title" so the exported .md body stays clean.
          fs.writeFileSync(mdPath, `${stripLeadingTitle(article.contentMd, article.title).trim()}\n`, 'utf8');

          if (dryRun) {
            appendLog(site.siteDir, {
              action: 'dry-run', platform, slug, ok: true,
              detail: { title: article.title },
            });
            results.push({ slug, ok: true, dryRun: true, title: article.title });
            continue;
          }

          // Main image: the blog's featured image from the articles table.
          // publishAliyun downloads + re-uploads it to Aliyun's own OSS/CDN; the
          // platform's whitelist is jpg/jpeg/png/gif, so a webp source is skipped
          // with a warning (non-fatal — the draft is still saved).
          const res = await aliyun.publishAliyun({
            mdFile: mdPath,
            title: article.title,
            publish: false, // live publish is human-gated on this platform
            coverUrl: article.featuredImage || null,
          });
          appendLog(site.siteDir, {
            action: 'draft', platform, slug, ok: !res.failed, detail: res,
          });
          if (res.failed) {
            failed += 1;
            results.push({ slug, ok: false, stage: res.stage, detail: res, title: article.title });
          } else {
            // identical shape to the csdn branch so channel_plan logging is uniform
            results.push({
              slug,
              ok: true,
              published: false,
              draftId: res.draftId,
              articleId: null,
              url: res.url,
              title: article.title,
              publishGated: true,
            });
          }
        } else if (platform === 'tencent') {
          // Reuses the SAME upstream dedup as every other platform (filterUnpublished).
          // ✅ Unlike Aliyun, Tencent Cloud publish is NOT human-gated (verified
          // 2026-09-27: addArticle succeeds with no captcha). It does enter the
          // platform's review queue (status 0 = 审核中) and goes public once approved,
          // so `publish` follows `asDraft` like the other ungated channels.
          // title is passed separately to the platform pipeline; drop any leading
          // "# Title" so the exported .md body stays clean.
          fs.writeFileSync(mdPath, `${stripLeadingTitle(article.contentMd, article.title).trim()}\n`, 'utf8');
          const tags = articleTagsFor(article);

          // Map OUR plan category onto the platform's 分类 id via the cached
          // dictionary (never fails). classifyIds is NOT required by the platform,
          // so a miss just means "no category" rather than an error.
          const taxo = tencentTaxoCtx
            ? tencentTaxonomy.resolveFromContext(tencentTaxoCtx, { category: article.planCategory })
            : null;
          const taxoSummary = taxo
            ? {
                classify: taxo.classifyName || taxo.classifyIds[0] || null,
                classifyIds: taxo.classifyIds,
                classifyOrigin: taxo.classifyOrigin,
                dictEmpty: taxo.dictEmpty,
              }
            : null;
          // Main image: the blog's own featured image, straight from the articles
          // table (articles.featured_image). Tencent Cloud accepts ANY external url
          // as-is — including webp — so no upload step is involved.
          const coverUrl = article.featuredImage || null;

          if (dryRun) {
            appendLog(site.siteDir, {
              action: 'dry-run', platform, slug, ok: true,
              detail: { title: article.title, tags, coverUrl, taxonomy: taxoSummary },
            });
            results.push({ slug, ok: true, dryRun: true, title: article.title, tags, coverUrl, taxonomy: taxoSummary });
            continue;
          }

          const res = await tencent.publishTencent({
            mdFile: mdPath,
            title: article.title,
            publish: !asDraft,
            tags,
            classifyIds: taxo ? taxo.classifyIds : null,
            coverUrl,
          });
          appendLog(site.siteDir, {
            action: asDraft ? 'draft' : 'publish', platform, slug, ok: !res.failed,
            detail: { ...res, taxonomy: taxoSummary },
          });
          if (res.failed) {
            failed += 1;
            results.push({ slug, ok: false, stage: res.stage, detail: res, title: article.title });
          } else {
            // identical shape to the csdn branch so channel_plan logging is uniform
            results.push({
              slug,
              ok: true,
              published: !asDraft,
              draftId: res.draftId,
              articleId: res.articleId,
              url: res.url,
              title: article.title,
              tags: res.tags,
              coverUrl: res.coverUrl,
              underReview: !!res.underReview,
              taxonomy: taxoSummary,
            });
          }
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

  // report slugs dropped by the channel-agnostic dedup (already published here)
  for (const s of skipped) {
    results.push({ slug: s, ok: true, skipped: true, reason: 'already published (channel_plan)' });
  }

  return {
    ok: failed === 0,
    platform,
    action: asDraft ? 'draft' : 'publish',
    refs: { mdDir: exportDir(site.siteDir, platform) },
    results,
    skipped: skipped.length ? skipped : undefined,
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

  // ---- channel-agnostic dedup on slug (Mode B) ----
  // Same single filterUnpublished used by Mode A — only slugs NOT yet published on
  // this platform are exported/pushed. Keeps a rewritten draft from re-landing an
  // article that already went out.
  const inSlugs = (articles || []).map((a) => (a && a.slug)).filter(Boolean);
  const { toPublish: keepSlugs, skipped } = await t.plan.channel.filterUnpublished(platform, inSlugs);
  const keepSet = new Set(keepSlugs);
  if (skipped.length) {
    appendLog(site.siteDir, {
      action: 'skip-published',
      platform,
      slugs: skipped,
      ok: true,
      detail: { reason: 'already published on this platform (Mode B)', mode: 'export' },
    });
  }
  const activeArticles = (articles || []).filter((a) => keepSet.has(a.slug));

  const exported = [];
  let failed = 0;
  for (const article of activeArticles) {
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

  // report Mode B slugs dropped by the channel-agnostic dedup
  for (const s of skipped) {
    exported.push({ slug: s, ok: true, skipped: true, reason: 'already published (channel_plan)' });
  }

  // ---- api:official platforms (wechat) actually push the rewritten draft ----
  // Mode B's contract: the harness already rewrote the article; here we land it in
  // the platform draft box (createDraft) instead of only exporting a local package.
  let pushResult = null;
  const plat = registry.getPlatform(platform);
  if (plat && plat.api === 'official' && platform === 'wechat' && !dryRun) {
    try {
      pushResult = await publishRewrittenToWechat({ articles: activeArticles, siteKey });
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
    for (const article of activeArticles) {
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
          contentMd: stripLeadingTitle(article.contentMd, article.title).trim(),
          title,
          publish: !asDraft,
          tags,
          categoryId: taxo ? taxo.categoryId : null,
          tagIds: taxo ? taxo.tagIds : null,
          // 封面：博客特色图（harness 传入的 cover；缺失时回落 articles.featured_image）。
          coverUrl: await featuredImageFor(article.slug, article.cover || article.featuredImage),
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

  // ---- csdn: Mode B ALSO pushes the rewritten draft through the real pipeline ----
  // Same rationale as juejin: without this a platform-adapted draft would only ever
  // land on disk. CSDN needs no taxonomy dictionary (free-text tags), but it DOES
  // need the HTML conversion, which publishCsdn does internally (mdToCsdnHtml).
  const csdnResults = [];
  if (platform === 'csdn' && !dryRun) {
    for (const article of activeArticles) {
      if (!article.slug || !article.title || !article.contentMd) continue;
      try {
        // tags: prefer the DB plan row (single source of truth, as in Mode A);
        // fall back to whatever tags the harness passed in.
        let tags = Array.isArray(article.tags) && article.tags.length ? article.tags : [];
        try {
          await t.db.withConn(async (conn) => {
            const row = await planRepo.getBySlug(conn, DEFAULT_APP_ID(), article.slug);
            if (row && Array.isArray(row.tags) && row.tags.length) tags = row.tags;
          });
        } catch (e) {
          // a missing plan row must not block publishing
        }

        const res = await csdn.publishCsdn({
          contentMd: stripLeadingTitle(article.contentMd, article.title).trim(),
          title: article.title,
          publish: !asDraft,
          tags,
          // 封面同 Mode A：harness 传了 cover 就用，否则回落到 DB featured_image。
          coverUrl: await featuredImageFor(article.slug, article.cover || article.featuredImage),
        });

        appendLog(site.siteDir, {
          action: asDraft ? 'draft' : 'publish',
          platform,
          slug: article.slug,
          ok: !res.failed,
          detail: { ...res, rewrite: article.rewrite || 'harness' },
        });

        if (res.failed) {
          failed += 1;
          csdnResults.push({ slug: article.slug, ok: false, stage: res.stage, detail: res, title: article.title });
        } else {
          csdnResults.push({
            slug: article.slug,
            ok: true,
            published: !asDraft,
            draftId: res.draftId,
            articleId: res.articleId,
            url: res.url,
            title: article.title,
            tags: res.tags,
          });
        }
      } catch (e) {
        failed += 1;
        csdnResults.push({ slug: article.slug, ok: false, error: e.message, title: article.title });
        appendLog(site.siteDir, { action: 'error', platform, slug: article.slug, ok: false, detail: { error: e.message } });
      }
    }
  }

  // ---- aliyun: Mode B ALSO pushes the rewritten draft through the real pipeline ----
  // Same rationale as csdn: without this a platform-adapted draft would only ever land
  // on disk. Aliyun takes Markdown directly (no HTML conversion) and has no free-text
  // tags. Publish stays human-gated, so this always lands in the draft box.
  const aliyunResults = [];
  if (platform === 'aliyun' && !dryRun) {
    for (const article of activeArticles) {
      if (!article.slug || !article.title || !article.contentMd) continue;
      try {
        const res = await aliyun.publishAliyun({
          contentMd: stripLeadingTitle(article.contentMd, article.title).trim(),
          title: article.title,
          publish: false, // live publish is human-gated on this platform
          coverUrl: await featuredImageFor(article.slug, article.featuredImage),
        });

        appendLog(site.siteDir, {
          action: 'draft',
          platform,
          slug: article.slug,
          ok: !res.failed,
          detail: { ...res, rewrite: article.rewrite || 'harness' },
        });

        if (res.failed) {
          failed += 1;
          aliyunResults.push({ slug: article.slug, ok: false, stage: res.stage, detail: res, title: article.title });
        } else {
          aliyunResults.push({
            slug: article.slug,
            ok: true,
            published: false,
            draftId: res.draftId,
            articleId: null,
            url: res.url,
            title: article.title,
            publishGated: true,
          });
        }
      } catch (e) {
        failed += 1;
        aliyunResults.push({ slug: article.slug, ok: false, error: e.message, title: article.title });
        appendLog(site.siteDir, { action: 'error', platform, slug: article.slug, ok: false, detail: { error: e.message } });
      }
    }
  }

  // ---- tencent: Mode B ALSO pushes the rewritten draft through the real pipeline ----
  // Same rationale as csdn/aliyun: without this a platform-adapted draft would only
  // ever land on disk. Tencent Cloud takes Markdown directly and is NOT publish-gated,
  // so when `asDraft` is false this goes live (into the platform review queue).
  const tencentResults = [];
  if (platform === 'tencent' && !dryRun) {
    const tencentTaxoCtx = await tencentTaxonomy.prepareTencentTaxonomy({ siteDir: site.siteDir, autoSync: true });
    for (const article of activeArticles) {
      if (!article.slug || !article.title || !article.contentMd) continue;
      try {
        // Category: prefer the DB plan row (single source of truth, as in Mode A).
        let category = null;
        try {
          await t.db.withConn(async (conn) => {
            const row = await planRepo.getBySlug(conn, DEFAULT_APP_ID(), article.slug);
            if (!row) return;
            category = row.category || category;
          });
        } catch (e) {
          // a missing plan row must not block publishing
        }
        const taxo = tencentTaxoCtx
          ? tencentTaxonomy.resolveFromContext(tencentTaxoCtx, { category })
          : null;
        const taxoSummary = taxo
          ? {
              classify: taxo.classifyName || taxo.classifyIds[0] || null,
              classifyIds: taxo.classifyIds,
              classifyOrigin: taxo.classifyOrigin,
              dictEmpty: taxo.dictEmpty,
            }
          : null;

        const res = await tencent.publishTencent({
          contentMd: stripLeadingTitle(article.contentMd, article.title).trim(),
          title: article.title,
          publish: !asDraft, // not human-gated on this platform
          tags: Array.isArray(article.tags) && article.tags.length ? article.tags : null,
          classifyIds: taxo ? taxo.classifyIds : null,
          // Mode B articles come from the harness; when they carry no cover, fall
          // back to the articles table (same source of truth as Mode A).
          coverUrl: await featuredImageFor(article.slug, article.featuredImage),
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
          tencentResults.push({ slug: article.slug, ok: false, stage: res.stage, detail: res, title: article.title });
        } else {
          tencentResults.push({
            slug: article.slug,
            ok: true,
            published: !asDraft,
            draftId: res.draftId,
            articleId: res.articleId,
            url: res.url,
            title: article.title,
            tags: res.tags,
            coverUrl: res.coverUrl,
            underReview: !!res.underReview,
            taxonomy: taxoSummary,
          });
        }
      } catch (e) {
        failed += 1;
        tencentResults.push({ slug: article.slug, ok: false, error: e.message, title: article.title });
        appendLog(site.siteDir, { action: 'error', platform, slug: article.slug, ok: false, detail: { error: e.message } });
      }
    }
  }

  const pushResults = [...juejinResults, ...csdnResults, ...aliyunResults, ...tencentResults];

  return {
    ok: failed === 0,
    platform,
    action: pushResults.length ? (asDraft ? 'draft' : 'publish') : pushResult ? 'draft' : 'manual',
    refs: { mdDir: dir, mediaId: pushResult && pushResult.mediaId },
    exported,
    // mirror Mode A's shape so the MCP publish log (channel_plan) can record it
    results: pushResults.length ? pushResults : undefined,
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
