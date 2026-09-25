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
 *   tengence-geo channel-plan.js taxonomy sync [--platform=juejin]
 *   tengence-geo channel-plan.js taxonomy list [--kind=tag] [--name=SEO | --prefix=搜索] [--limit=50]
 *   tengence-geo channel-plan.js taxonomy resolve --category=geo-ai-search --tags=geo-seo,search-system
 * ============================================================================
 */
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '..', '..');
const t = require('@tengence/geo-sdk');

async function main() {
  const { positionals, flags } = t.cli.args.parse(
    {
      platform: { type: 'string' },
      status: { type: 'string' },
      published: { type: 'string' },
      all: { type: 'boolean' },
      kind: { type: 'string' },
      name: { type: 'string' },
      prefix: { type: 'string' },
      limit: { type: 'string' },
      category: { type: 'string' },
      tags: { type: 'string' },
      keywords: { type: 'string' },
    },
    process.argv.slice(2)
  );
  const site = t.site.loadSite(t.site.readSiteArg());

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

  if (cmd === 'taxonomy') {
    const sub = positionals[1] || 'list';
    const jt = t.syndicate.juejinTaxonomy;
    const repo = t.db.channelTaxonomy;
    const appId = Number(process.env.APP_ID || 1);
    const plat = flags.platform || 'juejin';

    if (sub === 'sync') {
      const res = await jt.syncJuejinTaxonomy();
      console.log(`✅ taxonomy synced: ${JSON.stringify(res)}`);
      const stats = await jt.taxonomyStats();
      console.log(`   cached: ${JSON.stringify(stats)}`);
      return;
    }

    if (sub === 'list') {
      const limit = flags.limit ? Number(flags.limit) : 100;
      let rows;
      await t.db.withConn(async (conn) => {
        if (flags.name) {
          const one = await repo.findByName(conn, appId, plat, flags.kind || 'tag', flags.name);
          rows = one ? [one] : [];
        } else if (flags.prefix) {
          rows = await repo.findByPrefix(conn, appId, plat, flags.kind || 'tag', flags.prefix, limit);
        } else {
          rows = await repo.list(conn, appId, { platform: plat, kind: flags.kind, limit });
        }
      });
      const stats = await jt.taxonomyStats();
      console.log(`taxonomy(${plat}) cached: categories=${stats.categories} tags=${stats.tags} — showing ${rows.length}`);
      for (const r of rows) console.log(`  ${r.kind} | ${r.external_id} | ${r.name}${r.parent_id ? ` (parent=${r.parent_id})` : ''}`);
      return;
    }

    if (sub === 'resolve') {
      const res = await jt.resolveJuejinTaxonomy({
        category: flags.category || null,
        tags: flags.tags ? flags.tags.split(',').map((s) => s.trim()).filter(Boolean) : [],
        keywords: flags.keywords ? flags.keywords.split(',').map((s) => s.trim()).filter(Boolean) : [],
        siteDir: site.siteDir,
        autoSync: false,
      });
      console.log('resolved:');
      console.log(`  category: ${res.categoryName || '(env)'} = ${res.categoryId}  [${res.categoryOrigin}]`);
      console.log(`  tags:     ${res.tagNames.join(', ') || '(env)'} = [${res.tagIds.join(', ')}]  [${res.origins.join(', ')}]`);
      if (res.dictEmpty) console.log('  ⚠️ dictionary empty — run: channel-plan.js taxonomy sync');
      return;
    }

    console.error(`Unknown taxonomy subcommand "${sub}" (sync | list | resolve)`);
    process.exit(1);
  }

  console.error(`Unknown command "${cmd}" (list | next | mark | import-wechat | reconcile | taxonomy)`);
  process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n❌ Failed: ${err.message}`);
    process.exit(1);
  });
}
