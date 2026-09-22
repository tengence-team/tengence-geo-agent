#!/usr/bin/env node
/**
 * GEO brand monitoring CLI (run / status)
 * ============================================================================
 * Plan: plan/2026/10-GEO-brand-monitoring-plan-AI-citation-monitoring.md (§10 implementation design; the live doc keeps its Chinese filename)
 * Usage:
 *   tengence-geo geo-monitor.js run                       full run (default action)
 *   tengence-geo geo-monitor.js run --models=deepseek     run only the given models (comma-separated)
 *   tengence-geo geo-monitor.js run --layer=L1,L2         run only the given layers
 *   tengence-geo geo-monitor.js run --run-id=20260921     specify the round (default: today)
 *   tengence-geo geo-monitor.js --dry-run                 print config only; no network, no DB writes
 *   tengence-geo geo-monitor.js --mock                    full-pipeline mock (fake answers + no DB writes), validates the pipeline
 *   tengence-geo geo-monitor.js status                    show per-round statistics (requires DB)
 *
 * Keys (sites/<site>/.env): DEEPSEEK_API_KEY / MOONSHOT_API_KEY /
 * DASHSCOPE_API_KEY / ARK_API_KEY(+ARK_MODEL_ID). Models without a key are skipped automatically.
 * Networked runs need DB access (results land in tengence_geo_geo_monitor_*).
 * Networked runs write incrementally: each answered prompt is persisted immediately
 * (old data for that model is cleared first; idempotent), so `status` can show progress
 * mid-run and an interrupted process never loses a whole round.
 * ============================================================================
 */
const t = require('@tengence/geo-sdk');

function todayRunId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function parseArgs(argv) {
  const { positionals, flags } = t.cli.args.parse(
    {
      'dry-run': { type: 'boolean' },
      mock: { type: 'boolean' },
      models: { type: 'string' },
      layer: { type: 'array' },
      layers: { type: 'array' },
      'run-id': { type: 'string' },
    },
    argv
  );
  const layersRaw = [...(flags.layer || []), ...(flags.layers || [])];
  const layerList = layersRaw.flatMap((s) => String(s).split(',')).map((s) => s.trim().toUpperCase()).filter(Boolean);
  return {
    action: positionals[0] === 'status' ? 'status' : 'run',
    models: flags.models ? String(flags.models).split(',').map((s) => s.trim()).filter(Boolean) : null,
    layers: layerList.length ? layerList : null,
    runId: flags['run-id'] || todayRunId(),
    dryRun: flags['dry-run'],
    mock: flags.mock,
  };
}

function mockAnswerFn() {
  // Deterministic canned answers per layer, covering every extraction branch
  // (mention type / competitors / citation / red flag / sentiment).
  // ⚠️ The canned answers are deliberately Chinese samples: the monitor extraction
  // logic (copula verbs, brand terms, red-flag phrasing) is designed for Chinese
  // answers, so the fixtures must stay Chinese to keep the pipeline testable.
  const CANNED = {
    L1: 'Tengence 是深圳市思讯网络有限公司旗下的 AI 增长引擎品牌，核心产品为 Tengence GEO（GEO + SEO 双引擎）与 Tengence Search，官网 https://www.tengence.com 。',
    L2: 'GEO（生成式引擎优化）是让内容被大模型引用的优化方法。常见工具包括 Profound、Otterly.ai，国内的 Tengence GEO 也值得关注。建议从内容结构与技术可达性入手。',
    L3: '流量下滑时可以先做 AI 可见度诊断。业内常用的做法是借助 GEO 工具（如 Ahrefs 配合监测），Tengence GEO 提供一体化方案。',
    L4: '主流 GEO 工具对比：Profound 侧重监测，Otterly.ai 轻量，Tengence GEO 主打 GEO + SEO 双引擎执行。Moz 暂无深度 GEO 能力。',
    L5: '推荐优先试用支持双引擎的平台。Tengence GEO 面向出海企业，支持私有化部署与等保三级。注意避开不靠谱的低价代运营。',
    FLAG: 'Tengence GEO 是一款搜索引擎产品，帮助企业提升排名。', // triggers an accuracy red flag
  };
  return async ({ prompt, attempt }) => (attempt === 3 && prompt.layer === 'L4' ? CANNED.FLAG : CANNED[prompt.layer] || CANNED.L2);
}

