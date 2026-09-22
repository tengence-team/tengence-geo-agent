/**
 * Lightweight command-line argument parser
 * ============================================================================
 * New module added in batch A, no callers yet; later batches replace the hand-written
 * argv loops in each script. Design goals: zero dependencies, supports `--flag` /
 * `--key=value` / `--key value` / positionals / repeated occurrences aggregated into
 * arrays, and keeps the existing `--site` semantics (see site/config.js) unchanged.
 *
 * Usage:
 *   const { parse } = require('../cli/args');
 *   const { positionals, flags } = parse({
 *     force:  { type: 'boolean', alias: ['f'] },
 *     status: { type: 'string', default: 'draft' },
 *     slug:   { type: 'array' },
 *   });
 * ============================================================================
 */

/**
 * @param {Object} spec shape: { name: { type:'boolean'|'string'|'array', alias?:string[], default?:any } }
 * @param {string[]} [argv] default process.argv.slice(2)
 * @returns {{positionals:string[], flags:Object, unknown:string[]}}
 */
function parse(spec = {}, argv) {
  const args = (argv || process.argv.slice(2)).slice();

  // build alias → canonical-name index
  const lookup = new Map();
  for (const [name, def] of Object.entries(spec)) {
    lookup.set(name, name);
    for (const a of def.alias || []) lookup.set(a, name);
  }

  const flags = {};
  for (const [name, def] of Object.entries(spec)) {
    if (def.default !== undefined) flags[name] = def.default;
    else if (def.type === 'boolean') flags[name] = false;
    else if (def.type === 'array') flags[name] = [];
    else flags[name] = undefined;
  }

  const positionals = [];
  const unknown = [];

  const assign = (name, def, value) => {
    if (def.type === 'array') flags[name] = (flags[name] || []).concat([value]);
    else if (def.type === 'boolean') flags[name] = value === undefined ? true : !/^(false|0|no)$/i.test(String(value));
    else flags[name] = value;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--') && arg !== '-') {
      positionals.push(arg);
      continue;
    }

    let key;
    let inlineValue;
    let isShort = false;

    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      key = eq === -1 ? body : body.slice(0, eq);
      inlineValue = eq === -1 ? undefined : body.slice(eq + 1);
    } else {
      isShort = true;
      const body = arg.slice(1);
      const eq = body.indexOf('=');
      key = eq === -1 ? body : body.slice(0, eq);
      inlineValue = eq === -1 ? undefined : body.slice(eq + 1);
    }

    const canonical = lookup.get(key);
    if (!canonical) {
      unknown.push(arg);
      continue;
    }

    const def = spec[canonical];
    let value = inlineValue;
    if (value === undefined && def.type !== 'boolean') {
      const next = args[i + 1];
      if (next !== undefined && (!next.startsWith('--') || isShort)) {
        value = next;
        i++;
      }
    }
    assign(canonical, def, value);
  }

  return { positionals, flags, unknown };
}

/**
 * Extract `--site <key>` from argv (keeps semantics fully consistent with site/config.js)
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
  return undefined;
}

module.exports = { parse, readSiteArg };
