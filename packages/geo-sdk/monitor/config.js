/**
 * Monitor config loading (monitor domain)
 * ============================================================================
 * monitor.yaml (sites/<site>/config/) carries: brand terms, competitor list,
 * accuracy red flags, execution parameters. The question bank lives in
 * monitor-prompts.yaml (see prompts.js); neither file is ingested into the DB.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { loadSite } = require('../site/config');

const LAYERS = ['L1', 'L2', 'L3', 'L4', 'L5'];

/** Normalize yaml's pricing segment into { model: {input_per_1m, output_per_1m} },
 * skipping invalid entries */
function normalizePricing(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  for (const [model, v] of Object.entries(p)) {
    if (!v || typeof v !== 'object') continue;
    const inp = Number(v.input_per_1m);
    const outp = Number(v.output_per_1m);
    if (!Number.isFinite(inp) || !Number.isFinite(outp)) continue;
    out[model] = { input_per_1m: inp, output_per_1m: outp };
  }
  return out;
}

/** monitor.yaml path */
function monitorConfigPath(site) {
  const SITE = site || loadSite();
  return path.join(SITE.configDir, 'monitor.yaml');
}

/**
 * Load and validate monitor.yaml. Missing file / missing brand terms / invalid layer
 * all throw (no fallback convention).
 * @param {Object} [site] loadSite() return value
 */
function loadMonitorConfig(site) {
  const file = monitorConfigPath(site);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing monitor config: ${file}`);
  }
  const raw = yaml.load(fs.readFileSync(file, 'utf8')) || {};
  const c = raw.monitor || raw;

  const brandTerms = (c.brand_terms || []).map(String).filter(Boolean);
  if (brandTerms.length === 0) {
    throw new Error('monitor.yaml: brand_terms cannot be empty');
  }
  const accuracyFlags = (c.accuracy_flags || []).map((r) => ({
    term: String(r.term || ''),
    bad_phrases: (r.bad_phrases || []).map(String),
  }));

  const strongBrandTerms = (c.strong_brand_terms || []).map(String).filter(Boolean);
  const homonymBrandTerms = (c.homonym_brand_terms || []).map(String).filter(Boolean);
  const entityAnchors = (c.entity_anchors || []).map(String).filter(Boolean);

  return {
    brandTerms,
    strongBrandTerms,
    homonymBrandTerms,
    entityAnchors,
    siteDomain: c.site_domain || 'www.tengence.com',
    competitors: (c.competitors || []).map((x) => ({
      name: String(x.name),
      aliases: [String(x.name), ...(x.aliases || []).map(String)].filter(Boolean),
    })),
    accuracyFlags,
    // NOTE: the default marker/word lists below are Chinese on purpose — they match
    // against Chinese model answers to Chinese questions and must stay as-is.
    completeAccuracyMarkers: (c.complete_accuracy_markers || ['GEO + SEO', '双引擎']).map(String),
    recommendMarkers: (c.recommend_markers || ['推荐', '首选', '值得', '建议', '可以考虑', '不错', '好用', '靠谱', '领先']).map(String),
    negativeMarkers: (c.negative_markers || ['智商税', '骗局', '垃圾', '避坑', '谨慎', '不好用', '问题多', '投诉', '割韭菜', '不靠谱']).map(String),
    positiveMarkers: (c.positive_markers || ['推荐', '领先', '优秀', '好用', '靠谱', '专业', '值得', '头部', '知名']).map(String),
    attempts: Number(c.attempts) > 0 ? Number(c.attempts) : 3,
    temperature: c.temperature !== undefined ? Number(c.temperature) : 0.2,
    models: (c.models || []).map(String),
    reportDir: c.report_dir || 'plan/2026/reports',
    pricing: normalizePricing(c.pricing),
  };
}

module.exports = { loadMonitorConfig, monitorConfigPath, LAYERS, normalizePricing };
