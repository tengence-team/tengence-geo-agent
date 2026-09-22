/**
 * OpenAI-compatible unified client (llm domain)
 * ============================================================================
 * The four domestic providers (DeepSeek / Kimi / Qwen / Doubao) all share the
 * /chat/completions protocol; this file is the single HTTP exit: timeout, retry
 * (429/5xx/network-error exponential backoff) and truncated error-body display are
 * all converged here, so callers don't reinvent the wheel.
 *
 * Plain fetch (Node 18+), no SDK dependency; fetchImpl is injectable for tests.
 * ============================================================================
 */

const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call chat/completions once
 * @param {Object} opts
 * @param {Object} opts.provider    provider object from providers.js (its baseUrl is used)
 * @param {string} opts.apiKey      Bearer key (resolved from env by the caller before passing)
 * @param {string} opts.model       model name / endpoint ID
 * @param {Array}  opts.messages    [{role:'user', content:'...'}]
 * @param {number} [opts.temperature=0.2]
 * @param {number} [opts.maxTokens=2048]
 * @param {number} [opts.timeoutMs=60000]
 * @param {number} [opts.retries=2]
 * @param {Function} [opts.fetchImpl] test injection
 * @returns {Promise<{text:string, model:string, usage:{prompt_tokens,completion_tokens}}>}
 */
async function chatCompletion({
  provider,
  apiKey,
  model,
  messages,
  temperature = 0.2,
  maxTokens = 2048,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  fetchImpl = fetch,
}) {
  if (!provider || !provider.baseUrl) throw new Error('chatCompletion: missing provider/baseUrl');
  if (!apiKey) throw new Error(`chatCompletion: missing API key (${provider.key})`);
  if (!model) throw new Error(`chatCompletion: missing model (${provider.key})`);
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('chatCompletion: missing messages');
  }

  const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
  // provider-level temperature override (e.g. the kimi-k2 family forces
  // temperature=1); otherwise uses the caller-passed value
  const temp = provider.temperature != null ? provider.temperature : temperature;
  const body = JSON.stringify({ model, messages, temperature: temp, max_tokens: maxTokens });

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // backoff: exponential + jitter (no wait on the first attempt, avoiding
    // needless latency)
    if (attempt > 0) await sleep(RETRY_BASE_DELAY_MS * attempt + Math.floor(Math.random() * 500));
    // explicit AbortController + manual timeout fallback: more stable than
    // AbortSignal.timeout; guarantees rejection within timeoutMs, avoiding undici's
    // bodyTimeout hanging for 300s before throwing read ETIMEDOUT
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await res.text();
      if (!res.ok) {
        const err = new Error(
          `LLM ${provider.key} HTTP ${res.status}: ${text.slice(0, 300)}`
        );
        err.status = res.status;
        // 429 / 5xx retryable; 4xx parameter errors throw directly
        if (res.status === 429 || res.status >= 500) {
          lastErr = err;
          continue;
        }
        throw err;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`LLM ${provider.key} returned non-JSON: ${text.slice(0, 200)}`);
      }

      const content = data.choices && data.choices[0] && data.choices[0].message;
      if (!content || typeof content.content !== 'string') {
        throw new Error(
          `LLM ${provider.key} response missing choices[0].message.content: ${text.slice(0, 200)}`
        );
      }

      return {
        text: content.content,
        model: data.model || model,
        usage: {
          prompt_tokens: (data.usage && data.usage.prompt_tokens) || 0,
          completion_tokens: (data.usage && data.usage.completion_tokens) || 0,
        },
      };
    } catch (e) {
      clearTimeout(timer);
      // network-layer errors (timeout / connection failure / abort) are all
      // retryable; 4xx carrying an HTTP status code throw directly
      if (e.status) throw e;
      lastErr = e;
      if (attempt < retries) {
        console.warn(
          `  ↻ ${provider.key} call ${attempt + 1} failed (${e.name || e.code || 'err'}: ${String(e.message).slice(0, 80)}), retrying in ~${RETRY_BASE_DELAY_MS * (attempt + 1)}ms`
        );
      }
    }
  }
  throw lastErr || new Error(`LLM ${provider.key} call failed`);
}

module.exports = { chatCompletion, sleep };
