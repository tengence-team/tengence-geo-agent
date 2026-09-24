#!/usr/bin/env node
/**
 * channel-publish.js — unified cross-platform publish/export CLI
 * ============================================================================
 * Usage:
 *   Mode A (original DB slugs through the platform's own pipeline):
 *     tengence-geo channel-publish.js --platform=wechat --slugs=a,b,c [--publish] [--dry-run] [--keep-order]
 *     tengence-geo channel-publish.js --platform=juejin --slugs=what-is-geo [--publish] [--dry-run]
 *     tengence-geo channel-publish.js --platform=devto  --slugs=what-is-geo [--dry-run]
 *
 *   Mode B (export a publish package from an already-rewritten markdown file):
 *     tengence-geo channel-publish.js --platform=zhihu --from-md=/path/rewritten.md
 *
 * Defaults: asDraft=true (wechat/juejin create a draft, never mass-send) unless
 * --publish is passed. api:none platforms (zhihu/csdn/toutiao/xiaohongshu) only
 * accept Mode B.
 * ============================================================================
 */
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '..', '..');
const t = require('@tengence/geo-sdk');

/** Parse a publish-package md (front matter + body) into an articles[] item. */
function articleFromMdFile(mdPath) {
  const raw = fs.readFileSync(mdPath, 'utf8');
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const body = fmMatch ? raw.slice(fmMatch[0].length).trim() : raw.trim();
  const slug = path.basename(mdPath, '.md');
  function fmValue(key) {
    if (!fmMatch) return null;
    const m = fmMatch[1].match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, 'm'));
    return m ? m[1].trim() : null;
  }
  const title = fmValue('title') || (body.match(/^#\s+(.+)$/m) || [])[1] || slug;
  const tagsRaw = fmValue('tags');
  let tags = [];
  if (tagsRaw) {
    try {
      tags = JSON.parse(tagsRaw.replace(/'/g, '"'));
    } catch (e) {
      tags = [];
    }
  }
  return {
    slug,
    title,
    contentMd: body,
    summary: fmValue('summary') || '',
    tags: Array.isArray(tags) ? tags : [],
    sourceUrl: fmValue('source_url') || '',
    cover: fmValue('cover') || '',
    rewrite: 'harness',
    mode: fmValue('mode') || 'harness',
  };
}

async function main() {
  const { positionals, flags } = t.cli.args.parse(
    {
      platform: { type: 'string' },
      slugs: { type: 'string' },
      publish: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'keep-order': { type: 'boolean' },
      'from-md': { type: 'string' },
    },
    process.argv.slice(2)
  );

  const platform = flags.platform;
  if (!platform) {
    console.error('Usage: channel-publish.js --platform=<key> --slugs=a,b,c [--publish] [--dry-run] [--keep-order]');
    console.error('       channel-publish.js --platform=<key> --from-md=<file.md>');
    console.error(`Known platforms: ${t.syndicate.registry.PLATFORM_KEYS.join(', ')}`);
    process.exit(1);
  }

  const siteKey = t.site.readSiteArg();
  const dryRun = flags['dry-run'];
  const keepOrder = flags['keep-order'];
  const asDraft = !flags.publish;

  if (flags['from-md']) {
    const abs = path.resolve(flags['from-md']);
    if (!fs.existsSync(abs)) {
      console.error(`❌ File does not exist: ${abs}`);
      process.exit(1);
    }
    const article = articleFromMdFile(abs);
    const result = await t.syndicate.channel.publishToChannel({
      platform,
      articles: [article],
      asDraft,
      keepOrder,
      dryRun,
      siteKey,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  let slugs = [];
  if (flags.slugs) {
    slugs = String(flags.slugs).split(',').map((s) => s.trim()).filter(Boolean);
  } else if (positionals[0]) {
    slugs = [positionals[0]];
  }
  if (slugs.length === 0) {
    console.error('❌ channel-publish needs --slugs=a,b,c (Mode A) or --from-md=<file> (Mode B)');
    process.exit(1);
  }

  const result = await t.syndicate.channel.publishToChannel({
    platform,
    slugs,
    asDraft,
    keepOrder,
    dryRun,
    siteKey,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n❌ Failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { articleFromMdFile };
