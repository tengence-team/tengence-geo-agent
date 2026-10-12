'use strict';
/**
 * GEO content engine MCP tool registry (@tengence/geo-mcp/tools/registry)
 * ============================================================================
 * Each tool = { name, description, inputSchema, run(args) }.
 * inputSchema uses Zod raw shapes (@modelcontextprotocol/sdk 1.30 native support;
 * auto-converted to JSON Schema).
 * run() context contract:
 *   - the user workspace is NOT assumed: it comes from (a) the tool argument,
 *     (b) a previous workspace_use call in this session, (c) the persisted state
 *     file, or (d) the SITES_ROOT env var. When none is known the tool returns an
 *     actionable error instead of guessing a directory (see geo-sdk/site/workspace).
 *   - internal runtime data (SQLite/state/logs) lives in ~/.tengence/geo-mcp and is
 *     resolved inside geo-sdk/paths.js — never configured through the MCP client;
 *   - the site argument is resolved from the workspace: when it holds exactly one
 *     site that site is used, otherwise an explicit `site` is required;
 *   - every return is { content: [{ type: 'text', text }] }, text being a JSON string
 *     (structured, easy for AI consumption).
 *
 * Implementation strategy: prefer calling the @tengence/geo-sdk domain APIs directly
 * (same logic); pure-orchestration operations (ingest / export / image / publish draft /
 * update) delegate to @tengence/geo-cli bins (canonical behavior, avoiding duplicated
 * orchestration in the MCP layer).
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const { z } = require('zod');
const t = require('@tengence/geo-sdk');

/**
 * Platforms whose publish outcomes are logged per-platform into channel_plan
 * (platform='juejin' / platform='csdn' / …), which is what gives each of them an
 * INDEPENDENT publishing calendar and drives the shared slug-based dedup.
 * wechat is excluded: it keeps a real per-issue calendar imported from its plan doc.
 *
 * devto IS included (2026-10-11): publishDevto was DRAFT-FIRST (dashboard publish is
 * manual; dev.to has no review pipeline), so the log must record the draft —
 * otherwise nextDue would re-create a duplicate draft every run. Since 2026-10-12
 * dev.to publishes LIVE (published:true + cover image), so the status rule
 * (r.published) now logs devto rows as "published".
 */
// 'aliyun' is included even though its publish is human-gated: the log is what the
// slug-based dedup reads, so a draft-only run must still be recorded as "draft"
// (never "published") — otherwise every run would create another draft.
const PUBLISH_LOG_PLATFORMS = ['juejin', 'csdn', 'aliyun', 'tencent', 'devto'];

// ---- language-code gate (2026-10-07) --------------------------------------
// Language identifiers are unified to zh-hans | en | zh-hant — the LANG_MAP was
// removed and normalizeLang is identity, so a legacy region code (zh-cn / en-us /
// zh-hk / zh-tw, any casing) would be written to the DB **as-is** and silently
// re-pollute plan/articles rows. Every tool whose input carries a language code
// and writes rows must reject legacy codes at its entry.
const { LANG_OK, LANG_LEGACY } = require('./languages');/** @returns {string|null} rejection message, or null when the code is valid. */
function langReject(lang) {
  const v = String(lang == null ? '' : lang).trim().toLowerCase();
  if (v === '') return null;
  if (LANG_LEGACY.has(v)) {
    return `language code "${lang}" is a legacy region code — use zh-hans | en | zh-hant (unified 2026-10-07); rejected`;
  }
  if (!LANG_OK.has(v)) return `language code "${lang}" is not supported (zh-hans | en | zh-hant)`;
  return null;
}
/** Normalize a validated language code to lowercase. */
function langNorm(lang) {
  return String(lang).trim().toLowerCase();
}
/** @returns {string|null} first invalid key message, or null when all keys are valid. */
function recordLangsReject(record, field) {
  for (const k of Object.keys(record || {})) {
    const e = langReject(k);
    if (e) return `${field} key: ${e}`;
  }
  return null;
}

/**
 * Resolve the user workspace for a call.
 * `args.workspace` overrides everything for this one call; otherwise the already
 * bound / persisted value is used. Throws when unknown — nothing is invented here.
 */
function useWorkspace(args) {
  if (args && args.workspace) t.workspace.use(args.workspace);
  return t.workspace.require();
}

/**
 * Resolve the site key for a call.
 * Explicit `site` wins; otherwise the workspace must contain exactly one site —
 * with zero or many, we ask instead of picking one at random.
 */
function resolveSiteKey(args) {
  const key = args && args.site;
  if (key) return key;
  const sites = t.site.listSites();
  if (sites.length === 1) return sites[0];
  if (sites.length === 0) {
    throw new Error(
      'The workspace contains no site yet. Call site_init with a site key to scaffold ' +
        'one (e.g. site_init({"key": "tengence", "domain": "example.com"})).'
    );
  }
  throw new Error(`Multiple sites exist in this workspace; pass an explicit "site": ${sites.join(', ')}`);
}

/** Site context: loadSite(<resolved key>).
 * Bootstrap: when the requested key does not exist yet, it is auto-initialized
 * (same philosophy as the DB — "created on first use"); args.url supplies the
 * canonical domain. The returned object carries `_bootstrap`
 * ({created, site_key, domain, site_dir}) so callers can surface it. */
function withSite(args) {
  useWorkspace(args);
  const key = resolveSiteKey(args);
  try {
    return t.site.loadSite(key, { domain: key });
  } catch (e) {
    if (args.url) {
      const { key: k, domain } = t.site.siteKeyFromUrl(args.url);
      return t.site.loadSite(k, { autoInit: true, domain });
    }
    return t.site.loadSite(key, { autoInit: true, domain: key });
  }
}

/** Bind workspace (if given) and resolve the site key — single expression for CLI delegation. */
function cliSite(args) {
  useWorkspace(args);
  return resolveSiteKey(args);
}

/** Uniformly wrap a result as MCP text content (JSON string, indent=2) */
function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/**
 * Like ok(), but also exposes the parsed payload as MCP `structuredContent`
 * (machine-readable channel) so clients can consume it without string-parsing.
 * Structured tools return this on their success branch; server.js passes it
 * through untouched (no server-side re-parsing).
 */
function okStructured(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/** Wrap an error as MCP text content with isError; normalizes non-Error throws. */
function fail(err) {
  const message = err && err.message ? err.message : String(err);
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }],
    isError: true,
  };
}

/** Delegate to a geo-cli bin (canonical orchestration); returns { code, stdout, stderr } */
function runCli(binName, args, opts = {}) {
  const binPath = require.resolve(`@tengence/geo-cli/bin/${binName}.js`);
  // Propagate the bound workspace to the child process: geo-cli resolves the site
  // through SITES_ROOT (site/config.js) and an in-process setSitesRoot is invisible
  // to a spawned child, so without this every site-dependent CLI starts unbound.
  const sitesRoot = t.site.SITES_ROOT;
  const res = spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(sitesRoot ? { SITES_ROOT: sitesRoot } : {}), ...opts.env },
    timeout: opts.timeout || 300000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { code: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
}

// ==================== Zod schema helpers ====================

const siteField = z
  .string()
  .optional()
  .describe('site key; auto-selected when the workspace holds exactly one site');
const workspaceField = z
  .string()
  .optional()
  .describe('absolute user workspace directory (`~` allowed); binds it for later calls when given');

// ==================== tool definitions ====================
// ==================== Article field routing (publish_update_fields) ====================

/**
 * Where each article field has to be written. One merged tool, three destinations —
 * the split is forced by the platform, not by convenience:
 *
 *  - `wp`    → WP native REST (/wp/v2/posts/{id}). Only this API can write the post
 *              body / title / excerpt / status / slug / taxonomy / featured_media
 *              (media ID). It CANNOT write post_modified (readonly, verified).
 *  - `meta`  → Tengence plugin API (PUT /tengence/v1/posts/{id}). The 21 registered
 *              SEO/GEO/base keys. Native WP silently drops unregistered meta keys.
 *  - `date`  → plugin dates API (POST /tengence/v1/posts/{id}/dates); the only way
 *              to write post_modified.
 *
 * SEO (`seo_*`) and GEO (`geo_*`) stay separate groups on purpose — they are
 * different concerns with different owners and are reported back separately, so a
 * caller can update one without touching the other.
 */
const ARTICLE_FIELD_ROUTES = {
  // --- WP native (post body / taxonomy / featured image media id) ---
  title: 'wp',
  content: 'wp',
  excerpt: 'wp',
  slug: 'wp',
  status: 'wp',
  categories: 'wp',
  tags: 'wp',
  sticky: 'wp',
  featured_media: 'wp',

  // --- plugin meta: base ---
  image: 'meta',            // featured image URL (meta mirror of featured_media)
  image_alt: 'meta',
  reading_time: 'meta',
  author: 'meta',

  // --- plugin meta: SEO (independent group) ---
  seo_meta_title: 'meta',
  seo_meta_description: 'meta',
  seo_meta_keywords: 'meta',
  seo_canonical_url: 'meta',
  seo_og_type: 'meta',
  seo_og_locale: 'meta',
  seo_noindex: 'meta',
  seo_og_image: 'meta',

  // --- plugin meta: GEO (independent group) ---
  geo_ai_summary: 'meta',
  geo_qa_pairs: 'meta',
  geo_citations: 'meta',
  geo_key_takeaways: 'meta',
  geo_schema_data: 'meta',
  geo_entity: 'meta',

  // --- plugin meta: i18n / regions / cta ---
  i18n: 'meta',
  regions: 'meta',
  cta: 'meta',

  // --- plugin dates API ---
  date: 'date',
  date_gmt: 'date',
  modified: 'date',
  modified_gmt: 'date',
};

/** Meta keys handled by the plugin dates API rather than the meta endpoint. */
const DATE_FIELD_KEYS = ['date', 'date_gmt', 'modified', 'modified_gmt'];

/** Meta keys treated as SEO for reporting / DB mirroring. */
const SEO_META_KEYS = Object.keys(ARTICLE_FIELD_ROUTES).filter(
  (k) => ARTICLE_FIELD_ROUTES[k] === 'meta' && k.startsWith('seo_')
);
/** Meta keys treated as GEO for reporting. */
const GEO_META_KEYS = Object.keys(ARTICLE_FIELD_ROUTES).filter(
  (k) => ARTICLE_FIELD_ROUTES[k] === 'meta' && k.startsWith('geo_')
);


