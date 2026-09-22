/**
 * Monitor cost estimation (monitor domain)
 * ============================================================================
 * Pure functions: convert "per-model token usage" into cost by monitor.yaml's
 * pricing unit prices. Unit prices are RMB ¥ / million tokens, passed in after
 * parsing by config.normalizePricing.
 * Usage comes from each model API's prompt_tokens / completion_tokens (precise);
 * cost is an estimate — unit prices follow each platform's official rates and can be
 * fine-tuned in monitor.yaml.
 * ============================================================================
 */

/**
 * Estimate cost per model price; models without a price get tokens only, no cost.
 * @param {Array<{model,promptTokens,completionTokens}>} tokenRows
 * @param {Object} [pricing] { modelKey: {input_per_1m, output_per_1m} }
 * @param {Object} [alias] DB actual model name → pricing key mapping (resolves
 *                         qwen-plus→qwen, ep-xxx→doubao naming differences)
 * @returns {{rows:Array, totalCost:?number, totalIn:number, totalOut:number}}
 */
function computeCostByModel(tokenRows, pricing, alias) {
  const out = [];
  let totalCost = null;
  let totalIn = 0;
  let totalOut = 0;
  for (const t of tokenRows || []) {
    // the model name stored in the DB may be a provider key (deepseek/kimi, from
    // early runs) or the real modelOf value (qwen-plus / ep-xxx); normalize to the
    // pricing key via alias so the cost never computes to 0.
    const key = (alias && alias[t.model]) || t.model;
    const p = pricing && pricing[key];
    const inCost = p ? (t.promptTokens / 1e6) * p.input_per_1m : null;
    const outCost = p ? (t.completionTokens / 1e6) * p.output_per_1m : null;
    const cost = inCost != null && outCost != null ? inCost + outCost : null;
    if (cost != null) totalCost = (totalCost || 0) + cost;
    totalIn += t.promptTokens;
    totalOut += t.completionTokens;
    out.push({ model: t.model, promptTokens: t.promptTokens, completionTokens: t.completionTokens, inCost, outCost, cost });
  }
  return { rows: out, totalCost, totalIn, totalOut };
}

/** Money formatting (null → dash; <0.01 keeps 4 decimals so it doesn't display as a
 * distorted ¥0.00) */
function fmtMoney(v) {
  if (v == null) return '—';
  return `¥${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
}

module.exports = { computeCostByModel, fmtMoney };
