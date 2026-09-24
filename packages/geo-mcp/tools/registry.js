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
const { z } = require('zod');
const t = require('@tengence/geo-sdk');

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

function fail(err) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }, null, 2) }],
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

const tools = [
  // ---------- workspace ----------
  {
    name: 'workspace_use',
    description:
      'Bind the user workspace directory (call this first): all site config, credentials and output files live under it. Ask the user which directory to use if it was not mentioned; `~` is supported and expanded here.',
    inputSchema: z.object({
      path: z.string().describe('absolute directory path chosen by the user (e.g. ~/my-geo-workspace)'),
      create: z.boolean().optional().describe('create the directory when missing (default false)'),
    }),
    async run(args) {
      try {
        return ok(t.workspace.use(args.path, { create: !!args.create }));
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'site_init',
    description:
      'Scaffold a site inside the bound workspace: <workspace>/<key>/{config,data/inbox,data/reports,.env} (idempotent, never overwrites existing files)',
    inputSchema: z.object({
      key: z.string().describe('site key (lowercase letters, digits, underscore)'),
      domain: z.string().optional().describe('canonical domain, defaults to the key'),
      name: z.string().optional().describe('display name, defaults to the domain'),
      lang: z.string().optional().describe('default language (default zh-CN)'),
    }),
    async run(args) {
      try {
        t.workspace.require();
        return ok(t.site.initSite(args));
      } catch (e) {
        return fail(e);
      }
    },
  },

  // ---------- site ----------
  {
    name: 'site_list',
    description:
      'List the sites inside the bound user workspace (site key, domain, app_id, storage driver). Returns a hint instead when no workspace is bound yet.',
    inputSchema: z.object({}),
    async run() {
      const bound = t.workspace.current();
      if (!bound) {
        return ok({
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
      return ok({ ok: true, bound: true, workspace: bound, sites, sites_root: t.site.SITES_ROOT });
    },
  },
  {
    name: 'site_status',
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
    description: 'List articles (articles table), with status/limit filters',
    inputSchema: z.object({
      site: siteField,
      status: z.string().optional().describe('draft|queued|published etc. (optional)'),
      limit: z.number().optional().describe('max rows (default 50)'),
    }),
    async run(args) {
      try {
        const S = withSite(args);
        const appId = parseInt(process.env.APP_ID || S.env.APP_ID || '1', 10);
        const rows = await t.db.withConn((conn) =>
          t.db.articles.list(conn, appId, {
            status: args.status || undefined,
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
    name: 'article_ingest',
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
      const cliArgs = [args.slug, args.md_path, '--site', cliSite(args)];
      if (args.lang) cliArgs.push('--lang', args.lang);
      if (args.research_path) cliArgs.push('--research', args.research_path);
      const r = runCli('article-ingest', cliArgs);
      return ok({
        ok: r.code === 0,
        exit_code: r.code,
        output: r.stdout || r.stderr,
      });
    },
  },
  {
    name: 'article_export',
    description: 'Export an article md + brief from the DB to the site data/inbox (for rewriting)',
    inputSchema: z.object({
      slug: z.string().describe('article slug'),
      site: siteField,
    }),
    async run(args) {
      if (!args.slug) return fail(new Error('article_export requires slug'));
      const r = runCli('article-export', [args.slug, '--site', cliSite(args)]);
      return ok({ ok: r.code === 0, exit_code: r.code, output: r.stdout || r.stderr });
    },
  },

  // ---------- check ----------
  {
    name: 'check_article',
    description: 'Publish gate: enforces the editorial rules codified in the "article-writing-standards" standard (citation dual-channel, word count by T1–T7 type, banned words, the three GEO blocks — Summary / Key Takeaways / FAQ / Data Sources — and the research-brief hard check). Read that standard via standards_read before authoring, and run article_draft first to scaffold per-spec.',
    inputSchema: z.object({
      slug: z.string().describe('article slug'),
      site: siteField,
      type: z.string().optional().describe('T1..T7 (hard word-count check by type when declared)'),
    }),
    async run(args) {
      if (!args.slug) return fail(new Error('check_article requires slug'));
      try {
        const S = withSite(args);
        process.env.APP_ID = process.env.APP_ID || S.env.APP_ID || '1';
        const result = await t.check.checkArticle({
          slug: args.slug,
          type: args.type || null,
          site: S.siteKey,
        });
        return ok({ ok: result.ok, slug: result.slug, rows: result.rows, warns: result.warns });
      } catch (e) {
        return fail(e);
      }
    },
  },

  // ---------- publish ----------
  {
    name: 'publish_draft',
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
      return ok({ ok: r.code === 0, exit_code: r.code, output: r.stdout || r.stderr });
    },
  },
  {
    name: 'publish_from_db',
    description: 'Publish an article from the DB to WordPress (--force updates an existing article)',
    inputSchema: z.object({
      article_id: z.number().describe('articles.id'),
      site: siteField,
      status: z.string().optional().describe('draft|publish (default draft)'),
      force: z.boolean().optional().describe('force-update when it already exists'),
    }),
    async run(args) {
      if (!args.article_id) return fail(new Error('publish_from_db requires article_id'));
      const cliArgs = [String(args.article_id), '--site', cliSite(args)];
      if (args.status) cliArgs.push('--status', args.status);
      if (args.force) cliArgs.push('--force');
      const r = runCli('publish-from-db', cliArgs);
      return ok({ ok: r.code === 0, exit_code: r.code, output: r.stdout || r.stderr });
    },
  },
  {
    name: 'publish_update_article',
    description: 'Bypass update of an existing article (title/content/status + sync SEO/GEO meta). ' +
      'When meta_description is provided, runs meta-only mode: updates ONLY the article meta_description ' +
      '(DB seo.meta_description + WP seo_meta_description via the plugin API, 165–175 chars hard gate); ' +
      'body/title/status/excerpt are left untouched.',
    inputSchema: z.object({
      md_path: z.string().optional().describe('absolute path to the body Markdown (required for full update; omit in meta-only mode)'),
      meta_description: z.string().optional().describe('new meta_description (165–175 characters). Providing it switches to meta-only mode'),
      site: siteField,
      slug: z.string().optional().describe('target slug'),
      post_id: z.number().optional().describe('target WP post id (either slug or post_id)'),
    }),
    async run(args) {
      const cliArgs = [];
      if (args.meta_description) {
        if (!args.slug && !args.post_id) return fail(new Error('meta-only mode requires slug or post_id'));
        cliArgs.push('--meta-only', '--meta-desc', args.meta_description);
      } else {
        if (!args.md_path) return fail(new Error('publish_update_article requires md_path (or meta_description for meta-only mode)'));
        cliArgs.push(args.md_path);
      }
      cliArgs.push('--site', cliSite(args));
      if (args.slug) cliArgs.push('--slug', args.slug);
      if (args.post_id) cliArgs.push('--post-id', String(args.post_id));
      const r = runCli('publish-update-article', cliArgs);
      return ok({ ok: r.code === 0, exit_code: r.code, output: r.stdout || r.stderr });
    },
  },
  {
    name: 'publish_daily',
    description: 'Run the daily promotion task (promotes due drafts to publish by plan publish_order; default 1/day). ' +
      'Optional date sets the promoted article publish/modified time (YYYY-MM-DDTHH:MM:SS, site timezone).',
    inputSchema: z.object({
      site: siteField,
      date: z.string().optional().describe('publish/modified time for the promoted article, YYYY-MM-DDTHH:MM:SS in the site timezone; omit to leave WordPress untouched'),
    }),
    async run(args) {
      const cliArgs = ['--site', cliSite(args)];
      if (args.date) cliArgs.push('--date', args.date);
      const r = runCli('promote-daily', cliArgs);
      return ok({ ok: r.code === 0, exit_code: r.code, output: r.stdout || r.stderr });
    },
  },

  // ---------- plan ----------
  {
    name: 'plan_list',
    description: 'Article plan table list (status/batch/category/node filters)',
    inputSchema: z.object({
      site: siteField,
      status: z.string().optional().describe('todo|written|queued|published etc.'),
      batch: z.string().optional().describe('batch'),
      limit: z.number().optional().describe('max rows (default 100)'),
    }),
    async run(args) {
      try {
        const S = withSite(args);
        process.env.APP_ID = process.env.APP_ID || S.env.APP_ID || '1';
        const rows = await t.plan.list({
          status: args.status || undefined,
          batch: args.batch || undefined,
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
    description: 'Import/update the plan table from the site plan directory (idempotent)',
    inputSchema: z.object({
      site: siteField,
      file: z.string().optional().describe('absolute path to a plan file (default: scan the site plan directory)'),
    }),
    async run(args) {
      try {
        const S = withSite(args);
        const res = await t.plan.importPlan(S, { file: args.file || undefined });
        return ok({ ok: true, result: res });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'plan_mark_status',
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
    description: 'Run GEO monitoring (one round of site prompts × models; results persisted)',
    inputSchema: z.object({
      site: siteField,
      run_id: z.string().optional().describe('YYYYMMDD (default today)'),
      models: z.array(z.string()).optional().describe('subset of model keys'),
      layers: z.array(z.string()).optional().describe('subset of layers'),
    }),
    async run(args) {
      try {
        const S = withSite(args);
        const runId = args.run_id || new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const res = await t.monitor.run.runMonitor({
          site: S,
          runId,
          models: args.models,
          layers: args.layers,
        });
        return ok({ ok: true, run_id: runId, result: res });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'monitor_report',
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
        return ok({ ok: true, count: (results || []).length, results: results || [] });
      } catch (e) {
        return fail(e);
      }
    },
  },

  // ---------- db ----------
  {
    name: 'db_init',
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
    name: 'search_submit_gsc',
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
    description:
      'Full GEO/SEO site diagnosis: domain (DNS/TLS cert/WHOIS), transport & server fingerprint (CMS/framework/platform/CDN), robots.txt, sitemap, homepage + representative pages (meta, H1..H6 structure, JSON-LD, OG, images/alt, links, mixed content), performance and security checks. Bootstraps the site on first use (url → site key, dots → underscores).',
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
    }),
    async run(args) {
      if (!args.url) return fail(new Error('diagnose_site requires url'));
      try {
        useWorkspace(args);
        const res = await t.diagnose.runDiagnosis({
          url: args.url,
          siteKey: args.site ? resolveSiteKey(args) : undefined,
          extraPages: args.pages,
          maxPages: args.max_pages,
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'report_write',
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

  // ---------- util / diagnostics ----------
  {
    name: 'util_ping',
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

  // ---------- standards (writing & GEO requirements, consumed while authoring) ----------
  {
    name: 'standards_list',
    description:
      'List the generic writing & GEO standards shipped with the engine (titles, whether a site-specific supplement exists). ' +
      'Read one with standards_read before authoring an article; see article_draft for a ready-to-use brief.',
    inputSchema: z.object({}),
    async run() {
      try {
        return ok({ ok: true, standards: t.standards.listStandards() });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'standards_read',
    description:
      'Read a generic standard document (base + any site-specific supplement merged). Names are repository-relative without `.md`, ' +
      'e.g. "article-writing-standards", "content-strategy", "block-conventions", "templates/skeletons/howto", "templates/research-brief". ' +
      'This is the canonical way to pull the requirements an article must satisfy.',
    inputSchema: z.object({
      name: z.string().describe('standard name without .md, e.g. article-writing-standards'),
    }),
    async run(args) {
      if (!args.name) return fail(new Error('standards_read requires name'));
      try {
        const s = t.standards.readStandard(args.name);
        return ok({
          ok: true,
          name: s.name,
          has_supplement: s.hasSupplement,
          merged: s.merged,
        });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'article_draft',
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
        return ok(brief);
      } catch (e) {
        return fail(e);
      }
    },
  },
  // ---------- cross-platform channel ----------
  {
    name: 'channel_list',
    description:
      'List all external content platforms in the syndicate registry: API type (official|cookie|none), status (ready|pending|manual), ' +
      'capabilities (multi-article merge, per-platform limits, draft/cover/tags) and the full platform rewrite rules (styles). ' +
      'The rewrite rules are the HARNESS rewriting guide — the server never rewrites content: read the original via article_export, ' +
      'apply these rules yourself, then channel_publish to land the draft/export.',
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
    name: 'channel_publish',
    description:
      'Publish/export to one external platform. Mode A: pass slugs[] and the server reads the DB and runs the platform pipeline ' +
      '(wechat drafts box — preview in mp.weixin.qq.com before mass-sending; juejin draft; devto publish). Mode B: pass pre-written ' +
      'articles[] ({slug,title,contentMd,summary,tags,sourceUrl,cover}) — the harness-rewritten draft — and the server exports a publish ' +
      'package to <site>/data/channel-export/<platform>/<slug>.md with full front matter (manual publishing on every platform; ' +
      'required for api:none platforms). asDraft defaults true (never mass-sends).',
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
        return ok({ ok: result.ok, ...result });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'channel_plan_next',
    description:
      'Per-platform publishing calendar: return the next due issue for a platform (earliest row not published) plus all calendar rows ' +
      '(status/period/topic/weekday/slugs). The due issue slugs are what to prepare next (the wechat 12-period plan is already imported).',
    inputSchema: z.object({
      platform: z.string().optional().describe('filter rows to one platform (default: all platforms)'),
    }),
    async run(args) {
      try {
        const ch = t.plan.channel;
        const rows = await ch.list({ platform: args.platform });
        const next = args.platform ? await ch.nextDue(args.platform) : null;
        return ok({ ok: true, next, rows });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: 'channel_plan_mark',
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
  // ---------- wechat backend read-back & progress reconciliation ----------
  {
    name: 'wechat_status',
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
    name: 'wechat_sync_progress',
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
];

const registry = new Map(tools.map((tool) => [tool.name, tool]));

module.exports = { tools, registry };
