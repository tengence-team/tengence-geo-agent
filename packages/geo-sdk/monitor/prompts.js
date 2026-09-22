/**
 * Monitor question-bank loading (monitor domain)
 * ============================================================================
 * monitor-prompts.yaml is the **single source of truth** for the 60 questions (yaml
 * only, never ingested into the DB, avoiding dual-source drift).
 * Structure:
 *   prompts:
 *     - id: P01
 *       layer: L1
 *       question: "What company is Tengence?"
 *       variants:            # optional, synonymous rewrites (rotated to avoid overfitting)
 *         - "Please introduce the company Tengence."
 * NOTE: the example bank is English; for zh-CN sites write questions in the language
 * of the answers you monitor (extraction wordlists are language-specific).
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { loadSite } = require('../site/config');
const { LAYERS } = require('./config');

/** monitor-prompts.yaml path */
function monitorPromptsPath(site) {
  const SITE = site || loadSite();
  return path.join(SITE.configDir, 'monitor-prompts.yaml');
}

/**
 * Load and validate the question bank: id unique, layer valid, question non-empty,
 * variants an array.
 * @param {Object} [site] loadSite() return value
 */
function loadMonitorPrompts(site) {
  const file = monitorPromptsPath(site);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing monitor question bank: ${file}`);
  }
  const raw = yaml.load(fs.readFileSync(file, 'utf8')) || {};
  const list = raw.prompts || [];
  if (list.length === 0) throw new Error('monitor-prompts.yaml: prompts is empty');

  const seen = new Set();
  for (const p of list) {
    if (!p.id || seen.has(p.id)) {
      throw new Error(`monitor-prompts.yaml: id missing or duplicated (${p.id || '(empty)'})`);
    }
    seen.add(p.id);
    if (!LAYERS.includes(p.layer)) {
      throw new Error(`monitor-prompts.yaml: ${p.id} has an invalid layer (${p.layer})`);
    }
    if (!p.question || !String(p.question).trim()) {
      throw new Error(`monitor-prompts.yaml: ${p.id} question is empty`);
    }
    if (p.variants !== undefined && !Array.isArray(p.variants)) {
      throw new Error(`monitor-prompts.yaml: ${p.id} variants must be an array`);
    }
  }
  return list.map((p) => ({
    id: p.id,
    layer: p.layer,
    question: String(p.question).trim(),
    variants: (p.variants || []).map((v) => String(v).trim()).filter(Boolean),
  }));
}

/**
 * Resolve the question text for a given prompt and attempt (attempt starts at 1;
 * 0=the original question, then variants rotate)
 */
function questionFor(prompt, attempt) {
  const pool = [prompt.question, ...prompt.variants];
  const idx = Math.max(0, attempt - 1) % pool.length;
  return pool[idx];
}

module.exports = { loadMonitorPrompts, monitorPromptsPath, questionFor, LAYERS };
