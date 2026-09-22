'use strict';
/**
 * Generic writing & GEO standards — resolution layer
 * ============================================================================
 * Ships inside @tengence/geo-sdk and is versioned with the package. Everything
 * here is site-agnostic (no brand / domain / product names). Anything that is
 * specific to one deployment is a **supplement** layered on top under
 * `$TENGENCE_GEO_HOME/standards/` — it may only tighten or instantiate the base,
 * never replace it (see `site-profile.md` §2).
 *
 * Resolution (three tiers, read-only merge):
 *   1. BASE  — this directory (the package's own `standards/`, authoritative).
 *   2. SUPPLEMENT — `<TENGENCE_GEO_HOME>/standards/` (optional, site-specific).
 * The merged text = base, then — when a same-named supplement file exists — a
 * clearly delimited "Site-specific Additions" section appended after it.
 *
 * A name is a repository-relative path WITHOUT the `.md` extension, e.g.
 *   `article-writing-standards`
 *   `templates/skeletons/howto`
 *   `templates/research-brief`
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const paths = require('../paths');

/** Base directory = this module's own location (package `standards/`). */
const BASE_DIR = __dirname;

/** Supplement directory = the internal home's `standards/` sub-directory. */
function supplementDir() {
  return path.join(paths.internalHome(), 'standards');
}

/** T1–T7 skeleton file map (type → skeleton file name without extension). */
const SKELETONS = {
  definition: 'templates/skeletons/definition',
  howto: 'templates/skeletons/howto',
  product: 'templates/skeletons/product',
  case: 'templates/skeletons/case',
  industry: 'templates/skeletons/industry',
  comparison: 'templates/skeletons/comparison',
  guide: 'templates/skeletons/guide',
};

/** Resolve a name to a base file path; tolerates an already-present `.md`. */
function basePath(name) {
  const rel = String(name).replace(/\.md$/, '');
  return path.join(BASE_DIR, rel + '.md');
}

/** Resolve a name to a supplement file path (may not exist). */
function supplementPath(name) {
  const rel = String(name).replace(/\.md$/, '');
  return path.join(supplementDir(), rel + '.md');
}

/** Title = the first Markdown H1 (`# ...`) in a file, else the file name. */
function fileTitle(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = /^\s*#\s+(.+?)\s*$/m.exec(text);
    return m ? m[1].trim() : path.basename(file, '.md');
  } catch (_) {
    return path.basename(file, '.md');
  }
}

/** Recursively collect every `.md` file under a directory. */
function walkMd(dir, prefix) {
  let out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out = out.concat(walkMd(full, rel));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(rel.replace(/\.md$/, ''));
    }
  }
  return out;
}

/**
 * List every standard document shipped with the package.
 * @returns {Array<{name, title, hasSupplement, sizeBytes}>}
 */
function listStandards() {
  return walkMd(BASE_DIR, '')
    .sort()
    .map((name) => {
      const bp = basePath(name);
      let sizeBytes = 0;
      try {
        sizeBytes = fs.statSync(bp).size;
      } catch (_) {}
      return {
        name,
        title: fileTitle(bp),
        hasSupplement: fs.existsSync(supplementPath(name)),
        sizeBytes,
      };
    });
}

/**
 * Read a standard document as a base+supplement merge.
 * @param {string} name repository-relative path without `.md`
 * @returns {{name, base, supplement, merged, hasSupplement}}
 */
function readStandard(name) {
  const bp = basePath(name);
  if (!fs.existsSync(bp)) {
    const available = listStandards().map((s) => s.name);
    const err = new Error(
      `Unknown standard "${name}". Available: ${available.join(', ')}`
    );
    err.code = 'UNKNOWN_STANDARD';
    err.available = available;
    throw err;
  }
  const base = fs.readFileSync(bp, 'utf8');
  const sp = supplementPath(name);
  let supplement = null;
  if (fs.existsSync(sp)) {
    supplement = fs.readFileSync(sp, 'utf8');
  }
  const merged = supplement
    ? `${base}\n\n---\n\n## Site-specific Additions (supplement)\n\n` +
      `> Loaded from \`${sp}\`. A supplement may only tighten or instantiate the base ` +
      `above; it never relaxes a hard requirement.\n\n${supplement}`
    : base;
  return { name, base, supplement, merged, hasSupplement: !!supplement };
}

/** Get the body skeleton text for a T1–T7 type (throws on unknown type). */
function getSkeleton(type) {
  const key = String(type || '').toLowerCase();
  const name = SKELETONS[key];
  if (!name) {
    const available = Object.keys(SKELETONS).join(', ');
    const err = new Error(`Unknown article type "${type}". Available: ${available}`);
    err.code = 'UNKNOWN_TYPE';
    err.available = Object.keys(SKELETONS);
    throw err;
  }
  return readStandard(name).merged;
}

/** Get the pre-writing research-brief template text. */
function getResearchBrief() {
  return readStandard('templates/research-brief').merged;
}

/**
 * Assemble a ready-to-use writing brief for an article: the matched T1–T7 skeleton,
 * the research-brief template, and the full writing standard (base+supplement).
 * The caller (an AI client) uses this to author the body per the generic spec; the
 * `check_article` gate then enforces the same rules codified in `article-writing-standards.md`.
 *
 * @param {{type?:string, topic?:string}} opts
 * @returns {object} brief payload
 */
function buildDraftBrief(opts = {}) {
  const type = (opts.type || 'guide').toLowerCase();
  const skeleton = getSkeleton(type);
  const researchBrief = getResearchBrief();
  const writing = readStandard('article-writing-standards').merged;
  return {
    ok: true,
    type,
    type_label: SKELETONS[type] ? path.basename(SKELETONS[type]) : type,
    skeleton,
    research_brief_template: researchBrief,
    writing_standard: writing,
    block_headings: {
      summary: '> **Summary:** (one-sentence abstract, first content after the H1)',
      key_takeaways: '## Key Takeaways',
      faq: '## FAQ',
      data_sources: '## Data Sources',
      related_reading: '## Related Reading',
      get_started: '## Get Started',
      about: '## About <Brand>',
    },
    standards_to_read_in_full: [
      'article-writing-standards',
      'content-strategy',
      'block-conventions',
    ],
    note:
      'Author the body in Markdown following `skeleton` and `writing_standard`. ' +
      'Fill `research_brief_template` before drafting. The `check_article` gate ' +
      'enforces the G1–G14 editorial gates; do not skip it before publishing.',
  };
}

module.exports = {
  BASE_DIR,
  supplementDir,
  SKELETONS,
  listStandards,
  readStandard,
  getSkeleton,
  getResearchBrief,
  buildDraftBrief,
};