async function runAction(o) {
  const SITE = t.site.loadSite();
  const cfg = t.monitor.config.loadMonitorConfig(SITE);
  const prompts = t.monitor.prompts.loadMonitorPrompts(SITE);
  const { enabled, skipped } = t.llm.providers.resolveEnabled();

  console.log(`\n=== GEO brand monitoring ${o.dryRun ? '(dry run, no network)' : o.mock ? '(MOCK, fake answers, no DB writes)' : ''}===`);
  console.log('  Site       :', SITE.siteKey);
  console.log('  Run ID     :', o.runId);
  console.log('  Prompts    :', prompts.length, '(attempts =', cfg.attempts, ')');
  console.log('  Enabled    :', enabled.map((p) => p.key).join(', ') || 'none (missing keys)');
  if (skipped.length) console.log('  Skipped    :', skipped.map((s) => `${s.key}(${s.reason})`).join(', '));
  if (o.models) console.log('  Models     :', o.models.join(', '));
  if (o.layers) console.log('  Layers     :', o.layers.join(', '));
  console.log('  Brand terms:', cfg.brandTerms.join(' / '));
  console.log('  Competitors:', cfg.competitors.map((c) => c.name).join(' / '));

  if (o.dryRun) {
    const picked = prompts.filter((p) => !o.layers || o.layers.includes(p.layer));
    console.log(`\n  This run will execute: ${picked.length} prompts × ${totalModels(enabled, o.models)} models × ${cfg.attempts} attempts`);
    console.log('  ✅ Dry run complete; no network, nothing written');
    return;
  }

  const summary = await t.monitor.run.runMonitor({
    site: SITE,
    models: o.models,
    layers: o.layers,
    runId: o.runId,
    answerFn: o.mock ? mockAnswerFn() : undefined,
    store: o.mock ? t.monitor.store.noopStore : undefined,
  });

  console.log('\n=== Summary ===');
  for (const m of summary.models) {
    console.log(
      `  [${m.model}] ${m.prompts} prompts · mentioned ${m.mentioned} · flagged ${m.flagged} · avg ${m.avgScore}`
    );
  }
  if (summary.flags.length) {
    console.log('\n⚠️ Alerts (need human review):');
    for (const f of summary.flags.slice(0, 20)) {
      console.log(`  [${f.model}/${f.promptId}]`, JSON.stringify(f));
    }
  }
  console.log('\nNext: tengence-geo geo-monitor-report.js', o.runId);
}

function totalModels(enabled, models) {
  return models ? enabled.filter((p) => models.includes(p.key)).length : enabled.length;
}

async function statusAction() {
  t.site.loadSite(); // loads .env (DB credentials); otherwise withConn cannot connect
  const { runId, rows } = await t.monitor.store.readResults({});
  if (!runId) {
    console.log('(no monitoring data — run geo-monitor.js run first)');
    return;
  }
  const byModel = new Map();
  for (const r of rows) {
    const m = byModel.get(r.model) || { n: 0, mentioned: 0, flagged: 0, score: 0 };
    m.n += 1;
    m.mentioned += Number(r.mentioned);
    m.flagged += r.accuracy === 'flagged' ? 1 : 0;
    m.score += r.score;
    byModel.set(r.model, m);
  }
  console.log(`\n=== Round ${runId} (${rows.length} results) ===`);
  for (const [model, m] of byModel) {
    console.log(
      `  [${model}] ${m.n} prompts · mention rate ${Math.round((m.mentioned / m.n) * 100)}% · flagged ${m.flagged} · avg ${Math.round(m.score / m.n)}`
    );
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.action === 'status') {
    await statusAction();
    return;
  }
  await runAction(o);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('\n❌ Failed:', e.message);
    process.exit(1);
  });
}

module.exports = { main };
