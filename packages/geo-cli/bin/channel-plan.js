#!/usr/bin/env node
/**
 * channel-plan.js — per-platform publishing calendar CLI
 * ============================================================================
 * Usage:
 *   tengence-geo channel-plan.js list [--platform=wechat] [--status=todo]
 *   tengence-geo channel-plan.js next [--platform=juejin]   # derived from blog publish_order
 *   tengence-geo channel-plan.js mark <id> <status>         # todo|draft|published|paused
 *   tengence-geo channel-plan.js import-wechat <plan.md>    # import 《微信公众号发布计划.md》
 *   tengence-geo channel-plan.js reconcile <platform> [--published=slug1,slug2]
 * ============================================================================
 */
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '..', '..');
const t = require('@tengence/geo-sdk');

async function main() {
  const { positionals, flags } = t.cli.args.parse(
    { platform: { type: 'string' }, status: { type: 'string' }, published: { type: 'string' }, all: { type: 'boolean' } },
    process.argv.slice(2)
  );
  t.site.loadSite(t.site.readSiteArg());

  const cmd = positionals[0] || 'list';
  const platform = flags.platform;
  const ch = t.plan.channel;

  if (cmd === 'list') {
    const rows = await ch.list({ platform, status: flags.status });
    console.log(`channel_plan rows: ${rows.length}${platform ? ` (platform=${platform})` : ''}${flags.status ? ` (status=${flags.status})` : ''}`);
    for (const r of rows) {
      console.log(
        `  #${r.id} ${r.platform} | ${r.period} | ${r.status} | ${r.weekday || '—'} | ${r.topic || ''} | ` +
          `${r.article_slugs.length} slugs | draft_ids=${r.draft_ids.length}`
      );
    }
    return;
  }

  if (cmd === 'next') {
    if (!platform) {
      console.error('❌ channel-plan next requires --platform=<key>');
      process.exit(1);
    }
    const next = await ch.nextDue(platform);
    if (!next) {
      console.log(`No due issue for ${platform} (all rows published/paused).`);
      return;
    }
    console.log(`Next due for ${platform}: #${next.id ?? '—'} ${next.period || ''} [${next.status}] ${next.topic || ''} (${next.weekday || '—'})` +
      (next.source ? `  source=${next.source}` : ''));
    console.log(`Slugs (${next.article_slugs.length}): ${next.article_slugs.join(', ')}`);
    return;
  }

  if (cmd === 'mark') {
    const id = Number(positionals[1]);
    const status = positionals[2];
    if (!id || !status) {
      console.error('Usage: channel-plan.js mark <id> <todo|draft|published|paused>');
      process.exit(1);
    }
    const res = await ch.markStatus(id, status);
    console.log(`✅ #${res.id} → ${res.status}`);
    return;
  }

  if (cmd === 'import-wechat') {
    const mdPath = positionals[1];
    if (!mdPath || !fs.existsSync(mdPath)) {
      console.error('Usage: channel-plan.js import-wechat <微信公众号发布计划.md>');
      process.exit(1);
    }
    const res = await ch.importWechatPlan(path.resolve(mdPath));
    console.log(`✅ WeChat plan imported: ${JSON.stringify(res)}`);
    return;
  }

  if (cmd === 'reconcile') {
    const platform = flags.platform || positionals[1];
    if (!platform) {
      console.error('Usage: channel-plan.js reconcile <platform> [--published=slug1,slug2]');
      process.exit(1);
    }
    let map;
    if (flags.published) {
      map = flags.published.split(',').map((s) => ({ slug: s.trim() }));
    }
    const res = await ch.reconcileFromJuejin({ map });
    console.log(`✅ Reconciled ${platform}: ${JSON.stringify(res)}`);
    return;
  }

  console.error(`Unknown command "${cmd}" (list | next | mark | import-wechat | reconcile)`);
  process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n❌ Failed: ${err.message}`);
    process.exit(1);
  });
}
