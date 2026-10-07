'use strict';
/**
 * Translation glossary loading (geo-sdk/translate/glossary)
 * ============================================================================
 * Merge order (later wins): global standards/translation-glossary.yaml (base) ←
 * site config/translation-glossary.yaml. Exposed to the harness via the MCP tool
 * `translation_glossary_get`; the forbidden-term part drives the T5/T6 gate.
 * Loading must never throw — a missing/broken glossary falls back to empty.
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const GLOBAL_GLOSSARY = path.join(__dirname, '..', 'standards', 'translation-glossary.yaml');

function loadGlobal() {
  try {
    return yaml.load(fs.readFileSync(GLOBAL_GLOSSARY, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

/**
 * Load a site-level glossary (config/translation-glossary.yaml).
 * @param {string} [siteKey] site key; absent/unknown site → empty object
 * @returns {object} parsed YAML or {}
 */
function loadSiteGlossary(siteKey) {
  if (!siteKey) return {};
  try {
    const site = require('../site').loadSite(siteKey);
    const p = path.join(site.siteDir, 'config', 'translation-glossary.yaml');
    if (fs.existsSync(p)) return yaml.load(fs.readFileSync(p, 'utf8')) || {};
    return {};
  } catch (_) {
    return {};
  }
}

/**
 * Merge forbidden-term lists per target language (global base + site override).
 * @param {string} [siteKey]
 * @returns {{'en':string[], 'zh-hant':string[]}}
 */
function loadForbidden(siteKey) {
  const out = { 'en': [], 'zh-hant': [] };
  const global = loadGlobal();
  if (global && global.forbidden && typeof global.forbidden === 'object') {
    for (const lang of Object.keys(out)) {
      if (Array.isArray(global.forbidden[lang])) out[lang].push(...global.forbidden[lang]);
    }
  }
  const site = loadSiteGlossary(siteKey);
  if (site && site.forbidden && typeof site.forbidden === 'object') {
    for (const lang of Object.keys(out)) {
      if (Array.isArray(site.forbidden[lang])) out[lang].push(...site.forbidden[lang]);
    }
  }
  for (const lang of Object.keys(out)) {
    out[lang] = [...new Set(out[lang].map((w) => String(w).trim()).filter(Boolean))];
  }
  return out;
}

/**
 * Full merged glossary for agent consumption (translation_glossary_get).
 * @param {string} [siteKey]
 * @returns {object} { forbidden, brands, phrases, product_terms, site }
 */
function loadFull(siteKey) {
  const global = loadGlobal();
  const site = loadSiteGlossary(siteKey);
  const merge = (key) => {
    const g = global[key] && typeof global[key] === 'object' ? global[key] : {};
    const s = site[key] && typeof site[key] === 'object' ? site[key] : {};
    return { ...g, ...s };
  };
  return {
    forbidden: loadForbidden(siteKey),
    brands: merge('brands'),
    phrases: merge('phrases'),
    product_terms: merge('product_terms'),
    site: (site && site.site) || null,
  };
}

module.exports = { loadGlobal, loadSiteGlossary, loadForbidden, loadFull };
