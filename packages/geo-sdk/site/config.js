/**
 * Site config loader (core of the multi-site abstraction)
 * ============================================================================
 * Storage layout (see also ../paths.js):
 *   - Internal runtime data : ~/.tengence/geo-mcp/      (DB / state / logs — never user content)
 *   - User workspace        : chosen by the user        (holds one directory per site)
 *
 * Conventions:
 *   - Workspace root  : *must be provided* — via setSitesRoot(), the SITES_ROOT env var
 *                       (absolute / `~` / relative to cwd), or the persisted state file.
 *                       Nothing here guesses a directory: there is no cwd-based
 *                       fallback, and no hard-coded default root.
 *   - Site root       : <workspace>/<site>/
 *   - Sensitive config: <site>/.env               (gitignore; copy .env.example and fill in values)
 *   - Non-sensitive   : <site>/config/{site,wordpress}.yaml
 *   - Multi-tenant    : each site's .env can set APP_ID (default 1); the single SQLite
 *                       file isolates data per app_id
 *
 * Bootstrap (auto-init, since 2026-09-21):
 *   - loadSite(key, { autoInit: true, domain, lang }) creates a minimal site skeleton
 *     on first use (same philosophy as the DB: "any tool call auto-initializes on
 *     first use"). initSite is idempotent and never overwrites existing files.
 *   - siteKeyFromUrl(url) derives the site key from a URL hostname:
 *     https://www.example.com/abc -> key=www_example_com, domain=www.example.com
 *
 * CLI:
 *   All CLIs support --site <key>; default per DEFAULT_SITE.
 *   Example: node packages/geo-cli/bin/publish-from-db.js 12 --site tengence
 *
 * Usage:
 *   const { siteKey, siteDir, site, wordpress, env } = loadSite();
 *   const cfg = loadSite('tengence');   // explicitly pick a site
 *   const boot = initSite({ key: 'www_example_com', domain: 'www.example.com' });
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const paths = require('../paths');

/**
 * Workspace root (the old SITES_ROOT semantics).
 *
 * Deliberately starts as null unless the caller supplied one: guessing a directory
 * (`<cwd>/sites`, some ~/… constant) would silently write user content wherever the
 * process happened to be started — which for a spawned server process is the
 * client's own directory, not anything the user chose.
 * Call setSitesRoot() to bind one (that is what the workspace tools do).
 */
let _sitesRoot = process.env.SITES_ROOT ? paths.resolvePath(process.env.SITES_ROOT) : null;

/** Point the workspace root at another directory (`~` supported). */
function setSitesRoot(p) {
  if (!p) throw new Error('setSitesRoot requires a non-empty path');
  _sitesRoot = paths.resolvePath(p);
  return _sitesRoot;
}

/** The bound workspace root, or null when nothing has been provided yet. */
function getSitesRoot() {
  return _sitesRoot;
}

const NOT_BOUND_HINT =
  'No workspace directory is set. Tell the user to pick one and call the `workspace_use` ' +
  'tool with its absolute path (e.g. workspace_use({"path": "~/my-geo-workspace"})); ' +
  'afterwards every tool works inside it. SITES_ROOT=<dir> is an equivalent alternative.';

/** The bound workspace root; throws an actionable error when unbound. */
function requireSitesRoot() {
  if (!_sitesRoot) throw new Error(NOT_BOUND_HINT);
  return _sitesRoot;
}

/** Compatibility export: legacy code used REPO_ROOT to resolve resource paths; new semantics = parent of SITES_ROOT */
const REPO_ROOT = () => path.resolve(requireSitesRoot(), '..');
const DEFAULT_SITE = 'tengence';

/**
 * Parse --site <key> from argv (also supports --site=<key>)
 */
function readSiteArg(argv = process.argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--site') {
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
    } else if (arg.startsWith('--site=')) {
      const value = arg.slice('--site='.length);
      if (value) return value;
    }
  }
  return DEFAULT_SITE;
}

/**
 * Minimal .env parser (avoids an extra dependency)
 * Existing process.env vars win and are never overwritten by the file.
 * @returns {Object} the key-value pairs read from the file this call
 */
function loadEnvFile(envPath) {
  const loaded = {};
  if (!fs.existsSync(envPath)) return loaded;

  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // strip paired quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    loaded[key] = value;
    if (!(key in process.env)) process.env[key] = value;
  }
  return loaded;
}

