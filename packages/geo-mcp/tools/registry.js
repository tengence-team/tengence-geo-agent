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
// Async sibling of runCli: spawnSync freezes the whole MCP server (single-threaded
// HTTP) for the full child runtime, so any slow CLI made every other tool call look
// dead and tripped the client's per-request timeout. Use this for long CLIs.
function runCliAsync(binName, args, opts = {}) {
  const binPath = require.resolve(`@tengence/geo-cli/bin/${binName}.js`);
  const sitesRoot = t.site.SITES_ROOT;
  return new Promise((resolve) => {
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [binPath, ...args], {
      env: { ...process.env, ...(sitesRoot ? { SITES_ROOT: sitesRoot } : {}), ...opts.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeout || 600000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: '', stderr: String(e && e.message) });
    });
  });
}

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


/**
 * G17/G18/G19 闸门报告 → 失败项名称数组（最多 6 项）。
 * checkArticle 的 rows 形如 [名称, 说明, ok]，ok=false 的即失败项。
 */
function gateFailures(report) {
  const rows = (report && Array.isArray(report.rows)) ? report.rows : [];
  return rows
    .filter((r) => Array.isArray(r) && r[2] === false)
    .map((r) => String(r[0]).trim())
    .filter(Boolean)
    .slice(0, 6);
}

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
    description:
      'List articles (articles table) with category/tags resolved from the article plan row, ' +
      'with status/category/lang/limit filters',
    inputSchema: z.object({
      site: siteField,
      status: z.string().optional().describe('draft|queued|published etc. (optional)'),
      category: z
        .string()
        .optional()
        .describe('plan category slug filter, e.g. geo-ai-search (optional)'),
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
            category: args.category || undefined,
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
    title: '校验文章（G1–G18 门禁，含 G18 标签语义硬校验）',
    annotations: { readOnlyHint: true },
    structured: true,
    description: 'Publish gate: enforces the editorial rules codified in the "article-writing-standards" standard (citation dual-channel, word count by T1–T7 type, banned words, the three GEO blocks — Summary / Key Takeaways / FAQ / Data Sources — and the research-brief hard check), plus the G18 ALWAYS-HARD tag/category semantics gate: tags must be configured, no category slug may be used as a tag, strong-domain tags (e.g. ai-ask = Insight, tengence-search = Search, tengence-geo = GEO) must match the article primary domain, and a product-line category must not contradict it. Read that standard via resource geo://standard/article-writing-standards before authoring, and run article_draft first to scaffold per-spec. On failure, fix the offending tags/category in plan.tags / plan.category (and the WP terms) and re-run; tagSemantics in the result names the exact defect.',
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
          // G18 (2026-11-05): machine-readable tag/category semantic verdict —
          // an always-hard gate; mismatches[].tag names what to fix.
          tagSemantics: result.tagSemantics,
        });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    // 2026-11-14: the maintenance side of the internal-link language rule. The
    // judgement itself is the SSOT used by check_article (writing + publish) and
    // translation T10 — this tool only lists, and (with apply=true) rewrites.
    name: 'article_links_audit',
    title: '内链语言审计与修复',
    annotations: { readOnlyHint: false },
    structured: true,
    description:
      'Audit EVERY article body (drafts + published, all languages) for on-site links whose language prefix does not match the body language ' +
      '(a zh-hans article linking to /en/blog/article/… or to a bare /blog/article/… that falls through to the default language). ' +
      'Uses the same rule (geo-sdk content/md internalLinkLanguageIssues) as the check_article gate and translation T10, so the audit can never disagree with the gate. ' +
      'Default apply=false = READ-ONLY list (slug / lang / offending links / affected counts). With apply=true it rewrites articles.content_longtext and, for published rows, the live WP post content, then re-verifies. ' +
      'Pass slugs to limit the blast radius to an explicit list.',
    inputSchema: z.object({
      site: siteField,
      apply: z.boolean().optional().describe('false (default) = read-only audit; true = rewrite DB md + live WP content for the rows in scope'),
      slugs: z.array(z.object({ slug: z.string(), lang: z.string().optional() })).optional().describe('limit the operation to these rows (slug + optional lang)'),
      langs: z.array(z.string()).optional().describe('limit the audit to these languages (zh-hans|zh-hant|en)'),
      include_wp: z.boolean().optional().describe('also read the LIVE WP content of published rows (slower; the reader-facing surface can drift from the DB body)'),
    }),
    async run(args) {
      try {
        const S = withSite(args);
        process.env.APP_ID = process.env.APP_ID || S.env.APP_ID || '1';
        const appId = parseInt(process.env.APP_ID || '1', 10);
        if (args.langs && args.langs.length) {
          for (const l of args.langs) {
            const e = langReject(l);
            if (e) return fail(new Error(e));
          }
        }
        if (args.apply) {
          const r = await t.linkAudit.repairLinks({
            appId,
            site: S.siteKey,
            slugs: args.slugs || null,
            langs: args.langs && args.langs.length ? args.langs.map(langNorm) : undefined,
            dryRun: false,
          });
          return okStructured(r);
        }
        const r = await t.linkAudit.auditLinks({
          appId,
          langs: args.langs && args.langs.length ? args.langs.map(langNorm) : undefined,
          slug: args.slugs && args.slugs.length === 1 ? args.slugs[0].slug : undefined,
          includeWp: !!args.include_wp,
          site: S.siteKey,
        });
        // Single-slug audit: only the requested lang(s) are relevant.
        if (args.slugs && args.slugs.length) {
          r.affected = r.affected.filter((a) => args.slugs.some((w) => w.slug === a.slug && (!w.lang || langNorm(w.lang) === a.lang)));
        }
        return okStructured({ ok: true, apply: false, ...r });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'article_links_fix',
    title: '内链修复（映射 / 死链）',
    annotations: { readOnlyHint: false },
    structured: true,
    description:
      'Three maintenance fixes that belong to the internal-link rules, all defaulting to READ-ONLY (dryRun=true). ' +
      'mode="mapping": repair the polluted articles.wp_post_id mapping — each row is resolved through the plugin multilingual endpoint ' +
      '(slug + lang) and rewritten only when the id genuinely differs (the column is copied across language rows by the legacy translation flow). ' +
      'mode="dead": replace dead internal article targets (pre-existing 404s) with live same-language articles given by `replace` ' +
      '({ "<dead-slug>": "<live-slug>" }); the replacement is resolved by slug+lang first and refused if it is not live, so a fix can never create a new 404. ' +
      'Both modes rewrite the DB body and the live WP content of the resolved post.',
    inputSchema: z.object({
      site: siteField,
      mode: z.enum(['mapping', 'dead', 'malformed']).describe('mapping = fix articles.wp_post_id; dead = replace dead internal article targets; malformed = repair broken Markdown link syntax (raw-URL link text / Chinese close bracket / truncated product URL)'),
      apply: z.boolean().optional().describe('false (default) = dry run (report only); true = write'),
      replace: z.record(z.string(), z.string()).optional().describe('mode=dead: { "<dead-slug>": "<live-slug>" }'),
      slugs: z.array(z.object({ slug: z.string(), lang: z.string().optional() })).optional().describe('limit the operation to these rows'),
    }),
    async run(args) {
      try {
        const S = withSite(args);
        process.env.APP_ID = process.env.APP_ID || S.env.APP_ID || '1';
        const appId = parseInt(process.env.APP_ID || '1', 10);
        if (args.slugs && args.slugs.length) {
          for (const w of args.slugs) {
            if (w.lang) { const e = langReject(w.lang); if (e) return fail(new Error(e)); }
          }
        }
        const dryRun = args.apply !== true;
        if (args.mode === 'mapping') {
          const r = await t.linkAudit.repairMapping({
            appId, site: S.siteKey, dryRun,
            slug: args.slugs && args.slugs.length === 1 ? args.slugs[0].slug : undefined,
          });
          return okStructured(r);
        }
        if (args.mode === 'malformed') {
          const r = await t.linkAudit.repairMalformed({
            appId, site: S.siteKey, dryRun, slugs: args.slugs || null,
          });
          return okStructured(r);
        }
        if (!args.replace || !Object.keys(args.replace).length) {
          return fail(new Error('mode=dead requires replace ({ "<dead-slug>": "<live-slug>" })'));
        }
        const r = await t.linkAudit.repairDeadTargets({
          appId, site: S.siteKey, dryRun, replace: args.replace, slugs: args.slugs || null,
        });
        return okStructured(r);
      } catch (e) {
        return fail(e);
      }
    },
  },

  {
    name: 'article_research_sync',
    title: '研究 brief 引用补齐（B2 ledger）',
    annotations: { readOnlyHint: false },
    structured: true,
    description:
      'The B2 ledger row of check_article requires every body citation URL to appear in the research brief. ' +
      'Legacy briefs frequently omit the URLs the body actually cites, which made an already-published article ' +
      'un-saveable and would gate any rewrite. This tool audits the gap and (apply=true) appends the missing ' +
      'citations — title + URL, taken from the body itself — into a dedicated section of articles.research_md, ' +
      'then reads back and re-checks. It never loosens the gate and never invents a source: the URL must already ' +
      'be cited in the body. Defaults to READ-ONLY (apply=false).',
    inputSchema: z.object({
      site: siteField,
      apply: z.boolean().optional().describe('false (default) = audit only; true = write the missing citations into research_md'),
      slug: z.string().optional().describe('limit to one slug'),
      lang: z.string().optional().describe('limit to one language'),
      status: z.string().optional().describe('limit to one status (draft|publish)'),
      slugs: z.array(z.object({ slug: z.string(), lang: z.string().optional() })).optional().describe('limit to these rows'),
    }),
    async run(args) {
      try {
        const S = withSite(args);
        process.env.APP_ID = process.env.APP_ID || S.env.APP_ID || '1';
        const appId = parseInt(process.env.APP_ID || '1', 10);
        if (args.lang) { const e = langReject(args.lang); if (e) return fail(new Error(e)); }
        if (args.slugs && args.slugs.length) {
          for (const w of args.slugs) {
            if (w.lang) { const e = langReject(w.lang); if (e) return fail(new Error(e)); }
          }
        }
        const dryRun = args.apply !== true;
        const r = await t.researchBrief.backfillBriefCitations({
          appId, dryRun, siteDir: S.siteDir, slug: args.slug, lang: args.lang, status: args.status, slugs: args.slugs || null,
        });
        return okStructured(r);
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
    name: 'content_publish',
    title: '发布任意 WordPress 内容',
    description:
      'Generic WordPress content writer for ANY REST-exposed post type (post / page / tengence_doc / …). ' +
      'The tool knows only a target (site + post_type) and a payload (plain WP fields); it has no content profile, ' +
      'no post-type allowlist and no per-type branching. Idempotency key = post_type + slug + language. ' +
      'parent accepts an ID or a slug path such as "products/tengence-search" resolved inside the same post type + language. ' +
      'meta is passed through to the native API: keys registered for that post type are written, others are ignored by WP.',
    inputSchema: z.object({
      site: siteField,
      workspace: workspaceField,
      post_type: z.string().optional().describe('WP post type; default tengence_doc'),
      language: z.string().optional().describe('zh-hans | en | zh-hant (language taxonomy term); omit only for a non-multilingual type'),
      translation_group: z.string().optional().describe('translation group slug shared by the language versions'),
      parent: z.union([z.number(), z.string()]).optional().describe('parent ID, or slug path inside the same post type + language (e.g. "products/tengence-search")'),
      menu_order: z.number().optional(),
      slug: z.string().describe('stable slug; part of the idempotency key'),
      title: z.string().describe('page title in the target language'),
      content: z.string().optional().describe('HTML body'),
      excerpt: z.string().optional(),
      status: z.enum(['publish', 'draft', 'pending', 'private']).optional().describe('default publish'),
      meta: z.record(z.any()).optional().describe('registered meta keys (e.g. _tengence_doc_summary); passed through to the native API'),
    }).passthrough(),
    async run(args) {
      const { site, workspace, post_type, language, translation_group, menu_order, meta, ...rest } = args;
      if (language) {
        const e = langReject(language);
        if (e) return fail(new Error(e));
      }
      withSite(args);
      let parent = rest.parent;
      if (typeof parent === 'string') {
        const segments = parent.split('/').filter(Boolean);
        let parentId = 0;
        for (const segment of segments) {
          const found = await t.wpContent.findBySlug(segment, {
            postType: post_type || 'tengence_doc', status: 'any', parent: parentId || undefined, lang: language,
          });
          if (!found) return fail(new Error(`parent path not found: ${parent} (segment "${segment}")`));
          parentId = found.id;
        }
        parent = parentId;
      }
      const payload = {
        ...rest,
        postType: post_type || 'tengence_doc',
        language,
        translationGroup: translation_group,
        menuOrder: menu_order,
        meta,
        parent,
      };
      if (!payload.slug || !payload.title) return fail(new Error('content_publish requires slug and title'));
      const result = await t.wpContent.publish(payload);
      return ok(result);
    },
  },
  {
    name: 'content_media_upload',
    title: '上传内容配图/截图',
    description:
      'Upload one local image to the WordPress media library with SEO-complete metadata. ' +
      'Type-agnostic: it only takes a file plus alt / title / filename; no post type, no stock-photo search, no DB image records. ' +
      'The file name is normalised (ASCII lowercase, hyphens, <=80 chars) before upload; alt must describe the image itself in the page language, ' +
      'title is the media title in the page language. Returns media_id + url for inserting into the content body.',
    inputSchema: z.object({
      site: siteField,
      workspace: workspaceField,
      path: z.string().describe('absolute local image path (png/jpg/jpeg/webp, max 8 MB)'),
      alt: z.string().describe('alt text of the image itself, in the page language (required)'),
      title: z.string().describe('media title in the page language (required)'),
      filename: z.string().optional().describe('normalised filename, e.g. tengence-docs-quickstart-step1-workbench-zh-hans.png; when omitted a normalised local basename is used'),
    }).passthrough(),
    async run(args) {
      withSite(args);
      if (!args.path) return fail(new Error('content_media_upload requires path'));
      if (!args.alt || !args.title) return fail(new Error('content_media_upload requires alt and title'));
      const result = await t.wp.media.uploadMediaWithMeta(args.path, {
        alt: args.alt,
        title: args.title,
        filename: args.filename,
      });
      return ok(result);
    },
  },
  {
    name: 'content_media_get',
    title: '读取媒体信息',
    description: 'Read one WordPress media item by ID (source URL, alt, title). Use it to verify an upload before inserting it into a doc.',
    inputSchema: z.object({
      site: siteField,
      workspace: workspaceField,
      media_id: z.number(),
    }).passthrough(),
    async run(args) {
      withSite(args);
      const media = await t.wp.media.getMedia(args.media_id);
      if (!media) return fail(new Error(`media ${args.media_id} not found`));
      return ok(media);
    },
  },
  {
    name: 'content_tree',
    title: '读取任意内容树',
    description: 'Read every node of a hierarchical WordPress post type (default tengence_doc) and return both the flat list and the assembled tree (parent + menu_order). Type-agnostic.',
    inputSchema: z.object({
      site: siteField,
      workspace: workspaceField,
      post_type: z.string().optional().describe('default tengence_doc'),
      status: z.string().optional().describe('default any (drafts included)'),
    }).passthrough(),
    async run(args) {
      withSite(args);
      const { flat, tree } = await t.wpContent.tree({ postType: args.post_type || 'tengence_doc', status: args.status || 'any' });
      return ok({ total: flat.length, tree });
    },
  },
  {
    name: 'content_status',
    title: '内容状态统计',
    description: 'Count nodes of a post type by status and language, and list them. Type-agnostic; useful before and after a batch publish.',
    inputSchema: z.object({
      site: siteField,
      workspace: workspaceField,
      post_type: z.string().optional().describe('default tengence_doc'),
      language: z.string().optional().describe('filter by zh-hans | en | zh-hant'),
      status: z.string().optional().describe('default any'),
    }).passthrough(),
    async run(args) {
      withSite(args);
      const { flat } = await t.wpContent.tree({ postType: args.post_type || 'tengence_doc', status: args.status || 'any' });
      const languageSet = new Set();
      if (args.language) {
        const localized = await t.wp.plugin.listPostsByLanguage('', args.language, { postType: args.post_type || 'tengence_doc' }).catch(() => []);
        localized.forEach((p) => languageSet.add(p.id));
      }
      const items = flat
        .filter((n) => !args.language || languageSet.has(n.id))
        .map((n) => ({ id: n.id, slug: n.slug, title: typeof n.title === 'string' ? n.title : n.title && n.title.rendered, status: n.status, parent: n.parent, menu_order: n.menu_order }));
      const byStatus = items.reduce((acc, n) => { acc[n.status] = (acc[n.status] || 0) + 1; return acc; }, {});
      return ok({ post_type: args.post_type || 'tengence_doc', language: args.language || null, total: items.length, by_status: byStatus, items });
    },
  },
  {
    name: 'content_delete',
    title: '删除任意内容',
    description: 'Delete a WordPress content item by ID. force=false trashes it (reversible), force=true deletes permanently. Type-agnostic.',
    inputSchema: z.object({
      site: siteField,
      workspace: workspaceField,
      post_type: z.string().optional().describe('default tengence_doc'),
      id: z.number(),
      force: z.boolean().optional().describe('default false (trash)'),
    }).passthrough(),
    async run(args) {
      withSite(args);
      const result = await t.wpContent.remove(args.id, { postType: args.post_type || 'tengence_doc', force: Boolean(args.force) });
      return ok({ id: args.id, deleted: Boolean(args.force), previous_status: result && result.status });
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
      status: z.enum(['draft', 'publish']).optional().describe('target WP status; default publish. Pass draft to sync a body into an unpublished draft without publishing it'),
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
      if (args.status) cliArgs.push('--status', args.status);
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
      'seo_meta_description / featured image into the DB row (sync_db, default true) to keep the DB as the SSOT.',
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
      sync_db: z.boolean().optional().describe('mirror title / seo_meta_title / seo_meta_description / featured image into the DB row (default true)'),
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

        // ---- 1a. cover pre-flight (G20 at the write boundary, 2026-11-13) ----
        // Writing a cover is the one moment where "the field has a value but the URL is
        // dead" is cheap to prevent: verify the media id / URL BEFORE anything touches
        // WP or the DB. A failure here returns with zero writes (the ai-marketing
        // incident was exactly a cover that existed in name only).
        let coverPreflight = null;
        if (args.featured_media !== undefined) {
          // getMedia throws on a WP 404 — translate that into one readable line instead
          // of dumping the whole "Page not found" HTML body into the tool result.
          let media = null;
          try {
            media = await t.wp.media.getMedia(args.featured_media, { siteKey });
          } catch (e) {
            media = null;
          }
          if (!media || !media.url) {
            return fail(new Error(`cover media ${args.featured_media} not found in the WP media library — nothing was written`));
          }
          const probe = await t.util.probeCover(media.url);
          if (!probe.ok) {
            return fail(new Error(`cover not reachable: ${media.url} — ${probe.reason} — nothing was written`));
          }
          coverPreflight = { media_id: args.featured_media, url: media.url };
          // no explicit image URL → mirror the media's own source_url (WP is the truth
          // for the attachment's location; hand-written URLs drift from it)
          if (args.image === undefined) args.image = media.url;
        } else if (args.image !== undefined) {
          const probe = await t.util.probeCover(args.image);
          if (!probe.ok) {
            return fail(new Error(`cover not reachable: ${args.image} — ${probe.reason} — nothing was written`));
          }
          coverPreflight = { media_id: null, url: args.image };
        }

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
            'SELECT id, slug, wp_post_id, title, seo, lang FROM tengence_geo_articles WHERE id = ? AND app_id = ? LIMIT 1',
            [args.article_id, appId]
          );
          dbRow = rows[0] || null;
          postId = dbRow && dbRow.wp_post_id;
          if (!postId) {
            return fail(new Error(`Article ${args.article_id} has no wp_post_id (not published yet)`));
          }
        }

        // ---- 2.5 GATE: any write that flips the post to status=publish must pass
        // the substantive-content gate first (2026-11-04). This tool used to write
        // status/content directly with no checkArticle, so a skeleton article with a
        // wp_post_id could be force-published. Field-level / meta-only updates that
        // do not touch status are unaffected. The DB row is the authority for
        // slug+lang (B7 cascade resolves the research brief); when only a wp_post_id
        // is given, the slug is read back from WP.
        // Only a real transition INTO publish must pass the gate. A body/meta write on a
        // post that is ALREADY published does not flip anything — and gating it made
        // legitimate repairs (correcting a wrong-language body) impossible to ship, which
        // is how 11 English-bodied zh-hans posts stayed broken.
        let preStatus = null;
        if (postId) {
          try {
            const pre = await t.wp.posts.get(postId, '?_fields=id,status', { siteKey });
            preStatus = (pre && pre.status) || null;
          } catch { preStatus = null; }
        }
        if (wpBody.status === 'publish' && preStatus !== 'publish') {
          let slug = dbRow ? dbRow.slug : null;
          let lang = args.lang || (dbRow && dbRow.lang) || null;
          if (!slug && postId) {
            try {
              const p = await t.wp.posts.get(postId, '?_fields=id,slug,status', { siteKey });
              slug = (p && p.slug) || null;
            } catch (e) {
              slug = null;
            }
          }
          if (!slug) {
            return fail(new Error(`Gate: cannot resolve a slug for post ${postId}; refusing status=publish`));
          }
          const report = await t.check.checkArticle({ slug, lang: lang || undefined, site: siteKey });
          if (!report.ok) {
            const hard = report.rows
              .filter((r) => !r[2] && !r[3])
              .map((r) => `${r[0]}: ${r[1]}`)
              .join('; ');
            return fail(
              new Error(
                `Gate failed — refusing to publish "${slug}" (${lang || 'site default'}): ${hard || 'unknown rows'}. ` +
                  'A substantive-content (G17) failure forces a rewrite before publishing; no manual override.'
              )
            );
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
        const wantsImg = args.image !== undefined || args.featured_media !== undefined;
        if (
          args.sync_db !== false &&
          (args.title !== undefined || args.seo_meta_title !== undefined || args.seo_meta_description !== undefined || wantsImg)
        ) {
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
        // featured image → articles.featured_image. Without this the DB keeps a NULL cover
        // while WP is correct, so the 公众号 cover gate (G20) sees an empty cover on a live
        // post and refuses the article — the ai-marketing-roi-measurement case.
        if (args.sync_db !== false && wantsImg && args.image) {
          if (!connection) connection = await t.db.createConnection();
          let row = dbRow;
          if (!row) {
            const [rows] = await connection.query(
              'SELECT id, slug, lang FROM tengence_geo_articles WHERE wp_post_id = ? AND app_id = ? LIMIT 1',
              [postId, appId]
            );
            row = rows[0] || null;
          }
          if (row) {
            await t.articleState.repo.updateFeaturedImage(connection, appId, row.slug, row.lang, args.image);
            dbMirrored.featured_image = args.image;
            dbMirrored.featured_image_lang = row.lang;
          } else {
            dbMirrored.warning = (dbMirrored.warning ? dbMirrored.warning + '; ' : '') + 'no DB row matched this post; featured_image not mirrored';
          }
        }

        return ok({
          ok: true,
          wp_post_id: postId,
          cover_preflight: coverPreflight || undefined,
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
    description: 'Article plan table list (state/batch/lang filters). Every row carries the DERIVED ' +
      'lifecycle `state` (todo|paused|written|queued|published) plus the raw `plan_status` mirror. ' +
      'Each language is its own row (zh-hans | en | zh-hant); pass lang to inspect one language only.',
    inputSchema: z.object({
      site: siteField,
      state: z.string().optional().describe('derived state filter: todo|paused|written|queued|published'),
      status: z.string().optional().describe('raw plan_status mirror filter (prefer `state`)'),
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
        const appId = parseInt(process.env.APP_ID || S.env.APP_ID || '1', 10);
        // One pass over article-state gives the derived state for every row; filtering
        // on the plan_status mirror is what made callers see `published` for drafts.
        const states = await t.articleState.list({ appId, limit: 5000 });
        const byKey = new Map(states.map((r) => [`${r.slug}::${r.lang}`, r]));
        const rows = await t.plan.list({
          status: args.status || undefined,
          batch: args.batch || undefined,
          lang: args.lang ? langNorm(args.lang) : undefined,
          limit: 5000,
        });
        const enriched = rows.map((r) => {
          const key = `${r.slug}::${langNorm(r.lang || 'zh-hans')}`;
          const st = byKey.get(key);
          return {
            ...r,
            state: st ? st.state : null,
            articlesStatus: st ? st.articleStatus : null,
            featuredImage: st ? st.featuredImage : null,
            stateDrifted: Boolean(st && st.state !== r.plan_status),
          };
        });
        const filtered = args.state
          ? enriched.filter((r) => r.state === String(args.state).toLowerCase())
          : enriched;
        const out = filtered.slice(0, args.limit || 100);
        return ok({ ok: true, count: out.length, rows: out });
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
        focus_keyword: z.string().optional().describe('per-language focus keyword (zh-hans / en / zh-hant rows each carry their own)'),
        publish_order: z.number().optional().describe('queue position; translations share the source value to publish together'),
        publish_batch: z.number().optional(),
        category: z.string().optional(),
        tags: z.array(z.string()).optional(),
        matrix_code: z.string().optional().describe('matrix code, e.g. A01'),
        hub_cluster: z.string().optional().describe('topic cluster letter, e.g. A'),
        keyword_volume: z.number().optional().describe('monthly search volume (null when unknown)'),
        keyword_competition: z.string().optional().describe('low | medium | high (or 低/中/高)'),
        search_intent: z.string().optional().describe('informational | commercial | transactional | comparison shorthands'),
        content_type: z.string().optional().describe('guide | playbook | analysis | listicle | comparison | definition | case-study | review'),
        target_word_count: z.number().optional().describe('planned word count for the EN master'),
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
    description:
      'Set one article lifecycle state through the single status entry (article-state).\n' +
      '  todo | paused   → legal only while no article row exists (pre-writing hold)\n' +
      '  written         → article row, draft, no wp_post_id\n' +
      '  queued          → article row, draft, wp_post_id set (draft pushed)\n' +
      '  published       → article row, status=publish (+ wp_post_id)\n' +
      'Illegal transitions are rejected by name (E_INVALID_TRANSITION / E_LANG_REQUIRED).',
    inputSchema: z.object({
      slug: z.string().describe('article slug'),
      status: z.string().describe('target state: todo | paused | written | queued | published'),
      lang: z.string().optional().describe('language row to write (zh-hans|en|zh-hant); default zh-hans — never slug-wide'),
      wp_post_id: z.number().optional().describe('WP post id to mirror (required for queued/published)'),
      site: siteField,
    }),
    async run(args) {
      if (!args.slug || !args.status) {
        return fail(new Error('plan_mark_status requires slug + status'));
      }
      try {
        const S = withSite(args);
        process.env.APP_ID = process.env.APP_ID || S.env.APP_ID || '1';
        const lang = langNorm(args.lang || 'zh-hans');
        const res = await t.articleState.setState({
          appId: parseInt(process.env.APP_ID || S.env.APP_ID || '1', 10),
          slug: args.slug,
          lang,
          to: args.status,
          wpPostId: args.wp_post_id === undefined ? null : args.wp_post_id,
        });
        return ok({ ok: true, result: res });
      } catch (e) {
        return fail(e);
      }
    },
  },

  {
    name: 'article_state_read',
    title: '读取文章状态',
    description:
      'THE single read entry for an article lifecycle state. Returns the DERIVED state ' +
      '(todo|paused|written|queued|published) together with the article-row facts it came from ' +
      '(articleStatus / wpPostId / featuredImage) and the raw plan_status mirror. ' +
      'Use this instead of reading plan_status or articles.status directly.',
    inputSchema: z.object({
      slug: z.string().describe('article slug'),
      lang: z.string().describe('zh-hans | en | zh-hant (required — a slug has one row per language)'),
      site: siteField,
    }),
    async run(args) {
      try {
        const S = withSite(args);
        process.env.APP_ID = process.env.APP_ID || S.env.APP_ID || '1';
        const e = langReject(args.lang);
        if (e) return fail(new Error(`article_state_read: ${e}`));
        if (!args.slug) return fail(new Error('article_state_read requires slug'));
        const state = await t.articleState.read({
          appId: parseInt(process.env.APP_ID || S.env.APP_ID || '1', 10),
          slug: args.slug,
          lang: langNorm(args.lang),
        });
        if (!state) return fail(new Error(`article_state_read: not found ${args.slug} (${args.lang})`));
        return ok({ ok: true, state });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'article_state_audit',
    title: '文章状态审计',
    description:
      'Cross-table status audit: drift (plan mirror disagrees with the article row), ' +
      'fkMismatch (plan.article_id points at another language\'s article), dangling (plan claims ' +
      'published/queued with no article row), missingCover. Read-only unless repair=true.',
    inputSchema: z.object({
      repair: z.boolean().optional().describe('true = write the fixes (plan mirror + article_id links); default false = read-only'),
      dryRun: z.boolean().optional().describe('inverse convenience flag: dryRun=false behaves like repair=true'),
      site: siteField,
    }),
    async run(args) {
      try {
        const S = withSite(args);
        process.env.APP_ID = process.env.APP_ID || S.env.APP_ID || '1';
        const repair = args.repair === true || args.dryRun === false;
        const report = await t.articleState.audit({
          appId: parseInt(process.env.APP_ID || S.env.APP_ID || '1', 10),
          fix: repair,
          dryRun: !repair,
        });
        return ok({ ok: true, report });
      } catch (e) {
        return fail(e);
      }
    },
  },

  // ---------- state: WordPress truth ----------
  {
    name: 'state_reconcile_wp',
    title: '按 WordPress 真值对账',
    description:
      'Bring the DB back in line with the LIVE WordPress post statuses.\n' +
      'article_state_audit only compares the plan mirror against the article row, so a state that is ' +
      'wrong in BOTH columns is invisible to it; only WordPress can settle that. This tool reads every ' +
      'post (publish/future/private/draft/pending), matches each plan row against the post of ITS OWN ' +
      'language (article.wp_post_id first, plan.wp_post_id second, slug|lang last), then rewrites ' +
      'articles.status, articles.published_at (= the real WP post date, never the moment we ran), ' +
      'plan.wp_post_id, plan.published_at and the plan_status mirror through article-state.\n' +
      'Upgrades are applied; a downgrade (DB says published, WordPress says draft) is only REPORTED ' +
      'unless allow_downgrade=true. dry_run defaults to TRUE.',
    inputSchema: z.object({
      dry_run: z.boolean().optional().describe('default true = report only; pass false to write'),
      allow_downgrade: z.boolean().optional().describe('default false; true applies published→queued when WP says draft'),
      repair_pointers: z
        .boolean()
        .optional()
        .describe(
          'default false. When a row points at ANOTHER language\'s post, rewrite plan.wp_post_id / ' +
            'articles.wp_post_id to the row\'s own post, or 0 when that language has no post. Reported as ' +
            'lang_mismatch either way; opt in only when you mean it — this decides which post a publish flips.'
        ),
      site: siteField,
    }),
    async run(args) {
      try {
        const S = withSite(args);
        process.env.APP_ID = process.env.APP_ID || S.env.APP_ID || '1';
        const siteKey = S.siteKey || S.key;
        const posts = [];
        for (const status of ['publish', 'future', 'draft', 'pending', 'private']) {
          const batch = await t.wp.posts.list({ status, _fields: 'id,slug,status,link,date' }, { siteKey });
          if (Array.isArray(batch)) posts.push(...batch);
        }
        if (!posts.length) {
          return fail(new Error('state_reconcile_wp: WordPress returned 0 posts — refusing to reconcile on empty platform data'));
        }
        const report = await t.articleState.reconcileWithWp({
          appId: parseInt(process.env.APP_ID || S.env.APP_ID || '1', 10),
          wpPosts: posts,
          dryRun: args.dry_run !== false,
          allowDowngrade: args.allow_downgrade === true,
          repairPointers: args.repair_pointers === true,
        });
        return ok({ ok: true, wp_posts: posts.length, report });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'wp_post_trash',
    title: '移入回收站 WP 文章',
    description:
      'Trash (status=trash) a WordPress post — the reversible way to clear a duplicate draft. ' +
      'Refuses to touch a post that is currently `publish` (that would take a live article down); ' +
      'pass dry_run=true to preview, force_other_status=true only for a deliberate exception.',
    inputSchema: z.object({
      wp_post_id: z.number().describe('WordPress post ID to trash'),
      dry_run: z.boolean().optional().describe('default true = read the status and report, write nothing'),
      force_other_status: z.boolean().optional().describe('allow trashing a post whose current status is not draft/pending/future/private'),
      site: siteField,
    }),
    async run(args) {
      if (!args.wp_post_id) return fail(new Error('wp_post_trash requires wp_post_id'));
      try {
        const S = withSite(args);
        const siteKey = S.siteKey || S.key;
        const before = await t.wp.posts.get(Number(args.wp_post_id), '?_fields=id,slug,status,date,link', { siteKey });
        if (!before || !before.id) return fail(new Error(`wp_post_trash: post ${args.wp_post_id} not found`));
        const st = String(before.status || '').toLowerCase();
        const safe = ['draft', 'pending', 'future', 'private'].includes(st);
        if (!safe && args.force_other_status !== true) {
          return fail(new Error(`wp_post_trash: post ${before.id} (${before.slug}) is "${st}" — refusing to trash it (force_other_status=true to override)`));
        }
        if (args.dry_run !== false) {
          return ok({ ok: true, dry_run: true, post_id: before.id, slug: before.slug, status: st, would: 'trash' });
        }
        let via = 'status';
        try {
          await t.wp.posts.update(Number(args.wp_post_id), { status: 'trash' }, { siteKey });
        } catch (e) {
          // The multilingual plugin narrows the writable status enum to
          // publish/future/draft/pending/private, so status=trash is a 400 here.
          // The REST trash endpoint (DELETE, force=false) is the real way.
          if (!/rest_invalid_param|not_in_enum|无效参数/i.test(e.message || '')) throw e;
          await t.wp.posts.remove(Number(args.wp_post_id), { siteKey });
          via = 'delete';
        }
        let after = null;
        try {
          after = await t.wp.posts.get(Number(args.wp_post_id), '?_fields=id,slug,status,link', { siteKey });
        } catch (e) {
          after = null; // trashed posts are not readable through the posts endpoint
        }
        return ok({
          ok: true,
          post_id: before.id,
          slug: before.slug,
          from: st,
          to: (after && after.status) || 'trash',
          via,
        });
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
      const r = await runCliAsync('image-acquire', cliArgs);
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
          // 默认保序：slugs 来自 publish_order 升序的候选队列，重排会让头条变成
          // "最近发布的那篇"（历史 bug）。只有显式 keepOrder:false 才按发布时间重排。
          keepOrder: args.keepOrder !== false,
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
              // r.published is the platform's own answer — true means the platform
              // really went live (devto since 2026-10-12), so it must win over the
              // manual-call default asDraft=true (2026-11-27: a live dev.to post was
              // recorded as `draft`, hiding it from the published audit).
              const status = !r.ok
                ? 'failed'
                : r.published === false
                  ? 'draft'
                  : r.published === true || (wentLive && !r.publishGated)
                    ? 'published'
                    : 'draft';
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
                error: r.ok ? null : r.error || (r.detail && (r.detail.err || r.detail.error || r.detail.message)) || r.stage,
                stage: r.ok ? null : r.stage || (r.detail && r.detail.stage),
                context: r.ok ? null : r.context || (r.detail && r.detail.context),
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
      'Move a channel_plan row to another status through the single status entry (channel-state). ' +
      'Legal moves only: todo→draft|reviewing|failed|paused|deleted, draft→published|reviewing|failed|paused|deleted, ' +
      'reviewing→published|review_failed|failed|paused|deleted, failed/review_failed→todo|paused|deleted, paused→todo|deleted, ' +
      'deleted→todo. `published` is terminal. deleted / review_failed / deleted→todo require `reason`.',
    inputSchema: z.object({
      id: z.number().describe('channel_plan row id (see channel_plan_next rows)'),
      status: z
        .enum(['todo', 'draft', 'reviewing', 'published', 'failed', 'review_failed', 'paused', 'deleted'])
        .describe('target status'),
      draftIds: z
        .array(z.string())
        .optional()
        .describe('draft/media ids to record (e.g. wechat media_id); omit to keep existing'),
      reason: z
        .string()
        .optional()
        .describe('why the row moves; REQUIRED for deleted / review_failed / reviving deleted→todo'),
      force: z
        .boolean()
        .optional()
        .describe('bypass the transition table (only for a reconcile-driven correction; reason becomes required)'),
      site: siteField,
    }),
    async run(args) {
      try {
        const S = withSite(args);
        const ch = t.plan.channel;
        const updated = await ch.markStatus(args.id, args.status, args.draftIds, {
          reason: args.reason || null,
          force: args.force === true,
        });
        const row = await ch.get(args.id);
        return ok({ ok: true, updated, row });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'channel_state_audit',
    title: '渠道状态审计',
    description:
      'Consistency report for tengence_geo_channel_plan: invalidStatus (a value outside the vocabulary), ' +
      'draftWithoutMedia (a wechat draft row with no media_id), publishedWithoutMedia, ' +
      'queueWithMedia (a todo/failed row still carrying a platform id), draftWithoutPeriod. ' +
      'Read-only; fix=true only normalises an unknown status to `failed` with a note (nothing else is guessed).',
    inputSchema: z.object({
      platform: z.string().optional().describe('limit the audit to one platform (default: all)'),
      fix: z.boolean().optional().describe('true = write the safe subset of fixes (default false)'),
      dryRun: z.boolean().optional().describe('inverse convenience flag: dryRun=false behaves like fix=true'),
      site: siteField,
    }),
    async run(args) {
      try {
        const S = withSite(args);
        process.env.APP_ID = process.env.APP_ID || S.env.APP_ID || '1';
        const fix = args.fix === true || args.dryRun === false;
        const report = await t.channelState.audit({
          appId: parseInt(process.env.APP_ID || S.env.APP_ID || '1', 10),
          platform: args.platform || null,
          fix,
          dryRun: !fix,
        });
        return ok({ ok: true, report });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'plan_order_audit',
    title: '发布顺序审计',
    description:
      'Audit tengence_geo_article_plan.publish_order: nonNumeric (a text value in an integer column), ' +
      'zeroOrder (never assigned), crossLangMismatch (a slug\'s language rows disagree), ' +
      'crossSlugDuplicate (two articles share a number). Read-only — use plan_order_repair to fix.',
    inputSchema: z.object({ site: siteField }),
    async run(args) {
      try {
        const S = withSite(args);
        process.env.APP_ID = process.env.APP_ID || S.env.APP_ID || '1';
        const appId = parseInt(process.env.APP_ID || S.env.APP_ID || '1', 10);
        const report = await t.db.withConn((conn) => t.plan.order.audit({ appId, conn }));
        return ok({ ok: true, report });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'plan_order_repair',
    title: '发布顺序修复',
    description:
      'Normalise publish_order: text/0 values get a fresh tail number (in row-id order, so the history ' +
      'sequence is preserved), every language row follows its zh-hans row, and residual collisions are broken ' +
      'by moving the later article to the tail. Dry-run by default; pass apply=true to write.',
    inputSchema: z.object({
      apply: z.boolean().optional().describe('true = write the changes (default false = dry run)'),
      site: siteField,
    }),
    async run(args) {
      try {
        const S = withSite(args);
        process.env.APP_ID = process.env.APP_ID || S.env.APP_ID || '1';
        const appId = parseInt(process.env.APP_ID || S.env.APP_ID || '1', 10);
        const report = await t.db.withConn((conn) =>
          t.plan.order.repair({ appId, apply: args.apply === true, conn })
        );
        return ok({ ok: true, report });
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
    name: 'channel_plan_status',
    title: '渠道发布状态/错误查询',
    description:
      'Query channel_plan publishing-task rows with their OUTCOME + FAILURE DETAIL (read-only). Returns, per row: ' +
      'status, error_code, error_message, error_stage, error_detail, error_context, error_raw, failed_at, draft_ids, ' +
      'article_id, notes, updated_at. Use this to find WHY a dispatch failed — e.g. Juejin returns err_no/err_msg — ' +
      'instead of the generic "publishToChannel returned not-ok" that the live publish log used to swallow. ' +
      'Filter by platform / slug / status / lang; limit caps rows (default 50, ascending by id).',
    inputSchema: z.object({
      platform: z.string().optional().describe('filter to one platform (juejin / csdn / aliyun / tencent / devto / wechat)'),
      slug: z.string().optional().describe('filter to one article slug (exact match, filtered in SQL)'),
      status: z.string().optional().describe('filter by status: failed | published | draft | reviewing | review_failed | deleted | todo | paused'),
      lang: z.string().optional().describe('language filter (default zh-hans; devto=en)'),
      limit: z.number().optional().describe('max rows (default 50)'),
      site: siteField,
    }),
    async run(args) {
      try {
        const appId = Number(process.env.APP_ID || 1);
        // slug is filtered in SQL (db/channel-plan.js list) so LIMIT cannot truncate
        // the result set before the slug match.
        const rows = await t.db.withConn(async (conn) =>
          t.db.channelPlan.list(conn, appId, {
            platform: args.platform,
            status: args.status,
            lang: args.lang,
            slug: args.slug,
            limit: args.limit || 50,
          })
        );
        return ok({
          ok: true,
          count: rows.length,
          rows: rows.map((r) => ({
            id: r.id,
            platform: r.platform,
            slug: r.slug,
            lang: r.lang,
            status: r.status,
            draft_ids: r.draft_ids,
            article_id: r.article_id,
            error_code: r.error_code || null,
            error_message: r.error_message || null,
            error_stage: r.error_stage || null,
            error_detail: r.error_detail || null,
            error_context: r.error_context || null,
            error_raw: r.error_raw || null,
            failed_at: r.failed_at || null,
            notes: r.notes || null,
            updated_at: r.updated_at || null,
          })),
        });
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
      'real outcomes, so each platform keeps its own calendar). Pass map[] of {slug, lang?, title?, articleId?} for the ' +
      'explicitly-known published articles (recommended — avoids API rate limits); the platform article id (e.g. the Juejin ' +
      'post id) is recorded on the row when known, so the local calendar can deep-link without re-querying the platform. ' +
      'Omit map to live-read the platform ' +
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
            articleId: z.string().optional().describe('platform article id to record (e.g. Juejin post id); kept as string'),
            draftId: z.string().optional().describe('platform draft id (optional)'),
            notes: z.string().optional(),
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
      '(publish_time within ±45 minutes — one hour of margin against tick drift, since the hourly tick has been observed ' +
      'drifting to 61–65 minutes) and has NOT run today ' +
      '(last_run_at). Per slot: picks the next N un-dispatched articles (nextDue, N = slot count), publishes through the same ' +
      'pipeline as channel_publish (juejin/csdn/devto publish for real; wechat stays DRAFT-BOX — 原创声明/赞赏 cannot be set via ' +
      'any WeChat API and need a manual toggle before sending), writes the outcome back to channel_plan and stamps last_run_at. ' +
      'dryRun=true prints the due plan with NO external calls and NO writes. Call this from ONE external ticker (cron/launchd ' +
      'every 30 min) — do NOT create one scheduled task per channel. The report carries stale_slots/alerts: slots whose ' +
      'window closed >2h ago without running today (a silent miss for the day).',
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

        // 2026-11-20 — dry_run 必须真的只读：此前 create_terms=true 时预览阶段也会
        // POST /tags 建出真实 term（实测 dry run 建了 agentic-ai），违反"预览不写"，
        // 还会把词表缓存弄脏。预览时只解析、把需要新建的 slug 报在 would_create 里。
        const create = args.create_terms === true && args.dry_run !== true;
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
            // 预览时不会真的建词，把"真跑会新建哪些"如实报出来
            would_create: {
              categories: args.create_terms && catRes ? catRes.unknown : [],
              tags: args.create_terms && tagRes ? tagRes.unknown : [],
            },
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
      '读微信后台真实状态并对账 channel_plan（只查 draft 行）：media_id 仍在草稿箱 → 保持 draft（缺 id 则回填）；' +
      '标题命中发表记录 → 升级 published + article_id；草稿箱与发表记录都没有 → 判 deleted（终态，永不自动重发，' +
      '需人工改回 todo 才会重发）；ambiguous 只报告不写。published 行永不降级，抓取失败则整平台零写入。' +
      'dryRun=true 只出报告不写库。返回 kept / backfilled / upgraded / deleted / notable 五类明细。',
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
        // capture titles first — a mass send consumes the draft message
        let draftTitles = [];
        try {
          const drafts = await t.syndicate.wechat.listDrafts();
          const hit = drafts.find((d) => d.media_id === args.media_id);
          draftTitles = (hit && hit.titles) || [];
        } catch (_) {
          draftTitles = [];
        }
        const result = await t.syndicate.wechat.massSend(args.media_id, {
          tagId: args.tag_id,
          toUsers: args.to_users,
          clientMsgId: args.client_msg_id,
        });
        // mass-send = 已推给粉丝 → the issue is published, not a draft (2026-11-13)
        let statusUpdated = null;
        try {
          statusUpdated = await t.plan.channel.recordWechatPublished({
            mediaId: args.media_id,
            titles: draftTitles,
          });
        } catch (e) {
          statusUpdated = { ok: false, error: e.message };
        }
        return ok({ ok: true, ...result, statusUpdated });
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
        const wechat = t.syndicate.wechat;
        // Titles MUST be captured before the publish: freepublish consumes the draft,
        // so afterwards the media_id can no longer be resolved to articles (2026-11-13).
        let draftTitles = [];
        try {
          const drafts = await wechat.listDrafts();
          const hit = drafts.find((d) => d.media_id === args.media_id);
          draftTitles = (hit && hit.titles) || [];
        } catch (_) {
          draftTitles = [];
        }
        let result;
        try {
          result = await wechat.publishDraftByMediaId(args.media_id, { dryRun: !!args.dryRun });
        } catch (pubErr) {
          if (!args.dryRun) {
            try {
              await t.plan.channel.recordWechatPublished({ mediaId: args.media_id, titles: draftTitles, status: 'failed' });
            } catch (_) { /* best effort — never mask the real publish error */ }
          }
          throw pubErr;
        }
        // write back channel_plan: the row must stop claiming "draft" once it is live
        let statusUpdated = null;
        if (!args.dryRun) {
          try {
            statusUpdated = await t.plan.channel.recordWechatPublished({
              mediaId: result.mediaId || args.media_id,
              articleId: result.articleId || null,
              titles: draftTitles,
            });
          } catch (e) {
            statusUpdated = { ok: false, error: e.message };
          }
        }
        return ok({ ok: true, ...result, statusUpdated });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'wechat_issue_preview',
    title: '微信本期选题预筛',
    description:
      '只读预览微信这一期会发哪几篇：按「已登记 todo 优先 → blog publish_order」取有序候选，逐篇跑 G17/G18/G19 闸门，' +
      'PASS 的进 ready（凑满 perIssue 即停），FAIL 的进 needsRepair（不丢弃，供按渠道改写后再发）。零写入，可反复调用。' +
      'perIssue 优先级：参数 > schedule.count > 环境变量 WECHAT_PER_ISSUE > 3。',
    inputSchema: z.object({
      perIssue: z.number().optional().describe('本期几篇（默认 3，见优先级说明）'),
      limit: z.number().optional().describe('最多考察几篇候选（默认 8）'),
      site: siteField,
    }),
    async run(args) {
      try {
        const site = withSite(args);
        const ch = t.plan.channel;
        const perIssue = ch.wechatIssue.resolvePerIssue({ perIssue: args.perIssue });
        const cap = args.limit || ch.wechatIssue.DEFAULT_MAX_CANDIDATES;
        const candidates = await ch.wechatIssueCandidates({ limit: cap });
        const assembled = await ch.wechatIssue.assembleIssue({
          candidates,
          perIssue,
          maxCandidates: cap,
          check: async (slug) => {
            // 有渠道改写稿时校验改写稿 —— 修好的文章才能算"可发"
            const rw = t.syndicate.wechat.readRewrittenExport(site.siteDir, slug);
            const r = await t.check.checkArticle({
              slug,
              lang: 'zh-hans',
              site: site.siteKey,
              overrides: rw ? { title: rw.title, contentMd: rw.contentMd } : null,
            });
            const failures = gateFailures(r);
            if (r.ok) {
              // G20 封面体检：闸门只看 featured_image 字段是否为空，字段有值但 URL 404
              // 的稿子会一路过门、到建稿下载封面才炸（本期 ai-marketing 就是这么卡的）。
              let cover = '';
              await t.db.withConn(async (conn) => {
                const d = await t.db.articles.getDetail(conn, process.env.APP_ID || '1', slug, 'zh-hans');
                cover = (d && d.featured_image) || '';
              });
              const probe = await t.syndicate.wechat.probeCoverUrl(cover);
              if (!probe.ok) return { ok: false, failures: [`封面不可用（G20）: ${probe.reason}`] };
            }
            return { ok: !!r.ok, failures };
          },
        });
        return ok({ ok: true, perIssue, candidates, ...assembled });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'wechat_rewrite_packet',
    title: '微信改写工单',
    description:
      '给"闸门没过、但决定要发"的文章出一份改写工单：原文 markdown + 失败项（G17/G18/G19 具体哪几项）+ 微信渠道改写规则。' +
      '改写完成后用 channel_check(platform=wechat) 复检，再走 wechat_issue_publish 的 articles[] 建稿。只读，不生成内容。',
    inputSchema: z.object({
      slug: z.string().describe('article slug'),
      lang: z.string().optional().describe('language (default zh-hans)'),
      site: siteField,
    }),
    async run(args) {
      try {
        const site = withSite(args);
        const lang = args.lang || 'zh-hans';
        let detail = null;
        await t.db.withConn(async (conn) => {
          detail = await t.db.articles.getDetail(conn, process.env.APP_ID || '1', args.slug, lang);
        });
        if (!detail) return fail(new Error(`Article not found: ${args.slug} (${lang})`));
        const report = await t.check.checkArticle({ slug: args.slug, lang, site: site.siteKey });
        const plat = t.syndicate.registry.getPlatform('wechat');
        const existing = t.syndicate.wechat.readRewrittenExport(site.siteDir, args.slug);
        return ok({
          ok: true,
          slug: args.slug,
          lang,
          title: detail.title,
          contentMd: detail.content_longtext || '',
          gate: { ok: !!report.ok, failures: gateFailures(report) },
          rewriteRules: plat ? plat.rewrite : null,
          existingRewritten: existing ? { title: existing.title, path: existing.path } : null,
        });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'wechat_issue_publish',
    title: '微信建一期（N 篇一条图文）',
    description:
      '按「每期 N 篇（默认 3）」建 ONE 图文消息。两条路：① slugs[] → 先逐篇跑闸门、凑满 perIssue 篇合格稿再建（' +
      '不合格的回报在 needsRepair，不会被判死）；② articles[]（改写稿 {slug,title,contentMd}）→ 直接建稿，用于把闸门' +
      '不过的文章按渠道规则改写后发出去。成功后写 channel_plan（published/draft + media_id + 期号）。dryRun 只预览。',
    inputSchema: z.object({
      perIssue: z.number().optional().describe('本期几篇（默认 3）'),
      slugs: z.array(z.string()).optional().describe('Mode A：按这些 slug 建稿（会先跑闸门凑满）'),
      articles: z
        .array(
          z.object({
            slug: z.string(),
            title: z.string(),
            contentMd: z.string(),
            summary: z.string().optional(),
          })
        )
        .optional()
        .describe('Mode B：改写稿（每篇一项）'),
      keepOrder: z.boolean().optional().describe('true = 按传入顺序（第一篇为头条）'),
      dryRun: z.boolean().optional().describe('只预览，不建稿'),
      site: siteField,
    }),
    async run(args) {
      try {
        const site = withSite(args);
        const ch = t.plan.channel;
        const perIssue = ch.wechatIssue.resolvePerIssue({ perIssue: args.perIssue });
        const rewritten = Array.isArray(args.articles) ? args.articles : [];
        const slugsIn = Array.isArray(args.slugs) ? args.slugs : [];
        if (rewritten.length && slugsIn.length) return fail(new Error('wechat_issue_publish accepts slugs[] or articles[], not both'));

        if (rewritten.length) {
          for (const a of rewritten) {
            if (!a.slug || !a.title || !a.contentMd) return fail(new Error('articles[] requires slug/title/contentMd'));
          }
          const res = await t.syndicate.wechat.publishRewrittenToWechat({
            articles: rewritten,
            siteKey: site.siteKey,
            dryRun: !!args.dryRun,
          });
          return ok({ ok: true, mode: 'rewritten', perIssue, actualCount: rewritten.length, ...res });
        }

        const cap = Math.max(perIssue, 8);
        const candidates = slugsIn.length
          ? slugsIn.map((slug, i) => ({ slug, order: i + 1 }))
          : await ch.wechatIssueCandidates({ limit: cap });
        const assembled = await ch.wechatIssue.assembleIssue({
          candidates,
          perIssue,
          maxCandidates: cap,
          check: async (slug) => {
            // 有渠道改写稿时校验改写稿 —— 修好的文章才能算"可发"
            const rw = t.syndicate.wechat.readRewrittenExport(site.siteDir, slug);
            const r = await t.check.checkArticle({
              slug,
              lang: 'zh-hans',
              site: site.siteKey,
              overrides: rw ? { title: rw.title, contentMd: rw.contentMd } : null,
            });
            return { ok: !!r.ok, failures: gateFailures(r) };
          },
        });
        if (!assembled.ready.length) {
          return ok({ ok: false, reason: 'no gate-passing candidate', assembled });
        }
        const res = await t.syndicate.channel.publishToChannel({
          platform: 'wechat',
          slugs: assembled.ready.map((x) => x.slug),
          asDraft: true,
          // 顺序即语义：assembleIssue 的 ready 是按 publish_order 升序排好的（历史发布顺序），
          // 头条必须是队列里最早的一篇。默认保序，只有显式 keepOrder:false 才交给
          // syncWechat 按发布时间新→旧重排。
          keepOrder: args.keepOrder !== false,
          dryRun: !!args.dryRun,
          siteKey: site.siteKey,
        });
        const mediaId = (res.refs && res.refs.mediaId) || null;
        if (!args.dryRun && res.ok && mediaId) {
          try {
            await ch.recordWechatIssueCreated({
              slugs: assembled.ready.map((x) => x.slug),
              mediaId,
              notes: `auto-assembled ${assembled.ready.length}/${perIssue} 篇（闸门预筛）`,
            });
          } catch (e) {
            console.warn('[wechat_issue_publish] recordWechatIssueCreated failed:', e.message);
          }
        }
        return ok({ ok: !!res.ok, perIssue, actualCount: assembled.ready.length, assembled, ...res });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'wechat_draft_delete',
    title: '删除公众号草稿',
    description:
      '删除草稿箱里的一条消息（draft/delete）。与 wechat_article_delete（freepublish/delete，只能删已发布）不同。' +
      'IRREVERSIBLE —— 先确认 media_id（见 wechat_status drafts），带 confirm:"YES" 才真删；dryRun 只打印载荷。',
    inputSchema: z.object({
      media_id: z.string().describe('draft box media_id'),
      confirm: z.enum(['YES']).optional().describe('必须为 YES 才真删'),
      dryRun: z.boolean().optional().describe('只打印载荷不删除'),
      site: siteField,
    }),
    async run(args) {
      try {
        const site = withSite(args);
        const res = await t.syndicate.wechat.deleteDraft(args.media_id, {
          dryRun: !!args.dryRun || args.confirm !== 'YES',
          siteKey: site.siteKey,
        });
        return ok({ ok: true, ...res });
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
    match: /^(article_list|article_draft|article_ingest|article_export|article_terms_sync|article_links_audit|article_links_fix|article_research_sync|article_state_read|article_state_audit|state_reconcile_wp|check_article|check_translation|translation_glossary_get|wp_post_get|wp_post_trash)/,
  },
  { group: 'Generic content (any post type)', match: /^content_/ },
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
