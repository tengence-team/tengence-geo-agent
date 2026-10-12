'use strict';
/**
 * GEO content engine MCP Resources (@tengence/geo-mcp/tools/resources)
 * ============================================================================
 * Exposes reference data that the AI reads (not actions) through the MCP
 * Resources primitive. Fixed resources + parameterized templates.
 *
 * Every read reuses the @tengence/geo-sdk domain API directly (same data source
 * as the tools — no duplicated logic). Safety: site resources strip credentials
 * (env) — never expose tokens/keys/PII through a resource.
 *
 * This module is SDK-agnostic: it exports plain descriptors + callbacks. server.js
 * wraps them with registerResource / ResourceTemplate.
 *
 * Resource URI map:
 *   geo://standard-index                  fixed — standards index (listStandards)
 *   geo://sites                           fixed — non-sensitive site summary list
 *   geo://standard/{name}                 template — one standard (base+supplement merged)
 *   geo://site/{key}                      template — one site's non-sensitive config
 *   geo://glossary/{lang}                 template — merged glossary for a language
 */

const t = require('@tengence/geo-sdk');
const { LANG_LIST } = require('./languages');

/** Only these languages are exposed as glossary resources (shared language constant). */
const GLOSSARY_LANGS = LANG_LIST;

/** Non-secret subset of site.yaml (whitelist). */
function safeSiteFields(site) {
  return { domain: site.domain || null, lang: site.lang || null };
}

/** Non-secret subset of wordpress.yaml (whitelist). */
function safeWpFields(wp) {
  return { host: wp.host || null, type: wp.type || null };
}

/**
 * Whitelist a loaded site for resource exposure — only fields known to be
 * non-secret are kept (domain/lang; wordpress host/type). Credentials (.env:
 * env/envPath) and any custom secret dropped into site.yaml / wordpress.yaml
 * are never included: this is a whitelist, not a blacklist subtraction.
 */
function siteSummary(loaded) {
  const site = (loaded && loaded.site && loaded.site.site) || {};
  const wp = (loaded && loaded.wordpress) || {};
  const safeSite = safeSiteFields(site);
  const safeWp = safeWpFields(wp);
  return {
    siteKey: loaded.siteKey,
    siteDir: loaded.siteDir,
    configDir: loaded.configDir,
    domain: safeSite.domain,
    lang: safeSite.lang,
    site: safeSite,
    wordpress: safeWp,
  };
}

/** Non-sensitive, size-bounded summary of every site. */
function sitesSummary() {
  const keys = t.site.listSites();
  return keys.map((key) => {
    try {
      const loaded = t.site.loadSite(key);
      return { siteKey: key, ...siteSummary(loaded) };
    } catch (e) {
      return { siteKey: key, error: e.message };
    }
  });
}

/** Read the merged text of a standard; throws UNKNOWN_STANDARD on bad name. */
function readStandardText(name) {
  return t.standards.readStandard(String(name)).merged;
}

/** Guard the {lang} template argument against arbitrary input. */
function assertGlossaryLang(lang) {
  if (!GLOSSARY_LANGS.includes(lang)) {
    throw new Error(`Unknown glossary language "${lang}". Available: ${GLOSSARY_LANGS.join(', ')}`);
  }
  return lang;
}

/**
 * Fixed resources — one URI each.
 */
const fixedResources = [
  {
    name: 'standard-index',
    uri: 'geo://standard-index',
    config: {
      title: 'Standards Index',
      description: 'Index of generic writing & GEO standards shipped with the engine (name, title, hasSupplement).',
      mimeType: 'application/json',
    },
    read() {
      return {
        contents: [
          {
            uri: 'geo://standard-index',
            mimeType: 'application/json',
            text: JSON.stringify(t.standards.listStandards(), null, 2),
          },
        ],
      };
    },
  },
  {
    name: 'sites',
    uri: 'geo://sites',
    config: {
      title: 'Sites',
      description: 'Non-sensitive summary of every site in the workspace (domain, lang, wordpress host). No credentials.',
      mimeType: 'application/json',
    },
    read() {
      return {
        contents: [
          {
            uri: 'geo://sites',
            mimeType: 'application/json',
            text: JSON.stringify(sitesSummary(), null, 2),
          },
        ],
      };
    },
  },
];

/**
 * Parameterized resources — URI templates.
 */
const resourceTemplates = [
  {
    name: 'standard',
    uriTemplate: 'geo://standard/{name}',
    config: {
      title: 'Standard Document',
      description: 'Read a generic standard (base + site-specific supplement merged). name is repository-relative without .md, e.g. article-writing-standards, templates/skeletons/howto.',
      mimeType: 'text/markdown',
    },
    list() {
      return {
        resources: t.standards.listStandards().map((s) => ({
          uri: `geo://standard/${s.name}`,
          name: s.name,
          title: s.title,
          mimeType: 'text/markdown',
        })),
      };
    },
    read(_uri, variables) {
      const name = String(variables.name || '');
      let text;
      try {
        text = readStandardText(name);
      } catch (e) {
        throw new Error(`Unknown standard "${name}". Available standards are listed via geo://standard-index.`);
      }
      return {
        contents: [
          {
            uri: `geo://standard/${name}`,
            mimeType: 'text/markdown',
            text,
          },
        ],
      };
    },
  },
  {
    name: 'site',
    uriTemplate: 'geo://site/{key}',
    config: {
      title: 'Site Config',
      description: 'Non-sensitive configuration summary for a site (domain, lang, wordpress host). Credentials are never exposed.',
      mimeType: 'application/json',
    },
    list() {
      return {
        resources: t.site.listSites().map((key) => ({
          uri: `geo://site/${key}`,
          name: key,
          title: `Site ${key}`,
          mimeType: 'application/json',
        })),
      };
    },
    read(_uri, variables) {
      const key = String(variables.key || '');
      let loaded;
      try {
        loaded = t.site.loadSite(key);
      } catch (e) {
        throw new Error(`Unknown site "${key}". Sites are listed via geo://sites.`);
      }
      return {
        contents: [
          {
            uri: `geo://site/${key}`,
            mimeType: 'application/json',
            text: JSON.stringify(siteSummary(loaded), null, 2),
          },
        ],
      };
    },
  },
  {
    name: 'glossary',
    uriTemplate: 'geo://glossary/{lang}',
    config: {
      title: 'Translation Glossary',
      description: 'Merged translation glossary (global base + site override) for one language: zh-hans | en | zh-hant.',
      mimeType: 'text/markdown',
    },
    list() {
      return {
        resources: GLOSSARY_LANGS.map((lang) => ({
          uri: `geo://glossary/${lang}`,
          name: lang,
          title: `Glossary ${lang}`,
          mimeType: 'text/markdown',
        })),
      };
    },
    read(_uri, variables) {
      const lang = assertGlossaryLang(String(variables.lang || ''));
      const full = t.translate.glossary.loadFull();
      // Present only the entries for the requested language; keep it deterministic & flat.
      const slice = {
        forbidden: (full.forbidden && full.forbidden[lang]) || [],
      };
      return {
        contents: [
          {
            uri: `geo://glossary/${lang}`,
            mimeType: 'text/markdown',
            text:
              `# Translation glossary (${lang})\n\n` +
              `## Forbidden terms (gate-checked)\n\n` +
              (slice.forbidden.length
                ? slice.forbidden.map((w) => `- ${w}`).join('\n')
                : '(none)'),
          },
        ],
      };
    },
  },
];

module.exports = { fixedResources, resourceTemplates, GLOSSARY_LANGS };