/**
 * Derive a site key + canonical domain from a URL.
 * https://www.example.com/abc -> { key: 'www_example_com', domain: 'www.example.com' }
 * - only http/https accepted; hostname lowercased; `.` and any other non-alphanumeric
 *   char become `_` (safe directory name);
 * - hostname whitelist [a-z0-9.-]; rejects `..` / weird chars before key derivation.
 * @param {string} url
 * @returns {{key:string, domain:string}}
 */
function siteKeyFromUrl(url) {
  let u;
  try {
    u = new URL(String(url || '').trim());
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${u.protocol} (only http/https)`);
  }
  const host = u.hostname.toLowerCase();
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || host.includes('..')) {
    throw new Error(`Unsafe hostname: ${host}`);
  }
  return { key: host.replace(/[^a-z0-9]/g, '_'), domain: host };
}

/** Write a file only when it does not exist yet (idempotent bootstrap). */
function writeIfAbsent(file, content) {
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, content, { flag: 'wx', encoding: 'utf8' });
  return true;
}

/**
 * Create a minimal site skeleton under SITES_ROOT (idempotent, never overwrites):
 *   <SITES_ROOT>/<key>/config/{site,wordpress,monitor}.yaml
 *   <SITES_ROOT>/<key>/.env  (APP_ID=1)
 *   <SITES_ROOT>/<key>/data/{inbox,reports}/
 * @param {object} opts { key (required), domain?, name?, lang? }
 * @returns {{ok:boolean, key:string, site_key:string, domain:string, site_dir:string,
 *            created:boolean, structure:string[]}}
 */
function initSite({ key, domain, name, lang = 'zh-CN' } = {}) {
  const root = requireSitesRoot();
  if (!key || !/^[a-z0-9_]+$/.test(key)) {
    throw new Error(`Invalid site key: ${key} (lowercase alphanumeric + underscore only)`);
  }
  const siteDir = path.join(root, key);
  const resolvedDir = path.resolve(siteDir);
  if (!resolvedDir.startsWith(path.resolve(root) + path.sep)) {
    throw new Error(`Refusing to create site outside SITES_ROOT: ${resolvedDir}`);
  }
  const displayDomain = domain || key;
  const displayName = name || displayDomain;

  const configDir = path.join(siteDir, 'config');
  const dataDir = path.join(siteDir, 'data');
  const inboxDir = path.join(dataDir, 'inbox');
  const reportsDir = path.join(dataDir, 'reports');

  const existed = fs.existsSync(siteDir);
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });

  const stamp = new Date().toISOString();
  const yamlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

  writeIfAbsent(
    path.join(siteDir, '.env'),
    `# Auto-initialized by geo-sdk (${stamp}); add credentials (WP_* / tokens) as needed\nAPP_ID=1\n`
  );
  writeIfAbsent(
    path.join(configDir, 'site.yaml'),
    [
      `# Auto-initialized by geo-sdk (${stamp}); edit fields as needed`,
      'site:',
      `  key: ${key}`,
      `  name: ${yamlStr(displayName)}`,
      `  domain: ${displayDomain}`,
      '  languages:',
      `    default: ${lang}`,
      '  content:',
      '    root: data',
      '    posts: inbox',
      '    drafts: inbox',
      '',
    ].join('\n')
  );
  writeIfAbsent(
    path.join(configDir, 'wordpress.yaml'),
    [
      '# Auto-initialized by geo-sdk',
      'publish:',
      '  per_day: 1',
      '  skip_dates: []',
      '  default_status: draft',
      '',
    ].join('\n')
  );
  writeIfAbsent(
    path.join(configDir, 'monitor.yaml'),
    [
      '# GEO monitoring skeleton (auto-initialized). Fill in before use:',
      '#   brand_terms / site_domain / competitors (see packages/geo-sdk/monitor/config.js)',
      'monitor:',
      '  brand_terms: []',
      '  strong_brand_terms: []',
      '  homonym_brand_terms: []',
      '  entity_anchors: []',
      `  site_domain: ${displayDomain}`,
      '  competitors: []',
      '  accuracy_flags: []',
      '  complete_accuracy_markers: []',
      '  attempts: 3',
      '  temperature: 0.2',
      '  models: [deepseek, kimi]',
      '',
    ].join('\n')
  );

  return {
    ok: true,
    key,
    site_key: key,
    domain: displayDomain,
    site_dir: siteDir,
    created: !existed,
    structure: [
      '.env',
      'config/site.yaml',
      'config/wordpress.yaml',
      'config/monitor.yaml',
      'data/inbox',
      'data/reports',
    ],
  };
}

