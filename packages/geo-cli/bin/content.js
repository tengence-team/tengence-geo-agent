#!/usr/bin/env node

/**
 * Generic WordPress content CLI (any REST-exposed post type)
 * ============================================================================
 * A thin shell over tengence-geo-sdk/wp/content. It knows a target
 * (site + post_type) and a payload (plain WP fields); it does not know what a
 * "doc" or a "blog post" is.
 *
 * Usage:
 *   tengence-geo-content tree   --site tengence --type tengence_doc [--status any]
 *   tengence-geo-content status --site tengence --type tengence_doc --lang zh-hans
 *   tengence-geo-content publish --site tengence --type page payload.json
 *   tengence-geo-content delete  --site tengence --type page --id 123 [--force]
 *   cat payload.json | tengence-geo-content publish --site tengence
 *
 * Payload: { language, translationGroup, parent, menuOrder, meta, ...WP fields }
 * parent may be an ID or a slug path ("products/tengence-search"); it is resolved
 * against the same post type + language before writing.
 * ============================================================================
 */

const fs = require('fs');
const t = require('@tengence/geo-sdk');

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'force') opts.force = true;
      else {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) throw new Error(`Missing value for --${key}`);
        opts[key] = v;
        i++;
      }
    } else opts._.push(a);
  }
  return opts;
}

async function readPayload(file) {
  const raw = file ? fs.readFileSync(file, 'utf8') : await new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
  return JSON.parse(raw);
}

async function resolveParent(payload, options) {
  if (payload.parent === undefined || payload.parent === null || typeof payload.parent === 'number') return payload.parent;
  const segments = String(payload.parent).split('/').filter(Boolean);
  let parentId = 0;
  for (const segment of segments) {
    const found = await t.wpContent.findBySlug(segment, {
      postType: payload.postType,
      status: 'any',
      parent: parentId || undefined,
      lang: payload.language,
      ...options,
    });
    if (!found) throw new Error(`Parent path not found: ${payload.parent} (segment "${segment}")`);
    parentId = found.id;
  }
  return parentId;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const command = opts._[0];
  const siteKey = opts.site || t.site.readSiteArg();
  t.site.loadSite(siteKey);

  if (command === 'tree') {
    const { flat, tree } = await t.wpContent.tree({ postType: opts.type, status: opts.status || 'any', siteKey });
    const print = (nodes, depth = 0) => {
      for (const n of nodes) {
        console.log(`${'  '.repeat(depth)}${n.menu_order}\t${n.slug}\t${n.status}\t#${n.id}\t${typeof n.title === 'string' ? n.title : (n.title && n.title.rendered) || ''}`);
        print(n.children, depth + 1);
      }
    };
    print(tree);
    console.error(`total=${flat.length}`);
    return;
  }

  if (command === 'status') {
    const lang = opts.lang;
    const { flat } = await t.wpContent.tree({ postType: opts.type, status: opts.status || 'any', siteKey });
    console.log(`type=${opts.type || 'tengence_doc'} nodes=${flat.length} lang=${lang || '(all)'}`);
    for (const n of flat) {
      console.log(`${n.status}\t#${n.id}\t${n.slug}\tparent=${n.parent}\torder=${n.menu_order}\t${typeof n.title === 'string' ? n.title : (n.title && n.title.rendered) || ''}`);
    }
    return;
  }

  if (command === 'publish') {
    const payload = await readPayload(opts._[1]);
    const items = Array.isArray(payload) ? payload : [payload];
    const results = [];
    let failed = 0;
    for (const item of items) {
      try {
        if (opts.type) item.postType = opts.type;
        item.postType = item.postType || opts.type || 'post';
        const parent = await resolveParent(item, { siteKey });
        const result = await t.wpContent.publish({ ...item, parent }, { siteKey });
        results.push(result);
        console.log(JSON.stringify(result));
      } catch (err) {
        failed++;
        console.error(`FAILED ${item.slug}/${item.language}: ${err.message}`);
      }
    }
    if (Array.isArray(payload)) console.error(`published=${results.length} failed=${failed}`);
    if (failed) process.exitCode = 1;
    return;
  }

  if (command === 'delete') {
    if (!opts.id) throw new Error('delete requires --id');
    const result = await t.wpContent.remove(opts.id, { postType: opts.type, force: Boolean(opts.force), siteKey });
    console.log(JSON.stringify({ id: result.id, status: result.status }));
    return;
  }

  throw new Error('Usage: content <tree|status|publish|delete> [--site key] [--type postType] [payload.json]');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
