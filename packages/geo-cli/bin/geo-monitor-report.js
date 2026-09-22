#!/usr/bin/env node
/**
 * GEO brand monitoring weekly report CLI
 * ============================================================================
 * Usage:
 *   tengence-geo geo-monitor-report.js [runId] [--mock]
 *     runId defaults to the latest round in the DB; --mock = sample report from sample
 *     data (validates the template).
 *
 * Output: sites/tengence/plan/2026/reports/AI-citation-monitoring-weekly-<runId>.md
 * Content: per-model / per-layer metrics, SOV, red-flag ledger (accuracy hallucination /
 * negative sentiment), per-prompt detail.
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const t = require('@tengence/geo-sdk');
const { computeCostByModel, fmtMoney } = require('@tengence/geo-sdk/monitor/cost');
const { PROVIDERS, PROVIDER_KEYS, modelOf } = require('@tengence/geo-sdk/llm/providers');

const LAYER_NAMES = { L1: 'Brand awareness', L2: 'Category association', L3: 'Long-tail scenarios', L4: 'Comparison & review', L5: 'Purchase decision' };

function parseArgs(argv) {
  const { positionals, flags } = t.cli.args.parse(
    { mock: { type: 'boolean' }, models: { type: 'string' } },
    argv
  );
  return {
    runId: positionals[0] || null,
    mock: flags.mock,
    models: flags.models ? String(flags.models).split(',').map((s) => s.trim()).filter(Boolean) : null,
  };
}

function loadRows(o, SITE) {
  if (o.mock) {
    return mockRows();
  }
  return t.monitor.store.readResults({ runId: o.runId });
}

/** Sample data (covers every branch: mentioned/listed/recommended/not-mentioned/red flag/negative) */
function mockRows() {
  const mk = (model, promptId, layer, over = {}) => ({
    model, prompt_id: promptId, layer, mentioned: 0, entity_match: 'none', mention_type: 0, position: 0,
    sentiment: 'neutral', cited_tengence: 0, cited_any: 0, accuracy: 'basic', score: 0,
    competitors: [], flags: [], ...over,
  });
  return {
    runId: 'MOCK',
    rows: [
      mk('deepseek', 'P01', 'L1', { mentioned: 1, entity_match: 'ours', mention_type: 3, position: 1, cited_tengence: 1, cited_any: 1, accuracy: 'complete', score: 100 }),
      mk('deepseek', 'P38', 'L2', { mentioned: 1, entity_match: 'ours', mention_type: 2, position: 3, competitors: ['Profound', 'Otterly.ai'], cited_any: 1, score: 60 }),
      mk('deepseek', 'P41', 'L4', { mentioned: 1, entity_match: 'ours', mention_type: 2, position: 2, competitors: ['Profound'], accuracy: 'flagged', flags: [{ type: 'accuracy', bad_phrase: 'search engine' }], score: 35 }),
      mk('deepseek', 'P57', 'L5', { mentioned: 1, entity_match: 'ours', mention_type: 1, sentiment: 'negative', flags: [{ type: 'sentiment', value: 'negative' }], score: 0 }),
      mk('deepseek', 'P49', 'L5', { competitors: ['Ahrefs', 'SEMrush'], score: 0 }),
      mk('kimi', 'P01', 'L1', { mentioned: 1, entity_match: 'ambiguous', mention_type: 2, position: 1, accuracy: 'basic', score: 0 }),
      mk('kimi', 'P40', 'L4', { mentioned: 1, entity_match: 'ours', mention_type: 2, position: 2, competitors: ['Ahrefs'], score: 55 }),
      mk('kimi', 'P49', 'L5', { competitors: ['Profound', 'Peec AI'], score: 0 }),
    ],
  };
}

function pct(n, d) {
  return d === 0 ? '—' : `${Math.round((n / d) * 100)}%`;
}