/**
 * Load all config for the given site (site dir is assumed to exist).
 * @param {string} key
 * @returns {{siteKey:string, siteDir:string, configDir:string, envPath:string,
 *            env:Object, site:Object, wordpress:Object}}
 */
function loadSiteFiles(key) {
  const root = requireSitesRoot();
  const siteDir = path.join(root, key);
  const configDir = path.join(siteDir, 'config');
  const envPath = path.join(siteDir, '.env');
  const env = loadEnvFile(envPath);

  const readYaml = (name) => {
    const file = path.join(configDir, name);
    if (!fs.existsSync(file)) return {};
    return yaml.load(fs.readFileSync(file, 'utf8')) || {};
  };

  const site = readYaml('site.yaml');
  const wordpress = readYaml('wordpress.yaml');
  // taxonomy.yaml retired/archived on 2026-09-20 (category/tag allow-list = DB categories/tags tables)

  return { siteKey: key, siteDir, configDir, envPath, env, site, wordpress };
}

/**
 * Load all config for the given site.
 * @param {string} [siteKey] site key; default: --site or tengence
 * @param {object} [opts] { autoInit:boolean, domain?:string, lang?:string }
 *   When autoInit is true and the site does not exist, a minimal skeleton is created
 *   on first use (bootstrap), and the returned object carries `_bootstrap`.
 * @returns {{siteKey:string, siteDir:string, configDir:string, envPath:string,
 *            env:Object, site:Object, wordpress:Object, _bootstrap?:Object}}
 */
function loadSite(siteKey, opts = {}) {
  const root = requireSitesRoot();
  const key = siteKey || readSiteArg();
  const siteDir = path.join(root, key);
  const existed = fs.existsSync(siteDir);

  if (!existed) {
    if (!opts.autoInit) {
      throw new Error(
        `Site not found: sites/${key} (available: ${listSites().join(', ') || 'none'})`
      );
    }
    initSite({ key, domain: opts.domain || key, lang: opts.lang });
  }

  const S = loadSiteFiles(key);
  if (opts.autoInit) {
    S._bootstrap = {
      created: !existed,
      site_key: key,
      domain: (S.site && S.site.site && S.site.site.domain) || opts.domain || key,
      site_dir: siteDir,
    };
  }
  return S;
}

/**
 * Resolve an absolute path inside the site directory
 */
function sitePath(siteDir, ...segments) {
  return path.join(siteDir, ...segments);
}

/**
 * Resolve site content paths (all relative to the site dir sites/<site>/)
 * ---------------------------------------------------------------------------
 * Directory conventions (see the content section of sites/<site>/config/site.yaml):
 *   <root>/<posts>/<lang>/<category>/<slug>.md   body
 *   <root>/<drafts>/<lang>/<slug>.md             drafts (flat per language, no category)
 *   <root>/<templates>/<name>.md                 templates
 * The language comes from site.languages.default.
 *
 * @param {Object} site the return value of loadSite()
 */
function contentPaths(site) {
  const conf = (site && site.site && site.site.content) || {};
  const root = path.join(site.siteDir, conf.root || 'content');
  const lang = (site.site.languages && site.site.languages.default) || 'zh-CN';
  const posts = path.join(root, conf.posts || 'posts');
  const drafts = path.join(root, conf.drafts || 'drafts');
  return {
    lang,
    root,
    posts,
    postsLang: path.join(posts, lang),
    drafts,
    draftsLang: path.join(drafts, lang),
    templates: path.join(root, conf.templates || 'templates'),
  };
}

/**
 * List all available sites (directories under sites/ that contain config/)
 */
function listSites() {
  if (!_sitesRoot || !fs.existsSync(_sitesRoot)) return [];
  return fs
    .readdirSync(_sitesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(_sitesRoot, d.name, 'config')))
    .map((d) => d.name);
}

module.exports = {
  get SITES_ROOT() {
    return _sitesRoot;
  },
  get REPO_ROOT() {
    return REPO_ROOT();
  },
  DEFAULT_SITE,
  NOT_BOUND_HINT,
  readSiteArg,
  loadEnvFile,
  loadSite,
  initSite,
  siteKeyFromUrl,
  getSitesRoot,
  requireSitesRoot,
  setSitesRoot,
  sitePath,
  contentPaths,
  listSites,
};