const tools = [
  // ---------- workspace ----------
  {
    name: 'workspace_use',
    title: '绑定工作目录',
    annotations: { readOnlyHint: false },
    structured: true,
    description:
      'Bind the user workspace directory (call this first): all site config, credentials and output files live under it. Ask the user which directory to use if it was not mentioned; `~` is supported and expanded here.',
    inputSchema: z.object({
      path: z.string().describe('absolute directory path chosen by the user (e.g. ~/my-geo-workspace)'),
      create: z.boolean().optional().describe('create the directory when missing (default false)'),
    }),
    async run(args) {
      try {
        return okStructured(t.workspace.use(args.path, { create: !!args.create }));
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'site_init',
    title: '初始化站点',
    annotations: { openWorldHint: false },
    structured: true,
    description:
      'Scaffold a site inside the bound workspace: <workspace>/<key>/{config,data/inbox,data/reports,.env} (idempotent, never overwrites existing files)',
    inputSchema: z.object({
      key: z.string().describe('site key (lowercase letters, digits, underscore)'),
      domain: z.string().optional().describe('canonical domain, defaults to the key'),
      name: z.string().optional().describe('display name, defaults to the domain'),
      lang: z.string().optional().describe('default language (default zh-hans)'),
    }),
    async run(args) {
      try {
        t.workspace.require();
        return okStructured(t.site.initSite(args));
      } catch (e) {
        return fail(e);
      }
    },
  },

  // ---------- site ----------
  {
    name: 'site_list',
    title: '列出站点',
    annotations: { readOnlyHint: true },
    structured: true,
    description:
      'List the sites inside the bound user workspace (site key, domain, app_id, storage driver). Returns a hint instead when no workspace is bound yet.',
    inputSchema: z.object({}),
    async run() {
      const bound = t.workspace.current();
      if (!bound) {
        return okStructured({
          ok: false,
          bound: false,
          sites: [],
          hint: t.workspace.NOT_BOUND_HINT,
        });
      }
      const sites = t.site.listSites().map((key) => {
        try {
          const s = t.site.loadSite(key);
          return {
            key,
            domain: (s.site && s.site.site && s.site.site.domain) || '',
            app_id: parseInt(process.env.APP_ID || s.env.APP_ID || '1', 10),
            driver: t.db.driver(),
          };
        } catch (e) {
          return { key, error: e.message };
        }
      });
      return okStructured({ ok: true, bound: true, workspace: bound, sites, sites_root: t.site.SITES_ROOT });
    },
  },
  {
    name: 'site_status',
    title: '站点状态',
    description: 'Site status: config paths, .env readiness, DB driver and SQLite init state',
    inputSchema: z.object({ site: siteField }),
    async run(args) {
      try {
        const S = withSite(args);
        const driver = t.db.driver();
        const dbInfo =
          driver === 'sqlite'
            ? t.db.sqliteDbStatus()
            : { driver: 'mysql', database: (S.env.DB_DATABASE || '(not configured)') };
        const envKeys = ['WP_URL', 'WP_USERNAME', 'WP_PASSWORD', 'DB_HOST', 'DB_DATABASE'];
        return ok({
          ok: true,
          site: S.siteKey,
          site_dir: S.siteDir,
          ...(S._bootstrap ? { _bootstrap: S._bootstrap } : {}),
          driver,
          db: dbInfo,
          app_id: parseInt(process.env.APP_ID || S.env.APP_ID || '1', 10),
          env: Object.fromEntries(envKeys.map((k) => [k, !!S.env[k]])),
        });
      } catch (e) {
        return fail(e);
      }
    },
  },

  // ---------- article ----------
  {
    name: 'article_list',
    title: '文章列表',
    description: 'List articles (articles table), with status/lang/limit filters',
    inputSchema: z.object({
      site: siteField,
      status: z.string().optional().describe('draft|queued|published etc. (optional)'),
      lang: z.string().optional().describe('language filter (zh-hans|en|zh-hant; default all)'),
      limit: z.number().optional().describe('max rows (default 50)'),
    }),
    async run(args) {
      try {
        const S = withSite(args);
        const appId = parseInt(process.env.APP_ID || S.env.APP_ID || '1', 10);
        const rows = await t.db.withConn((conn) =>
          t.db.articles.list(conn, appId, {
            status: args.status || undefined,
            lang: args.lang || undefined,
            limit: args.limit || 50,
          })
        );
        return ok({ ok: true, count: rows.length, articles: rows });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'wp_post_get',
    title: '查询 WP 文章',
    description:
      'Read-only WordPress post lookup (id / slug / status / link / date / modified, and the ' +
      'full body HTML with include_content=true). ' +
      'Look up by wp_post_id, or by slug + lang (resolved through the plugin language endpoint). ' +
      'Use this to check whether an article is still an unpublished draft before promoting it — ' +
      'the articles table status is NOT authoritative for that.',
    inputSchema: z.object({
      site: siteField,
      wp_post_id: z.number().optional().describe('WordPress post ID'),
      slug: z.string().optional().describe('article slug (required when wp_post_id is omitted)'),
      lang: z
        .string()
        .optional()
        .describe('language code for a slug lookup: zh-hans | en | zh-hant (default zh-hans)'),
      include_content: z
        .boolean()
        .optional()
        .describe('also return the post body HTML (content.raw via WP context=edit); default false'),
    }),
    async run(args) {
      try {
        const S = withSite(args);
        const siteKey = S.siteKey || S.key;
        let postId = args.wp_post_id ? Number(args.wp_post_id) : null;
        const lang = args.lang || 'zh-hans';
        if (!postId) {
          if (!args.slug) return fail(new Error('either wp_post_id or slug is required'));
          const found = await t.wp.posts.findPostByLanguage(args.slug, lang, { siteKey });
          if (found && found.id) postId = found.id;
          if (!postId) {
            // WP hides drafts from a plain slug query; ask for them explicitly.
            const draft = await t.wp.posts.findBySlug(args.slug, { siteKey, status: 'draft' });
            if (draft && draft.id) postId = draft.id;
          }
          if (!postId) {
            const any = await t.wp.posts.findBySlug(args.slug, { siteKey });
            if (any && any.id) postId = any.id;
          }
          if (!postId) {
            return ok({
              ok: false,
              found: false,
              slug: args.slug,
              lang,
              reason: 'no WordPress post found for this slug + lang',
            });
          }
        }
        const fields =
          'id,slug,status,link,date,modified,featured_media' + (args.include_content ? ',content' : '');
        const query = `?_fields=${fields}` + (args.include_content ? '&context=edit' : '');
        const post = await t.wp.posts.get(postId, query, { siteKey });
        const out = {
          id: post.id,
          slug: post.slug,
          status: post.status,
          link: post.link,
          date: post.date,
          modified: post.modified,
          featured_media: post.featured_media || null,
        };
        // Featured image lives in WP (drafts are prepared in wp-admin with their image
        // already attached) — read it back from the media library so callers can reuse
        // the SAME image instead of acquiring a new one.
        if (post.featured_media) {
          try {
            const media = await t.wp.media.getMedia(post.featured_media, { siteKey });
            out.featured_image = media ? media.url : null;
            if (media) out.featured_alt = media.alt;
          } catch (e) {
            out.featured_image = null;
            out.featured_error = String(e.message).slice(0, 200);
          }
        } else {
          out.featured_image = null;
        }
        if (args.include_content) {
          out.content = post.content && post.content.raw !== undefined ? post.content.raw : (post.content || {}).rendered;
        }
        return ok({ ok: true, found: true, post: out });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'article_ingest',
    title: '入库文章',
    annotations: { openWorldHint: false },
    structured: true,
    description: 'Content ingest (single entry): body md + research brief → articles table (CLI canonical orchestration)',
    inputSchema: z.object({
      slug: z.string().describe('article slug'),
      md_path: z.string().describe('absolute path to the body Markdown file'),
      research_path: z.string().optional().describe('absolute path to the research brief (required by the publish gate)'),
      site: siteField,
      lang: z.string().optional().describe('language (defaults to the site default)'),
    }),
    async run(args) {
      if (!args.slug || !args.md_path) {
        return fail(new Error('article_ingest requires slug + md_path'));
      }
      if (args.lang) {
        const e = langReject(args.lang);
        if (e) return fail(new Error(e));
        args.lang = langNorm(args.lang);
      }
      const cliArgs = [args.slug, args.md_path, '--site', cliSite(args)];
      if (args.lang) cliArgs.push('--lang', args.lang);
      if (args.research_path) cliArgs.push('--research', args.research_path);
      const r = runCli('article-ingest', cliArgs);
      return okStructured({
        ok: r.code === 0,
        exit_code: r.code,
        output: r.stdout || r.stderr,
      });
    },
  },
  {
    name: 'article_export',
    title: '导出文章',
    description: 'Export an article md + brief from the DB to the site data/inbox (for rewriting / translation)',
    inputSchema: z.object({
      slug: z.string().describe('article slug'),
      site: siteField,
      lang: z.string().optional().describe('language (zh-hans|en|zh-hant; default the site default)'),
    }),
    async run(args) {
      if (!args.slug) return fail(new Error('article_export requires slug'));
      const cliArgs = [args.slug, '--site', cliSite(args)];
      if (args.lang) cliArgs.push('--lang', args.lang);
      const r = runCli('article-export', cliArgs);
      return ok({ ok: r.code === 0, exit_code: r.code, output: r.stdout || r.stderr });
    },
  },

  // ---------- check ----------
  {
    name: 'check_article',
    title: '校验文章（G1–G14 门禁）',
    annotations: { readOnlyHint: true },
    structured: true,
    description: 'Publish gate: enforces the editorial rules codified in the "article-writing-standards" standard (citation dual-channel, word count by T1–T7 type, banned words, the three GEO blocks — Summary / Key Takeaways / FAQ / Data Sources — and the research-brief hard check). Read that standard via resource geo://standard/article-writing-standards before authoring, and run article_draft first to scaffold per-spec.',
    inputSchema: z.object({
      slug: z.string().describe('article slug'),
      site: siteField,
      type: z.string().optional().describe('T1..T7 (hard word-count check by type when declared)'),
      lang: z.string().optional().describe('article language (zh-hans|en|zh-hant; default the site default)'),
    }),
    async run(args) {
      if (!args.slug) return fail(new Error('check_article requires slug'));
      if (args.lang) {
        const e = langReject(args.lang);
        if (e) return fail(new Error(e));
        args.lang = langNorm(args.lang);
      }
      try {
        const S = withSite(args);
        process.env.APP_ID = process.env.APP_ID || S.env.APP_ID || '1';
        const result = await t.check.checkArticle({
          slug: args.slug,
          type: args.type || null,
          lang: args.lang || null,
          site: S.siteKey,
        });
        return okStructured({
          ok: result.ok,
          slug: result.slug,
          rows: result.rows,
          warns: result.warns,
          // an already-published row (wp_post_id > 0) is gated advisory: re-publishing
          // it (translation_group, metadata fixes) must not be blocked by editorial
          // rules that postdate the body. Drafts stay hard-gated.
          isPublished: result.isPublished,
          research: result.research,
        });
      } catch (e) {
        return fail(e);
      }
    },
  },

  // ---------- translation (multilingual v1) ----------
  {
    name: 'translation_glossary_get',
    title: '读取翻译术语表',
    description: 'Translation glossary for a target language: merged global + site glossary (brands / phrases / product terms / forbidden words). ' +
      'Read it via resource geo://standard/translation-standards once per article, then consult this tool for the concrete terms the harness must apply',
    inputSchema: z.object({
      site: siteField,
      target_lang: z.string().describe('target language (en|zh-hant)'),
    }),
    async run(args) {
      try {
        const S = withSite(args);
        const full = t.translate.glossary.loadFull(S.siteKey);
        const lang = args.target_lang || 'en';
        const out = {
          brands: full.brands || {},
          phrases: full.phrases || {},
          product_terms: full.product_terms || {},
          forbidden: (full.forbidden && full.forbidden[lang]) || [],
        };
        return ok({ ok: true, target_lang: lang, glossary: out });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'check_translation',
    title: '校验译文（T 系列门禁）',
    description: 'Mechanical gate for a translated article (T1–T9): structure/blocks/numbering, link-set & image-set & number-set parity with the source, ' +
      'Simplified-Chinese & CJS residue, forbidden terms, per-section length, title & meta_description lengths. ' +
      'The harness translates with its own LLM and runs this before article_ingest --lang',
    inputSchema: z.object({
      slug: z.string().describe('article slug (source and, when md_path is absent, target DB row)'),
      source_lang: z.string().describe('source language (zh-hans)'),
      target_lang: z.string().describe('target language (en|zh-hant)'),
      md_path: z.string().optional().describe('absolute path to the translated Markdown (preferred; when absent the target is read from the DB row slug+target_lang)'),
      site: siteField,
    }),
    async run(args) {
      if (!args.slug || !args.target_lang) return fail(new Error('check_translation requires slug and target_lang'));
      if (args.source_lang) {
        const es = langReject(args.source_lang);
        if (es) return fail(new Error(es));
        args.source_lang = langNorm(args.source_lang);
      }
      {
        const et = langReject(args.target_lang);
        if (et) return fail(new Error(et));
        args.target_lang = langNorm(args.target_lang);
      }
      try {
        const S = withSite(args);
        const appId = parseInt(process.env.APP_ID || S.env.APP_ID || '1', 10);
        const sourceLang = args.source_lang || 'zh-hans';
        const targetLang = args.target_lang;
        let sourceMd = null;
        let targetMd = null;
        let src = null;
        let targetSeo = null;
        let targetFeaturedImage = null;
        await t.db.withConn(async (conn) => {
          src = await t.db.articles.getDetail(conn, appId, args.slug, sourceLang);
          sourceMd = src && src.content_longtext ? String(src.content_longtext) : '';
          if (!args.md_path) {
            const tgt = await t.db.articles.getDetail(conn, appId, args.slug, targetLang);
            targetMd = tgt && tgt.content_longtext ? String(tgt.content_longtext) : '';
            targetSeo = (tgt && tgt.seo) || null;
            targetFeaturedImage = (tgt && tgt.featured_image) || null;
          }
        });
        if (args.md_path) {
          targetMd = fs.readFileSync(args.md_path, 'utf8');
          // pre-ingest workflow: the translated .md may not carry the seo/featured_image
          // yet, so fall back to the already-ingested target row when one exists.
          await t.db.withConn(async (conn) => {
            const tgt = await t.db.articles.getDetail(conn, appId, args.slug, targetLang);
            if (tgt) {
              targetSeo = targetSeo || (tgt.seo || null);
              targetFeaturedImage = targetFeaturedImage || (tgt.featured_image || null);
            }
          });
        }
        if (!sourceMd || !targetMd) {
          const missing = [];
          if (!sourceMd) missing.push(`source ${sourceLang} (slug=${args.slug})`);
          if (!targetMd) missing.push(args.md_path ? `file ${args.md_path}` : `target ${targetLang} (slug=${args.slug})`);
          return fail(new Error(`check_translation: missing content for ${missing.join(', ')}`));
        }
        // 源正文无 front matter：把共享 featured_image 组装进源侧，
        // 供 T3 校验目标 front matter 的 featured_image 与源一致（三语复用同一张图）。
        if (src && src.featured_image) {
          sourceMd = `---\nfeatured_image: "${String(src.featured_image).replace(/"/g, '\\"')}"\n---\n\n` + sourceMd;
        }
        // 目标侧同理注入 featured_image：DB 模式下 content_longtext 无 front matter，
        // 注入后 T3 才能校验三语复用同一张图（无注入时目标图集合为空会误报）。
        if (targetFeaturedImage && !/^\s*---\s*[\s\S]*?^featured_image\s*:/m.test(targetMd)) {
          targetMd = `---\nfeatured_image: "${String(targetFeaturedImage).replace(/"/g, '\\"')}"\n---\n\n` + targetMd;
        }
        const result = t.translate.checkTranslation({
          sourceMd,
          targetMd,
          sourceLang,
          targetLang,
          siteKey: S.siteKey,
          targetSeo,
        });
        return ok({ ok: result.ok, slug: args.slug, source_lang: sourceLang, target_lang: targetLang, errors: result.errors, checks: result.checks });
      } catch (e) {
        return fail(e);
      }
    },
  },

  // ---------- publish ----------
  {
    name: 'publish_draft',
    title: '发布草稿',
    annotations: { openWorldHint: true },
    structured: true,
    description: 'Publish a draft (default draft → WP; can --status=publish directly, must pass the gate first)',
    inputSchema: z.object({
      md_path: z.string().describe('absolute path to the body Markdown'),
      site: siteField,
      status: z.string().optional().describe('draft|publish (default draft)'),
    }),
    async run(args) {
      if (!args.md_path) return fail(new Error('publish_draft requires md_path'));
      const cliArgs = [args.md_path, '--site', cliSite(args)];
      if (args.status) cliArgs.push('--status', args.status);
      const r = runCli('publish-draft', cliArgs);
      return okStructured({ ok: r.code === 0, exit_code: r.code, output: r.stdout || r.stderr });
    },
  },
  {
    name: 'publish_from_db',
    title: '从库发布',
    description: 'Publish an article from the DB to WordPress (--force updates an existing article). ' +
      'For translations (en / zh-hant) the zh-hans source article\'s publish + update time is inherited by default ' +
      '(via the plugin dates API); pass sync_source_dates=false to opt out.',
    inputSchema: z.object({
      article_id: z.number().describe('articles.id'),
      site: siteField,
      status: z.string().optional().describe('draft|publish (default draft)'),
      force: z.boolean().optional().describe('force-update when it already exists'),
      translation_group: z.string().optional().describe('translation-group UUID shared by the languages of one article (multilingual v1)'),
      sync_source_dates: z.boolean().optional().describe('inherit the zh-hans source publish/update time (default true; translations only)'),
    }),
    async run(args) {
      if (!args.article_id) return fail(new Error('publish_from_db requires article_id'));
      const cliArgs = [String(args.article_id), '--site', cliSite(args)];
      if (args.status) cliArgs.push('--status', args.status);
      if (args.force) cliArgs.push('--force');
      if (args.translation_group) cliArgs.push('--translation-group', args.translation_group);
      if (args.sync_source_dates === false) cliArgs.push('--no-sync-dates');
      const r = runCli('publish-from-db', cliArgs);
      return ok({ ok: r.code === 0, exit_code: r.code, output: r.stdout || r.stderr });
    },
  },
  {
    name: 'publish_update_article',
    title: '更新已发布文章',
    description: 'Bypass update of an existing article (title/content/status + sync SEO/GEO meta). ' +
      'When meta_title / meta_description / post_title is provided, runs meta-only mode: updates ONLY those fields ' +
      '(meta_title → DB seo.title + WP seo_meta_title; meta_description → DB seo.meta_description + WP seo_meta_description, 165–175 chars hard gate; ' +
      'post_title → DB title + WP post_title itself); body/content/status/excerpt untouched. ' +
      'Target the article by article_id, slug (+lang) or post_id. For single-field edits prefer publish_update_fields ' +
      '(one entry point for every attribute); this tool stays for whole-body rewrites from Markdown.',
    inputSchema: z.object({
      md_path: z.string().optional().describe('absolute path to the body Markdown (required for full update; omit in meta-only mode)'),
      meta_title: z.string().optional().describe('new SEO title (≤200 characters). Providing it switches to meta-only mode'),
      meta_description: z.string().optional().describe('new meta_description (165–175 characters). Providing it switches to meta-only mode'),
      post_title: z.string().optional().describe('new WordPress post title itself (≤200 characters, also updates DB title column). Providing it switches to meta-only mode'),
      site: siteField,
      article_id: z.number().optional().describe('articles.id (DB) — resolved to its slug + lang + wp_post_id; the simplest way to target an article'),
      slug: z.string().optional().describe('target slug'),
      lang: z.string().optional().describe('article language for slug lookup (zh-hans|en|zh-hant; default the site default)'),
      post_id: z.number().optional().describe('target WP post id (either slug or post_id)'),
    }).passthrough(),
    async run(args) {
      if (args.lang) {
        const e = langReject(args.lang);
        if (e) return fail(new Error(e));
        args.lang = langNorm(args.lang);
      }
      // resolve article_id → slug / lang / wp_post_id (the CLI only knows slug + post-id)
      let slug = args.slug || null;
      let lang = args.lang || null;
      let postId = args.post_id || null;

      if (args.article_id) {
        const S = withSite(args);
        const appId = parseInt(process.env.APP_ID || S.env.APP_ID || '1', 10);
        const rows = await t.db.withConn((conn) =>
          conn.query(
            'SELECT slug, lang, wp_post_id FROM tengence_geo_articles WHERE id = ? AND app_id = ? LIMIT 1',
            [args.article_id, appId]
          ).then(([r]) => r)
        );
        if (!rows.length) {
          return fail(new Error(`Article ${args.article_id} not found (app_id=${appId})`));
        }
        const row = rows[0];
        // an explicit slug/post_id still wins, so a caller can override the lookup
        slug = slug || row.slug;
        lang = lang || row.lang;
        postId = postId || row.wp_post_id || null;
      }

      const cliArgs = [];
      if (args.meta_title || args.meta_description || args.post_title) {
        if (!slug && !postId) return fail(new Error('meta-only mode requires article_id, slug or post_id'));
        cliArgs.push('--meta-only');
        if (args.meta_title) cliArgs.push('--meta-title', args.meta_title);
        if (args.meta_description) cliArgs.push('--meta-desc', args.meta_description);
        if (args.post_title) cliArgs.push('--post-title', args.post_title);
      } else {
        if (!args.md_path) return fail(new Error('publish_update_article requires md_path (or meta_title/meta_description/post_title for meta-only mode)'));
        cliArgs.push(args.md_path);
      }
      cliArgs.push('--site', cliSite(args));
      if (slug) cliArgs.push('--slug', slug);
      if (lang) cliArgs.push('--lang', lang);
      if (postId) cliArgs.push('--post-id', String(postId));
      const r = runCli('publish-update-article', cliArgs);
      return ok({
        ok: r.code === 0,
        exit_code: r.code,
        resolved: { slug, lang, post_id: postId },
        output: r.stdout || r.stderr,
      });
    },
  },
  {
    name: 'publish_daily',
    title: '每日到期发布',
    description: 'Run the daily promotion task (promotes due drafts to publish by plan publish_order; default 1/day). ' +
      'Optional date sets the promoted article publish/modified time (YYYY-MM-DDTHH:MM:SS, site timezone). ' +
      'Optional slug switches to SLUG MODE: publish that slug with every language version it has in the draft box ' +
      '(zh-hans / en / zh-hant), still running the internal-link check and the gate re-check; comma-separated slugs allowed.',
    inputSchema: z.object({
      site: siteField,
      date: z.string().optional().describe('publish/modified time for the promoted article, YYYY-MM-DDTHH:MM:SS in the site timezone; omit to leave WordPress untouched'),
      slug: z.string().optional().describe('slug mode: publish this slug in all of its languages (comma-separated for several slugs); omit for the normal plan-order queue'),
      count: z.number().optional().describe('how many articles to promote in queue mode (default: wordpress.publish.per_day, usually 1)'),
      dry_run: z.boolean().optional().describe('report only, do not write'),
    }),
    async run(args, ctx) {
      const cliArgs = ['--site', cliSite(args)];
      if (args.slug) cliArgs.push('--slug', args.slug);
      if (args.count) cliArgs.push('--count', String(args.count));
      if (args.date) cliArgs.push('--date', args.date);
      if (args.dry_run) cliArgs.push('--dry-run');
      // promote-daily runs as a synchronous child process (spawnSync), so no
      // mid-run progress is observable; report start + end only.
      if (ctx && ctx.onProgress) ctx.onProgress({ step: 1, total: 2, stage: '发布', detail: '开始执行 promote-daily', percent: 0 });
      const r = runCli('promote-daily', cliArgs);
      if (ctx && ctx.onProgress) ctx.onProgress({ step: 2, total: 2, stage: '发布', detail: `promote-daily 退出码 ${r.code}`, percent: 100 });
      return ok({ ok: r.code === 0, exit_code: r.code, output: r.stdout || r.stderr });
    },
  },
  {
    name: 'publish_update_fields',
    title: '更新文章字段',
    description:
      'Update ANY article attribute through ONE entry point. Fields are routed to the only API that can actually write them:\n' +
      '  • WP native (/wp/v2): title, content, excerpt, slug, status, categories, tags, sticky, featured_media (media ID)\n' +
      '  • plugin meta (PUT /tengence/v1/posts/{id}): image, image_alt, reading_time, author, i18n, regions, cta\n' +
      '  • SEO (independent group): seo_meta_title, seo_meta_description, seo_meta_keywords, seo_canonical_url,\n' +
      '    seo_og_type, seo_og_locale, seo_noindex, seo_og_image\n' +
      '  • GEO (independent group): geo_ai_summary, geo_qa_pairs, geo_citations, geo_key_takeaways, geo_schema_data, geo_entity\n' +
      '  • dates (plugin dates API — the ONLY way to write post_modified, which wp/v2 treats as readonly)\n' +
      'Only the fields you pass are touched; everything else is left untouched. SEO and GEO are applied as one batch each and\n' +
      'reported separately, so you can update one without touching the other. Optionally mirrors title / seo_meta_title /\n' +
      'seo_meta_description into the DB row (sync_db, default true) to keep the DB as the SSOT.',
    inputSchema: z.object({
      site: siteField,
      article_id: z.number().optional().describe('articles.id (DB) — resolved to its wp_post_id; omit when wp_post_id is given'),
      wp_post_id: z.number().optional().describe('target WP post id; overrides the DB mapping when given'),
      lang: z.string().optional().describe('article language for the DB mirror (zh-hans|en|zh-hant; default the site default)'),

      // --- WP native ---
      title: z.string().optional().describe('post title (WP native)'),
      content: z.string().optional().describe('post content HTML (WP native)'),
      excerpt: z.string().optional().describe('post excerpt / summary (WP native)'),
      slug: z.string().optional().describe('post slug (WP native)'),
      status: z.string().optional().describe('draft|publish|pending|private (WP native)'),
      categories: z
        .array(z.union([z.number(), z.string()]))
        .optional()
        .describe('category terms (WP native) — term IDs (numbers) or term slugs (strings); slugs are resolved, pass create_terms to auto-create'),
      tags: z
        .array(z.union([z.number(), z.string()]))
        .optional()
        .describe('tag terms (WP native) — term IDs (numbers) or term slugs (strings); slugs are resolved, pass create_terms to auto-create'),
      create_terms: z.boolean().optional().describe('create missing category/tag slugs passed above instead of failing (default false)'),
      sticky: z.boolean().optional().describe('sticky flag (WP native)'),
      featured_media: z.number().optional().describe('featured image MEDIA ID (WP native); pair with image (URL) to keep both in sync'),

      // --- plugin meta: base ---
      image: z.string().optional().describe('featured image URL (meta)'),
      image_alt: z.string().optional().describe('featured image alt text'),
      reading_time: z.number().optional().describe('reading time in minutes'),
      author: z.string().optional().describe('author display name'),
      i18n: z.any().optional().describe('i18n object (plugin meta)'),
      regions: z.array(z.string()).optional().describe('regions array (plugin meta)'),
      cta: z.any().optional().describe('cta object (plugin meta)'),

      // --- SEO (independent) ---
      seo_meta_title: z.string().optional().describe('SEO title'),
      seo_meta_description: z.string().optional().describe('SEO meta description'),
      seo_meta_keywords: z.array(z.string()).optional().describe('SEO keywords array'),
      seo_canonical_url: z.string().optional().describe('canonical URL'),
      seo_og_type: z.string().optional().describe('OG type'),
      seo_og_locale: z.string().optional().describe('OG locale'),
      seo_noindex: z.boolean().optional().describe('noindex flag'),
      seo_og_image: z.string().optional().describe('OG image URL'),

      // --- GEO (independent) ---
      geo_ai_summary: z.string().optional().describe('GEO AI summary'),
      geo_qa_pairs: z.array(z.any()).optional().describe('GEO QA pairs [{question,answer}]'),
      geo_citations: z.any().optional().describe('GEO citations (array or object)'),
      geo_key_takeaways: z.array(z.string()).optional().describe('GEO key takeaways array'),
      geo_schema_data: z.any().optional().describe('GEO schema data (object or array)'),
      geo_entity: z.any().optional().describe('GEO entity (object)'),

      // --- dates ---
      date: z.string().optional().describe('publish time, YYYY-MM-DDTHH:MM:SS (site timezone)'),
      date_gmt: z.string().optional().describe('publish time (GMT)'),
      modified: z.string().optional().describe('update time, YYYY-MM-DDTHH:MM:SS (site timezone)'),
      modified_gmt: z.string().optional().describe('update time (GMT)'),
      copy_dates_from: z.number().optional().describe('WP post id to copy all four date values from (e.g. the zh-hans source article)'),

      // --- language / translation group ---
      language: z.string().optional().describe('set the post language (zh-hans|en|zh-hant) via the plugin language API'),
      translation_group: z.string().optional().describe('translation-group UUID shared by the languages of one article'),

      // --- behavior ---
      sync_db: z.boolean().optional().describe('mirror title / seo_meta_title / seo_meta_description into the DB row (default true)'),
      dry_run: z.boolean().optional().describe('validate and report the routing without writing anything'),
    }).passthrough(), // keep unknown keys so a typo'd field is reported by name, not silently dropped
    async run(args) {
      if (args.lang) {
        const e = langReject(args.lang);
        if (e) return fail(new Error(e));
        args.lang = langNorm(args.lang);
      }
      if (args.language) {
        const e = langReject(args.language);
        if (e) return fail(new Error(e));
        args.language = langNorm(args.language);
      }
      let connection = null;
      try {
        if (!args.article_id && !args.wp_post_id) {
          return fail(new Error('publish_update_fields requires article_id (or wp_post_id)'));
        }
        const S = withSite(args);
        const siteKey = S.siteKey;
        const appId = parseInt(process.env.APP_ID || S.env.APP_ID || '1', 10);

        // ---- 1. split the incoming fields by destination ----
        const wpBody = {};
        const metaPatch = {};
        const datePatch = {};
        const unknown = [];
        const IGNORED = new Set(['site', 'article_id', 'wp_post_id', 'lang', 'copy_dates_from', 'sync_db', 'dry_run', 'language', 'translation_group', 'create_terms']);

        for (const [k, v] of Object.entries(args)) {
          if (IGNORED.has(k) || v === undefined || v === null) continue;
          const route = ARTICLE_FIELD_ROUTES[k];
          if (!route) {
            unknown.push(k);
            continue;
          }
          if (route === 'wp') wpBody[k] = v;
          else if (route === 'meta') metaPatch[k] = v;
          else datePatch[k] = v;
        }

        // taxonomy accepts term IDs OR slugs; resolve any slugs to IDs before the
        // wp/v2 write, so one call can carry classification straight from the plan table
        const termReport = {};
        if (wpBody.categories || wpBody.tags) {
          const create = args.create_terms === true;
          if (wpBody.categories) {
            const r = await t.wp.terms.resolveTermIds(wpBody.categories, { taxonomy: 'category', create, siteKey });
            if (r.unknown.length && !create) {
              return fail(new Error(`unknown category slug(s): ${r.unknown.join(', ')} — fix the slugs or pass create_terms=true`));
            }
            termReport.categories = r;
            wpBody.categories = r.ids;
          }
          if (wpBody.tags) {
            const r = await t.wp.terms.resolveTermIds(wpBody.tags, { taxonomy: 'post_tag', create, siteKey });
            if (r.unknown.length && !create) {
              return fail(new Error(`unknown tag slug(s): ${r.unknown.join(', ')} — fix the slugs or pass create_terms=true`));
            }
            termReport.tags = r;
            wpBody.tags = r.ids;
          }
        }

        const wantLang = args.language || null;
        const wantGroup = args.translation_group || null;
        // unknown fields first: a typo must name itself, not report "nothing to update"
        if (unknown.length) {
          return fail(new Error(
            `unknown field(s): ${unknown.join(', ')} — call the tool with no arguments to see the supported list`
          ));
        }
        if (!Object.keys(wpBody).length && !Object.keys(metaPatch).length && !Object.keys(datePatch).length &&
            !args.copy_dates_from && !wantLang) {
          return fail(new Error('nothing to update: pass at least one field'));
        }

        const seoRequested = SEO_META_KEYS.filter((k) => metaPatch[k] !== undefined);
        const geoRequested = GEO_META_KEYS.filter((k) => metaPatch[k] !== undefined);
        const baseMetaRequested = Object.keys(metaPatch).filter(
          (k) => !seoRequested.includes(k) && !geoRequested.includes(k)
        );

        const plan = {
          wp_native: Object.keys(wpBody),
          plugin_meta_seo: seoRequested,
          plugin_meta_geo: geoRequested,
          plugin_meta_base: baseMetaRequested,
          plugin_dates: Object.keys(datePatch),
          dates_copied_from: args.copy_dates_from || null,
          language: wantLang,
          translation_group: wantGroup,
          sync_db: args.sync_db !== false,
        };

        if (args.dry_run) {
          return ok({ ok: true, dry_run: true, wp_post_id: args.wp_post_id || null, plan });
        }

        // ---- 2. resolve the target WP post id ----
        let postId = args.wp_post_id || null;
        let dbRow = null;
        if (!postId) {
          connection = await t.db.createConnection();
          const [rows] = await connection.query(
            'SELECT id, wp_post_id, title, seo, lang FROM tengence_geo_articles WHERE id = ? AND app_id = ? LIMIT 1',
            [args.article_id, appId]
          );
          dbRow = rows[0] || null;
          postId = dbRow && dbRow.wp_post_id;
          if (!postId) {
            return fail(new Error(`Article ${args.article_id} has no wp_post_id (not published yet)`));
          }
        }

        const applied = {};
        const before = {};
        let after_dates = null;

        // ---- 3. WP native fields (one call) ----
        if (Object.keys(wpBody).length) {
          const pre = await t.wp.posts.get(postId, '?context=edit&_fields=id,title,excerpt,slug,status,featured_media', { siteKey });
          before.wp_native = {
            title: pre && pre.title && pre.title.raw !== undefined ? pre.title.raw : (pre.title || {}).rendered,
            excerpt: pre && pre.excerpt && pre.excerpt.raw !== undefined ? pre.excerpt.raw : (pre.excerpt || {}).rendered,
            slug: pre && pre.slug,
            status: pre && pre.status,
            featured_media: pre && pre.featured_media,
          };
          // taxonomy read-back: the whole reason this was missing is that a write
          // to categories/tags could not be confirmed afterwards
          if (wpBody.categories || wpBody.tags) {
            const preTerms = await t.wp.terms.getPostTerms(postId, { siteKey });
            before.wp_native.categories = preTerms.categories.map((c) => c.slug);
            before.wp_native.tags = preTerms.tags.map((x) => x.slug);
          }
          await t.wp.posts.update(postId, wpBody, { siteKey });
          applied.wp_native = Object.keys(wpBody);
        }

        // ---- 4. plugin meta (one call; SEO / GEO reported separately) ----
        if (Object.keys(metaPatch).length) {
          const pre = await t.wp.posts.getMeta(postId, { siteKey });
          before.plugin_meta = {};
          for (const k of Object.keys(metaPatch)) before.plugin_meta[k] = pre ? pre[k] : undefined;
          await t.wp.posts.saveMeta(postId, metaPatch, { siteKey });
          applied.plugin_meta_seo = seoRequested;
          applied.plugin_meta_geo = geoRequested;
          applied.plugin_meta_base = baseMetaRequested;
        }

        // ---- 5. dates (plugin dates API — the only writer of post_modified) ----
        if (Object.keys(datePatch).length || args.copy_dates_from) {
          const pre = await t.wp.posts.getPostDates(postId, { siteKey });
          before.dates = { date: pre.date, modified: pre.modified };
          if (args.copy_dates_from) {
            const src = await t.wp.posts.getPostDates(args.copy_dates_from, { siteKey });
            datePatch.date = src.date;
            datePatch.date_gmt = src.date_gmt;
            datePatch.modified = src.modified;
            datePatch.modified_gmt = src.modified_gmt;
          }
          if (Object.keys(datePatch).length) {
            const r = await t.wp.posts.setPostDates(postId, datePatch, { siteKey });
            const post = (r && r.data && r.data.dates) || (await t.wp.posts.getPostDates(postId, { siteKey }));
            applied.plugin_dates = Object.keys(datePatch);
            after_dates = { date: post.date, modified: post.modified };
          }
        }

        // ---- 6. language / translation group ----
        // siteKey is mandatory here: the MCP server process has no `--site` argv, so
        // without it the plugin target falls back to a non-existent default site.
        if (wantLang) {
          await t.wp.posts.setPostLanguage(
            postId,
            { language: wantLang, translationGroup: wantGroup },
            { siteKey }
          );
          applied.language = wantLang;
          applied.translation_group = wantGroup;
        }

        // ---- 7. mirror into the DB (SSOT) ----
        const dbMirrored = {};
        if (args.sync_db !== false && (args.title !== undefined || args.seo_meta_title !== undefined || args.seo_meta_description !== undefined)) {
          if (!connection) connection = await t.db.createConnection();
          let row = dbRow;
          if (!row) {
            const [rows] = await connection.query(
              'SELECT id, seo, title, lang FROM tengence_geo_articles WHERE wp_post_id = ? AND app_id = ? LIMIT 1',
              [postId, appId]
            );
            row = rows[0] || null;
          }
          if (row) {
            const seo = JSON.parse(row.seo || '{}');
            if (args.seo_meta_title !== undefined) seo.title = args.seo_meta_title;
            if (args.seo_meta_description !== undefined) seo.meta_description = args.seo_meta_description;
            const saveFields = { seo: JSON.stringify(seo) };
            if (args.title !== undefined) saveFields.title = args.title;
            await t.db.articles.saveContent(connection, row.id, appId, saveFields);
            dbMirrored.article_id = row.id;
            dbMirrored.fields = Object.keys(saveFields);
          } else {
            dbMirrored.warning = 'no DB row matched this post; nothing mirrored';
          }
        }

        return ok({
          ok: true,
          wp_post_id: postId,
          plan,
          applied,
          before,
          after_dates: after_dates,
          db_mirrored: dbMirrored,
          taxonomy: Object.keys(termReport).length ? termReport : undefined,
        });
      } catch (e) {
        return fail(e);
      } finally {
        if (connection) await connection.end();
      }
    },
  },

  // ---------- plan ----------
  {
    name: 'plan_list',
    title: '内容计划列表',
    description: 'Article plan table list (status/batch/category/node/lang filters). Each language is its own row ' +
      '(zh-hans | en | zh-hant); pass lang to inspect one language only.',
    inputSchema: z.object({
      site: siteField,
      status: z.string().optional().describe('todo|written|queued|published etc.'),
      batch: z.string().optional().describe('batch'),
      lang: z.string().optional().describe('zh-hans | en | zh-hant (default: all languages)'),
      limit: z.number().optional().describe('max rows (default 100)'),
    }),
    async run(args) {
      try {
        const S = withSite(args);
        process.env.APP_ID = process.env.APP_ID || S.env.APP_ID || '1';
        const e = langReject(args.lang);
        if (e) return fail(new Error(`plan_list: ${e}`));
        const rows = await t.plan.list({
          status: args.status || undefined,
          batch: args.batch || undefined,
          lang: args.lang ? langNorm(args.lang) : undefined,
          limit: args.limit || 100,
        });
        return ok({ ok: true, count: rows.length, rows });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'plan_import',
    title: '导入内容计划',
    description: 'Import/update the plan table (idempotent upsert by (slug, lang)). ' +
      'Two modes: (a) no `rows` — DB-only maintenance (backfill article_id / wp_post_id / ' +
      'published_url / featured_image, reconcile status from the articles table, assign missing ' +
      'publish_order); (b) `rows[]` — write the given plan rows directly, which is how a ' +
      'translation row (lang=en|zh-hant) is created or updated: it must be written through this ' +
      'keyed upsert, never by slug alone, otherwise it silently overwrites the zh-hans source row. ' +
      'Pass publish_order to sequence a translation alongside its source (same order value = ' +
      'published together), and plan_status to maintain its lifecycle. ' +
      'NOTE: this tool never reads a plan document — the plan table is the source of truth, so any ' +
      'markdown/JSON plan must be converted to rows[] by the caller before calling this.',
    inputSchema: z.object({
      site: siteField,
      rows: z.array(z.object({
        slug: z.string().describe('article slug (shared by all three languages)'),
        lang: z.string().optional().describe('zh-hans | en | zh-hant (default zh-hans)'),
        node_type: z.string().optional().describe("spoke | hub (default spoke)"),
        title: z.string().optional(),
        publish_order: z.number().optional().describe('queue position; translations share the source value to publish together'),
        publish_batch: z.number().optional(),
        category: z.string().optional(),
        tags: z.array(z.string()).optional(),
        article_id: z.number().optional(),
        wp_post_id: z.number().optional(),
        published_url: z.string().optional(),
        plan_status: z.string().optional().describe('todo | written | queued | published | paused'),
        queued_at: z.string().optional(),
        published_at: z.string().optional(),
        languages: z.string().optional().describe('WP locale list of the trilingual set, e.g. "zh-cn,en-us,zh-hk"'),
        notes: z.string().optional(),
      })).optional().describe('explicit plan rows to upsert (per-language)'),
    }),
    async run(args) {
      try {
        const S = withSite(args);
        process.env.APP_ID = process.env.APP_ID || S.env.APP_ID || '1';
        if (args.rows) {
          const created = [];
          const updated = [];
          for (const r of args.rows) {
            if (!r.slug) return fail(new Error('plan_import: every row requires a slug'));
            const e = langReject(r.lang);
            if (e) return fail(new Error(`plan_import row "${r.slug}": ${e}`));
            const { lang = 'zh-hans', ...record } = r;
            const res = await t.plan.upsert(record, { lang: langNorm(lang) });
            (res.created ? created : updated).push(res.id);
          }
          return ok({
            ok: true,
            mode: 'rows',
            created: created.length,
            updated: updated.length,
            ids: created.concat(updated),
          });
        }
        const res = await t.plan.importPlan(S, {});
        return ok({ ok: true, mode: 'db-maintenance', result: res });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'plan_mark_status',
    title: '标记计划状态',
    description: 'Update a plan row status (todo/written/queued/published/archived)',
    inputSchema: z.object({
      slug: z.string().describe('article slug'),
      status: z.string().describe('target status'),
      site: siteField,
    }),
    async run(args) {
      if (!args.slug || !args.status) {
        return fail(new Error('plan_mark_status requires slug + status'));
      }
      try {
        const S = withSite(args);
        process.env.APP_ID = process.env.APP_ID || S.env.APP_ID || '1';
        // repo.updateStatus expects the DB column name (plan_status); passing "status"
        // matched no allowed field and silently made this tool a no-op.
        const res = await t.plan.updateStatus(args.slug, { plan_status: args.status });
        return ok({ ok: true, result: res });
      } catch (e) {
        return fail(e);
      }
    },
  },

  // ---------- image ----------
  {
    name: 'image_acquire',
    title: '采集配图',
    description: 'Auto image pipeline (search → red-line filter → download → WebP crop → upload to WP media library)',
    inputSchema: z.object({
      query: z.string().describe('image search keyword'),
      slug: z.string().describe('target article slug (for registration)'),
      site: siteField,
      count: z.number().optional().describe('count (default 3)'),
      dry_run: z.boolean().optional().describe('preview only, nothing persisted'),
    }),
    async run(args) {
      if (!args.query || !args.slug) {
        return fail(new Error('image_acquire requires query + slug'));
      }
      const cliArgs = ['--query', args.query, '--slug', args.slug, '--site', cliSite(args)];
      if (args.count) cliArgs.push('--count', String(args.count));
      if (args.dry_run) cliArgs.push('--dry-run');
      const r = runCli('image-acquire', cliArgs);
      return ok({ ok: r.code === 0, exit_code: r.code, output: r.stdout || r.stderr });
    },
  },

  // ---------- monitor ----------
  {
    name: 'monitor_run',
    title: '运行 AI 可见性监测',
    description: 'Run GEO monitoring (one round of site prompts × models; results persisted)',
    inputSchema: z.object({
      site: siteField,
      run_id: z.string().optional().describe('YYYYMMDD (default today)'),
      models: z.array(z.string()).optional().describe('subset of model keys'),
      layers: z.array(z.string()).optional().describe('subset of layers'),
    }),
    async run(args, ctx) {
      try {
        const S = withSite(args);
        const runId = args.run_id || new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const res = await t.monitor.run.runMonitor({
          site: S,
          runId,
          models: args.models,
          layers: args.layers,
          onProgress: ctx && ctx.onProgress,
        });
        return ok({ ok: true, run_id: runId, result: res });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'monitor_report',
    title: '读取 AI 监测报告',
    annotations: { readOnlyHint: true },
    structured: true,
    description: 'Read monitoring results (latest round or a given run_id)',
    inputSchema: z.object({
      site: siteField,
      run_id: z.string().optional().describe('YYYYMMDD (default latest)'),
    }),
    async run(args) {
      try {
        const S = withSite(args);
        const store = require('@tengence/geo-sdk/monitor/store');
        const results = await store.readResults(S, args.run_id ? { runId: args.run_id } : undefined);
        return okStructured({ ok: true, count: (results || []).length, results: results || [] });
      } catch (e) {
        return fail(e);
      }
    },
  },

  // ---------- db ----------
  {
    name: 'db_init',
    title: '初始化数据库',
    description: 'Explicitly initialize the database (sqlite idempotent table creation / mysql DDL; --drop rebuilds)',
    inputSchema: z.object({
      site: siteField,
      drop: z.boolean().optional().describe('drop and rebuild (dangerous)'),
    }),
    async run(args) {
      const cliArgs = ['--site', cliSite(args)];
      if (args.drop) cliArgs.push('--drop');
      const r = runCli('db-init', cliArgs);
      return ok({ ok: r.code === 0, exit_code: r.code, output: r.stdout || r.stderr });
    },
  },
  {
    name: 'db_status',
    title: '数据库状态',
    description: 'Database status: driver, path, schema version, table list, missing tables',
    inputSchema: z.object({ site: siteField }),
    async run() {
      try {
        const driver = t.db.driver();
        if (driver === 'sqlite') {
          return ok({ ok: true, driver, status: t.db.sqliteDbStatus() });
        }
        const S = t.site.loadSite();
        return ok({ ok: true, driver, database: S.env.DB_DATABASE || '(not configured)' });
      } catch (e) {
        return fail(e);
      }
    },
  },

  // ---------- search / inclusion submission ----------
  {
    name: 'search_gsc_stats',
    title: '查询 GSC 流量统计',
    description:
      'Read Google Search Console Search Analytics data: clicks / impressions / CTR / average position, ' +
      'grouped by query (default), page, date, country or device. This is the ONLY Google source for ' +
      'search performance — and the only source at all for page-level data (Bing dropped its page/traffic ' +
      'endpoints on 2026-08-31). GSC data is finalised 2–3 days late: the default window is the 28 days ' +
      'ending 3 days ago. Requires the GSC service account (secrets/gsc-service-account.json or GOOGLE_SA_JSON).',
    inputSchema: z.object({
      site: siteField,
      dimensions: z
        .array(z.enum(['query', 'page', 'date', 'country', 'device']))
        .optional()
        .describe('group-by dimensions; default ["query"]. Use ["page"] for per-URL clicks/impressions, ["date"] for a daily trend, ["query","page"] for both.'),
      start_date: z.string().optional().describe('YYYY-MM-DD (default: 27 days before end_date)'),
      end_date: z.string().optional().describe('YYYY-MM-DD (default: 3 days ago)'),
      row_limit: z.number().optional().describe('max rows to return (default 100)'),
    }),
    async run(args) {
      try {
        const S = withSite(args);
        const res = await t.search.searchAnalytics(S, {
          dimensions: args.dimensions,
          startDate: args.start_date,
          endDate: args.end_date,
          rowLimit: args.row_limit,
        });
        return ok({ ok: true, ...res });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'search_gsc_inspect',
    title: 'GSC 网址检查',
    description:
      'Query one URL\'s Google indexing status (URL Inspection API, read-only): verdict, coverageState, ' +
      'indexingState, lastCrawlTime, googleCanonical. Use it to check whether a specific article page is ' +
      'indexed. Quota: 2000 calls/day.',
    inputSchema: z.object({
      url: z.string().describe('fully-qualified URL to inspect, e.g. https://www.tengence.com/blog/article/<slug>/'),
      site: siteField,
    }),
    async run(args) {
      if (!args.url) return fail(new Error('search_gsc_inspect requires url'));
      try {
        const S = withSite(args);
        const res = await t.search.inspectUrl(S, args.url);
        return ok({ ok: true, url: args.url, inspection: res.inspectionResult || res });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'search_submit_gsc',
    title: 'GSC 收录提交',
    description: 'Submit the sitemap to Google Search Console (soft-fail)',
    inputSchema: z.object({
      site: siteField,
      sitemap_url: z.string().optional().describe('sitemap URL (default: auto-derived)'),
    }),
    async run(args) {
      try {
        const S = withSite(args);
        const url =
          args.sitemap_url ||
          `https://www.${(S.site && S.site.site && S.site.site.domain) || ''}/sitemap_index.xml`;
        const res = await t.search.submitSitemap(S, url);
        return ok({ ok: true, url, http_status: res.httpStatus });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'search_submit_indexnow',
    title: 'IndexNow 收录提交',
    description: 'Submit URLs to IndexNow (requires INDEXNOW_KEY)',
    inputSchema: z.object({
      url: z.string().describe('URLs to submit (multiple allowed, comma-separated)'),
      site: siteField,
    }),
    async run(args) {
      if (!args.url) return fail(new Error('search_submit_indexnow requires url'));
      try {
        const S = withSite(args);
        const host = process.env.INDEXNOW_HOST || `www.${(S.site && S.site.site && S.site.site.domain) || ''}`;
        const res = await t.search.indexnow.submitUrls({
          host,
          key: process.env.INDEXNOW_KEY,
          keyLocation: process.env.INDEXNOW_KEY_LOCATION || `https://${host}/${process.env.INDEXNOW_KEY}.txt`,
          urlList: args.url.split(',').map((u) => u.trim()),
        });
        return ok({ ok: true, http_status: res.httpStatus, count: res.count });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'search_submit_baidu',
    title: '百度收录提交',
    description:
      'Submit URLs to Baidu normal inclusion (requires BAIDU_TOKEN / BAIDU_SITE). ' +
      'Two modes: pass url for an explicit list, or all=true to push the sitemap incrementally — ' +
      'it recursively flattens sitemap_index.xml, skips every URL already logged as submitted in ' +
      'data/baidu-log.jsonl, and pushes at most limit URLs (default 10) so a scheduled run stays ' +
      'inside the daily quota.',
    inputSchema: z.object({
      url: z.string().optional().describe('URLs to submit (multiple allowed, comma-separated, ≤2000 per call); omit when all=true'),
      all: z.boolean().optional().describe('sitemap incremental mode: push only URLs not yet logged as submitted'),
      limit: z.number().optional().describe('max URLs to push when all=true (default 10)'),
      site: siteField,
    }),
    async run(args) {
      if (args.all) {
        const cliArgs = ['--all', '--limit', String(args.limit == null ? 10 : args.limit), '--site', cliSite(args)];
        const r = runCli('submit-baidu', cliArgs);
        return ok({ ok: r.code === 0, exit_code: r.code, output: r.stdout || r.stderr });
      }
      if (!args.url) return fail(new Error('search_submit_baidu requires url (or all=true)'));
      try {
        const S = withSite(args);
        const res = await t.search.baidu.submitBatch(args.url.split(',').map((u) => u.trim()), {
          token: process.env.BAIDU_TOKEN,
          site: process.env.BAIDU_SITE || `www.${(S.site && S.site.site && S.site.site.domain) || ''}`,
        });
        return ok({ ok: true, success: res.success, remain: res.remain, http_status: res.httpStatus });
      } catch (e) {
        return fail(e);
      }
    },
  },

  // ---------- webmaster (搜索引擎站长后台管理域; separate from search/) ----------
  {
    name: 'webmaster_bing_status',
    title: 'Bing 站长状态',
    description:
      'Read Bing Webmaster console data (verified sites / URL submission quota / query stats / crawl issues). Requires BING_WEBMASTER_API_KEY in the site .env. Note: Bing trimmed its JSON API on 2026-08-31 (GetPages/GetSitemaps/GetTrafficStats/GetUrlSubmissionStatus now 404).',
    inputSchema: z.object({
      action: z
        .enum(['sites', 'quota', 'stats', 'issues'])
        .describe('what to read from the Bing Webmaster console'),
      site: siteField,
    }),
    async run(args) {
      try {
        const S = withSite(args);
        const apiKey = process.env.BING_WEBMASTER_API_KEY;
        const domain = (S.site && S.site.site && S.site.site.domain) || process.env.SITE_DOMAIN;
        const bing = t.webmaster.bing;
        if (!apiKey) return fail(new Error('BING_WEBMASTER_API_KEY not configured in the site .env'));
        switch (args.action) {
          case 'sites':
            return ok({ ok: true, sites: await bing.listSites({ apiKey }) });
          case 'quota':
            return ok({ ok: true, quota: await bing.getQuota({ apiKey, domain }) });
          case 'stats':
            return ok({ ok: true, query_stats: await bing.getQueryStats({ apiKey, domain }) });
          case 'issues':
            return ok({ ok: true, crawl_issues: await bing.getCrawlIssues({ apiKey, domain }) });
          default:
            return fail(new Error(`Unknown action: ${args.action}`));
        }
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'webmaster_bing_submit',
    title: 'Bing 收录提交',
    description:
      'Write to Bing Webmaster: submit URL(s) (comma-separated = batch, ≤10000 per call). Requires BING_WEBMASTER_API_KEY in the site .env.',
    inputSchema: z.object({
      url: z.string().describe('URL(s) to submit; multiple allowed, comma-separated'),
      site: siteField,
    }),
    async run(args) {
      try {
        const S = withSite(args);
        const apiKey = process.env.BING_WEBMASTER_API_KEY;
        const domain = (S.site && S.site.site && S.site.site.domain) || process.env.SITE_DOMAIN;
        const bing = t.webmaster.bing;
        if (!apiKey) return fail(new Error('BING_WEBMASTER_API_KEY not configured in the site .env'));
        if (!args.url) return fail(new Error('webmaster_bing_submit requires url'));
        const urls = args.url.split(',').map((u) => u.trim()).filter(Boolean);
        const res = urls.length === 1
          ? await bing.submitUrl({ apiKey, url: urls[0], domain })
          : await bing.submitUrlBatch({ apiKey, urlList: urls, domain });
        // keep the shared dedupe log in sync so later CLI --all runs skip these URLs
        bing.logLine({ action: 'submit', ok: true, detail: res, urls }, bing.defaultLogPath('bing'));
        return ok({ ok: true, submitted: urls.length, urls, response: res });
      } catch (e) {
        return fail(e);
      }
    },
  },

  // ---------- diagnose (site GEO/SEO diagnosis) ----------
  {
    name: 'diagnose_site',
    title: '站点 GEO 诊断',
    description:
      'Full GEO/SEO site diagnosis: domain (DNS incl. CNAME chain / TLS cert / WHOIS), transport & server fingerprint (CMS/framework/platform/CDN), HTTP/3, robots.txt (incl. Allow/Disallow conflicts), sitemap (all child sitemaps, language distribution, lastmod freshness), homepage + representative pages (meta, H1..H6, JSON-LD, OG, images/alt, links, mixed content), i18n (per-language homepage hreflang symmetry, 404 localization, article coverage, language switcher), CDN cache hit-rate sampling, static asset cache policy, subdomain health sweep, admin/backend exposure sweep, external-resource health, performance (TTFB stability, LCP candidate, resource hints) and security (CSP parse, SAN usage, SRI) checks, plus a GEO extended pack (data-point citation density, date signals, author byline, authoritative-source citations, entity consistency, llms.txt structure, static-HTML content, AI-content disclosure, Q&A answer blocks). Returns an overall 0-100 score with letter grade and per-dimension breakdown. Bootstraps the site on first use. All probes are read-only (GET/HEAD), bounded by a request budget, and soft-fail.',
    inputSchema: z.object({
      url: z.string().describe('site URL, e.g. https://www.example.com'),
      site: siteField,
      pages: z
        .array(z.string())
        .optional()
        .describe('extra page URLs to diagnose in addition to the homepage'),
      max_pages: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('max representative pages to sample (default 4; the site is sampled, never fully crawled)'),
      deep: z
        .boolean()
        .optional()
        .describe('run the full probe set — subdomains / exposure / CDN cache-hit sampling / i18n homepages / asset cache policy (default true; set false to skip all load-adding probes, keeping zero-request parsing checks)'),
      max_requests: z
        .number()
        .int()
        .min(50)
        .optional()
        .describe('total outbound request budget across the run, redirects counted (default 700; optional probes are skipped once exhausted)'),
    }),
    async run(args, ctx) {
      if (!args.url) return fail(new Error('diagnose_site requires url'));
      try {
        useWorkspace(args);
        const res = await t.diagnose.runDiagnosis({
          url: args.url,
          siteKey: args.site ? resolveSiteKey(args) : undefined,
          extraPages: args.pages,
          maxPages: args.max_pages,
          deep: args.deep !== false,
          maxRequests: args.max_requests || 700,
          onProgress: ctx && ctx.onProgress,
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'report_write',
    title: '写监测报告',
    description:
      'Write a Markdown report into the site data/reports/ directory (path-safe: filename is basenamed and confined to the reports dir). Auto-bootstraps the site on first use.',
    inputSchema: z.object({
      content: z.string().describe('Markdown report content'),
      filename: z
        .string()
        .optional()
        .describe('report filename (default <YYYYMMDD>-<site>-diagnosis.md)'),
      site: siteField,
    }),
    async run(args) {
      if (!args.content) return fail(new Error('report_write requires content'));
      try {
        const S = withSite(args);
        const fs = require('fs');
        const path = require('path');
        const reportsDir = path.join(S.siteDir, 'data', 'reports');
        fs.mkdirSync(reportsDir, { recursive: true });
        const name =
          args.filename ||
          `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${S.siteKey}-diagnosis.md`;
        const base = path.basename(name);
        const dest = path.resolve(reportsDir, base);
        if (!dest.startsWith(path.resolve(reportsDir) + path.sep)) {
          return fail(new Error(`unsafe report filename: ${name}`));
        }
        fs.writeFileSync(dest, args.content, 'utf8');
        return ok({
          ok: true,
          path: dest,
          site: S.siteKey,
          ...(S._bootstrap ? { _bootstrap: S._bootstrap } : {}),
        });
      } catch (e) {
        return fail(e);
      }
    },
  },

  // ---------- site_geo_plan_skill (site-geo-plan skill spec, MCP-managed) ----------
  {
    name: 'site_geo_plan_skill',
    title: '站点 GEO 实施方案',
    description:
      'Read-only access to the site-geo-plan skill specification (SKILL.md + references/plan-template.md) ' +
      'that governs detailed GEO/SEO implementation plan generation (multi-part: 上篇技术修复/中篇关键词与内容/' +
      '价值桥接/下篇实施保障/附录; every diagnosis issue expanded 现状→方案→步骤→验收; full keyword matrix; ' +
      'manpower person-day matrix). Returns both files verbatim so callers can implement/verify plans ' +
      'against the canonical spec.',
    inputSchema: z.object({}),
    async run() {
      try {
        const path = require('path');
        const dir = path.join(__dirname, '..', '..', 'geo-sdk', 'site-geo-plan');
        const fs = require('fs');
        const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
        let template = null;
        try {
          template = fs.readFileSync(path.join(dir, 'references', 'plan-template.md'), 'utf8');
        } catch (_e) {
          template = null;
        }
        return ok({
          skill_path: path.join(dir, 'SKILL.md'),
          plan_template_path: template ? path.join(dir, 'references', 'plan-template.md') : null,
          skill,
          plan_template: template,
        });
      } catch (e) {
        return fail(e);
      }
    },
  },

  // ---------- util / diagnostics ----------
  {
    name: 'util_ping',
    title: '服务连通性测试',
    description:
      'Connectivity self-check: SDK version, driver, internal data directory, bound workspace and site count',
    inputSchema: z.object({}),
    async run() {
      return ok({
        ok: true,
        sdk: require('@tengence/geo-sdk/package.json').version,
        internal_home: t.paths.internalHome(),
        db_path: t.paths.dbPath(),
        workspace: t.workspace.current(),
        sites_root: t.site.SITES_ROOT,
        sites: t.site.listSites(),
        driver: t.db.driver(),
      });
    },
  },

  {
    name: 'article_draft',
    title: '生成写作 Brief',
    annotations: { readOnlyHint: true },
    structured: true,
    description:
      'Assemble a ready-to-use writing brief for a new article: the matched T1–T7 body skeleton, the pre-writing research-brief template, ' +
      'and the full writing standard (base + supplement). The body you author MUST follow this brief; the check_article gate enforces the ' +
      'same G1–G14 editorial gates before publishing. Call this first, then write the Markdown body, then check_article.',
    inputSchema: z.object({
      type: z
        .string()
        .optional()
        .describe('T1–T7 body type: definition|howto|product|case|industry|comparison|guide (default guide)'),
      topic: z.string().optional().describe('working topic / target keyword (echoed into the brief for context)'),
      site: siteField,
    }),
    async run(args) {
      try {
        const brief = t.standards.buildDraftBrief({ type: args.type || 'guide', topic: args.topic });
        if (args.topic) brief.topic = args.topic;
        return okStructured(brief);
      } catch (e) {
        return fail(e);
      }
    },
  },
  // ---------- cross-platform channel ----------
  {
    name: 'channel_list',
    title: '平台状态列表',
    description:
      'List all external content platforms in the syndicate registry: API type (official|cookie|none), status (ready|pending|manual), ' +
      'capabilities (multi-article merge, per-platform limits, draft/cover/tags) and the full platform rewrite rules (styles). ' +
      'The rewrite rules are the HARNESS rewriting guide — the server never rewrites content: read the original via article_export, ' +
      'apply these rules yourself, then channel_publish to land the draft/export. ' +
      'READY PLATFORMS: wechat (微信公众号, official API), juejin (掘金, cookie — can publish article drafts) and ' +
      'csdn (CSDN, cookie — the creator-console gateway; needs CSDN_COOKIE before status becomes ready). ' +
      'To publish to Juejin/CSDN pass platform="juejin"/"csdn" to channel_publish / channel_plan_*; this server is multi-channel.',
    inputSchema: z.object({
      platform: z.string().optional().describe('filter to one platform key'),
    }),
    async run(args) {
      try {
        const platforms = t.syndicate.registry.listPlatforms();
        return ok({
          ok: true,
          platforms: args.platform ? platforms.filter((p) => p.key === args.platform) : platforms,
        });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'channel_style_get',
    title: '读取平台改写规则',
    description:
      'Return the FULL platform style / rewrite rules for ONE platform (wechat / juejin / blog / …). ' +
      'This is the RULES half of the rewrite surface: the server only serves the rules, the harness/Skill does the actual rewriting. ' +
      'Covers rewrite.strategy (source|title|body|both — what to change), title hooks + forbidden words, body structure + style, ' +
      'internalLinks requirement, cta and the acceptance checklist. ALWAYS call this BEFORE rewriting an article for a platform ' +
      'so the latest rules are used (never hardcode rules in the client). Multi-channel: pick by platform=.',
    inputSchema: z.object({
      platform: z.string().describe('platform key, e.g. wechat / juejin / blog'),
    }),
    async run(args) {
      try {
        const p = t.syndicate.registry.getPlatform(args.platform);
        if (!p) return fail(new Error(`Unknown platform: ${args.platform}`));
        return ok({ ok: true, platform: p.key, name: p.name, capabilities: p.capabilities, rewrite: p.rewrite });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'channel_check',
    title: '平台连接检查',
    description:
      'Validate a title/body against a platform\'s style rules — the 校验 (validation) half. Deterministic, no content generation. ' +
      'Returns errors (HARD: title length / forbidden words / body length / removeBlocks) and warnings ' +
      '(SOFT: CTA presence / internal links / keepBlocks) plus the platform checklist and rewrite.strategy. ' +
      'Run AFTER rewriting to confirm it passes before channel_publish. Platform-scoped (wechat / juejin / blog / any registry platform).',
    inputSchema: z.object({
      platform: z.string().describe('platform key, e.g. wechat / juejin / blog'),
      title: z.string().optional().describe('article title to validate'),
      body: z.string().optional().describe('article body (markdown) to validate'),
    }),
    async run(args) {
      try {
        const res = t.syndicate.styleCheck.check({
          platform: args.platform,
          title: args.title,
          body: args.body,
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'channel_publish',
    title: '平台发布',
    description:
      'Publish/export to one external platform. Mode A: pass slugs[] and the server reads the DB and runs the platform pipeline ' +
      '(wechat drafts box — preview in mp.weixin.qq.com before mass-sending; juejin draft → publish; csdn draft → publish; ' +
      'devto publish). Mode B: pass pre-written ' +
      'articles[] ({slug,title,contentMd,summary,tags,sourceUrl,cover}) — the harness-rewritten draft — and the server exports a publish ' +
      'package to <site>/data/channel-export/<platform>/<slug>.md with full front matter (manual publishing on every platform; ' +
      'required for api:none platforms). asDraft defaults true (never mass-sends). ' +
      'PLATFORMS: wechat, juejin (cookie — 原文直发 via juejin draft), csdn (cookie — 通过创作中心网关一步发文), devto. ' +
      'Juejin pipeline: reads DB article → resolves category/tags against the cached platform dictionary ' +
      '(channel_taxonomy; our article_plan.category/tags → the platform\'s category_id/tag_ids — see channel_taxonomy_resolve) ' +
      '→ creates draft → writes body → publishes; dryRun=true previews the plan AND the resolved taxonomy with no external ' +
      'calls; idempotent — skips a slug already on Juejin (draft or published). Category and tag are both required by Juejin, ' +
      'so a fallback chain (alias → dictionary → env → dictionary default) guarantees both are always sent. ' +
      'CSDN pipeline: reads DB article → Markdown is converted to CSDN HTML locally (CSDN does NOT convert server-side) → ' +
      'one saveArticle call (status 2=draft / 0=publish); tags come from article_plan.tags else target_keywords (1~5 required ' +
      'to publish). Idempotent through the SAME slug-based dedup as juejin. ' +
      'Every publish outcome is logged to channel_plan under its own platform, so each platform keeps an INDEPENDENT ' +
      'publishing calendar (only real outcomes are recorded — the blog plan is never bulk-imported). ' +
      'This server is multi-channel; choose by platform=.',
    inputSchema: z.object({
      platform: z.string().describe('platform key (see channel_list)'),
      slugs: z.array(z.string()).optional().describe('Mode A: article slugs to publish through the platform pipeline'),
      articles: z
        .array(
          z.object({
            slug: z.string(),
            title: z.string(),
            contentMd: z.string(),
            summary: z.string().optional(),
            tags: z.array(z.string()).optional(),
            sourceUrl: z.string().optional(),
            cover: z.string().optional(),
            rewrite: z.string().optional(),
            mode: z.string().optional(),
          })
        )
        .optional()
        .describe('Mode B: pre-written (harness-rewritten) articles to export as publish packages'),
      asDraft: z.boolean().optional().describe('default true: create draft (wechat/juejin), never mass-send'),
      keepOrder: z.boolean().optional().describe('wechat only: keep slugs order (1st = headline)'),
      dryRun: z.boolean().optional().describe('print the plan, no external calls'),
      site: siteField,
    }),
    async run(args) {
      try {
        const site = withSite(args);
        const result = await t.syndicate.channel.publishToChannel({
          platform: args.platform,
          slugs: args.slugs || [],
          articles: args.articles || [],
          asDraft: args.asDraft !== false,
          keepOrder: !!args.keepOrder,
          dryRun: !!args.dryRun,
          siteKey: site.siteKey,
        });
        // Record each attempt into the channel_plan publish log (success + failure),
        // under ITS OWN platform key — this is what gives every cookie/api platform
        // (juejin, csdn, …) an independent publishing calendar.
        // dryRun never touches the platform, so nothing is logged.
        //
        // The log is what the slug-based dedup reads, so its status must be truthful:
        //   skipped  → already published locally; do NOT re-write (would churn updated_at)
        //   draft-only creation → status "draft"  (NOT published)
        //   article went live   → status "published"
        //   attempt failed      → status "failed" (leaves the slug eligible for a retry)
        // ---- wechat: ONE message = N rows sharing ONE 第N期 period + media_id ----
        // A wechat send merges N articles into a single 图文 message (one media_id).
        // v7: recordWechatIssue writes one row PER SLUG, all sharing the same
        // period ("第N期") and the same draft_ids (media_id); in-issue headline
        // order = row id order. The shared period/media_id keeps the
        // "which articles went into this message" mapping.
        if (args.platform === 'wechat' && !args.dryRun && result.ok) {
          const group = (result.slugs && result.slugs.length ? result.slugs : args.slugs) || [];
          const mediaId = (result.refs && result.refs.mediaId) || null;
          if (group.length) {
            try {
              const issue = await t.plan.channel.recordWechatIssue({
                slugs: group,
                mediaId,
                status: 'draft', // draft box is the terminal state — we never mass-send
                topic: group.length === 1 ? null : `${group.length} 篇合辑`,
                notes: `merged into one WeChat message (media_id: ${mediaId || 'n/a'})`,
              });
              result.loggedIssue = issue;
            } catch (logErr) {
              // logging failure must not mask the publish result
              console.error('[channel_publish] recordWechatIssue failed:', logErr.message);
            }
          }
        }
        if (PUBLISH_LOG_PLATFORMS.includes(args.platform) && !args.dryRun) {
          const ch = t.plan.channel;
          const wentLive = args.asDraft === false;
          for (const r of result.results || []) {
            if (r.skipped || r.dryRun) continue;
            try {
              // leave an audit trail of the taxonomy actually used (channel_plan stores
              // no category/tag columns on purpose — article_plan stays the single source).
              // juejin reports a resolved {category, tags}; csdn reports plain tags.
              const tax = r.taxonomy;
              const taxNote = tax
                ? `tax: ${tax.category} [${tax.categoryOrigin}] / ${(tax.tags || []).join(', ')}`
                : Array.isArray(r.tags) && r.tags.length
                  ? `tags: ${r.tags.join(', ')}`
                  : null;
              // publishGated (aliyun): the platform refused/never attempted a live
              // publish, so even with asDraft=false the truthful status is "draft".
              // r.published is the platform's own answer (juejin/csdn = !asDraft,
              // devto always false = draft-first) — it wins over wentLive.
              const status = !r.ok ? 'failed' : r.published === false ? 'draft' : wentLive && !r.publishGated ? 'published' : 'draft';
              // devto returns the live post url in detail.url — keep it as publish evidence
              // (devto has no taxonomy, so taxNote alone would drop the trace).
              const devtoUrl = r.detail && r.detail.url ? `url: ${r.detail.url}` : null;
              await ch.recordPublish({
                platform: args.platform,
                slug: r.slug,
                title: r.title || (r.detail && r.detail.title),
                status,
                draftId: r.draftId || (r.detail && r.detail.draftId),
                notes: status === 'published' ? (taxNote || devtoUrl) : null,
                error: r.ok ? null : r.error || (r.detail && (r.detail.err || r.detail.message)) || r.stage,
              });
            } catch (logErr) {
              // logging failure must not mask the publish result
              console.error('[channel_publish] recordPublish failed:', logErr.message);
            }
          }
        }
        return ok({ ok: result.ok, ...result });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'channel_plan_next',
    title: '下一到期平台发布',
    description:
      'Per-platform publishing calendar: return the next article to publish for a platform plus all calendar rows ' +
      '(status/period/topic/weekday/slugs). Each platform has its OWN rows in the same channel_plan table. ' +
      'Every platform now DERIVES its queue from the blog article_plan: nextDue returns the next blog-published article (by ' +
      'publish_order) that is NOT yet recorded as published on THAT platform, so each platform\'s queue follows the blog order and ' +
      '(wechat: a pending calendar row imported via importWechatIssues still wins, otherwise it falls through to the blog order) ' +
      'resumes right after the last article published to it (failed rows retry). Nothing is ever bulk-copied from the blog plan: ' +
      'only real outcomes are recorded, so juejin and csdn each keep their own independent calendar in the shared table. ' +
      'Seed already-published articles with channel_plan_reconcile (platform=csdn) before the first nextDue, otherwise the ' +
      'csdn queue starts from the very first blog article.',
    inputSchema: z.object({
      platform: z.string().optional().describe('filter rows to one platform (default: all platforms)'),
      count: z
        .number()
        .optional()
        .describe(
          'how many articles the NEXT send should contain (wechat merges them into ONE 图文 message, ' +
            'so count=3 returns the next 3 un-dispatched articles as one issue). Default 1.'
        ),
    }),
    async run(args) {
      try {
        const ch = t.plan.channel;
        const rows = await ch.list({ platform: args.platform });
        const next = args.platform
          ? await ch.nextDue(args.platform, { count: args.count || 1 })
          : null;
        return ok({ ok: true, next, rows });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'channel_plan_mark',
    title: '标记平台发布状态',
    description:
      'Update a channel_plan row status (todo | draft | published | paused) and optionally record its draft ids (media ids). ' +
      'Call after channel_publish to persist the created draft (e.g. wechat media_id) and keep the calendar in sync.',
    inputSchema: z.object({
      id: z.number().describe('channel_plan row id (see channel_plan_next rows)'),
      status: z.enum(['todo', 'draft', 'published', 'paused']).describe('new row status'),
      draftIds: z
        .array(z.string())
        .optional()
        .describe('draft/media ids to record (e.g. wechat media_id); omit to keep existing'),
    }),
    async run(args) {
      try {
        const ch = t.plan.channel;
        const updated = await ch.markStatus(args.id, args.status, args.draftIds);
        const row = await ch.get(args.id);
        return ok({ ok: true, updated, row });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'juejin_status',
    title: '掘金状态',
    description:
      'Read the Juejin (掘金) backend for this site: the draft box (article_draft/list_by_user) and the published list ' +
      '(article/list_by_user). Read-only. Requires JUEJIN_COOKIE + JUEJIN_UID in the site .env. Use it to verify before ' +
      'publishing (idempotency) and to see what is already on Juejin. page defaults to 0 (50 per page).',
    inputSchema: z.object({
      page: z.number().optional().describe('page index (default 0)'),
      site: siteField,
    }),
    async run(args) {
      try {
        withSite(args);
        const page = args.page || 0;
        const jj = t.syndicate.juejin;
        const [drafts, published] = await Promise.all([jj.listDrafts(page, 50), jj.listPublished(page, 50)]);
        const mapItems = (resp) => {
          const data = resp && resp.data;
          const items = Array.isArray(data) ? data : data && Array.isArray(data.data) ? data.data : [];
          return items.map((it) => ({
            id: it.id || it.article_id,
            title: it.title || (it.article_info && it.article_info.title) || '',
            audit_status: it.article_info && it.article_info.audit_status != null ? it.article_info.audit_status : null,
          }));
        };
        return ok({
          ok: true,
          drafts: mapItems(drafts),
          published: mapItems(published),
          drafts_err: drafts && drafts.err_no !== 0 ? drafts.err_msg : null,
          published_err: published && published.err_no !== 0 ? published.err_msg : null,
        });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'juejin_draft_delete',
    title: '删除掘金草稿',
    description:
      'Delete a Juejin draft (article_draft/delete). IRREVERSIBLE — pass confirm=true only after verifying the draft id via ' +
      'juejin_status. Requires JUEJIN_COOKIE + JUEJIN_UID in the site .env.',
    inputSchema: z.object({
      draftId: z.string().describe('draft id from juejin_status drafts[].id'),
      confirm: z.boolean().describe('must be true to actually delete'),
      site: siteField,
    }),
    async run(args) {
      try {
        if (!args.confirm) return fail(new Error('Refusing to delete without confirm=true'));
        withSite(args);
        const res = await t.syndicate.juejin.deleteDraft(args.draftId);
        return ok({ ok: res && res.err_no === 0, result: res });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'juejin_article_delete',
    title: '删除掘金文章',
    description:
      'Delete a published Juejin article (article/delete). IRREVERSIBLE — pass confirm=true only after verifying the article id ' +
      'via juejin_status. Requires JUEJIN_COOKIE + JUEJIN_UID in the site .env.',
    inputSchema: z.object({
      articleId: z.string().describe('article id from juejin_status published[].id'),
      confirm: z.boolean().describe('must be true to actually delete'),
      site: siteField,
    }),
    async run(args) {
      try {
        if (!args.confirm) return fail(new Error('Refusing to delete without confirm=true'));
        withSite(args);
        const res = await t.syndicate.juejin.deleteArticle(args.articleId);
        return ok({ ok: res && res.err_no === 0, result: res });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'csdn_status',
    title: 'CSDN 状态',
    description:
      'Read the CSDN blog backend for this site: the draft box and the published list ' +
      '(blog/phoenix/console/v1/article/list with status=draft / all_v2). Read-only. Requires CSDN_COOKIE in the site .env. ' +
      'Use it to verify before publishing (idempotency) and to see what is already on CSDN. page is 1-based (default 1). ' +
      'An expired login is surfaced as cookieExpired=true + code 401 instead of an empty list — renew CSDN_COOKIE then. ' +
      'This is the CSDN counterpart of juejin_status.',
    inputSchema: z.object({
      page: z.number().optional().describe('1-based page index (default 1)'),
      pageSize: z.number().optional().describe('page size (default 20)'),
      site: siteField,
    }),
    async run(args) {
      try {
        withSite(args);
        const page = args.page || 1;
        const pageSize = args.pageSize || 20;
        const c = t.syndicate.csdn;
        const [drafts, published] = await Promise.all([c.listDrafts(page, pageSize), c.listPublished(page, pageSize)]);
        const shape = (res) => ({
          items: (res.items || []).map((it) => ({
            id: it.id,
            title: it.title,
            status: it.status,
            url: it.url,
            postTime: it.postTime,
            viewCount: it.viewCount,
          })),
          err: res.ok ? null : res.msg,
          cookieExpired: !!res.cookieExpired,
        });
        return ok({ ok: true, drafts: shape(drafts), published: shape(published), counts: published.counts || {} });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'csdn_article_delete',
    title: '删除 CSDN 文章',
    description:
      'Delete a CSDN article (blog/phoenix/console/v1/article/del). IRREVERSIBLE — pass confirm=true only after verifying the ' +
      'article id via csdn_status. Requires CSDN_COOKIE in the site .env. NOTE: this removes it from CSDN only; the local ' +
      'channel_plan publish log (the CSDN publishing calendar) is not touched — re-run channel_plan_reconcile(platform=csdn) ' +
      'afterwards if you want the log back in sync.',
    inputSchema: z.object({
      articleId: z.string().describe('article id from csdn_status items[].id'),
      deep: z.boolean().optional().describe('also purge from the recycle bin (default false)'),
      confirm: z.boolean().describe('must be true to actually delete'),
      site: siteField,
    }),
    async run(args) {
      try {
        if (!args.confirm) return fail(new Error('Refusing to delete without confirm=true'));
        withSite(args);
        const res = await t.syndicate.csdn.deleteArticle(args.articleId, !!args.deep);
        return ok({ ok: !!(res && (res.code === 200 || res.code === '200')), result: res });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'channel_plan_reconcile',
    title: '对账平台计划',
    description:
      'Reconcile a platform channel_plan with what is ACTUALLY published on that platform (platform=juejin | csdn). ' +
      'This SEEDS the publish plan with already-published articles — we do NOT bulk-import the blog plan (the table logs ' +
      'real outcomes, so each platform keeps its own calendar). Pass map[] of {slug, lang?, title?} for the ' +
      'explicitly-known published articles (recommended — avoids API rate limits), or omit map to live-read the platform ' +
      'published list and match titles back to blog slugs. Idempotent (upsert by platform+slug+lang; lang defaults to the ' +
      "platform's language, e.g. zh-hans). Run this once per platform before the first channel_plan_next so the " +
      'already-published articles are skipped instead of re-published.',
    inputSchema: z.object({
      platform: z.string().describe('platform key, e.g. juejin or csdn'),
      map: z
        .array(
          z.object({
            slug: z.string(),
            lang: z.string().optional().describe("article language, e.g. 'zh-hans' (default: platform's language)"),
            title: z.string().optional(),
          })
        )
        .optional()
        .describe('explicit known published articles; omit to live-read the platform'),
      site: siteField,
    }),
    async run(args) {
      try {
        withSite(args);
        const res = await t.plan.channel.reconcileFromPlatform(args.platform, { map: args.map });
        return ok({ ok: true, ...res });
      } catch (e) {
        return fail(e);
      }
    },
  },
  // ---------- auto-publish scheduling rules (channel_schedule) ----------
  {
    name: 'channel_audit_check',
    title: '平台合规审计',
    description:
      'Sync channel_plan statuses against the LIVE platform audit (审核) state — the review-check loop. ' +
      'For juejin: article/list_by_user audit_status (2=通过→published, 1=审核中→reviewing, 0/3=未通过→review_failed). ' +
      'For csdn: published list (→published) vs the audit list (审核中/未通过 share one list →review_failed). ' +
      'The platform APIs expose NO reject-reason text: review_failed rows get a notes flag telling you where to look ' +
      '(Juejin/CSDN backend); rows still reviewing for >24h get a stale-flag note (human check). ' +
      'Runs automatically as step ① of channel_publish_due; use this tool standalone to inspect or force a check. ' +
      'devto/wechat have no automated review and are not supported here. Read-only when dryRun=true (no DB writes).',
    inputSchema: z.object({
      platform: z.string().optional().describe('juejin | csdn (default: both)'),
      dryRun: z.boolean().optional().describe('preview verdicts without writing (default false)'),
      site: siteField,
    }),
    async run(args) {
      try {
        withSite(args);
        const platforms = (args.platform ? [args.platform] : ['juejin', 'csdn']).filter(
          (p) => p === 'juejin' || p === 'csdn'
        );
        if (!platforms.length) return fail(new Error('channel_audit_check: platform must be juejin or csdn'));
        const out = {};
        for (const p of platforms) {
          try {
            out[p] = await t.plan.channel.syncStatuses(p, { dryRun: !!args.dryRun });
          } catch (e) {
            out[p] = { ok: false, error: e.message };
          }
        }
        return ok({ ok: true, dryRun: !!args.dryRun, results: out });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'channel_schedule_list',
    title: '平台排期列表',
    description:
      'List the auto-publish scheduling rules (table tengence_geo_channel_schedule): one row = one (platform, publish_time) ' +
      'slot, with count (articles per fire), enabled and last_run_at (day-level re-fire guard). ' +
      'The schedule is the config the unified executor channel_publish_due reads — it does NOT contain articles, ' +
      'the executor picks the next due article(s) from the channel_plan queue at fire time.',
    inputSchema: z.object({
      platform: z.string().optional().describe('filter to one platform key (juejin | csdn | devto | wechat | ...)'),
    }),
    async run(args) {
      try {
        const rows = await t.plan.channelSchedule.list({ platform: args.platform });
        return ok({ ok: true, count: rows.length, rows });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'channel_schedule_get',
    title: '平台排期详情',
    description:
      'Get one channel_schedule slot by id (see channel_schedule_list rows). Returns the slot or null when it does not exist.',
    inputSchema: z.object({
      id: z.number().describe('channel_schedule row id'),
    }),
    async run(args) {
      try {
        const row = await t.plan.channelSchedule.get(args.id);
        return ok({ ok: true, row });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'channel_schedule_set',
    title: '设置平台排期',
    description:
      'Create or update one auto-publish scheduling slot (upsert by platform + publish_time). ' +
      'publish_time is "HH:MM" (zero-padded, local time, non-整点 recommended to avoid platform top-of-hour congestion). ' +
      'count = how many articles one fire takes (default 1; wechat: one issue = N rows of channel_plan, e.g. count=2 for ' +
      'a 2-article 合辑). enabled=0 pauses the slot without deleting it. Returns the resulting row.',
    inputSchema: z.object({
      platform: z.string().describe('platform key (juejin | csdn | devto | wechat | ...)'),
      publish_time: z.string().describe('"HH:MM" local time, e.g. "10:35"'),
      count: z.number().optional().describe('articles per fire, positive integer (default 1)'),
      enabled: z.number().optional().describe('1 = active (default), 0 = paused'),
    }),
    async run(args) {
      try {
        const res = await t.plan.channelSchedule.set({
          platform: args.platform,
          publish_time: args.publish_time,
          count: args.count,
          enabled: args.enabled,
        });
        return ok({ ok: true, action: res.action, id: res.id, row: res.row });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'channel_schedule_del',
    title: '删除平台排期',
    description:
      'Delete a channel_schedule slot — by id, or by the unique key (platform + publish_time). ' +
      'Returns the number of deleted rows. Use enabled=0 on channel_schedule_set instead if you want to pause, not delete.',
    inputSchema: z.object({
      id: z.number().optional().describe('channel_schedule row id (preferred)'),
      platform: z.string().optional().describe('platform key (with publish_time to target the unique key)'),
      publish_time: z.string().optional().describe('"HH:MM" (with platform)'),
    }),
    async run(args) {
      try {
        if (args.id != null) {
          const res = await t.plan.channelSchedule.del({ id: args.id });
          return ok({ ok: true, deleted: res.deleted });
        }
        if (args.platform && args.publish_time) {
          const res = await t.plan.channelSchedule.del({ platform: args.platform, publish_time: args.publish_time });
          return ok({ ok: true, deleted: res.deleted });
        }
        return fail(new Error('channel_schedule_del requires id, or platform + publish_time'));
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'channel_publish_due',
    title: '到期平台内容发布',
    description:
      'UNIFIED auto-publish executor: scan the channel_schedule slots and publish on every platform whose slot is due NOW ' +
      '(publish_time within ±15 minutes — a 30-minute external tick always lands in the window) and has NOT run today ' +
      '(last_run_at). Per slot: picks the next N un-dispatched articles (nextDue, N = slot count), publishes through the same ' +
      'pipeline as channel_publish (juejin/csdn/devto publish for real; wechat stays DRAFT-BOX — 原创声明/赞赏 cannot be set via ' +
      'any WeChat API and need a manual toggle before sending), writes the outcome back to channel_plan and stamps last_run_at. ' +
      'dryRun=true prints the due plan with NO external calls and NO writes. Call this from ONE external ticker (cron/launchd ' +
      'every 30 min) — do NOT create one scheduled task per channel.',
    inputSchema: z.object({
      dryRun: z.boolean().optional().describe('print the due plan only, no external calls, no writes'),
      site: siteField,
    }),
    async run(args, ctx) {
      try {
        withSite(args);
        const res = await t.plan.channelSchedule.publishDue({ dryRun: !!args.dryRun, siteKey: args.site, onProgress: ctx && ctx.onProgress });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  },
  // ---------- external-platform taxonomy dictionary (channel_taxonomy) ----------
  {
    name: 'channel_taxonomy_sync',
    title: '同步平台类目',
    description:
      'Refresh the cached dictionary of an EXTERNAL platform\'s own taxonomy (category + tag id/name) into the workspace ' +
      'table channel_taxonomy. Currently juejin: 8 categories + ~725 tags fetched from the platform APIs. The dictionary is ' +
      'PLATFORM-scoped, shared by every site — a site publishing to Juejin needs NO mapping file of its own. It is used to ' +
      'map our article_plan category/tags onto the platform\'s category_id/tag_ids at publish time. Idempotent (upsert by ' +
      'platform id); publish auto-runs this once when the dictionary is empty, so calling it manually is only needed to ' +
      'refresh after a platform word-list change. Names are indexed for exact/prefix lookup (infix search runs in memory). ' +
      'Requires JUEJIN_COOKIE in the site .env. Read-only on the platform — it fetches lists, it does not publish.',
    inputSchema: z.object({
      platform: z.string().optional().describe('platform key (default juejin)'),
      site: siteField,
    }),
    async run(args) {
      try {
        withSite(args);
        const res = await t.syndicate.juejinTaxonomy.syncJuejinTaxonomy();
        const stats = await t.syndicate.juejinTaxonomy.taxonomyStats();
        return ok({ ok: true, ...res, cached: stats });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'channel_taxonomy_list',
    title: '平台类目列表',
    description:
      'Read the cached external-platform taxonomy dictionary (channel_taxonomy) — the platform\'s OWN categories and tags ' +
      'with their ids. Filter by kind (category|tag); look one up exactly with name=, or by prefix with prefix= (prefix ' +
      'lookups use the NOCASE index; infix/contains search is NOT index-accelerated, so do it client-side over this list). ' +
      'Use it to see which platform tags exist before choosing an alias.',
    inputSchema: z.object({
      platform: z.string().optional().describe('platform key (default juejin)'),
      kind: z.enum(['category', 'tag']).optional().describe('category | tag (omit for both)'),
      name: z.string().optional().describe('exact name lookup (case-insensitive)'),
      prefix: z.string().optional().describe('name prefix lookup, e.g. "搜索"'),
      limit: z.number().optional().describe('max rows (default 100)'),
      site: siteField,
    }),
    async run(args) {
      try {
        withSite(args);
        const appId = Number(process.env.APP_ID || 1);
        const platform = args.platform || 'juejin';
        const repo = t.db.channelTaxonomy;
        let rows;
        await t.db.withConn(async (conn) => {
          if (args.name) {
            const one = await repo.findByName(conn, appId, platform, args.kind || 'tag', args.name);
            rows = one ? [one] : [];
          } else if (args.prefix) {
            rows = await repo.findByPrefix(conn, appId, platform, args.kind || 'tag', args.prefix, args.limit || 100);
          } else {
            rows = await repo.list(conn, appId, { platform, kind: args.kind, limit: args.limit || 100 });
          }
        });
        const stats = await t.syndicate.juejinTaxonomy.taxonomyStats();
        return ok({
          ok: true,
          platform,
          cached: stats,
          count: rows.length,
          rows: rows.map((r) => ({ kind: r.kind, external_id: r.external_id, name: r.name, parent_id: r.parent_id, extra: r.extra })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'channel_taxonomy_resolve',
    title: '解析平台类目',
    description:
      'Preview how OUR taxonomy maps onto a platform\'s (article_plan.category/tags → platform category_id/tag_ids) WITHOUT ' +
      'publishing. Returns the chosen ids/names plus a per-item origin showing which fallback layer fired (alias / exact / ' +
      'token:<kw> / fuzzy / default / env / first / hardcoded). Use it to sanity-check a mapping before a real publish; it ' +
      'never makes external calls and never writes.',
    inputSchema: z.object({
      category: z.string().optional().describe('our category slug, e.g. geo-ai-search'),
      tags: z.array(z.string()).optional().describe('our tag slugs, e.g. ["geo-seo","search-system"]'),
      keywords: z.array(z.string()).optional().describe('extra keywords (article target_keywords)'),
      platform: z.string().optional().describe('platform key (default juejin)'),
      site: siteField,
    }),
    async run(args) {
      try {
        const site = withSite(args);
        const res = await t.syndicate.juejinTaxonomy.resolveJuejinTaxonomy({
          category: args.category || null,
          tags: args.tags || [],
          keywords: args.keywords || [],
          siteDir: site.siteDir,
          autoSync: false,
        });
        return ok({ ok: true, ...res });
      } catch (e) {
        return fail(e);
      }
    },
  },
  // ---------- term names (multilingual category / tag / author display names) ----------
  // Thin MCP wrappers: all domain logic (language-code mapping, validation, endpoint/body
  // construction) lives in @tengence/geo-sdk/wp/termnames (t.wp.termnames), which talks to
  // the plugin's /tengence/v1/term-names + /author-names REST endpoints
  // (tengence-wordpress-plugin modules/multilingual/RestTermNames.php).
  {
    name: 'term_names_list',
    title: '术语名列表',
    description:
      'List the multilingual display-name table for WP categories & tags (plugin option tengence_ml_term_names). ' +
      'taxonomy optional: omit for both category and post_tag, or pass category|post_tag to filter. Read-only.',
    inputSchema: z.object({
      taxonomy: z.enum(['category', 'post_tag']).optional().describe('filter to one taxonomy; omit for both'),
      site: siteField,
    }),
    async run(args) {
      try {
        const S = withSite(args);
        const data = await t.wp.termnames.listTermNames({ siteKey: S.siteKey, taxonomy: args.taxonomy });
        return ok({ ok: true, data });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'article_terms_sync',
    title: '同步文章类目',
    description:
      'Read and/or set an article\'s WordPress classification (category 类目 + post_tag 标签) using TERM SLUGS ' +
      '(the same keys the plan table and article front matter use), not raw term IDs.\n' +
      'Three modes:\n' +
      '  • read — pass only the target (wp_post_id or slug+lang): returns the current terms as {id,slug,name}.\n' +
      '  • write — pass category_slugs / tag_slugs: resolves them (create_terms=true to auto-create missing slugs) ' +
      '    and sets them on the post. Omit a field to leave that taxonomy untouched.\n' +
      '  • mirror — pass copy_from (a source wp_post_id): copies that post\'s exact categories+tags onto the target. ' +
      '    This is how a translation is aligned to its source article in one call.\n' +
      'Always returns a before/after diff and the resolved IDs, so a write can be verified without a second call. ' +
      'dry_run previews the resolution and the write that would happen, touching nothing.',
    inputSchema: z.object({
      site: siteField,
      wp_post_id: z.number().optional().describe('target WordPress post id; omit when slug is given'),
      slug: z.string().optional().describe('target article slug (required when wp_post_id is omitted)'),
      lang: z.string().optional().describe('language for a slug lookup: zh-hans|en|zh-hant (default zh-hans)'),
      copy_from: z.number().optional().describe('source wp_post_id whose categories+tags should be mirrored onto the target'),
      category_slugs: z.array(z.string()).optional().describe('category slugs to set, e.g. ["product-solutions"]'),
      tag_slugs: z.array(z.string()).optional().describe('tag slugs to set, e.g. ["geo-seo","saas"]'),
      create_terms: z.boolean().optional().describe('create any missing term slug instead of failing (default false)'),
      dry_run: z.boolean().optional().describe('resolve + report the planned write without touching WP'),
    }),
    async run(args) {
      if (args.lang) {
        const e = langReject(args.lang);
        if (e) return fail(new Error(e));
        args.lang = langNorm(args.lang);
      }
      try {
        const S = withSite(args);
        const siteKey = S.siteKey || S.key;
        let postId = args.wp_post_id ? Number(args.wp_post_id) : null;
        if (!postId) {
          if (!args.slug) return fail(new Error('either wp_post_id or slug is required'));
          const lang = args.lang || 'zh-hans';
          let found = await t.wp.posts.findPostByLanguage(args.slug, lang, { siteKey });
          if (found && found.id) postId = found.id;
          if (!postId) {
            const draft = await t.wp.posts.findBySlug(args.slug, { siteKey, status: 'draft' });
            if (draft && draft.id) postId = draft.id;
          }
          if (!postId) {
            const any = await t.wp.posts.findBySlug(args.slug, { siteKey });
            if (any && any.id) postId = any.id;
          }
          if (!postId) {
            return ok({ ok: false, found: false, slug: args.slug, reason: 'no WordPress post found for this slug + lang' });
          }
        }

        // ---- read current terms (the "before" of the diff) ----
        const before = await t.wp.terms.getPostTerms(postId, { siteKey });

        // ---- decide the target term set ----
        let wantCats = null; // null = leave untouched
        let wantTags = null;
        let mirrored = false;

        if (args.copy_from) {
          const src = await t.wp.terms.getTermsForCopy(Number(args.copy_from), { siteKey });
          wantCats = src.category_slugs;
          wantTags = src.tag_slugs;
          mirrored = true;
        }
        if (args.category_slugs) wantCats = args.category_slugs;
        if (args.tag_slugs) wantTags = args.tag_slugs;

        const isWrite = wantCats !== null || wantTags !== null;

        if (!isWrite) {
          return ok({
            ok: true,
            found: true,
            wp_post_id: postId,
            mode: 'read',
            terms: before,
          });
        }

        const create = args.create_terms === true;
        const catRes = wantCats === null
          ? null
          : await t.wp.terms.resolveTermIds(wantCats, { taxonomy: 'category', create, siteKey });
        const tagRes = wantTags === null
          ? null
          : await t.wp.terms.resolveTermIds(wantTags, { taxonomy: 'post_tag', create, siteKey });

        const problems = [];
        if (catRes && catRes.unknown.length) problems.push(`unknown category slug(s): ${catRes.unknown.join(', ')}`);
        if (tagRes && tagRes.unknown.length) problems.push(`unknown tag slug(s): ${tagRes.unknown.join(', ')}`);
        if (problems.length && !args.dry_run) {
          return fail(new Error(`${problems.join('; ')} — pass create_terms=true to create them, or fix the slugs`));
        }

        if (args.dry_run) {
          return ok({
            ok: true,
            dry_run: true,
            found: true,
            wp_post_id: postId,
            mode: mirrored ? 'mirror(dry-run)' : 'write(dry-run)',
            mirrored_from: args.copy_from || null,
            before,
            would_set: {
              categories: catRes ? catRes.ids : '(untouched)',
              tags: tagRes ? tagRes.ids : '(untouched)',
            },
            resolved: { categories: catRes ? catRes.resolved : [], tags: tagRes ? tagRes.resolved : [] },
            created: { categories: catRes ? catRes.created : [], tags: tagRes ? tagRes.created : [] },
            problems,
          });
        }

        // ---- apply: one wp/v2 update carrying only the fields we resolved ----
        const body = {};
        if (catRes) body.categories = catRes.ids;
        if (tagRes) body.tags = tagRes.ids;
        await t.wp.posts.update(postId, body, { siteKey });

        const after = await t.wp.terms.getPostTerms(postId, { siteKey });
        return ok({
          ok: true,
          found: true,
          wp_post_id: postId,
          mode: mirrored ? 'mirror' : 'write',
          mirrored_from: args.copy_from || null,
          before,
          after,
          resolved: { categories: catRes ? catRes.resolved : [], tags: tagRes ? tagRes.resolved : [] },
          created: { categories: catRes ? catRes.created : [], tags: tagRes ? tagRes.created : [] },
        });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'term_name_get',
    title: '查询术语名',
    description:
      'Read the multilingual display names of ONE WP term (GET /term-names/{taxonomy}/{slug}): returns original_name ' +
      'plus the configured per-language names. Read-only.',
    inputSchema: z.object({
      taxonomy: z.enum(['category', 'post_tag']).describe('category (类目) or post_tag (标签)'),
      slug: z.string().describe('term slug, e.g. geo-ai-search'),
      site: siteField,
    }),
    async run(args) {
      try {
        const S = withSite(args);
        const data = await t.wp.termnames.getTermName({ siteKey: S.siteKey, taxonomy: args.taxonomy, slug: args.slug });
        return ok({ ok: true, data });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'term_name_set',
    title: '设置术语名',
    description:
      'Set (UPSERT) the multilingual display names of ONE category/tag term — PUT /term-names/{taxonomy}/{slug} with ' +
      '{"names":{"en":"GEO & AI Search","zh-hans":"GEO与AI搜索","zh-hant":"GEO與AI搜尋"}}. Idempotent partial update: ' +
      'only the passed language keys change, the others are kept; an EMPTY STRING ("") for a language CLEARS that ' +
      'language (display falls back to the original term name). Language keys accept plugin codes en / zh-hans / ' +
      'zh-hant and geo codes en / zh-hans / zh-hant (auto-mapped). Fails 404 when the term slug does not exist on WP.',
    inputSchema: z.object({
      taxonomy: z.enum(['category', 'post_tag']).describe('category (类目) or post_tag (标签)'),
      slug: z.string().describe('term slug, e.g. geo-ai-search'),
      names: z.record(z.string(), z.string()).describe('language code → display name; "" clears that language'),
      site: siteField,
    }),
    async run(args) {
      if (args.names) {
        const e = recordLangsReject(args.names, 'names');
        if (e) return fail(new Error(e));
      }
      try {
        const S = withSite(args);
        const data = await t.wp.termnames.setTermName({
          siteKey: S.siteKey,
          taxonomy: args.taxonomy,
          slug: args.slug,
          names: args.names,
        });
        return ok({ ok: true, data });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'term_name_delete',
    title: '删除术语名',
    description:
      'Delete the multilingual display names of ONE WP term (DELETE /term-names/{taxonomy}/{slug}). Without lang the ' +
      'whole entry is removed; pass lang (en / zh-hans / zh-hant or en / zh-hans / zh-hant) to remove only that language. ' +
      'The WP term itself is never touched.',
    inputSchema: z.object({
      taxonomy: z.enum(['category', 'post_tag']).describe('category (类目) or post_tag (标签)'),
      slug: z.string().describe('term slug'),
      lang: z.string().optional().describe('remove only this language (omit to remove all configured names)'),
      site: siteField,
    }),
    async run(args) {
      if (args.lang) {
        const e = langReject(args.lang);
        if (e) return fail(new Error(e));
        args.lang = langNorm(args.lang);
      }
      try {
        const S = withSite(args);
        const data = await t.wp.termnames.deleteTermName({
          siteKey: S.siteKey,
          taxonomy: args.taxonomy,
          slug: args.slug,
          lang: args.lang,
        });
        return ok({ ok: true, data });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'term_names_batch',
    title: '批量设置术语名',
    description:
      'Batch-set multilingual display names for many WP terms in one call (POST /term-names/batch). Body shape: ' +
      '{"category":{"<slug>":{"<lang>":"<name>",...}},"post_tag":{...}} — pass categories and/or tags. Merge semantics ' +
      'per term (empty string clears that language); per-item validation; response reports updated count + per-item ' +
      'failures (e.g. term not found).',
    inputSchema: z.object({
      category: z.record(z.string(), z.record(z.string(), z.string())).optional().describe('category slug → {lang: name}'),
      post_tag: z.record(z.string(), z.record(z.string(), z.string())).optional().describe('tag slug → {lang: name}'),
      site: siteField,
    }),
    async run(args) {
      for (const grp of ['category', 'post_tag']) {
        const rec = args[grp];
        if (rec) {
          for (const slug of Object.keys(rec)) {
            const e = recordLangsReject(rec[slug], `${grp}.${slug}`);
            if (e) return fail(new Error(e));
          }
        }
      }
      try {
        const S = withSite(args);
        const data = await t.wp.termnames.batchTermNames({
          siteKey: S.siteKey,
          category: args.category,
          post_tag: args.post_tag,
        });
        return ok({ ok: true, data });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'author_names_list',
    title: '作者名列表',
    description:
      'List the multilingual display names for all WP authors (GET /author-names): configured per-language names plus ' +
      'the original display_names. Read-only.',
    inputSchema: z.object({ site: siteField }),
    async run(args) {
      try {
        const S = withSite(args);
        const data = await t.wp.termnames.listAuthorNames({ siteKey: S.siteKey });
        return ok({ ok: true, data });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'author_name_get',
    title: '查询作者名',
    description:
      'Read the multilingual display names of ONE WP author (GET /author-names/{id}): returns display_name (original) ' +
      'plus the configured per-language names. Read-only.',
    inputSchema: z.object({
      id: z.number().int().positive().describe('WP author/user ID'),
      site: siteField,
    }),
    async run(args) {
      try {
        const S = withSite(args);
        const data = await t.wp.termnames.getAuthorName({ siteKey: S.siteKey, id: args.id });
        return ok({ ok: true, data });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'author_name_set',
    title: '设置作者名',
    description:
      'Set (UPSERT) the multilingual display names of ONE WP author — PUT /author-names/{id} with ' +
      '{"names":{"en":"John Doe","zh-hans":"张三"}}. Idempotent partial update; an EMPTY STRING ("") for a language ' +
      'CLEARS that language (falls back to the original display_name). Language keys accept plugin codes en / zh-hans / ' +
      'zh-hant and geo codes en / zh-hans / zh-hant (auto-mapped). Fails 404 when the author id does not exist.',
    inputSchema: z.object({
      id: z.number().int().positive().describe('WP author/user ID'),
      names: z.record(z.string(), z.string()).describe('language code → display name; "" clears that language'),
      site: siteField,
    }),
    async run(args) {
      if (args.names) {
        const e = recordLangsReject(args.names, 'names');
        if (e) return fail(new Error(e));
      }
      try {
        const S = withSite(args);
        const data = await t.wp.termnames.setAuthorName({ siteKey: S.siteKey, id: args.id, names: args.names });
        return ok({ ok: true, data });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'author_name_delete',
    title: '删除作者名',
    description:
      'Delete the multilingual display names of ONE WP author (DELETE /author-names/{id}). Without lang the whole entry ' +
      'is removed; pass lang (en / zh-hans / zh-hant or en / zh-hans / zh-hant) to remove only that language. The WP user ' +
      'itself is never touched.',
    inputSchema: z.object({
      id: z.number().int().positive().describe('WP author/user ID'),
      lang: z.string().optional().describe('remove only this language (omit to remove all configured names)'),
      site: siteField,
    }),
    async run(args) {
      if (args.lang) {
        const e = langReject(args.lang);
        if (e) return fail(new Error(e));
        args.lang = langNorm(args.lang);
      }
      try {
        const S = withSite(args);
        const data = await t.wp.termnames.deleteAuthorName({ siteKey: S.siteKey, id: args.id, lang: args.lang });
        return ok({ ok: true, data });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'author_names_batch',
    title: '批量设置作者名',
    description:
      'Batch-set multilingual display names for many WP authors in one call (POST /author-names/batch). Body shape: ' +
      '{"authors":{"<id>":{"<lang>":"<name>",...}}} — author ids are numeric strings. Merge semantics per author (empty ' +
      'string clears that language); per-item validation; response reports updated count + per-item failures.',
    inputSchema: z.object({
      authors: z.record(z.string(), z.record(z.string(), z.string())).describe('author id (numeric string) → {lang: name}'),
      site: siteField,
    }),
    async run(args) {
      if (args.authors) {
        for (const id of Object.keys(args.authors)) {
          const e = recordLangsReject(args.authors[id], `authors.${id}`);
          if (e) return fail(new Error(e));
        }
      }
      try {
        const S = withSite(args);
        const data = await t.wp.termnames.batchAuthorNames({ siteKey: S.siteKey, authors: args.authors });
        return ok({ ok: true, data });
      } catch (e) {
        return fail(e);
      }
    },
  },
  // ---------- wechat backend read-back & progress reconciliation ----------
  {
    name: 'wechat_status',
    title: '微信公众号状态',
    description:
      'Read the WeChat official-account backend: the draft box (draft/batchget — media_id + titles) and the mass-sent list ' +
      '(freepublish/batchget — article_id + titles). Read-only. Requires WECHAT_APP_ID/SECRET in the site .env and the ' +
      'current outbound IP whitelisted in mp.weixin.qq.com.',
    inputSchema: z.object({ site: siteField }),
    async run(args) {
      try {
        const S = withSite(args);
        const wechat = t.syndicate.wechat;
        const drafts = await wechat.listDrafts();
        const published = await wechat.listPublished();
        return ok({ ok: true, drafts, published });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'wechat_stats',
    title: '微信公众号统计',
    description:
      'Read official-account statistics from the WeChat backend (datacube/*, served WITHOUT the /cgi-bin/ prefix — ' +
      'the /cgi-bin/datacube/* variant is blocked by the egress proxy in this environment). Returns: user growth ' +
      '(user_summary), cumulative users (user_cumulate), upstream/interactive messages (upstream_msg, maxSpan 30d), ' +
      'interface quality (interface_summary, 30d), account biz summary (biz_summary, 30d), daily article reads ' +
      '(article_read, single-day), shares (article_share, single-day) and per-article detail incl. 送达率/读完率/平均' +
      '阅读时长/跳出 (article_detail, single-day). Read-only. Constraints: data is T+1 (end_date defaults to ' +
      'yesterday); most endpoints allow a <=7d window, the *_read/_share/_detail ones require begin_date === end_date. ' +
      'Requires 用户分析/图文分析 permissions (认证公众号); an unauthorised account returns errcode 48001. Legacy ' +
      'endpoints getarticletotal/getuserread/getusershare are OFFLINE (47009) and have been replaced by the new ' +
      '“发表内容” APIs above.',
    inputSchema: z.object({
      action: z
        .enum([
          'overview',
          'user_summary',
          'user_cumulate',
          'upstream_msg',
          'interface_summary',
          'biz_summary',
          'article_read',
          'article_share',
          'article_detail',
        ])
        .optional()
        .describe(
          'report to read; default overview = user_summary + user_cumulate + biz_summary + upstream_msg in one 7-day window'
        ),
      begin_date: z.string().optional().describe('YYYY-MM-DD; default = 6 days before end_date'),
      end_date: z.string().optional().describe('YYYY-MM-DD; default = yesterday (data is T+1, today is never available)'),
      site: siteField,
    }),
    async run(args) {
      try {
        const S = withSite(args);
        const wechat = t.syndicate.wechat;
        const range = { beginDate: args.begin_date, endDate: args.end_date };
        if (!args.action || args.action === 'overview') {
          return ok({ ok: true, ...(await wechat.getStatsOverview(range)) });
        }
        return ok({ ok: true, ...(await wechat.getStats(args.action, range)) });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'wechat_sync_progress',
    title: '公众号同步进度',
    description:
      'Reconcile the channel_plan calendar with the real WeChat backend and auto-fix the DB: draft rows whose media_id is ' +
      'missing from the draft box and not found in the publish list are rolled back to todo (draft_ids cleared); draft rows ' +
      'whose titles appear in the publish list are upgraded to published. Published rows are never downgraded. Returns the ' +
      'reconciliation report. dryRun=true previews without writing.',
    inputSchema: z.object({
      site: siteField,
      dryRun: z.boolean().optional().describe('preview only — compute and report, do not write to the DB'),
    }),
    async run(args) {
      try {
        const S = withSite(args);
        const result = await t.syndicate.wechat.syncProgressFromWechat({
          siteKey: S.siteKey,
          dryRun: !!args.dryRun,
        });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'wechat_mass_preview',
    title: '公众号群发预览',
    description:
      'Send a draft (media_id from the draft box) to one user as a preview (message/mass/preview). Requires a verified ' +
      'account; pass openid (touser) or wxname (towxname). Use this to check layout before mass-sending.',
    inputSchema: z.object({
      media_id: z.string().describe('draft box media_id (see wechat_status drafts)'),
      openid: z.string().optional().describe('receiver openid'),
      wxname: z.string().optional().describe('receiver wxname (user must have interacted with the account)'),
      dryRun: z.boolean().optional().describe('print the payload, do not send'),
      site: siteField,
    }),
    async run(args) {
      try {
        const S = withSite(args);
        if (!args.openid && !args.wxname) return fail(new Error('wechat_mass_preview requires openid or wxname'));
        const result = await t.syndicate.wechat.massPreview(args.media_id, {
          openid: args.openid,
          wxname: args.wxname,
          dryRun: !!args.dryRun,
        });
        return ok({ ok: true, ...result });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'wechat_mass_send',
    title: '公众号群发',
    description:
      'Mass-send (PUSH to followers) a draft via message/mass/sendall (all followers or one tag) or message/mass/send ' +
      '(specific openids). Subscription accounts get 1 mass-send per day. After a successful send the draft is consumed ' +
      '(auto-deleted from the draft box). If 风险操作保护 is on, the admin must confirm in mp.weixin.qq.com before it ' +
      'really goes out. Safety: execution requires confirm="YES"; dryRun=true only prints the payload.',
    inputSchema: z.object({
      media_id: z.string().describe('draft box media_id (see wechat_status drafts)'),
      tag_id: z.number().optional().describe('send to one user tag only (omit = all followers)'),
      to_users: z.array(z.string()).optional().describe('specific openids (message/mass/send)'),
      client_msg_id: z.string().optional().describe('clientmsgid — de-duplicates repeated sends'),
      confirm: z.enum(['YES']).optional().describe('must be "YES" to actually push to followers (not needed for dryRun)'),
      dryRun: z.boolean().optional().describe('print the payload, do not send'),
      site: siteField,
    }),
    async run(args) {
      try {
        const S = withSite(args);
        if (args.dryRun) {
          const result = await t.syndicate.wechat.massSend(args.media_id, {
            tagId: args.tag_id,
            toUsers: args.to_users,
            clientMsgId: args.client_msg_id,
            dryRun: true,
          });
          return ok({ ok: true, ...result });
        }
        if (args.confirm !== 'YES') {
          return fail(new Error('wechat_mass_send pushes to followers — pass confirm="YES" to execute (or dryRun=true to preview)'));
        }
        const result = await t.syndicate.wechat.massSend(args.media_id, {
          tagId: args.tag_id,
          toUsers: args.to_users,
          clientMsgId: args.client_msg_id,
        });
        return ok({ ok: true, ...result });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'wechat_mass_status',
    title: '公众号群发状态',
    description: 'Query a mass-send task status (message/mass/get, msg_id from wechat_mass_send).',
    inputSchema: z.object({
      msg_id: z.number().describe('mass-send task msg_id'),
      site: siteField,
    }),
    async run(args) {
      try {
        const S = withSite(args);
        if (!args.msg_id) return fail(new Error('wechat_mass_status requires msg_id'));
        const result = await t.syndicate.wechat.massStatus(args.msg_id);
        return ok({ ok: true, ...result });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'wechat_article_delete',
    title: '删除公众号文章',
    description:
      'Delete a published article (freepublish/delete, article_id from wechat_status published). IRREVERSIBLE — verify the ' +
      'article_id first; index (1-based) deletes one article of a multi-article message, omit to delete the whole message.',
    inputSchema: z.object({
      article_id: z.string().describe('published article_id (see wechat_status published)'),
      index: z.number().optional().describe('1-based position within the message; omit to delete the whole message'),
      confirm: z.enum(['YES']).optional().describe('must be "YES" to actually delete (irreversible); not needed for dryRun'),
      dryRun: z.boolean().optional().describe('print the payload, do not delete'),
      site: siteField,
    }),
    async run(args) {
      try {
        const S = withSite(args);
        if (args.dryRun) {
          const result = await t.syndicate.wechat.deletePublished(args.article_id, { index: args.index, dryRun: true });
          return ok({ ok: true, ...result });
        }
        if (args.confirm !== 'YES') {
          return fail(new Error('wechat_article_delete is irreversible — pass confirm="YES" to execute (or dryRun=true to preview)'));
        }
        const result = await t.syndicate.wechat.deletePublished(args.article_id, { index: args.index });
        return ok({ ok: true, ...result });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'wechat_draft_publish',
    title: '发布公众号草稿',
    description:
      'Publish a draft box media_id to the account homepage via freepublish/submit (NO push to followers — the draft is ' +
      'consumed and moves to the published list, where it is visible in the account homepage). Use for the "发布" step; ' +
      'mass push (推送粉丝) is a separate tool wechat_mass_send.',
    inputSchema: z.object({
      media_id: z.string().describe('draft box media_id (see wechat_status drafts)'),
      dryRun: z.boolean().optional().describe('print the payload, do not publish'),
      site: siteField,
    }),
    async run(args) {
      try {
        const S = withSite(args);
        const result = await t.syndicate.wechat.publishDraftByMediaId(args.media_id, { dryRun: !!args.dryRun });
        return ok({ ok: true, ...result });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'wechat_draft_update',
    title: '更新公众号草稿',
    description:
      'Update ONE article inside a WeChat draft-box media_id (draft/update). Safety: draft/update REPLACES the whole ' +
      'article, so this tool first reads the current article from the draft box, merges ONLY the fields you pass and ' +
      'submits the complete article back — title/author/digest/content/thumb are preserved when omitted. Use ' +
      'content_source_url to fix the「阅读原文」link, or title/content to rewrite the article body. Returns the merged ' +
      'article for verification (dryRun=true reads + merges only, never writes).',
    inputSchema: z.object({
      media_id: z.string().describe('draft box media_id (see wechat_status drafts)'),
      index: z.number().optional().describe('article position in the multi-article message, 0-based (default 0)'),
      title: z.string().optional().describe('new title (omit to keep current)'),
      author: z.string().optional().describe('new author (omit to keep current)'),
      digest: z.string().optional().describe('new digest (omit to keep current)'),
      content: z.string().optional().describe('new body HTML (omit to keep current)'),
      content_source_url: z.string().optional().describe('new「阅读原文」link (omit to keep current)'),
      thumb_media_id: z.string().optional().describe('new cover media id (omit to keep current)'),
      show_cover_pic: z.number().optional().describe('0|1 show cover inside the article body'),
      need_open_comment: z.number().optional().describe('0|1 allow comments'),
      only_fans_can_comment: z.number().optional().describe('0|1 fans-only comments'),
      dryRun: z.boolean().optional().describe('read + merge only, print the would-be payload, do NOT call draft/update'),
      site: siteField,
    }),
    async run(args) {
      try {
        const S = withSite(args);
        const patch = {};
        for (const key of ['title', 'author', 'digest', 'content', 'content_source_url', 'thumb_media_id']) {
          if (args[key] != null) patch[key] = args[key];
        }
        for (const key of ['show_cover_pic', 'need_open_comment', 'only_fans_can_comment']) {
          if (args[key] != null) patch[key] = Number(args[key]);
        }
        const result = await t.syndicate.wechat.updateDraft(args.media_id, args.index || 0, patch, {
          dryRun: !!args.dryRun,
        });
        return ok({ ok: true, ...result });
      } catch (e) {
        return fail(e);
      }
    },
  },
];

/**
 * Canonical tool groupings — single source of truth for "which tool belongs to
 * which domain". server.js aggregates the LIVE tool list through these matchers
 * into the server instructions, so the group listing never drifts from the
 * actually-registered tools. Order matters: first matcher wins. A tool that
 * matches nothing lands in "Uncategorized" and needs a rule added here.
 */
const TOOL_GROUPS = [
  { group: 'Workspace & Site', match: /^(workspace_use|site_|db_|diagnose_site)/ },
  {
    group: 'Content authoring & gate',
    match: /^(article_list|article_draft|article_ingest|article_export|article_terms_sync|check_article|check_translation|translation_glossary_get|wp_post_get)/,
  },
  { group: 'Publishing (WordPress)', match: /^publish_/ },
  { group: 'Search inclusion & analytics', match: /^(search_|webmaster_)/ },
  { group: 'AI visibility monitoring', match: /^(monitor_|report_write)/ },
  { group: 'Cross-platform syndication', match: /^(channel_|juejin_|csdn_|wechat_)/ },
  { group: 'Multi-language term/author names', match: /^(term_name|term_names|author_name|author_names)/ },
  { group: 'Planning & content calendar', match: /^plan_/ },
  { group: 'Media & assets', match: /^image_/ },
  { group: 'Utility', match: /^util_/ },
];

const registry = new Map(tools.map((tool) => [tool.name, tool]));

/**
 * Long-running tools that may be task-ified under the MCP Tasks extension
 * (their executor returns resultType:"task" when the client declares the
 * io.modelcontextprotocol/tasks extension; otherwise they run synchronously).
 */
const LONG_TOOLS = new Set(['publish_daily', 'monitor_run', 'diagnose_site', 'channel_publish_due']);

module.exports = { tools, registry, TOOL_GROUPS, LONG_TOOLS };
