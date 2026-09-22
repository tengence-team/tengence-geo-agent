/**
 * Monitor orchestration (monitor domain)
 * ============================================================================
 * runMonitor: question × model × N attempts → per-item extraction → aggregation
 * (majority vote) → scoring → persist.
 *
 * Aggregation rubric (plan §8 randomness countermeasures):
 *   - mentioned / citedTengence / sentiment: majority across N attempts;
 *   - mentionType: the max type among the mentioned rounds (recommendation > listed >
 *     incidental);
 *   - accuracy: flagged if any round is flagged (conservative); otherwise complete if
 *     any round is complete;
 *   - competitors: union; flags: union;
 *   - score: mean of the rounds, rounded; representative = the round whose score is
 *     the median, with its original text.
 * ============================================================================
 */

const { loadMonitorConfig, LAYERS } = require('./config');
const { loadMonitorPrompts, questionFor } = require('./prompts');
const { extract } = require('./extract');
const { scoreResult } = require('./score');
const store = require('./store');
const { PROVIDERS, resolveEnabled, modelOf } = require('../llm/providers');
const { chatCompletion } = require('../llm/client');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function majority(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best;
  let bestN = -1;
  for (const [v, n] of counts) {
    if (n > bestN || (n === bestN && v > best)) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

function median(scores) {
  const sorted = [...scores].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// question-level resilience: when a whole question's calls keep failing (transient
// timeout / slow server), retry the whole question a few times; if it still fails,
// skip it (marking an unmeasured flag) while the rest run normally — so one
// question timeout never aborts the whole round.
const PROMPT_RETRIES = 2;
const PROMPT_RETRY_DELAY_BASE = 15000;

/**
 * Run one monitoring round
 * @param {Object} opts
 * @param {Object} [opts.site]        loadSite() result
 * @param {string[]} [opts.models]    only run the given model keys (default = all configured)
 * @param {string[]} [opts.layers]    only run the given layers (default = all)
 * @param {string}  opts.runId        YYYYMMDD
 * @param {number}  [opts.attempts]   overrides config.attempts
 * @param {Function} [opts.answerFn]  injected answer function (mock): async ({provider, question}) => string
 * @param {Object}  [opts.store]      injected storage (default DB store)
 * @returns {Promise<Object>} the run summary
 */
async function runMonitor({
  site,
  models,
  layers,
  runId,
  attempts,
  answerFn,
  store: storeImpl,
} = {}) {
  if (!runId) throw new Error('runMonitor: missing runId (YYYYMMDD)');
  const cfg = loadMonitorConfig(site);
  const promptsAll = loadMonitorPrompts(site);
  const prompts = layers && layers.length
    ? promptsAll.filter((p) => layers.includes(p.layer))
    : promptsAll;
  if (prompts.length === 0) throw new Error(`runMonitor: no questions after layer filtering (${layers})`);

  let providers;
  let skipped = [];
  if (answerFn) {
    // mock pipeline verification: keys aren't checked; use the specified (or all)
    // provider definitions directly
    const keys = models && models.length ? models : Object.keys(PROVIDERS);
    providers = keys.map((k) => PROVIDERS[k]).filter(Boolean);
  } else {
    const resolved = resolveEnabled();
    providers = resolved.enabled;
    skipped = resolved.skipped;
    if (models && models.length) {
      providers = providers.filter((p) => models.includes(p.key));
    }
    if (providers.length === 0) {
      throw new Error(
        `runMonitor: no usable models. Configured: ${providers.map((p) => p.key).join(', ') || 'none'}; ` +
        `skipped: ${skipped.map((s) => `${s.key}(${s.reason})`).join(', ') || 'none'}`
      );
    }
  }

  const totalAttempts = attempts > 0 ? attempts : cfg.attempts;
  const impl = storeImpl || store;
  const modelSummaries = [];
  const allFlags = [];

  for (const provider of providers) {
    const model = modelOf(provider);
    const apiKey = process.env[provider.envKey];
    const answers = [];
    const results = [];
    const incremental = !answerFn && typeof impl.writeQuestion === 'function';

    // incremental persist: clear the model's old data at the start of the model loop
    // (idempotent starting point), then write question by question
    if (incremental) {
      await impl.beginModelRun({ runId, model });
    }

    for (const prompt of prompts) {
      let done = false;
      let lastErr = null;
      for (let pr = 0; pr <= PROMPT_RETRIES && !done; pr++) {
        try {
          const perAttempt = [];
          for (let attempt = 1; attempt <= totalAttempts; attempt++) {
            const question = questionFor(prompt, attempt);
            let text;
            let usage = null;
            let modelVersion = null;
            if (answerFn) {
              text = await answerFn({ provider, prompt, question, attempt });
            } else {
              const res = await chatCompletion({
                provider,
                apiKey,
                model,
                messages: [{ role: 'user', content: question }],
                temperature: cfg.temperature,
                maxTokens: provider.maxTokens || 768,
                timeoutMs: provider.timeoutMs,
              });
              text = res.text;
              usage = res.usage;
              modelVersion = res.model;
            }
            const e = extract(text, cfg);
            const { score } = scoreResult(e);
            perAttempt.push({ text, ...e, score, usage, modelVersion });

            // mock (answerFn) has no network calls, no rate limiting needed
            if (!answerFn) await sleep(provider.intervalMs || 1200);
          }

          // aggregation (majority vote)
          const mentioned = majority(perAttempt.map((a) => a.mentioned));
          const entityMatch = majority(perAttempt.map((a) => a.entityMatch));
          const mentionedRounds = perAttempt.filter((a) => a.mentioned === 1);
          const mentionType = mentionedRounds.length
            ? Math.max(...mentionedRounds.map((a) => a.mentionType))
            : 0;
          const sentiment = mentionedRounds.length ? majority(mentionedRounds.map((a) => a.sentiment)) : 'neutral';
          const position = mentionedRounds.length ? majority(mentionedRounds.map((a) => a.position)) : 0;
          const flagged = perAttempt.some((a) => a.accuracy === 'flagged');
          const complete = perAttempt.some((a) => a.accuracy === 'complete');
          const accuracy = flagged ? 'flagged' : complete ? 'complete' : 'basic';
          const competitors = [...new Set(perAttempt.flatMap((a) => a.competitors))];
          const flags = [...new Map(perAttempt.flatMap((a) => a.flags).map((f) => [JSON.stringify(f), f])).values()];
          const score = Math.round(perAttempt.reduce((s, a) => s + a.score, 0) / perAttempt.length);
          const repScore = median(perAttempt.map((a) => a.score));
          const representative = perAttempt.find((a) => a.score === repScore) || perAttempt[0];

          // this question's answer variants
          const qAnswers = [];
          for (let i = 0; i < perAttempt.length; i++) {
            const a = perAttempt[i];
            qAnswers.push({
              modelVersion: a.modelVersion || provider.key,
              promptId: prompt.id,
              layer: prompt.layer,
              variant: i,
              attempt: i + 1,
              question: questionFor(prompt, i + 1),
              text: a.text,
              promptTokens: (a.usage && a.usage.prompt_tokens) || 0,
              completionTokens: (a.usage && a.usage.completion_tokens) || 0,
            });
          }
          const qResult = {
            promptId: prompt.id,
            layer: prompt.layer,
            mentioned,
            entityMatch,
            mentionType,
            position,
            sentiment,
            citedTengence: majority(perAttempt.map((a) => a.citedTengence)),
            citedAny: majority(perAttempt.map((a) => a.citedAny)),
            accuracy,
            score,
            competitors,
            flags,
          };

          results.push(qResult);
          allFlags.push(...flags.map((f) => ({ ...f, promptId: prompt.id, model: provider.key })));

          if (answerFn) {
            // mock: buffer, then one writeRun at the end (noopStore actually writes nothing)
            answers.push(...qAnswers);
          } else if (incremental) {
            // real network: write question by question (incremental; progress can be
            // checked via status mid-run)
            await impl.writeQuestion({ runId, model, answers: qAnswers, result: qResult });
          } else {
            // legacy store (no writeQuestion): buffer, then one writeRun at the end
            answers.push(...qAnswers);
          }
          done = true;
        } catch (e) {
          lastErr = e;
          const isQuota = e.status === 429 || /SetLimitExceeded|rate.?limit|quota|too many requests/i.test(String(e.message || ''));
          if (isQuota) {
            // quota/rate limits (e.g. 429 SetLimitExceeded) don't recover in seconds;
            // skip this question immediately to avoid backoff dragging the whole round
            // into hours; re-running the question later fills the gap.
            console.warn(
              `  ⏭ ${provider.key} question ${prompt.id} hit a rate/quota limit (${String(e.message).slice(0, 60)}); skipping (re-runnable to fill)`
            );
            break;
          }
          if (pr < PROMPT_RETRIES) {
            const d = PROMPT_RETRY_DELAY_BASE * (pr + 1);
            console.warn(
              `  ↻ ${provider.key} question ${prompt.id} failed as a whole (${String(e.message).slice(0, 80)}); retrying the whole question in ~${Math.round(d / 1000)}s`
            );
            await sleep(d);
          }
        }
      }
      if (!done) {
        console.warn(
          `  ⚠ ${provider.key} question ${prompt.id} failed ${PROMPT_RETRIES + 1} consecutive times; skipping (not counted this round, re-runnable to fill)`
        );
        allFlags.push({
          type: 'unmeasured',
          promptId: prompt.id,
          model: provider.key,
          detail: String((lastErr && lastErr.message) || '').slice(0, 160),
        });
      }
    }

    // mock or store without incremental support: one persist at the end
    if (answerFn || !incremental) {
      await impl.writeRun({ runId, model: provider.key, answers, results });
    }
    modelSummaries.push({
      model: provider.key,
      prompts: prompts.length,
      mentioned: results.filter((r) => r.mentioned === 1).length,
      flagged: results.filter((r) => r.accuracy === 'flagged').length,
      avgScore: Math.round(results.reduce((s, r) => s + r.score, 0) / results.length),
    });
  }

  return { runId, models: modelSummaries, flags: allFlags };
}

module.exports = { runMonitor, majority, median, LAYERS };
