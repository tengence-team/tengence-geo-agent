/**
 * Model-provider registry (llm domain)
 * ============================================================================
 * The four domestic providers all expose OpenAI-compatible endpoints
 * (/chat/completions); one client works across all of them by swapping base_url +
 * model + key — no per-provider adapters needed. Doubao (Volcano Ark)'s model is
 * actually an "inference endpoint ID" (ep-xxx), configured via ARK_MODEL_ID.
 *
 * Conventions:
 *   - Keys only come from sites/<site>/.env (loadSite injects process.env); a
 *     missing key counts as "provider not enabled", skipped by resolveEnabled
 *     (no error — models can be incrementally onboarded).
 *   - This file has zero side effects and zero network.
 * ============================================================================
 */

const PROVIDERS = {
  deepseek: {
    key: 'deepseek',
    label: 'DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    intervalMs: 1200,
    maxTokens: 768,
  },
  kimi: {
    key: 'kimi',
    label: 'Kimi (Moonshot)',
    envKey: 'MOONSHOT_API_KEY',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6',
    // the kimi-k2 family forces temperature=1 (other values get 400)
    temperature: 1,
    intervalMs: 1200,
    maxTokens: 768,
  },
  qwen: {
    key: 'qwen',
    label: 'Qwen (Tongyi Qianwen)',
    envKey: 'DASHSCOPE_API_KEY',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    intervalMs: 1200,
    maxTokens: 768,
  },
  doubao: {
    key: 'doubao',
    label: 'Doubao (Volcano Ark)',
    envKey: 'ARK_API_KEY',
    // Ark's model = inference endpoint ID (ep-xxx), must be provided via the
    // .env ARK_MODEL_ID
    modelEnv: 'ARK_MODEL_ID',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: null,
    intervalMs: 1200,
    // Doubao-Seed-2.1-Turbo is a reasoning model (thinking tokens don't count
    // against this cap); maxTokens only constrains the final visible output, 768 is
    // enough
    maxTokens: 768,
    // reasoning models have high first-token latency; widen the timeout to 120s
    // (regular models use the client's default 90s)
    timeoutMs: 120000,
  },
};

/** All provider keys (stable order) */
const PROVIDER_KEYS = Object.keys(PROVIDERS);

/**
 * Resolve the currently usable model list: enabled only when the key (and Doubao's
 * endpoint ID) are both configured.
 * @param {Object} [env] default process.env (injectable for tests)
 * @returns {{enabled: Object[], skipped: {key:string, reason:string}[]}}
 */
function resolveEnabled(env = process.env) {
  const enabled = [];
  const skipped = [];
  for (const key of PROVIDER_KEYS) {
    const p = PROVIDERS[key];
    if (!env[p.envKey]) {
      skipped.push({ key, reason: `missing ${p.envKey}` });
      continue;
    }
    if (p.modelEnv && !env[p.modelEnv]) {
      skipped.push({ key, reason: `missing ${p.modelEnv} (Doubao requires the inference endpoint ID)` });
      continue;
    }
    enabled.push(p);
  }
  return { enabled, skipped };
}

/** Resolve a provider's model name (Doubao reads the endpoint ID from env) */
function modelOf(provider, env = process.env) {
  return provider.modelEnv ? env[provider.modelEnv] : provider.model;
}

module.exports = { PROVIDERS, PROVIDER_KEYS, resolveEnabled, modelOf };