function buildReport({ runId, rows, cost, excludedModels }, cfg) {
  const models = [...new Set(rows.map((r) => r.model))];
  const lines = [];
  const brandMentioned = rows.filter((r) => r.mentioned === 1).length; // string-level match (may include same-name confusion)
  const confirmedOurs = rows.filter((r) => r.entity_match === 'ours' && r.mentioned === 1).length; // confirmed as our Tengence
  const ambiguous = rows.filter((r) => r.entity_match === 'ambiguous').length; // same-name other entity
  const competitorMentionCount = rows.filter((r) => (r.competitors || []).length > 0).length;
  const sovDenominator = confirmedOurs + competitorMentionCount;

  lines.push(`# AI Citation Monitoring Weekly (${runId})`);
  lines.push('');
  lines.push(`> Auto-generated at ${new Date().toISOString().slice(0, 16).replace('T', ' ')}; methodology in plan/2026 doc #10.`);
  lines.push('');

  if (excludedModels && excludedModels.length) {
    const hasDoubao = excludedModels.some((m) => m.startsWith('ep-'));
    lines.push(
      `> ⚠️ **Comparison scope**：this report only compares the models included via \`--models\` (${models.join(', ')}).` +
        `The following stored models are **excluded** from this round: ${excludedModels.join(', ')}.`
    );
    if (hasDoubao) {
      lines.push(
        '> Among them, Doubao (Doubao-Seed-2.1-Turbo, endpoint ep-20260916235412-lgl8l) hit an Ark endpoint quota' +
          ' (HTTP 429 SetLimitExceeded) and only 13/60 prompts were stored — sample too small, excluded; once the quota' +
          ' recovers, run `tengence-geo geo-monitor.js run --models=doubao --run-id=' +
          runId +
          '` to backfill the 47 prompts, then regenerate the full 4-model report.'
      );
    }
    lines.push('');
  }
  lines.push('## 1. Overview');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Prompts monitored | ${rows.length} (× ${models.length} models) |`);
  lines.push(`| Brand mention rate (string match) | ${pct(brandMentioned, rows.length)} (${brandMentioned}/${rows.length}) |`);
  lines.push(`| **Confirmed as our Tengence** | ${pct(confirmedOurs, rows.length)} (${confirmedOurs}/${rows.length}) |`);
  lines.push(`| ⚠️ Same-name confusion (ambiguous) | ${pct(ambiguous, rows.length)} (${ambiguous}/${rows.length}) |`);
  lines.push(`| SOV (confirmed brand / confirmed brand + competitors) | ${sovDenominator === 0 ? '—' : pct(confirmedOurs, sovDenominator)} |`);
  lines.push(`| Avg score (GEO Visibility Score) | ${rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : 0} |`);
  lines.push(`| Cites tengence.com | ${pct(rows.filter((r) => r.cited_tengence === 1).length, rows.length)} |`);
  lines.push(`| **Estimated cost this round** | ${fmtMoney(cost.totalCost)} (input ${(cost.totalIn / 1000).toFixed(1)}k + output ${(cost.totalOut / 1000).toFixed(1)}k tokens) |`);
  lines.push('');

  lines.push('## 2. Per-model metrics');
  lines.push('');
  lines.push('| Model | Prompts | String mention rate | Confirmed ours | Same-name confusion | Active recommendation | Cites official site | Red flags | Avg |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const m of models) {
    const rs = rows.filter((r) => r.model === m);
    lines.push(
      `| ${m} | ${rs.length} | ${pct(rs.filter((r) => r.mentioned === 1).length, rs.length)} | ` +
      `${pct(rs.filter((r) => r.entity_match === 'ours' && r.mentioned === 1).length, rs.length)} | ` +
      `${pct(rs.filter((r) => r.entity_match === 'ambiguous').length, rs.length)} | ` +
      `${rs.filter((r) => r.mention_type === 3).length} | ${pct(rs.filter((r) => r.cited_tengence === 1).length, rs.length)} | ` +
      `${rs.filter((r) => r.accuracy === 'flagged').length} | ${Math.round(rs.reduce((s, r) => s + r.score, 0) / rs.length)} |`
    );
  }
  lines.push('');

  lines.push('## 3. Per-layer metrics (all models combined)');
  lines.push('');
  lines.push('| Layer | Prompts | String mention rate | Confirmed ours | Avg |');
  lines.push('|---|---|---|---|---|');
  for (const layer of Object.keys(LAYER_NAMES)) {
    const rs = rows.filter((r) => r.layer === layer);
    if (rs.length === 0) continue;
    lines.push(
      `| ${layer} ${LAYER_NAMES[layer]} | ${rs.length} | ${pct(rs.filter((r) => r.mentioned === 1).length, rs.length)} | ` +
      `${pct(rs.filter((r) => r.entity_match === 'ours' && r.mentioned === 1).length, rs.length)} | ` +
      `${Math.round(rs.reduce((s, r) => s + r.score, 0) / rs.length)} |`
    );
  }
  lines.push('');

  const flagged = rows.filter((r) => r.accuracy === 'flagged' || r.sentiment === 'negative');
  lines.push('## 4. ⚠️ Red-flag ledger (needs human review)');
  lines.push('');
  if (flagged.length === 0) {
    lines.push('(no red flags this round)');
  } else {
    lines.push('| Model | Prompt | Type | Detail |');
    lines.push('|---|---|---|---|');
    for (const r of flagged) {
      for (const f of r.flags || []) {
        lines.push(`| ${r.model} | ${r.prompt_id} | ${f.type} | ${f.bad_phrase || f.value || ''} |`);
      }
    }
  }
  lines.push('');

  lines.push('## 5. SOV competitor landscape');
  lines.push('');
  const compCounts = new Map();
  for (const r of rows) for (const c of r.competitors || []) compCounts.set(c, (compCounts.get(c) || 0) + 1);
  if (compCounts.size === 0) {
    lines.push('(no competitor mentions this round)');
  } else {
    lines.push('| Competitor | Prompt-mentions |');
    lines.push('|---|---|');
    for (const [c, n] of [...compCounts.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${c} | ${n} |`);
    }
  }
  lines.push('');

  lines.push('## 6. Per-prompt detail');
  lines.push('');
  lines.push('| Model | Prompt | Layer | Entity | Mentioned | Type | Position | Cites official site | Accuracy | Score | Competitors |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  const typeNames = { 0: '—', 1: 'casual', 2: 'listed', 3: 'recommended' };
  const entNames = { ours: '✅ours', ambiguous: '⚠️same-name', none: '—' };
  for (const r of rows) {
    lines.push(
      `| ${r.model} | ${r.prompt_id} | ${r.layer} | ${entNames[r.entity_match] || '—'} | ${r.mentioned ? '✅' : '—'} | ${typeNames[r.mention_type] || r.mention_type} | ` +
      `${r.position || '—'} | ${r.cited_tengence ? '✅' : '—'} | ${r.accuracy} | ${r.score} | ${(r.competitors || []).join(', ') || '—'} |`
    );
  }
  lines.push('');
  lines.push('## 7. Token usage & cost (estimate)');
  lines.push('');
  lines.push('> Usage comes from each model API\'s `prompt_tokens` / `completion_tokens` (exact); cost = usage × the `pricing` unit price in `monitor.yaml` (¥ per million tokens, configurable).');
  lines.push('');
  lines.push('| Model | Input tokens | Output tokens | Input cost | Output cost | Subtotal |');
  lines.push('|---|---|---|---|---|---|');
  for (const c of cost.rows) {
    lines.push(
      `| ${c.model} | ${c.promptTokens.toLocaleString()} | ${c.completionTokens.toLocaleString()} | ` +
      `${fmtMoney(c.inCost)} | ${fmtMoney(c.outCost)} | ${fmtMoney(c.cost)} |`
    );
  }
  lines.push(
    `| **Total** | **${cost.totalIn.toLocaleString()}** | **${cost.totalOut.toLocaleString()}** | — | — | **${fmtMoney(cost.totalCost)}** |`
  );
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('**Tengence** · Data source: `tengence_geo_geo_monitor_*`; generated by `tengence-geo geo-monitor-report.js ' + runId + '`');
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const SITE = t.site.loadSite();
  const cfg = t.monitor.config.loadMonitorConfig(SITE);

  const raw = await loadRows(o, SITE);
  if (!raw.runId || raw.rows.length === 0) {
    console.error('❌ No monitoring data: run tengence-geo geo-monitor.js run first');
    process.exit(1);
  }
  // --models limits the comparison scope (other stored models are marked excluded and
  // the report explains why they are not included)
  const allModels = [...new Set(raw.rows.map((r) => r.model))];
  const excludedModels = o.models ? allModels.filter((m) => !o.models.includes(m)) : [];
  const data = o.models
    ? { runId: raw.runId, rows: raw.rows.filter((r) => o.models.includes(r.model)) }
    : raw;
  if (data.rows.length === 0) {
    console.error('❌ The models in --models have no data this round:', o.models.join(','));
    process.exit(1);
  }

  // Usage & cost: SUM over the answers table (exact tokens), estimated with monitor.yaml pricing
  let tokenRows = [];
  if (o.mock) {
    // sample token data, only to validate the report template
    tokenRows = [
      { model: 'deepseek', promptTokens: 5400, completionTokens: 3200 },
      { model: 'kimi', promptTokens: 6100, completionTokens: 4800 },
    ];
  } else {
    try {
      tokenRows = await t.monitor.store.readTokenTotals({ runId: data.runId });
    } catch (e) {
      console.warn('⚠️ Failed to read token usage (cost section will be blank):', e.message);
    }
  }
  // Cost only covers the compared models (models removed by --models are excluded so the
  // total does not include their distorted cost)
  if (o.models) tokenRows = tokenRows.filter((t) => o.models.includes(t.model));
  // Normalize actual DB model names (deepseek/kimi/qwen-plus/ep-xxx) to pricing keys (deepseek/kimi/qwen/doubao)
  const costAlias = {};
  for (const k of PROVIDER_KEYS) {
    const m = modelOf(PROVIDERS[k]);
    if (m) costAlias[m] = k;
    costAlias[k] = k; // compatible with early runs storing provider keys directly
  }
  const cost = computeCostByModel(tokenRows, cfg.pricing, costAlias);

  const md = buildReport({ ...data, cost, excludedModels }, cfg);
  const outDir = path.join(SITE.siteDir, cfg.reportDir);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `AI-citation-monitoring-weekly-${data.runId}.md`);
  fs.writeFileSync(outFile, md, 'utf8');
  console.log(`✅ Weekly report generated: ${outFile}`);
  console.log(`   Round ${data.runId} · ${data.rows.length} results`);
  console.log(`   Token usage: input ${(cost.totalIn / 1000).toFixed(1)}k + output ${(cost.totalOut / 1000).toFixed(1)}k`);
  console.log(`   Estimated cost: ${fmtMoney(cost.totalCost)} (see "7. Token usage & cost" in the report)`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('\n❌ Failed:', e.message);
    process.exit(1);
  });
}

module.exports = { main };
